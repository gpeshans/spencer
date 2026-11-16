import { describe, expect, it } from 'vitest';

import type { QueryOutcome } from '../pg';
import { buildVocabulary } from '../plan/vocabulary';
import { createSqlGuard } from '../sql-guard';
import { testModel } from '../testing/model';
import { MAX_LISTED_VALUES, readValues, valueQueries } from './values';

const model = testModel();
const vocabulary = buildVocabulary(model);

const listed = (id: string, values: string[], truncated: false | 'rows' = false): QueryOutcome => ({
  id,
  ok: true,
  columns: [{ name: 'value', type: 'text' }],
  rows: values.map((value) => ({ value })),
  truncated,
  cost: 1,
  fingerprint: 'f',
  durationMs: 1,
});

describe('valueQueries', () => {
  it('lists the values of every dimension except time, with quoted identifiers', () => {
    const queries = valueQueries(vocabulary);
    expect(queries.map((query) => query.id)).toEqual([
      'values.category',
      'values.bucket',
      'values.member',
      'values.income_category',
    ]);
    expect(queries[0]!.sql).toBe(
      'select distinct "category_label"::text as value from "reporting"."spendings" ' +
        `where "category_label" is not null order by value limit ${MAX_LISTED_VALUES + 1}`,
    );
  });

  it('passes the same SQL guard as LLM-written SQL', async () => {
    const guard = createSqlGuard({ relations: model.relations.map((relation) => relation.name) });
    for (const query of valueQueries(vocabulary)) {
      const verdict = await guard.check(query.sql, { paramCount: 0 });
      expect(verdict, query.id).toMatchObject({ ok: true });
    }
  });
});

describe('readValues', () => {
  it('keeps the values of each dimension that could be listed', () => {
    const values = readValues(vocabulary, [
      listed('values.category', ['Groceries', 'Rent']),
      listed('values.bucket', ['needs'], 'rows'),
      listed('values.member', Array.from({ length: MAX_LISTED_VALUES + 1 }, (_, index) => `m${index}`)),
      { id: 'values.income_category', ok: false, error: { code: 'timeout', message: 'slow' }, durationMs: 5 },
    ]);
    expect(values).toEqual({ category: ['Groceries', 'Rent'] });
  });
});
