/**
 * spencer's settings for the report engine (docs/report-engine-spec.md §9).
 * Secrets are not here: they come from the environment (lib/reports/env.ts).
 */
export const reportsConfig = {
  /** The semantic model and what it's introspected from (stage 0). */
  model: {
    path: 'supabase/reporting/semantic-model.json',
    schemas: ['reporting'],
    role: 'reports_reader',
    /** SECURITY DEFINER by design: it verifies the signed scope (migration 0008). */
    trustedFunctions: ['reporting.scope_group_id'],
  },
  /** The signed household scope (migration 0008). */
  scope: {
    setting: 'reports.scope',
    verifySql: 'select reporting.scope_group_id()::text as tenant_id',
  },
  /** Spend and abuse limits (spec §5.7). */
  limits: {
    /** LLM spend per run, across its requests. */
    runUsd: 0.5,
    /** LLM spend over the last 24 hours, across the household: the API key is shared. */
    dailyUsd: 5,
    /** New runs per person per hour. */
    runsPerHour: 20,
  },
  /** Spencer shows the household's category, bucket and member names to the LLM (decided 2026-11-16). */
  shareValues: true,
  /** How often the report page polls a run that is working without a stream. */
  pollMs: 2000,
} as const;
