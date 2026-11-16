# Report engine: design spec (v1)

> **Status:** approved 2026-11-16
> **Working name:** `report-engine` inside spencer; published as `querybrief` under Apache-2.0

## 1. What we're building

A module that turns a plain-language request ("how did our spending in October compare with September, by category?") into a report. It understands the request, checks it can be answered, plans the report, has the LLM write read-only SQL, checks that SQL, runs it under the requesting user's own data permissions, and renders the result as an in-app report or a PDF.

- **Spencer is the first user, not the only one.** The module is built as a standalone package inside this repo, with no imports from spencer's code. It can then move to its own repo and be published as open source.
- **Safety is the product.** The database confines every query to the user's household (row-level security, RLS). A strict SQL validator and a read-only transaction are layered on top. Nothing the LLM writes can change data or read another household's rows.

### In scope for v1

- Learning the database once: a `reporting` schema of views, plus a reviewed semantic-model file (§4, stage 0).
- The staged pipeline (§4): understand intent → check feasibility → plan → write SQL → validate → execute → post-process and verify → narrate → render.
- Reports with several sections, each with its own query. All sections run against one consistent snapshot and are combined in code.
- Clarifying questions, and plan approval when needed.
- Output as an in-app report or a PDF, both from the same saved result. The output type is chosen per request.
- Saved reports (opt-in) that can be shared with the household, with daily scheduled re-runs whose results appear in the app.
- Full logging of every run: SQL, plain-language summaries, tokens, cost, latency, retries, fallbacks, errors, and an audit trail.
- Claude Opus 5.5, with retries and a Sonnet 5.5 fallback.

### Not in v1 (v0.2 or later)

- Queries whose results feed other queries (chained queries).
- OpenRouter and other providers. The provider interface is ready for them.
- Email or push delivery, and schedules more frequent than daily.
- An MCP server, reusable React components, CSV export.
- Anything other than `SELECT`.

## 2. Decisions so far

| Topic | Decision |
|---|---|
| beep-server | Rewrite its patterns (usage/cost recording, audit log, retry then fallback, cancellable timeouts, untrusted-text fencing). Copy no code. |
| Pipeline | Staged, with a check between every stage (§4). |
| Who writes SQL | The LLM. SQL compiled by our code from the plan's structured query is the fallback and the cross-check. Reconfirmed after the research comparing compiled and LLM-written SQL. |
| Pauses | Only when needed: real ambiguity, partial feasibility, or a costly plan. |
| Semantic model | Drafted by the LLM, reviewed by you, committed next to the migrations. |
| SQL execution | A dedicated read-only database role that can only read a `reporting` schema of views, using one read-only transaction per report. |
| Visibility | Runs and logs: author only. Saved reports: the author can share them with the household. |
| PDF | `@react-pdf/renderer`. Charts are redrawn from the same chart spec as the app (not pixel-identical). |
| Models | Opus 5.5 for every stage; Sonnet 5.5 on persistent errors; Anthropic's server-side refusal fallback on. |
| LLM library | Official Anthropic SDK, behind the engine's own provider interface. |
| Repo layout | A workspace package inside spencer, extracted when it's published. |
| Row data sent to the LLM | Library default: none. Spencer: schema plus row-capped results. |
| Multiple queries | Several independent queries per report in v1; chained queries in v0.2. |
| Scheduling | One daily Vercel Cron tick; results in the app only. |
| License and name | Apache-2.0: free for any use, commercial included, with an explicit patent grant that protects users. Published as `querybrief` (claim the npm org and GitHub name before publishing). |
| Hosting | Vercel Hobby with Fluid compute on (confirmed): 300 s per function call, cron at most once a day. |
| Signed scope | In v1 (§5.2). |
| Limits and retention | As proposed in §4 (stage 3), §5.7 and §7. |
| Navigation | A "Reports" entry in the user menu. |
| Prerequisite | Migration 0007 fixes spencer's table grants first (§5.2). The reporting migration is 0008. |

## 3. Architecture

