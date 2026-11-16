import { isTerminal, newRun, RUN_STATUSES, type RunState } from 'report-engine';
import { describe, expect, it } from 'vitest';

import { FINISHED, isStalled, STALLED_MS, stalledFailure } from './status';

const NOW = new Date('2026-11-16T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const run = (fields: Partial<RunState>): RunState => ({ ...newRun('3f0c7a52-6b1e-4d2a-9c8e-1b2a3c4d5e6f', 'x'), ...fields });

describe('FINISHED', () => {
  it("matches the engine's terminal statuses", () => {
    for (const status of RUN_STATUSES) expect(FINISHED.includes(status), status).toBe(isTerminal(status));
  });
});

describe('stalledFailure', () => {
  it('fails a working run that has not been saved for too long, at the stage it reached', () => {
    const stalled = stalledFailure({ state: run({ status: 'executing', stage: 'validating' }), updatedAt: ago(STALLED_MS + 1) }, NOW);
    expect(stalled).toMatchObject({
      status: 'failed',
      error: { stage: 'validating', code: 'stalled', message: 'The run stopped before it finished. Try again.' },
    });
    expect(stalledFailure({ state: run({ status: 'executing' }), updatedAt: ago(STALLED_MS + 1) }, NOW)?.error?.stage).toBe(
      'writing_sql',
    );
  });

  it('leaves runs that were saved recently, or are waiting or done', () => {
    expect(stalledFailure({ state: run({ status: 'planning' }), updatedAt: ago(STALLED_MS) }, NOW)).toBeNull();
    expect(isStalled('awaiting_approval', ago(STALLED_MS * 10), NOW)).toBe(false);
    expect(isStalled('succeeded', ago(STALLED_MS * 10), NOW)).toBe(false);
    expect(isStalled('received', ago(STALLED_MS * 10), NOW)).toBe(true);
  });
});
