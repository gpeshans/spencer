/**
 * spencer's settings for the report engine (docs/report-engine-spec.md §9).
 * Budgets, row-data handling and the model per stage join this in M2.
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
} as const;