```
spencer (Next.js 16 app)                       packages/report-engine (never imports spencer code)
─────────────────────────────────────          ──────────────────────────────────────────────────────
app/(app)/reports/…          pages        ─┐    core/       pipeline, stage contracts (zod), run state
app/api/reports/…            handlers      ├─▶              machine, ReportDocument, post-processing, checks
app/api/cron/reports         daily tick   ─┘    llm/        provider interface, retry/fallback, usage + cost
components/reports/*         in-app renderer    llm/anthropic/  official SDK adapter
reports.config.ts            spencer settings   sql-guard/  parser, allow-lists, syntax-tree rules, LIMIT
supabase/migrations/0008_reporting.sql          pg/         executor, transaction envelope, EXPLAIN gate,
supabase/reporting/semantic-model.json                      introspection
                                                semantic/   model schema, loader, freshness check, generator
                                                compile/    structured query → SQL (fallback, cross-check)
                                                pdf/        ReportDocument → PDF (@react-pdf/renderer)
```

- Spencer adds `"workspaces": ["packages/*"]` to `package.json` (it uses npm). Next 16 compiles workspace packages automatically (Turbopack, and webpack for the App Router), so `next.config.ts` needs no `transpilePackages` entry. The package has its own `package.json`, `tsconfig` and tests. A lint rule forbids `@/…` imports inside it.
- The engine contains no UI apart from the PDF renderer. Spencer renders the in-app report with its own components (shadcn, plus Recharts through `components/ui/chart.tsx`).
- The subfolders map one-to-one onto the packages proposed for publishing (`core`, `sql-guard`, `pg`, `supabase`, `llm-anthropic`, `pdf`, `next`). Extraction is then a move, not a rewrite.

## 4. The pipeline

Every stage reads the previous stage's typed result, saves its own result on the run, and must pass its check before the next stage starts. LLM stages use Claude's structured output (a JSON schema generated from zod), so every LLM result can be checked by code. A failed stage is retried on its own; the run never restarts from scratch.

### Stage 0: Learn the database (once per schema version)

**The reporting surface (migration 0008).** A `reporting` schema of `security_invoker` views is the only thing generated SQL may read. The views encode the rules that schema introspection can't discover:

- `reporting.spendings` has one row per spending: `spent_on, amount, category_key, category_label, bucket, member_id, member_name, description`. It joins categories on `(group_id, kind = 'expense', key)`, because there is no foreign key (`supabase/migrations/0001_init.sql:44`, `supabase/migrations/0005_editable_categories.sql:19`).
- `reporting.monthly_income` has one row per month and category, holding the *standing* amount: the latest `income` row whose `effective_from` is on or before the month start (`lib/reports.ts:40-50`).
- `reporting.categories`, `reporting.bucket_targets` and `reporting.members`. No view exposes emails.
- Every view and column has a `COMMENT` explaining its meaning, units (the household's currency) and caveats. One example: in a partial year, income counts only for months that have started (`lib/reports.ts:143-146`).

**The semantic model file** is `supabase/reporting/semantic-model.json`, generated by `npm run reports:model`:

1. Code introspects the `reporting` schema: views, columns, types, comments and row estimates.
2. The LLM drafts descriptions, synonyms ("groceries" → a category), metric definitions (e.g. `spend = sum(amount) from reporting.spendings`), dimensions, example questions and suggested reports.
3. You review the file and commit it.

**Checks:**
- Every metric definition compiles and passes `EXPLAIN`.
- Every view is `security_invoker`.
- Introspection flags anything that would bypass RLS: views running with owner rights, materialized views, foreign tables and `SECURITY DEFINER` functions.

**Freshness:** the file stores a hash of the introspected schema. At run time, a mismatch stops the run with "semantic model out of date" instead of guessing.

### Stage 1: Understand intent (LLM, low effort)

- **Before the call:** code reads each dimension's values in the household's data, such as its category and member names, with code-built queries through the executor.
  - A deployment may show these values to the LLM, fenced, so it can map "groceries" onto the real name. Spencer does; the library default doesn't.
  - Code always uses them to check the values the intent names.
- **Output (`Intent`):**
  - **Kind:** report, single figure, comparison, trend, breakdown, listing, out of scope, or write request.
  - **What to compute:** metrics, dimensions and filters.
  - **When:** the time range resolved to absolute dates in the configured timezone, and any comparison period.
  - **Bookkeeping:** output type, assumptions, ambiguities and confidence.
- **Check (code):**
  - Every metric, dimension and value resolves against the semantic model. Unknown names get nearest-match suggestions.
  - Dates are valid.
  - Write requests and out-of-scope requests are refused, with a reason.
- **Pause:** if an ambiguity would change the result (e.g. "groceries" matches no category), the run asks a clarifying question and moves to `needs_clarification`.

### Stage 2: Feasibility and state (code, plus tiny read-only queries)

- **Checks:**
  - The required fields exist.
  - Data exists in the requested range (minimum and maximum date, row count, under the user's RLS scope).
  - The user's scope resolves to exactly one household. The executor verifies this for every run, so there is no separate probe.
  - The semantic model is fresh.
- These probe queries are built by code, not written by the LLM, and run through the same executor as everything else.
- **Output (`Feasibility`):** `ok`, `partial` or `no`, with gaps, alternatives and data coverage.
- **If it's not `ok`:** the run explains what's missing and offers alternatives. No SQL is written. `partial` pauses for confirmation.

### Stage 3: Plan (LLM, high effort)

- **Output (`ReportPlan`):**
  - A title.
  - Sections: headline figures, tables, charts and text. Each has a purpose, a **structured query** (view, measures, dimensions, filters, grain, sort, limit) and a chart or table spec.
  - The structured query names only what the semantic model defines (decided 2026-11-16).
    - It is either an `aggregate` (metrics by dimensions and a time grain) or `rows` (a listing).
    - Every name is a schema enum.
    - A question that spans two views, such as spending against income, is two sections combined in code.
    - A section these shapes can't describe gets LLM-written SQL with no compiled cross-check.
  - Derived calculations (share of total, change against the previous period).
  - Cross-checks, e.g. the category breakdown must add up to the total.
  - A plain-language summary.
- **Check (code):**
  - References resolve and aggregates fit the column types.
  - At most 8 sections.
  - Derived calculations reference sections that exist.
  - Code estimates the run's remaining cost from the plan's size and compares it with the per-run budget.
- **Approval (only when needed):**
  - **When it pauses:** the run moves to `awaiting_approval` if stage 1 or 2 flagged anything, the plan has more than 4 sections, or the cost estimate exceeds the per-run budget.
  - **How approval works:** it's a conditional update on the plan's hash. A double click can't run the report twice, and an edited plan can't skip approval.
  - **Expiry:** pending approvals expire after 24 hours.

### Stage 4: Write SQL (LLM, high effort)

- One call writes a `SELECT` for every section, from the plan and the semantic model.
- **Output per section:** SQL with `$n` placeholders for every value taken from the request, the parameter list, a plain-language summary, and the expected column names and types.
- Values from the request never appear in the SQL text, and every identifier must exist in the `reporting` schema.

### Stage 5: Validate SQL (code)

- **Static check (sql-guard, §5.4):** parse the SQL with the real Postgres parser and reject anything outside the rules. The text that passes runs unchanged. The database parses that same text with the same major grammar, so what runs is exactly what was checked, with no deparser in between.
- **Dry run:** `EXPLAIN (FORMAT JSON)` inside the user-scoped, read-only transaction. It catches unknown columns, type errors and cost blow-ups without running anything.
- **On failure** (including runtime errors and timeouts in stage 6), these are tried in order:
  1. The error goes back to stage 4 for the failing section, for up to 2 repairs. The repair prompt quotes the exact error (from the validator, `EXPLAIN` or Postgres) and lists the valid options: views, columns and functions. There is no generic "review your SQL" pass, because in published tests that made results worse.
  2. SQL compiled from the plan's structured query, checked by sql-guard like any other SQL.
  3. The section fails with a clear message. If the section is essential, the run fails.

  The Sonnet 5.5 fallback (§6) covers API failures, not SQL that fails validation.

### Stage 6: Execute (code)

- There is one read-only transaction per report (§5.3). Sections run inside it in order, and all of them see the same snapshot.
- **Checks:**
  - Result columns and types must match what the plan expects.
  - More than 1,000 rows means the result is truncated and marked as such.
  - Results also have a byte cap.

### Stage 7: Post-process and verify (code)

- Merges sections, computes derived values, and formats money and dates in the household's currency, following the conventions in `lib/format.ts`.
- Runs the plan's cross-checks, e.g. the breakdown sums to the total and the months add up to the year.
- **Compiled cross-check:** for every section the compiler can express, the compiled SQL runs as well, after passing the same sql-guard checks as LLM-written SQL.
  - If the two results differ, the compiled result is used and the mismatch is logged.
  - This is the one check that catches SQL that is valid but wrong, such as summing income rows by date.
- A section that fails a cross-check is marked "unverified" in the report, never shown silently.

### Stage 8: Narrate (LLM, medium effort)

- Writes the headline and insights from the verified results.
- Every value from the database is wrapped as untrusted data. Spending descriptions are free text that a user typed and could contain instructions.
- This call has no tools.
- **Check (code):** every number in the text must match a computed value, allowing for rounding. Otherwise the text is regenerated once; if it still fails, the sentence is dropped.
- With row data set to `none` (the library default), the LLM sees only the names and shapes of the computed figures, and code fills in the values.

### Stage 9: Render (code)

The run produces one `ReportDocument` (§8) and saves it. The report page and the PDF both render from it, so they always match.

### Run states

```
received → planning → [needs_clarification | awaiting_approval] → executing
         → succeeded | partial | failed | rejected | expired
```

- A `stage` field carries finer progress (understanding, checking, planning, writing SQL, validating, executing, verifying, narrating, rendering).
- The engine keeps no run state of its own. The planning half is `planRun` (M2b), which hands each new state to the caller to save.
  - A paused run carries `pendingUntil`, which spencer stores as `approval_expires_at`.
  - A clarifying answer clears the intent and the plan; stage 1 works them out again from the answer.
- Every transition is saved with a timestamp and the actor. The page can poll progress, a closed tab doesn't lose the run, and every run can be audited.

## 5. Security model

### 5.1 Threats

1. A signed-in user, or a crafted request, trying to read another household's data, change data or read secrets.
2. Instructions hidden in stored data (spending descriptions, category labels) or in the request, aimed at the LLM.
3. SQL that is valid but wrong, presenting wrong numbers as fact.
4. Resource abuse: slow queries, huge results, runaway LLM spend.
5. Leaked credentials: the database connection string, API keys, the cron secret.
6. Data leaving through the output, e.g. links or images in a PDF.

The **database identity (RLS) is the security boundary**. The validator is defence in depth. It is also load-bearing in one place: Supabase identifies the user through a session setting (`request.jwt.claims`), which a query calling `set_config` could rewrite. The validator must make that impossible, and the signed scope (§5.2) removes the dependency altogether.

### 5.2 Database setup (migration 0008)

**Roles:**
- `reports_login` is a login role, created **without a password** in the migration because the repo is public. You set the password once in the dashboard, and it's stored only in Vercel.
- `reports_login` is a member of **only** `reports_reader`. `reports_reader` is `NOLOGIN` and `NOBYPASSRLS`, with no other memberships. So the login can never become `authenticated`, `service_role` or `postgres`.

**What `reports_reader` can access:**
- `USAGE` on `reporting` and `SELECT` on its views.
- `SELECT` on exactly the base-table columns those views need. Security-invoker views check access as the caller, so these grants are required. `profiles.email` is never granted.
- `EXECUTE` on `reporting.scope_group_id()` (below), and nothing in `private`, `auth`, `vault` or `extensions`.

**Signed scope (in v1).** `reports_reader` never trusts `request.jwt.claims`:
- **Policies.** It gets its own read policies on the underlying tables, each checking `group_id = (select reporting.scope_group_id())`. The existing policies for `authenticated` are untouched.
- **Setting the scope.** At the start of each report transaction, the server sets `reports.scope` to `<group_id>.<expires_at>.<run_id>.<signature>`. The signature is an HMAC-SHA256 computed with `REPORTS_SCOPE_KEY`.
- **Checking the scope.** `reporting.scope_group_id()` is `SECURITY DEFINER` and `STABLE`, with an empty `search_path`. It:
  - recomputes the signature with `pgcrypto`'s `hmac`, using the same key read from Supabase Vault
  - checks that the scope hasn't expired
  - returns the household ID, or `NULL`, which matches no rows
- **Why it holds.** `reports_reader` can't read the Vault secret. A query that slipped past the validator and called `set_config` still couldn't forge another household's scope. A leaked database password on its own reads nothing.
- **The key.** It is created once in the SQL editor (`vault.create_secret`) and the same value is stored in Vercel. It never appears in the repo.

**Other hardening:**
- Supabase's default grants (including `TRUNCATE`) are revoked from `anon` and `authenticated` on the new log tables.
- The `reporting` schema is not exposed through the Data API.
- **Prerequisite (migration 0007):** the same default grants were never revoked on spencer's existing tables. That left `profiles.group_id` updatable by its owner, against the intent of `0001_init.sql:188-190`. Migration 0007 resets every app table to the privileges 0001–0005 intended.

### 5.3 Transaction envelope (one per report)

1. **Connection.** Connect through Supabase's pooler in transaction mode (port 6543, no prepared statements). Vercel can't reach direct connections, which are IPv6-only. Use a small dedicated pool that is never shared with app queries.
2. **Begin.** `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`.
3. **Limits.** `SET LOCAL statement_timeout = '5s'`, `lock_timeout = '1s'`, `idle_in_transaction_session_timeout = '15s'`, `transaction_timeout` (Postgres 17 or later), a `work_mem` cap, `search_path = pg_catalog` (so unqualified functions and operators can only mean built-ins; relations are always schema-qualified) and `standard_conforming_strings = on` (so the server reads string literals the way the parser did). All are set again before each query.
4. **Scope.** Set the signed scope (`reports.scope`, §5.2).
5. **Each section:**
   1. Run the `EXPLAIN` gate (cost and row thresholds).
   2. Run the checked query unchanged, fetching at most 1,001 rows. The row cap is a protocol-level limit, so the query's own `ORDER BY` and `LIMIT` stay intact.
   3. Check the tripwire: `current_user`, the scope and the limits must be unchanged.
6. **End.** Always `ROLLBACK`.

Queries are always sent over Postgres's extended protocol, which carries exactly one statement per message. So stacked statements (`…; COMMIT; DROP …`) can't run even if the parser were wrong. Nothing session-level is used, so nothing outlives the transaction on a pooled connection.

### 5.4 SQL validator (`sql-guard`)

Parser: `libpg-query` (the real Postgres grammar), pinned to the server's major version. Node types that aren't on the allow-list are rejected, so unanticipated constructs fail safe.

**Statement shape:**
- Exactly one statement, and it must be a `SELECT`. `WITH … SELECT` and `UNION`/`INTERSECT`/`EXCEPT` count.
- No data-modifying statement anywhere in the tree, including CTEs and subqueries.
- No `SELECT … INTO` and no locking clauses (`FOR UPDATE`/`SHARE`).

**Relations:**
- Only `reporting.*` views and the query's own CTE names.
- Nothing from `pg_catalog`, `information_schema`, `auth`, `storage`, `vault`, `net`, `extensions`, `cron` or `public`.

**Functions:**
- An allow-list only: aggregates, date and time, math, string, conditional and window functions.
- The list is checked on **every node type that can call a function**. That includes `FuncCall` and `RangeFunction` (a function used as a table); the reviewed Postgres MCP Pro bypass, CVE-2026-85620, used the latter.
- Never allowed, for example: `set_config`, `current_setting`, `pg_sleep*`, `pg_advisory*`, `pg_terminate_backend`, `pg_cancel_backend`, `pg_read_file`, `pg_ls_dir`, `lo_*`, `dblink*`, `http*`, `query_to_xml`/`table_to_xml`/`cursor_to_xml`, `nextval`/`setval`, `pg_notify`.

**Complexity:**
- No recursive CTEs in v1.
- Caps on nesting depth, joins and set operations.
- Every join needs a join condition, so there are no accidental cartesian products.

**Values:** values from the request must be bind parameters. Literal constants (`'month'`, `0`, `1`) are allowed.

**Relations:** must be schema-qualified. Unqualified names are accepted only for CTEs visible at that point, so a CTE can't shadow a catalog table outside its scope.

**Row limit:** enforced by the executor at the protocol level (§5.3), not by rewriting the query.

**Verdict:**
- On success: the unchanged text, a structural fingerprint, and the relations and functions used.
- On failure: machine-readable reasons with hints that name valid alternatives. These are fed back to stage 4 for repairs.

**Error messages:** Postgres errors can echo row values (a failed cast quotes the value). The executor reduces them to the error code and a safe message before they reach the LLM, as the row-data setting requires.

**Test suite:**
- Every bypass from the research: stacked `COMMIT;`, `pg_read_file` used as a table function, `COPY … TO PROGRAM`, `query_to_xml`, DML inside CTEs, `startsWith('SELECT')`-style tricks.
- Spencer-specific cases.

### 5.5 Prompt-injection defences

- **Fencing untrusted text:**
  - The request, schema comments and every value from the database are fenced as untrusted data, with a boundary their author can't know.
    - Per call, the boundary is random.
    - In the cached prefix (the schema), it is the hash of the fenced text, which keeps the prefix byte-identical so that it can be cached.
  - The fence sits below a note on which instructions take precedence. This is beep-server's pattern, rewritten.
- **No tools, no control:**
  - No LLM stage has tools.
  - Every output is structured and checked by code.
  - The LLM never chooses the role, the scope, the limits or any flags.
- **Narrative limits:** the narrative can't introduce numbers (the grounding check) or links.

### 5.6 Output safety

- PDFs are rendered with no network access.
  - Charts are drawn on the server, and links are stripped (or allow-listed).
  - All text is escaped.
- PDFs from the app are generated on request, after an RLS check, and sent with `Cache-Control: private, no-store`.
- Scheduled runs store their PDF in a private bucket at `{group_id}/{run_id}.pdf`. Downloads use signed URLs that expire within 5 minutes.

### 5.7 Abuse limits

- **Spend:**
  - A per-run LLM budget (default $0.50) and a daily one (default $5), both checked before every call.
  - A per-user rate limit of 20 runs per hour.
- **Time:**
  - Each LLM attempt has its own cancellable deadline, and each stage has a timeout.
  - The whole run is limited to 280 s, inside Vercel's 300 s.

## 6. LLM layer

**Provider interface.** `core` owns an `LlmProvider` interface:

```
generate({ stage, cachePrefix, system, input, schema, effort, maxTokens, timeoutMs, signal })
  → { ok: true, output, calls } | { ok: false, error: { code, message }, calls }
```

`calls` holds one record per attempt (built in M2a).

**Anthropic adapter** (official `@anthropic-ai/sdk`, 1.7.0 or later):
- `claude-opus-5-5` runs every stage, with the effort set per stage: intent `low`, plan `high`, SQL `high`, narrative `medium`. Adaptive thinking is always on for this model.
- Every stage uses structured output. The answer is validated again with zod, because the API can't enforce string lengths or numeric ranges. The SDK has kept `enum` and `const` in the schema since 1.7.0.
- **Prompt caching:** the semantic model and the fixed instructions form a stable prefix, cached for 5 minutes by default (1 hour is an option).
  - The cache key also covers the model, the effort and the output schema, so the stages of one run don't share an entry.
  - The cache pays off when the same stage runs again within the TTL: a retry, a repair, the next question.
  - *Corrected in M2a:* this spec first assumed one 1-hour entry shared by every stage. On that assumption most input tokens would have been cache reads.
- Anthropic's server-side refusal fallback (`fallbacks: "default"`) is enabled.
- Requests don't stream. Answers are small JSON documents, and every attempt has a deadline. A non-streamed refusal fallback also returns only the final model's answer.

**Retry and fallback policy.** This is beep-server's pattern, rewritten without beep-server's global patching:
1. The SDK retries with backoff on 408, 409, 429, 5xx, connection errors and timeouts, a bounded number of times.
2. An empty, truncated (`max_tokens`) or schema-invalid answer counts as a failure and gets one more try on the same model. A truncated answer gets twice the room.
3. If it still fails, the same step runs on `claude-sonnet-5-5`.
4. If that fails too, the stage fails, and the run reports which stage failed and why. Refusals and other 4xx errors end the stage at once.

Each attempt has its own cancellable deadline, so the run's total time stays bounded.

**Usage and cost.** Each call records:
- input, output, cache-write and cache-read tokens
- the model requested and the model that served it, and any fallback reason
- latency, stop reason, request ID and error class
- time to first token, which stays empty while requests don't stream

Cost comes from a price table that includes cache pricing. beep-server's recorder ignored cache tokens.

**Budgets** are checked before every attempt, so spend can pass a limit by at most one attempt.

## 7. Data model (migration 0008)

| Table | Purpose | Key columns |
|---|---|---|
| `report_runs` | One row per run; the state machine | owner_id, group_id, template_id, trigger (interactive/scheduled), request, output_type, status, stage, intent, feasibility, plan, plan_hash, result (ReportDocument), error, totals (tokens, cost, duration), stage timings, timestamps |
| `report_queries` | One row per SQL attempt | run_id, section_id, attempt, source (llm/compiled), sql, fingerprint, summary, validation verdict, EXPLAIN cost, rows, truncated, duration, error, cross-check result |
| `report_llm_calls` | One row per LLM call | run_id, stage, attempt, model requested/served, fallback reason, effort, token counts including cache, cost, latency, time to first token, stop reason, request ID, error class |
| `report_templates` | Saved reports | owner_id, group_id, title, request, plan, plan_hash, SQL per section with date-window parameters, output_type, shared, schedule (daily/weekly/monthly, time, timezone), next_run_at, enabled, status (ok/needs_repair), last_run_id |
| `report_events` | Append-only audit log | actor_id, run_id or template_id, action (approve, reject, save, share, schedule, delete, download), redacted details, created_at |

- **RLS:**
  - Runs, queries, LLM calls and events are readable only by their owner.
  - Templates are readable by their owner, or by the household when shared.
- **Writes:**
  - No user can write these tables directly.
  - The server writes them with the service role (`SUPABASE_SECRET_KEY`), so logs can't be forged.
- **Retention:**
  - Run content (request, plan, results) is kept for 90 days.
  - Usage and cost rows and audit events are kept indefinitely.
  - A saved report keeps its latest result.
- **Never stored or logged:** database passwords, API keys, signed scopes, or result sets beyond the bounded snapshot.

## 8. Outputs

**`ReportDocument`** is versioned JSON containing:
- title, period, generation time and assumptions
- sections, each one of:
  - `kpi`: label, value, unit, delta
  - `table`: typed and formatted columns, rows, a truncated flag
  - `chart`: bar, line, pie or area, with x/y/series field mapping and units
  - `text`: narrative that references the figures it cites
- a verification badge per section (verified, unverified or truncated)
- a footer listing each query's plain-language summary

**In-app renderer** (spencer, `components/reports/`):
- One generic renderer per section type, built on `ChartContainer`, `Stat` and `formatMoney`.
- The existing domain charts are tied to their own data shapes, so they aren't reused directly.
- Tables scroll horizontally, because the layout is `max-w-md`.

**PDF renderer** (engine, `pdf/`):
- Uses `@react-pdf/renderer` 4.1 or later, the first version supporting React 19.
- Charts are drawn with its SVG primitives from the same chart spec, in the same colors as the app.

## 9. Spencer integration

**Pages:**
- `app/(app)/reports/page.tsx` has the request box, suggested reports from the semantic model, saved reports and recent runs.
- `app/(app)/reports/[runId]/page.tsx` shows, depending on the run's status:
  - a clarifying question
  - the plan for review, with Approve and Reject
  - progress
  - the finished report, with Download PDF, Save and Share

**Handlers** (under `app/api/`, because a route handler can't share a folder with a page):
- `POST reports/runs` creates a run and streams progress through stages 1–3.
- `POST reports/runs/[runId]/approve`, `/reject` and `/clarify`.
- `GET reports/runs/[runId]` returns status and progress.
- `GET reports/runs/[runId]/pdf` returns the PDF.
- `GET cron/reports` is the daily tick.

Execution continues in `after()`, so it survives a closed tab. Small mutations (save, share, schedule, delete) are server actions.

**Proxy:** exempt `/api/cron/reports` from the logged-out redirect to `/login` (`lib/supabase/proxy-session.ts:39-46`). Vercel Cron doesn't follow redirects, so without the exemption the job would silently do nothing. The route authenticates with `CRON_SECRET` and takes no input.

**Scheduled runs:**
- **Identity:** the identity comes from the saved report's owner.
- **Before each run:** the tick re-checks that the owner still exists, is still allow-listed and is still in the same household. If not, it disables the report.
- **How it runs:** it re-runs the saved SQL through stages 5–9 as the owner, with no planning and no approval.
- **After a schema change:** a report whose SQL no longer validates is marked `needs_repair`.
- **Duplicates:** due reports are claimed with `FOR UPDATE SKIP LOCKED` and deduplicated on `(template_id, scheduled_for)`, so a duplicate or late tick is harmless.

**Navigation:** a "Reports" entry in the user menu, next to "Monthly income" (`components/user-menu.tsx:143-150`). The bottom nav's three tabs stay as they are.

**Config (`reports.config.ts`):**
- Row data `capped`: at most 200 rows go to the LLM.
- Budgets.
- Model and effort per stage.
- Timezone.

**Environment:**
- `ANTHROPIC_API_KEY`
- `REPORTS_DATABASE_URL` (the pooler URL, as `reports_login`)
- `SUPABASE_SECRET_KEY`
- `CRON_SECRET`
- `REPORTS_SCOPE_KEY` (the same value is stored in Vault, §5.2)

**Types:** `types/database.ts` is updated for the new tables.

## 10. Observability

- **Run record.** Every run returns and stores a `RunRecord` containing:
  - per-stage status and timings
  - SQL, summaries and fingerprints
  - validation verdicts, plan cost and row counts
  - every LLM call's usage and cost, plus retries, fallbacks and errors
- **Logs.**
  - Structured JSON logs (on Vercel) carry `run_id` on every line.
  - They never contain row data, prompts or SQL literals.
- **Tracing.**
  - OpenTelemetry spans go through `@opentelemetry/api` only, so they do nothing unless the app registers an SDK.
  - They follow the GenAI and database conventions, with content capture off.
  - They're compatible with Langfuse, if wanted later.
- **Usage view.** The reports page shows runs, tokens and cost per day and month, measured against the $200 budget.

## 11. Testing

- **sql-guard:** a Vitest suite of allowed queries and attack payloads (§5.4). Spencer has no test runner yet, so Vitest is added.
- **Database:** Vitest tests in `tests/db` with **two households**. They apply every migration to a throwaway `postgres:17.6` container (production's version), using a Supabase-shaped stub for the platform roles, `auth`, `extensions` and Vault. They skip themselves when Docker isn't available. Today everyone joins the first household at sign-up (`supabase/migrations/0001_init.sql:151-154`), so isolation between households has never been tested. The tests check that:
  - `reports_reader` sees only its own household through every view
  - forged, expired and missing scopes return no rows, and so do forged claims
  - `reports_reader` can't name base tables at all while the public schema grants it nothing (it gets no `USAGE` on `public`; the views don't need it). Where `PUBLIC` keeps the Postgres default `USAGE` on `public`, direct reads still stay inside the scope and the granted columns, and the validator rejects them anyway.
  - write attempts fail, even in a read-write transaction
  - every view is `security_invoker`
  - the default grants are revoked, and `authenticated` can't update `profiles.group_id` (migration 0007)
- **Golden tests:** standard reports (spending by category for a month, income for a month, a year summary) must match `lib/reports.ts` exactly.
- **Pipeline:**
  - Recorded LLM responses (fixtures) mean the test suite costs nothing.
  - A small evaluation set of about 25 questions with known answers runs against the real models on demand, after the budget is agreed.

## 12. Cost estimate (Opus 5.5; to be measured)

Rough figures per interactive report. The schema prefix is about 4K tokens, roughly $0.02 per call uncached. It is cached per stage (§6), so within one run it is mostly written rather than read.

| Stage | Approximate cost |
|---|---|
| Intent | $0.02 |
| Plan | $0.10 |
| SQL | $0.10 |
| Narrative | $0.07 |
| Occasional repairs | $0.05 |
| **Total** | **about $0.25–0.50** |

- **Budget:** $200 covers roughly 400–800 interactive reports.
- **Scheduled re-runs** skip planning and SQL writing. They cost about $0.07 with a fresh narrative, or $0 without one.
- **Prices used:**
  - Opus 5.5: $4 / $20 per million input/output tokens, $0.20 for cache reads.
  - Sonnet 5.5: $2 / $10.

## 13. Build plan

| Milestone | Delivers | What you can do afterwards |
|---|---|---|
| Pre | Migration 0007: reset spencer's table grants (its own pull request) | Apply it and re-run the grants check |
| M0 | Workspace package, Vitest, lint boundary, draft of migration 0008 (you apply it) | Review the database design as SQL |
| M1 | sql-guard, executor, introspection, semantic-model generator, more database tests | Run a hand-written query safely end to end; review the generated model |
| M2 | LLM layer, stages 1–6, run state machine, API routes, a minimal `/reports` page with approval | Ask a question and see the SQL and raw results |
| M3 | Post-processing, cross-checks, compiler fallback, narrative, in-app renderer | Get a finished report in the app |
| M4 | PDF renderer and download | Download the PDF |
| M5 | Saved reports, sharing, daily schedule, the needs-repair flow | Save, share and schedule reports |
| M6 | Hardening pass, budgets, usage view, package README/LICENSE/SECURITY.md | Prepare for extraction |

## 14. Environment facts and prerequisites

Confirmed on 2026-11-16:
- **Hosting:** Vercel Hobby with Fluid compute on.
- **Postgres:** 17.6. `sql-guard` pins the Postgres 17 grammar, and `security_invoker` and `transaction_timeout` are both available.
- **Extensions:** `pg_stat_statements`, `pgcrypto`, `plpgsql`, `supabase_vault` and `uuid-ossp`. There's no `pg_net`, `dblink`, `http` or `pg_cron`, so a query has no way to make outbound requests.

Before building on the database:
1. Apply migration 0007 (the grants fix) and re-run the grants check.
2. When migration 0008 lands:
   - set the `reports_login` password in the dashboard
   - create the Vault secret
   - add the environment variables from §9 to Vercel
3. Before publishing, claim the `querybrief` npm org and GitHub name.
