import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../core/canonical';
import { priceOf } from '../llm';
import type { AggregateQuery } from '../plan/query';
import { buildVocabulary } from '../plan/vocabulary';
import { testModel } from '../testing/model';
import { countUnions } from '../testing/schema';
import type { Intent } from './intent';
import {
  approvalReasons,
  checkPlan,
  estimateRemainingCost,
  planHash,
  planRequest,
  planSchema,
  renderPlanInput,
  toPlanDraft,
  type PlanSection,
  type ReportPlan,
} from './plan';

const vocabulary = buildVocabulary(testModel());
const values = { category: ['Groceries', 'Rent'], bucket: ['needs'], member: ['Alex'], income_category: ['Salary'] };
const OCTOBER = { from: '2026-10-01', to: '2026-11-01' };

const spend = (fields: Partial<AggregateQuery> = {}): AggregateQuery => ({
  shape: 'aggregate',
  relation: 'reporting.spendings',
  metrics: ['spend'],
  dimensions: [],
  grain: null,
  filters: [],
  period: OCTOBER,
  sort: [],
  limit: null,
  ...fields,
});

const section = (fields: Partial<PlanSection> & Pick<PlanSection, 'id'>): PlanSection => ({
  title: fields.id,
  purpose: 'Shows it.',
  display: 'table',
  query: spend(),
  essential: true,
  ...fields,
});

function plan(fields: Partial<ReportPlan> = {}): ReportPlan {
  return {
    title: 'October spending',
    summary: 'Spending in October, by category.',
    sections: [
      section({ id: 'total', display: 'figure' }),
      section({
        id: 'by_category',
        display: 'bar',
        query: spend({ dimensions: ['category'], sort: [{ by: 'spend', direction: 'desc' }] }),
      }),
    ],
    derived: [{ id: 'share', kind: 'share_of_total', label: 'Share', section: 'by_category', metric: 'spend', against: null }],
    crossChecks: [{ kind: 'sums_to', parts: 'by_category', total: 'total', metric: 'spend' }],
    ...fields,
  };
}

const check = (value: ReportPlan) => checkPlan(toPlanDraft(value), { vocabulary, values });
const issuesOf = (value: ReportPlan) => {
  const verdict = check(value);
  return verdict.verdict === 'invalid' ? verdict.issues : [];
};

describe('planSchema', () => {
  it('accepts a plan whose queries name only what the model has', () => {
    const schema = planSchema(vocabulary);
    expect(schema.safeParse(toPlanDraft(plan())).success).toBe(true);
    const broken = plan({ sections: [section({ id: 'x', query: spend({ metrics: ['profit'] }) })] });
    expect(schema.safeParse(toPlanDraft(broken)).success).toBe(false);
  });

  it('converts to a JSON schema well under the API limit of 16 union-typed fields', () => {
    const json = betaZodOutputFormat(planSchema(vocabulary)).schema as Record<string, unknown>;
    expect(JSON.stringify(json)).toContain('"enum":["figure","table","bar","line","pie","text"]');
    expect(JSON.stringify(json)).toContain('"reporting.spendings"');
    // A section's period (a range, or null) and a derived value's other side (or null).
    expect(countUnions(json)).toBe(2);
  });
});

describe('the plan prompt', () => {
  const intent: Intent = {
    kind: 'breakdown',
    restated: 'Spending per category in October.',
    metrics: ['spend'],
    dimensions: ['category'],
    grain: null,
    filters: [],
    period: OCTOBER,
    comparison: null,
    assumptions: [],
    ambiguities: [],
    confidence: 'high',
    refusal: null,
  };
  const feasibility = {
    status: 'partial' as const,
    coverage: [{ relation: 'reporting.spendings', first: '2026-10-12', last: '2026-11-15', rows: 9, comparisonRows: null }],
    gaps: ['reporting.spendings has data only from 2026-10-12.'],
    alternatives: [],
  };
  const boundary = 'd'.repeat(16);

  it('fences the intent, the coverage, the values, the request and any issues', () => {
    const text = renderPlanInput(
      { request: 'Spending by category in October', intent, feasibility, values, today: '2026-11-16', timeZone: 'Europe/Berlin', issues: ['total: a figure is an aggregate with no dimensions and no grain'] },
      boundary,
    );
    for (const label of ['intent', 'coverage', 'values', 'request', 'issues']) {
      expect(text).toContain(`<untrusted-${label}-${boundary}>`);
    }
    expect(text).toContain('reporting.spendings: 9 rows in the period, data from 2026-10-12 to 2026-11-15');
    expect(text).toContain('Gap: reporting.spendings has data only from 2026-10-12.');
    expect(text).toContain('Your previous plan had these problems.');
  });

  it('runs at high effort and leaves the values out when they are not shared', () => {
    const request = planRequest(vocabulary, 'PREFIX', {
      request: 'x',
      intent,
      feasibility,
      values: null,
      today: '2026-11-16',
      timeZone: 'Europe/Berlin',
    });
    expect(request).toMatchObject({ stage: 'plan', effort: 'high', cachePrefix: 'PREFIX' });
    expect(request.input).not.toContain('untrusted-values');
  });
});

