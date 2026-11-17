import { newRun, type RunState, type SemanticModel } from 'report-engine';
import { buildVocabulary } from 'report-engine/report';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { todayISO } from '@/lib/format';
import modelFile from '@/supabase/reporting/semantic-model.json';

/**
 * The PDF route end to end, with the real report builder and PDF renderer;
 * only the session, the stored run and the household's styles are stand-ins.
 */

const session = vi.hoisted(() => ({ profile: null as unknown }));
const store = vi.hoisted(() => ({ loadRun: vi.fn() }));

vi.mock('@/lib/session', () => ({ getProfile: async () => session.profile }));
vi.mock('@/lib/reports/store', () => store);
vi.mock('@/lib/reports/presentation', () => {
  const { relations, metrics, dimensions } = buildVocabulary(modelFile as unknown as SemanticModel);
  return { reportPresentation: async () => ({ vocabulary: { relations, metrics, dimensions }, styles: { category: { Groceries: { color: '#2f9e44' } } } }) };
});

const { GET } = await import('@/app/api/reports/runs/[runId]/pdf/route');

const RUN_ID = '3f0c7a52-6b1e-4d2a-9c8e-1b2a3c4d5e6f';
const supabase = { from: () => undefined };
const OCTOBER = { from: '2026-10-01', to: '2026-11-01' };

const finished = (status: RunState['status']): RunState => ({
  ...newRun(RUN_ID, 'How much did we spend per category in October?'),
  status,
  plan: {
    title: 'October spending',
    summary: 'Spending per category in October.',
    sections: [
      {
        id: 'by_category',
        title: 'By category',
        purpose: 'Where the money went.',
        display: 'bar',
        query: { shape: 'aggregate', relation: 'reporting.spendings', metrics: ['spend'], dimensions: ['category'], grain: null, filters: [], period: OCTOBER, sort: [], limit: null },
        essential: true,
      },
    ],
    derived: [],
    crossChecks: [],
  },
  results: [
    {
      section: 'by_category',
      status: 'ok',
      sql: 'select 1',
      params: [],
      summary: 'Spend per category.',
      columns: [
        { name: 'category', type: 'text' },
        { name: 'spend', type: 'number' },
      ],
      rows: [{ category: 'Groceries', spend: 412.5 }],
      truncated: false,
      attempts: 1,
      problems: [],
    },
  ],
});

const get = (runId = RUN_ID) => GET(new Request(`http://localhost/api/reports/runs/${runId}/pdf`), { params: Promise.resolve({ runId }) });
const errorOf = async (response: Response) => ({ status: response.status, ...((await response.json()) as { error: { code: string; message: string } }).error });

beforeEach(() => {
  session.profile = { supabase, user: { id: 'user-1' }, profile: { group_id: 'group-1' } };
  store.loadRun.mockReset();
});

describe('GET /api/reports/runs/[runId]/pdf', () => {
  it('asks a signed-out visitor to sign in', async () => {
    session.profile = null;
    expect(await errorOf(await get())).toMatchObject({ status: 401, code: 'unauthorized' });
    expect(store.loadRun).not.toHaveBeenCalled();
  });

  it("finds no run behind a bad id, or someone else's run", async () => {
    expect(await errorOf(await get('not-a-run'))).toMatchObject({ status: 404 });
    store.loadRun.mockResolvedValue(null);
    expect(await errorOf(await get())).toMatchObject({ status: 404, code: 'not_found' });
    // Read as the signed-in person, so RLS decides whose run it is.
    expect(store.loadRun).toHaveBeenCalledWith(supabase, RUN_ID);
  });

  it('has nothing to download before the run finishes', async () => {
    for (const status of ['planning', 'awaiting_approval', 'executing', 'failed', 'rejected'] as const) {
      store.loadRun.mockResolvedValue({ state: finished(status), updatedAt: '2026-11-17T09:00:00Z' });
      expect(await errorOf(await get())).toMatchObject({ status: 409, code: 'not_finished' });
    }
  });

  it('sends the finished report as a private PDF download', async () => {
    for (const status of ['succeeded', 'partial'] as const) {
      store.loadRun.mockResolvedValue({ state: finished(status), updatedAt: '2026-11-17T09:00:00Z' });
      const response = await get();
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/pdf');
      expect(response.headers.get('content-disposition')).toBe(`attachment; filename="october-spending-${todayISO()}.pdf"`);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      const pdf = Buffer.from(await response.arrayBuffer());
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      // Geist is embedded, not the built-in Helvetica.
      expect(pdf.toString('latin1')).toMatch(/\/FontName \/[A-Z]{6}\+Geist/);
    }
  });

  it("doesn't leak what went wrong inside", async () => {
    store.loadRun.mockRejectedValue(new Error('connection to db.internal:5432 refused'));
    const error = await errorOf(await get());
    expect(error.status).toBe(500);
    expect(error.message).not.toContain('db.internal');
  });
});
