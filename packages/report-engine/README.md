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