describe('checkPlan', () => {
  it('accepts a sound plan', () => {
    expect(check(plan())).toEqual({ verdict: 'ok', plan: plan(), unchecked: [] });
  });

  it('lists sections without a structured query, and spells filter values as the household does', () => {
    const verdict = check(
      plan({
        sections: [
          section({ id: 'groceries', display: 'figure', query: spend({ filters: [{ dimension: 'category', op: 'in', values: ['groceries'] }] }) }),
          section({ id: 'odd_one', display: 'table', query: null, purpose: 'Days with more than 100 spent.' }),
          section({ id: 'note', display: 'text', query: null }),
        ],
        derived: [],
        crossChecks: [],
      }),
    );
    expect(verdict.verdict).toBe('ok');
    if (verdict.verdict !== 'ok') return;
    expect(verdict.unchecked).toEqual(['odd_one']);
    expect((verdict.plan.sections[0]!.query as AggregateQuery).filters[0]!.values).toEqual(['Groceries']);
  });

  it('spells the filters of a listing as the household does, when they filter a dimension column', () => {
    const listing = section({
      id: 'groceries_list',
      display: 'table',
      query: {
        shape: 'rows',
        relation: 'reporting.spendings',
        columns: ['spent_on', 'description', 'amount'],
        filters: [
          { column: 'category_label', op: 'in', values: ['groceries'] },
          { column: 'description', op: 'contains', values: ['bread'] },
        ],
        period: OCTOBER,
        sort: [],
        limit: 20,
      },
    });
    const verdict = check(plan({ sections: [listing], derived: [], crossChecks: [] }));
    expect(verdict.verdict).toBe('ok');
    if (verdict.verdict !== 'ok') return;
    const query = verdict.plan.sections[0]!.query;
    expect(query?.shape === 'rows' && query.filters.map((filter) => filter.values)).toEqual([['Groceries'], ['bread']]);

    const unknown = { ...listing, query: { ...listing.query!, filters: [{ column: 'category_label', op: 'eq', values: ['Fuel'] }] } };
    expect(issuesOf(plan({ sections: [unknown as PlanSection], derived: [], crossChecks: [] }))).toEqual([
      'groceries_list: there is no category called "Fuel"',
    ]);
  });

  it('checks ids, queries and filter values', () => {
    expect(issuesOf(plan({ sections: [section({ id: 'a' }), section({ id: 'a' })], derived: [], crossChecks: [] }))).toEqual([
      'section id a is used twice',
    ]);
    expect(issuesOf(plan({ sections: [section({ id: 'Bad Id' })], derived: [], crossChecks: [] }))).toEqual([
      'section id "Bad Id" must be lowercase letters, digits and _',
    ]);
    expect(
      issuesOf(plan({ sections: [section({ id: 'x', query: spend({ metrics: ['monthly_income'] }) })], derived: [], crossChecks: [] })),
    ).toEqual(['x: metric monthly_income is not computed over reporting.spendings']);
    expect(
      issuesOf(
        plan({
          sections: [section({ id: 'x', query: spend({ filters: [{ dimension: 'category', op: 'in', values: ['Fuel'] }] }) })],
          derived: [],
          crossChecks: [],
        }),
      ),
    ).toEqual(['x: there is no category called "Fuel"']);
  });

  it('checks that each display fits its query', () => {
    const only = (value: PlanSection) => issuesOf(plan({ sections: [value], derived: [], crossChecks: [] }));
    expect(only(section({ id: 'x', display: 'text' }))).toEqual(['x: a text section has no query']);
    expect(only(section({ id: 'x', display: 'figure', query: spend({ dimensions: ['category'] }) }))).toEqual([
      'x: a figure is an aggregate with no dimensions and no grain',
    ]);
    expect(only(section({ id: 'x', display: 'line' }))).toEqual(['x: a line chart needs an aggregate with a grain']);
    expect(only(section({ id: 'x', display: 'line', query: spend({ grain: 'month' }) }))).toEqual([]);
    expect(only(section({ id: 'x', display: 'bar' }))).toEqual([
      'x: a bar chart needs an aggregate grouped by a dimension or a grain',
    ]);
    expect(only(section({ id: 'x', display: 'pie', query: spend({ dimensions: ['category'], metrics: ['spend', 'expense_count'] }) }))).toEqual([
      'x: a pie chart shows exactly one metric',
    ]);
  });

  it('checks derived values against the sections they use', () => {
    const derivedIssues = (derived: ReportPlan['derived']) => issuesOf(plan({ derived, crossChecks: [] }));
    expect(derivedIssues([{ id: 'd', kind: 'share_of_total', label: 'x', section: 'nope', metric: 'spend', against: null }])).toEqual([
      'd: section nope must exist and have an aggregate query',
    ]);
    expect(derivedIssues([{ id: 'd', kind: 'share_of_total', label: 'x', section: 'total', metric: 'spend', against: null }])).toEqual([
      'd: section total has nothing to share out',
    ]);
    expect(derivedIssues([{ id: 'd', kind: 'change', label: 'x', section: 'by_category', metric: 'spend', against: null }])).toEqual([
      'd: change needs "against"',
    ]);
    expect(
      derivedIssues([
        { id: 'd', kind: 'difference', label: 'x', section: 'by_category', metric: 'spend', against: { section: 'total', metric: 'spend' } },
      ]),
    ).toEqual(['d: by_category and total must share their dimensions and grain']);
    expect(derivedIssues([{ id: 'total', kind: 'share_of_total', label: 'x', section: 'by_category', metric: 'spend', against: null }])).toEqual([
      'derived id "total" must be new and lowercase',
    ]);
  });

  it('checks that a breakdown and its total line up', () => {
    const crossIssues = (crossChecks: ReportPlan['crossChecks'], sections = plan().sections) =>
      issuesOf(plan({ sections, derived: [], crossChecks }));
    expect(crossIssues([{ kind: 'sums_to', parts: 'total', total: 'by_category', metric: 'spend' }])).toEqual([
      'cross-check total → by_category: total must be a breakdown',
      'cross-check total → by_category: by_category must be a single total',
    ]);
    const september = plan().sections.map((entry) =>
      entry.id === 'total' ? { ...entry, query: spend({ period: { from: '2026-09-01', to: '2026-10-01' } }) } : entry,
    );
    expect(crossIssues(plan().crossChecks, september)).toEqual([
      'cross-check by_category → total: both must cover the same period',
    ]);
  });
});

