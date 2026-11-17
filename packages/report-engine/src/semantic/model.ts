import { z } from 'zod';

/**
 * The semantic model file (docs/report-engine-spec.md §4, stage 0).
 *
 * `relations` and `schemaHash` are regenerated from the database on every
 * build. Everything else is curated: written once (by the LLM's draft, then
 * a person) and carried over unchanged, then checked against the relations.
 */

const qualifiedName = z
  .string()
  .regex(/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/, 'must be a lowercase schema.name');
const identifier = z.string().regex(/^[a-z][a-z0-9_]*$/, 'must be a lowercase identifier');
const paramValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const RELATION_KINDS = ['table', 'view', 'materialized_view', 'foreign_table'] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

/**
 * What a number means, for showing it: an amount in the household's currency,
 * a count, a percentage in points (12.5 means 12.5 %), or a plain number.
 */
export const UNITS = ['currency', 'count', 'percent', 'number'] as const;
export type Unit = (typeof UNITS)[number];

export const SemanticColumnSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  description: z.string().optional(),
});

export const SemanticRelationSchema = z.object({
  name: qualifiedName,
  kind: z.enum(RELATION_KINDS),
  description: z.string().optional(),
  columns: z.array(SemanticColumnSchema).min(1),
});

export const MetricSchema = z.object({
  name: identifier,
  description: z.string().min(1),
  relation: qualifiedName,
  /** An aggregate over the relation, e.g. `sum(amount)`. */
  expression: z.string().min(1),
  unit: z.enum(UNITS),
});

/** The unit of a plain numeric column, e.g. an expense's amount, so a listing can show it as money. */
export const ColumnUnitSchema = z.object({
  relation: qualifiedName,
  column: z.string().min(1),
  unit: z.enum(UNITS),
});

export const DimensionSchema = z.object({
  name: identifier,
  description: z.string().min(1),
  relation: qualifiedName,
  column: z.string().min(1),
});

export const SynonymSchema = z.object({
  /** A word people use, e.g. "expenses". */
  term: z.string().min(1),
  /** What it means in this model, e.g. "the spend metric". */
  means: z.string().min(1),
});

export const ExampleSchema = z.object({
  question: z.string().min(1),
  sql: z.string().min(1),
  params: z.array(paramValue).default([]),
});

export const SuggestedReportSchema = z.object({
  title: z.string().min(1),
  request: z.string().min(1),
});

export const SemanticModelSchema = z.object({
  version: z.literal(1),
  /** When the relations last changed. */
  generatedAt: z.string().min(1),
  /** sha256 of the introspected relations; a mismatch means the model is stale. */
  schemaHash: z.string().regex(/^[0-9a-f]{64}$/),
  schemas: z.array(z.string().min(1)).min(1),
  relations: z.array(SemanticRelationSchema),
  metrics: z.array(MetricSchema).default([]),
  dimensions: z.array(DimensionSchema).default([]),
  columnUnits: z.array(ColumnUnitSchema).default([]),
  synonyms: z.array(SynonymSchema).default([]),
  examples: z.array(ExampleSchema).default([]),
  suggestedReports: z.array(SuggestedReportSchema).default([]),
});

export type SemanticModel = z.output<typeof SemanticModelSchema>;
export type SemanticRelation = z.output<typeof SemanticRelationSchema>;
export type SemanticColumn = z.output<typeof SemanticColumnSchema>;
export type Metric = z.output<typeof MetricSchema>;
export type Dimension = z.output<typeof DimensionSchema>;
export type ColumnUnit = z.output<typeof ColumnUnitSchema>;
export type Example = z.output<typeof ExampleSchema>;

/** Parses a model file's JSON, with readable errors. */
export function parseSemanticModel(json: unknown): SemanticModel {
  const result = SemanticModelSchema.safeParse(json);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new Error(`Invalid semantic model:\n- ${problems.join('\n- ')}`);
  }
  return result.data;
}
