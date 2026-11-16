import { describe, expect, it } from 'vitest';

import {
  RUN_STATUSES,
  canTransition,
  isRunStatus,
  isTerminal,
  nextStatuses,
  type RunStatus,
} from './run-status';

const TERMINAL: RunStatus[] = ['succeeded', 'partial', 'failed', 'rejected', 'expired'];

function reachableFrom(start: RunStatus): Set<RunStatus> {
  const seen = new Set<RunStatus>([start]);
  const queue: RunStatus[] = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of nextStatuses(current)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

describe('run status lifecycle', () => {
  it('has exactly the documented terminal statuses', () => {
    expect(RUN_STATUSES.filter(isTerminal)).toEqual(TERMINAL);
  });

  it('reaches every status from received', () => {
    expect([...reachableFrom('received')].sort()).toEqual([...RUN_STATUSES].sort());
  });

  it('lets every non-terminal status reach a terminal one', () => {
    for (const status of RUN_STATUSES.filter((s) => !isTerminal(s))) {
      const reachable = reachableFrom(status);
      expect(TERMINAL.some((t) => reachable.has(t)), status).toBe(true);
    }
  });

  it('only moves forward from approval', () => {
    expect(canTransition('awaiting_approval', 'executing')).toBe(true);
    expect(canTransition('awaiting_approval', 'planning')).toBe(false);
    expect(canTransition('executing', 'awaiting_approval')).toBe(false);
  });

  it('never leaves a terminal status', () => {
    for (const from of TERMINAL) {
      for (const to of RUN_STATUSES) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it('recognises valid status strings only', () => {
    expect(isRunStatus('executing')).toBe(true);
    expect(isRunStatus('EXECUTING')).toBe(false);
    expect(isRunStatus(undefined)).toBe(false);
  });
});
