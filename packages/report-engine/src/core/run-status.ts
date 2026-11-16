/**
 * Lifecycle of a report run (docs/report-engine-spec.md §4, "Run states").
 *
 * The list must match the check constraint on `public.report_runs.status`
 * (spencer migration 0008); a database test compares the two.
 */
export const RUN_STATUSES = [
  'received',
  'planning',
  'needs_clarification',
  'awaiting_approval',
  'executing',
  'succeeded',
  'partial',
  'failed',
  'rejected',
  'expired',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

const NEXT: { readonly [S in RunStatus]: readonly RunStatus[] } = {
  // Interactive runs plan first; scheduled runs re-run saved SQL directly.
  received: ['planning', 'executing', 'failed'],
  planning: ['needs_clarification', 'awaiting_approval', 'executing', 'failed'],
  // An answer sends the run back to planning; the user can also cancel it.
  needs_clarification: ['planning', 'rejected', 'expired', 'failed'],
  // Approval is the only way forward; there is no going back to planning.
  awaiting_approval: ['executing', 'rejected', 'expired'],
  // `partial`: some sections failed or could not be verified.
  executing: ['succeeded', 'partial', 'failed'],
  succeeded: [],
  partial: [],
  failed: [],
  rejected: [],
  expired: [],
};

export function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === 'string' && (RUN_STATUSES as readonly string[]).includes(value);
}

export function nextStatuses(from: RunStatus): readonly RunStatus[] {
  return NEXT[from];
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return NEXT[from].includes(to);
}

export function isTerminal(status: RunStatus): boolean {
  return NEXT[status].length === 0;
}
