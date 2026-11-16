# report-engine

Conversational, read-only reports over Postgres and Supabase. A request in plain language becomes a plan, then SQL that is checked and run under the requesting user's own data permissions, then a report rendered for a UI or as a PDF.

This is the working copy inside spencer. It is meant to be published as `querybrief` under Apache-2.0. The design is in [`docs/report-engine-spec.md`](../../docs/report-engine-spec.md).

## Rules for this package

- **Standalone.** Nothing here imports spencer code (`@/…`); a lint rule enforces it. Spencer depends on the engine, never the other way round, so the package can move to its own repo unchanged.
- **Tests.** `npm test` here runs the unit tests. Spencer's `npm test` also runs the database tests in `tests/db/` against a throwaway local Postgres (Docker).

## What's here so far (M0)

- `core/run-status.ts`: the run lifecycle. It must match the `report_runs.status` check constraint (spencer migration 0008).
- `supabase/signed-scope.ts`: signs the `reports.scope` value that the database function `reporting.scope_group_id()` verifies.
- `sql-guard/` (M1a): checks LLM-written SQL with the real Postgres 17 parser (`libpg-query`) before it runs.
  - **Allowed:** exactly one `SELECT`, reading only allow-listed, schema-qualified relations or CTEs in scope, and using only allow-listed functions, types and operators.
  - **Rejected:** any parse-tree node type not on the allow-list, plus over-complex queries.
  - **Output:** the original text, a structural fingerprint, and issues that name the valid alternatives.
- `pg/` (M1b): the executor (`createPgExecutor`). It runs guard-approved SQL for one report:
  - **Envelope:** one `REPEATABLE READ READ ONLY` transaction that always rolls back, under `SET LOCAL ROLE`, with limits and the guard's session settings (`search_path = pg_catalog`, `standard_conforming_strings = on`).
  - **Scope:** the signed scope is set, then verified.
  - **Per query:** a savepoint, an `EXPLAIN` cost gate, a protocol-level row cap, a byte cap, and a tripwire that aborts and discards everything if the session changes.
  - **Errors:** structured, and data errors never echo row values.
  - **Values:** typed by column. Dates and timestamps stay as server text; numerics become numbers only when exact.
- `semantic/` (M1c): the semantic model, stage 0.
  - **`introspect`** reads what the reporting role can see in the reporting schemas. It also flags every way a query could read past RLS: views without `security_invoker`, materialized views, foreign tables, tables without RLS, owner-rights views or unprotected tables behind the views, and untrusted `SECURITY DEFINER` functions.
  - **`buildSemanticModel`** regenerates the relations and `schemaHash`, keeps the curated sections (metrics, dimensions, synonyms, examples, suggested reports), and checks them with `sql-guard`.
  - **`checkFreshness`** detects a stale model.
- `llm/` (M2a): the LLM layer. `LlmProvider.generate()` returns a validated answer or a typed failure, plus a record of every attempt.
  - **Anthropic adapter** (`createAnthropicProvider`), on the official SDK:
    - Claude Opus 5.5 with adaptive thinking and the effort set per stage.
    - Structured output, validated again with zod, because the API can't enforce lengths or numeric ranges.
    - A cached prefix, and Anthropic's server-side refusal fallback.
  - **Retries and fallback:**
    - The SDK retries transient errors.
    - A truncated, empty or invalid answer gets one more try.
    - After that, the step moves on to Claude Sonnet 5.5.
    - Refusals and other 4xx errors end the call.
  - **Records:** each attempt carries tokens (cache reads and writes included), cost from a price table, latency, stop reason, request ID, error class and fallback reason. They are shaped for `report_llm_calls`.
  - **Budgets:** a `SpendGuard` is asked before every attempt. `createRunBudget` gives the per-run limit; `allGuards` combines it with a daily one.
  - **Hooks:** the guard and `onCall` belong to the provider, so create one provider per run when they are run-scoped. That is cheap: the SDK client is light and `fetch` pools connections.
- `plan/` (M2b): what a request or a plan may name, and the structured query.
  - **`buildVocabulary`** takes the names from the semantic model: metrics and dimensions per view, the date that periods and grain apply to, and the columns a listing may show (identifiers are left out).
  - **The structured query** has two shapes: `aggregate` (metrics by dimensions and a time grain) and `rows` (a listing).
    - The LLM writes it as one flat object, **`queryDraftSchema`**. Every name in it is a schema enum, so the API lets the LLM choose only names that exist.
    - **`toStructuredQuery`** then checks that the names fit the view. The API allows at most 16 union-typed fields per request, and a union of one variant per view would grow with every view.
    - `checkQuery` checks what the schema can't express.
- `prompt/` (M2b): `cachePrefix` (the rules, then the fenced semantic model) and `fence`.
  - A fence ends in a boundary that the text's author can't know.
  - The boundary is random per call, except in the cached prefix, which must stay byte-identical: there it is the hash of the fenced text.
- `stages/` (M2b): stage 1.
  - **`valueQueries` / `readValues`** read each dimension's values in the household's data, e.g. its category names. They use code-built SQL that passes sql-guard, through the executor.
  - **`intentRequest`** asks the LLM for an Intent at low effort.
  - **`checkIntent`** then decides what happens next:
    - It refuses writes and out-of-scope questions.
    - It asks a clarifying question for open choices, unknown values (offering the nearest matches) or dimensions that don't fit the figure.
    - Otherwise it returns the intent with values spelled the way the household spells them.