describe('planHash', () => {
  it('ignores key order and changes with the plan', () => {
    const reordered = JSON.parse(canonicalJson(plan())) as ReportPlan;
    const shuffled = Object.fromEntries(Object.entries(reordered).reverse()) as unknown as ReportPlan;
    expect(planHash(shuffled)).toBe(planHash(plan()));
    expect(planHash(plan({ title: 'Other' }))).not.toBe(planHash(plan()));
    expect(planHash(plan())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('cost and approval', () => {
  const opus = priceOf('claude-opus-5-5');

  it('estimates the rest of the run from the plan size', () => {
    const two = estimateRemainingCost(plan(), opus, 4000);
    // SQL: 4000 x $5 + (600 + 800) x $4 + (3000 + 1400) x $20, plus a quarter for repairs.
    // Narrative: 4000 x $5 + (600 + 600) x $4 + (1500 + 400) x $20. All per million.
    expect(two).toBeCloseTo(((20_000 + 5_600 + 88_000) * 1.25 + (20_000 + 4_800 + 38_000)) / 1_000_000, 10);
    const five = plan({ sections: ['a', 'b', 'c', 'd', 'e'].map((id) => section({ id })) });
    expect(estimateRemainingCost(five, opus, 4000)).toBeGreaterThan(two);
  });

  it('asks for approval on flags, more than four sections, or a cost over the budget left', () => {
    const base = { flags: [], plan: plan(), estimateUsd: 0.2, remainingUsd: 0.4 };
    expect(approvalReasons(base)).toEqual([]);
    expect(approvalReasons({ ...base, flags: ['Low confidence.'] })).toEqual(['Low confidence.']);
    const five = plan({ sections: ['a', 'b', 'c', 'd', 'e'].map((id) => section({ id })) });
    expect(approvalReasons({ ...base, plan: five })).toEqual(['The plan has 5 sections, more than 4.']);
    expect(approvalReasons({ ...base, estimateUsd: 0.45 })).toEqual([
      'The rest of the run is estimated at $0.45, more than the $0.40 left in its budget.',
    ]);
  });
});
