import { describe, expect, it } from 'vitest';

import { buildSemanticModel, checkCurated, checkFreshness, schemaHash } from './build';
import type { Introspection } from './introspect';
import { parseSemanticModel, type SemanticModel } from './model';

const introspection: Introspection = {
  schemas: ['reporting'],
  relations: [
    {
      name: 'reporting.spendings',
      kind: 'view',
      description: 'One row per expense.',
      columns: [
        { name: 'spent_on', type: 'date', description: 'Date of the expense.' },
        { name: 'amount', type: 'numeric(12,2)' },
        { name: 'category_label', type: 'text' },
      ],
    },
  ],
  warnings: [],
};

const curated: Pick<SemanticModel, 'metrics' | 'dimensions' | 'columnUnits' | 'synonyms' | 'examples' | 'suggestedReports'> = {
  metrics: [
    { name: 'spend', description: 'Total spent.', relation: 'reporting.spendings', expression: 'sum(amount)', unit: 'currency' },
  ],
  dimensions: [
    { name: 'category', description: 'Spending category.', relation: 'reporting.spendings', column: 'category_label' },
  ],
  columnUnits: [{ relation: 'reporting.spendings', column: 'amount', unit: 'currency' }],
  synonyms: [{ term: 'expenses', means: 'the spend metric' }],
  examples: [
    {
      question: 'Spend by category since a date',
      sql: 'select category_label, sum(amount) from reporting.spendings where spent_on >= $1::date group by 1',
      params: ['2026-01-01'],
    },
  ],
  suggestedReports: [{ title: 'By category', request: 'Spending by category last month.' }],
};

const NOW = new Date('2026-11-16T12:00:00.000Z');

describe('schemaHash', () => {
  it('is stable for the same schema', () => {
    expect(schemaHash(introspection)).toBe(schemaHash(structuredClone(introspection)));
    expect(schemaHash(introspection)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when a comment, a column or a type changes', () => {
    const base = schemaHash(introspection);
    const commented = structuredClone(introspection);
    commented.relations[0]!.columns[1]!.description = 'Amount spent.';
    const retyped = structuredClone(introspection);
    retyped.relations[0]!.columns[1]!.type = 'numeric';
    expect(schemaHash(commented)).not.toBe(base);
    expect(schemaHash(retyped)).not.toBe(base);
  });

  it('ignores warnings', () => {
    const withWarnings: Introspection = { ...introspection, warnings: ['something'] };
    expect(schemaHash(withWarnings)).toBe(schemaHash(introspection));
  });
});

describe('buildSemanticModel', () => {
  it('starts empty curated sections for a new model', async () => {
    const { model, problems } = await buildSemanticModel({ introspection, now: NOW });
    expect(model).toMatchObject({ version: 1, generatedAt: NOW.toISOString(), schemaHash: schemaHash(introspection) });
    expect(model.metrics).toEqual([]);
    expect(problems).toEqual([]);
  });

  it('keeps curated sections, and the date when nothing changed', async () => {
    const first = await buildSemanticModel({ introspection, now: NOW });
    const previous = { ...first.model, ...curated };
    const { model, problems } = await buildSemanticModel({
      introspection,
      previous,
      now: new Date('2027-01-01T00:00:00.000Z'),
    });
    expect(model).toEqual(previous);
    expect(problems).toEqual([]);
  });

  it('dates a rebuild whose relations changed, and still keeps curated sections', async () => {
    const previous = { ...(await buildSemanticModel({ introspection, now: NOW })).model, ...curated };
    const changed = structuredClone(introspection);
    changed.relations[0]!.columns.push({ name: 'bucket', type: 'text' });
    const later = new Date('2027-01-01T00:00:00.000Z');
    const { model } = await buildSemanticModel({ introspection: changed, previous, now: later });
    expect(model.generatedAt).toBe(later.toISOString());
    expect(model.schemaHash).toBe(schemaHash(changed));
    expect(model.metrics).toEqual(curated.metrics);
    expect(model.columnUnits).toEqual(curated.columnUnits);
  });

  it('reads a model file written before column units existed', async () => {
    const { columnUnits, ...older } = { ...(await buildSemanticModel({ introspection, now: NOW })).model, ...curated };
    expect(columnUnits).toHaveLength(1);
    expect(parseSemanticModel(JSON.parse(JSON.stringify(older))).columnUnits).toEqual([]);
  });

  it('passes introspection warnings through', async () => {
    const { warnings } = await buildSemanticModel({ introspection: { ...introspection, warnings: ['w'] }, now: NOW });
    expect(warnings).toEqual(['w']);
  });
});

describe('checkCurated', () => {
  const base = async () => ({ ...(await buildSemanticModel({ introspection, now: NOW })).model, ...curated });

  it('finds curated entries that no longer fit', async () => {
    const model = await base();
    model.metrics = [
      ...model.metrics,
      { name: 'spend', description: 'Again.', relation: 'reporting.spendings', expression: 'count(*)', unit: 'count' },
      { name: 'gone', description: 'Old view.', relation: 'reporting.gone', expression: 'count(*)', unit: 'count' },
      { name: 'sleepy', description: 'Not allowed.', relation: 'reporting.spendings', expression: 'pg_sleep(1)', unit: 'number' },
    ];
    model.dimensions = [
      ...model.dimensions,
      { name: 'member', description: 'Who.', relation: 'reporting.spendings', column: 'member_name' },
    ];
    model.columnUnits = [
      ...model.columnUnits,
      { relation: 'reporting.spendings', column: 'amount', unit: 'number' },
      { relation: 'reporting.gone', column: 'amount', unit: 'currency' },
      { relation: 'reporting.spendings', column: 'tip', unit: 'currency' },
      { relation: 'reporting.spendings', column: 'category_label', unit: 'currency' },
    ];
    model.examples = [...model.examples, { question: 'Secrets', sql: 'select * from vault.decrypted_secrets', params: [] }];

    const problems = await checkCurated(model);
    expect(problems).toEqual([
      'metric spend is defined twice.',
      'metric gone: reporting.gone is not a readable relation.',
      'metric sleepy: pg_sleep() is not allowed.',
      'dimension member: reporting.spendings has no column member_name.',
      'column unit reporting.spendings.amount is defined twice.',
      'column unit reporting.gone.amount: reporting.gone is not a readable relation.',
      'column unit reporting.spendings.tip: reporting.spendings has no column tip.',
      'column unit reporting.spendings.category_label: text is not a number type.',
      'example 2 ("Secrets"): vault.decrypted_secrets is not readable.',
    ]);
  });
});

describe('checkFreshness', () => {
  it('compares the model with the database', async () => {
    const { model } = await buildSemanticModel({ introspection, now: NOW });
    expect(checkFreshness(model, introspection).fresh).toBe(true);
    const changed = structuredClone(introspection);
    changed.relations[0]!.description = 'Changed.';
    expect(checkFreshness(model, changed)).toMatchObject({ fresh: false, model: model.schemaHash });
  });
});

describe('parseSemanticModel', () => {
  it('fills defaults and explains invalid files', async () => {
    const { model } = await buildSemanticModel({ introspection, now: NOW });
    const { version, generatedAt, schemaHash: hash, schemas, relations } = model;
    expect(parseSemanticModel({ version, generatedAt, schemaHash: hash, schemas, relations }).examples).toEqual([]);
    expect(() => parseSemanticModel({ ...model, schemaHash: 'nope' })).toThrow(/schemaHash/);
  });
});
