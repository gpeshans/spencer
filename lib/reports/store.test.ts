import { newRun, type RunState } from 'report-engine';
import { describe, expect, it } from 'vitest';

import type { ReportRunRow } from '@/types/database';

import { fromRow, toRow } from './store';

const NOW = new Date('2026-11-16T10:00:00.000Z');

function fullState(fields: Partial<RunState> = {}): RunState {
  return {
    ...newRun('3f0c7a52-6b1e-4d2a-9c8e-1b2a3c4d5e6f', 'Spending per category last month'),
    status: 'awaiting_approval',
    stage: 'planning',
    clarifications: [{ question: 'Which month?', options: ['October'], answer: 'October', askedAt: NOW.toISOString() }],
    intent: {
      kind: 'breakdown',
      restated: 'Spending per category in October.',
      metrics: ['spend'],
      dimensions: ['category'],
      grain: null,
      filters: [],
      period: { from: '2026-10-01', to: '2026-11-01' },
      comparison: null,
      assumptions: [],
      ambiguities: [],
      confidence: 'high',
      refusal: null,
    },
    flags: ['The request was understood with low confidence.'],
    feasibility: { status: 'ok', coverage: [], gaps: [], alternatives: [] },
    plan: { title: 'October', summary: 'October spending.', sections: [], derived: [], crossChecks: [] },
    planHash: 'a'.repeat(64),
    unchecked: ['odd_one'],
    approval: { reasons: ['The plan has 5 sections, more than 4.'], estimateUsd: 0.21 },
    pendingUntil: '2026-11-17T10:00:00.000Z',
    results: null,
    error: null,
    usage: { inputTokens: 300, outputTokens: 120, cacheReadTokens: 4000, cacheWrite5mTokens: 4000, cacheWrite1hTokens: 0 },
    costUsd: 0.0312345678,
    stageTimings: { understanding: 1200, checking: 40, planning: 9000 },
    ...fields,
  };
}

/** The row Supabase would hand back after saving `state`. */
function rowOf(state: RunState): ReportRunRow {
  return {
    ...(toRow(state, NOW) as Required<ReturnType<typeof toRow>>),
    id: state.id,
    owner_id: 'owner',
    group_id: 'group',
    template_id: null,
    triggered_by: 'interactive',
    request: state.request,
    output_type: 'ui',
    scheduled_for: null,
    started_at: NOW.toISOString(),
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  } as ReportRunRow;
}

describe('toRow and fromRow', () => {
  it('store a run and read it back unchanged, with the cost rounded to the column', () => {
    const state = fullState();
    expect(fromRow(rowOf(state))).toEqual({ ...state, costUsd: 0.031235 });
  });

  it('keep the results and the failure', () => {
    const state = fullState({
      status: 'failed',
      stage: 'executing',
      results: [
        {
          section: 'total',
          status: 'failed',
          sql: 'select 1',
          params: [],
          summary: null,
          columns: [],
          rows: [],
          truncated: false,
          attempts: 3,
          problems: ['No SQL was written for this section.'],
        },
      ],
      error: { stage: 'executing', code: 'sections_failed', message: '1 of 1 sections failed.', details: ['total: …'] },
      pendingUntil: null,
    });
    expect(fromRow(rowOf(state))).toEqual({ ...state, costUsd: 0.031235 });
  });

  it("keep stage 7 and 8's outputs beside the results", () => {
    const state = fullState({
      status: 'succeeded',
      stage: null,
      pendingUntil: null,
      results: [
        {
          section: 'total',
          status: 'ok',
          sql: 'select …',
          params: [],
          summary: 'Spend.',
          columns: [{ name: 'spend', type: 'number' }],
          rows: [{ spend: 42 }],
          truncated: false,
          attempts: 1,
          problems: [],
          source: 'compiled',
          check: 'mismatch',
          mismatch: 'the total: spend 41, against 42',
        },
      ],
      derived: [{ id: 'left', kind: 'difference', label: 'Left', section: 'total', format: { kind: 'money' }, rows: [{ key: {}, value: 8 }], skipped: null }],
      checks: [{ kind: 'sums_to', parts: 'a', total: 'total', metric: 'spend', verdict: 'skipped', detail: 'section a couldn\'t be computed' }],
      narrative: { headline: ['You spent ', { value: 42, format: { kind: 'money' } }, '.'], insights: [] },
    });
    expect(fromRow(rowOf(state))).toEqual({ ...state, costUsd: 0.031235 });
  });

  it('read a row from before M3 with no derived values, checks or narrative', () => {
    const row = rowOf(fullState({ status: 'succeeded', results: [] }));
    const old = fromRow({ ...row, result: { sections: [] } });
    expect(old).toMatchObject({ results: [], derived: null, checks: null, narrative: null });
  });

  it('add the cache writes up into one column, and mark when a run finished', () => {
    const row = toRow(fullState({ usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWrite5mTokens: 10, cacheWrite1hTokens: 5 } }), NOW);
    expect(row.cache_write_tokens).toBe(15);
    expect(row.finished_at).toBeNull();
    expect(toRow(fullState({ status: 'succeeded' }), NOW).finished_at).toBe(NOW.toISOString());
  });

  it('read a fresh row as an empty run', () => {
    const fresh = newRun('3f0c7a52-6b1e-4d2a-9c8e-1b2a3c4d5e6f', 'x');
    expect(fromRow(rowOf(fresh))).toEqual(fresh);
  });
});
