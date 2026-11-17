import type { Dimension, Metric, SemanticModel, Unit } from '../semantic';

/**
 * What a request or a plan may name, taken from the semantic model. The names
 * become schema enums, so the LLM can only choose names that exist, and code
 * can compile a structured query to SQL without guessing.
 */

export const GRAINS = ['day', 'week', 'month', 'quarter', 'year'] as const;
export type Grain = (typeof GRAINS)[number];

export type ColumnKind = 'text' | 'number' | 'date' | 'timestamp' | 'boolean';

export interface VocabularyColumn {
  name: string;
  kind: ColumnKind;
  /** For a number column the model gives a unit, e.g. an amount of money. */
  unit?: Unit;
}

export interface RelationVocabulary {
  /** Schema-qualified, e.g. `reporting.spendings`. */
  name: string;
  /** Names of the metrics computed over this relation. */
  metrics: string[];
  /** Names of the dimensions over this relation, the time dimension excluded. */
  dimensions: string[];
  /** The dimension that dates the rows. Periods and grain apply to its column. */
  time: { dimension: string; column: string } | null;
  /** Columns a listing may show: all of them except identifiers and unsupported types. */
  columns: VocabularyColumn[];
}

export interface Vocabulary {
  relations: RelationVocabulary[];
  metrics: Metric[];
  /** Dimensions people can group or filter by. Time dimensions are left out: periods and grain cover them. */
  dimensions: Dimension[];
  relation(name: string): RelationVocabulary | undefined;
  metric(name: string): Metric | undefined;
  dimension(name: string): Dimension | undefined;
}

/** How a Postgres type (as `format_type` prints it) can be used, or null if it can't. */
export function columnKind(type: string): ColumnKind | null {
  const base = type.toLowerCase().replace(/\(.*$/, '').trim();
  if (/^(text|character varying|varchar|character|char|citext|name)$/.test(base)) return 'text';
  if (/^(smallint|integer|bigint|numeric|decimal|real|double precision)$/.test(base)) return 'number';
  if (base === 'date') return 'date';
  if (base.startsWith('timestamp')) return 'timestamp';
  if (base === 'boolean') return 'boolean';
  return null; // uuid, json, arrays, ...: identifiers or shapes a report can't show
}

const isTimeKind = (kind: ColumnKind | null) => kind === 'date' || kind === 'timestamp';

export function buildVocabulary(model: SemanticModel): Vocabulary {
  if (model.metrics.length === 0) throw new Error('The semantic model needs at least one metric.');
  const relationNames = new Set(model.relations.map((relation) => relation.name));
  const metrics = model.metrics.filter((metric) => relationNames.has(metric.relation));

  const kindOf = (dimension: Dimension): ColumnKind | null => {
    const relation = model.relations.find((candidate) => candidate.name === dimension.relation);
    const column = relation?.columns.find((candidate) => candidate.name === dimension.column);
    return column ? columnKind(column.type) : null;
  };

  // `?? []`: a model file read without parseSemanticModel may predate column units.
  const units = new Map((model.columnUnits ?? []).map((entry) => [`${entry.relation}.${entry.column}`, entry.unit]));

  const relations = model.relations.map((relation): RelationVocabulary => {
    const ownDimensions = model.dimensions.filter((dimension) => dimension.relation === relation.name);
    // The first date-typed dimension dates the rows; any further ones are left out.
    const time = ownDimensions.find((dimension) => isTimeKind(kindOf(dimension)));
    return {
      name: relation.name,
      metrics: metrics.filter((metric) => metric.relation === relation.name).map((metric) => metric.name),
      dimensions: ownDimensions
        .filter((dimension) => {
          const kind = kindOf(dimension);
          return kind !== null && !isTimeKind(kind);
        })
        .map((dimension) => dimension.name),
      time: time ? { dimension: time.name, column: time.column } : null,
      columns: relation.columns.flatMap((column): VocabularyColumn[] => {
        const kind = columnKind(column.type);
        if (!kind) return [];
        const unit = kind === 'number' ? units.get(`${relation.name}.${column.name}`) : undefined;
        return [unit ? { name: column.name, kind, unit } : { name: column.name, kind }];
      }),
    };
  });

  const usable = new Set(relations.flatMap((relation) => relation.dimensions));
  const dimensions = model.dimensions.filter((dimension) => usable.has(dimension.name));

  return {
    relations,
    metrics,
    dimensions,
    relation: (name) => relations.find((relation) => relation.name === name),
    metric: (name) => metrics.find((metric) => metric.name === name),
    dimension: (name) => dimensions.find((dimension) => dimension.name === name),
  };
}
