import type { RunState, RunStatus } from 'report-engine';

/**
 * Status rules the server and the pages share. Types only from the engine, so
 * this module stays out of the way of page and browser bundles.
 */

/** Statuses in which a run is working, rather than waiting for someone or done. */
const WORKING: ReadonlySet<RunStatus> = new Set(['received', 'planning', 'executing']);

export const isWorking = (status: RunStatus) => WORKING.has(status);

/** The engine's terminal statuses (its isTerminal); a test keeps the two in step. */
export const FINISHED: readonly RunStatus[] = ['succeeded', 'partial', 'failed', 'rejected', 'expired'];

/**
 * A working run is saved at every stage, and the run deadline stops it well
 * inside the function's 300 s. A working run not saved for this long has lost
 * its function (a crash, a deploy, the platform's time limit) and won't move.
 */
export const STALLED_MS = 6 * 60_000;

/** A run as stored, with when it was last saved. */
export interface StoredRun {
  state: RunState;
  updatedAt: string;
}

export function isStalled(status: RunStatus, updatedAt: string, now: Date): boolean {
  return isWorking(status) && now.getTime() - Date.parse(updatedAt) > STALLED_MS;
}

/** The failed state for a run that has stalled, or null when it hasn't. */
export function stalledFailure({ state, updatedAt }: StoredRun, now: Date): RunState | null {
  if (!isStalled(state.status, updatedAt, now)) return null;
  return {
    ...state,
    status: 'failed',
    error: {
      stage: state.stage ?? (state.status === 'executing' ? 'writing_sql' : 'understanding'),
      code: 'stalled',
      message: 'The run stopped before it finished. Try again.',
    },
  };
}
