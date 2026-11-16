import { parseSemanticModel, type SemanticModel } from '../semantic';

/** A small semantic model for unit tests: expenses, monthly income and categories. */
export function testModel(): SemanticModel {
  return parseSemanticModel({
    version: 1,
    generatedAt: '2026-11-16T12:00:00.000Z',
    schemaHash: 'a'.repeat(64),
    schemas: ['reporting'],
    relations: [
      {
        name: 'reporting.categories',
        kind: 'view',
        description: 'Categories of the household.',
        columns: [
          { name: 'label', type: 'text' },
          { name: 'bucket', type: 'text' },
          { name: 'active', type: 'boolean' },
          { name: 'sort', type: 'integer' },
        ],
      },
      {
        name: 'reporting.monthly_income',
        kind: 'view',
        description: 'Standing income per month and category.',
        columns: [
          { name: 'month', type: 'date', description: 'First day of the month.' },
          { name: 'category_label', type: 'text' },
          { name: 'amount', type: 'numeric(12,2)' },
        ],
      },
      {
        name: 'reporting.spendings',
        kind: 'view',
        description: 'One row per expense.',
        columns: [
          { name: 'id', type: 'uuid' },
          { name: 'spent_on', type: 'date', description: 'Day of the expense.' },
          { name: 'amount', type: 'numeric(12,2)', description: 'In the household currency.' },
          { name: 'category_label', type: 'text' },
          { name: 'bucket', type: 'text' },
          { name: 'member_name', type: 'text' },
          { name: 'description', type: 'text' },
          { name: 'created_at', type: 'timestamp with time zone' },
          { name: 'tags', type: 'text[]' },
        ],
      },
    ],
    metrics: [
      { name: 'spend', description: 'Total spent.', relation: 'reporting.spendings', expression: 'sum(amount)', unit: 'currency' },
      { name: 'expense_count', description: 'Number of expenses.', relation: 'reporting.spendings', expression: 'count(*)', unit: 'count' },
      { name: 'monthly_income', description: 'Standing income.', relation: 'reporting.monthly_income', expression: 'sum(amount)', unit: 'currency' },
    ],
    dimensions: [
      { name: 'category', description: 'Spending category.', relation: 'reporting.spendings', column: 'category_label' },
      { name: 'bucket', description: 'Budget bucket.', relation: 'reporting.spendings', column: 'bucket' },
      { name: 'member', description: 'Who recorded it.', relation: 'reporting.spendings', column: 'member_name' },
      { name: 'spent_on', description: 'Expense date.', relation: 'reporting.spendings', column: 'spent_on' },
      { name: 'income_category', description: 'Income category.', relation: 'reporting.monthly_income', column: 'category_label' },
      { name: 'income_month', description: 'Income month.', relation: 'reporting.monthly_income', column: 'month' },
    ],
    synonyms: [{ term: 'costs', means: 'the spend metric' }],
    examples: [
      {
        question: 'How much did we spend last month?',
        sql: 'select sum(amount) as total\nfrom reporting.spendings\nwhere spent_on >= $1::date and spent_on < $2::date',
        params: ['2026-10-01', '2026-11-01'],
      },
    ],
  });
}
