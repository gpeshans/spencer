import type { ColumnType } from '../pg/values';
import type { StructuredQuery } from '../plan/query';
import type { Grain, Vocabulary } from '../plan/vocabulary';
import type { Unit } from '../semantic/model';
import type { ReportColumn, ValueFormat } from './document';

/** The parts of the vocabulary a report needs: plain data, so the browser can have it too. */
export type ReportVocabulary = Pick<Vocabulary, 'relations' | 'metrics' | 'dimensions'>;

/** What a result column holds, worked out from the section's query and the vocabulary. */
export interface ColumnRole {
  column: ReportColumn;
  /** The dimension whose values it holds: their labels and colours come from the styles. */
  dimension: string | null;
  /** The metric it holds. */
  metric: string | null;
  /** It is the section's grain column (a week, a month, ...). */
  time: boolean;
}

const GRAIN_LABEL: Readonly<Record<Grain, string>> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
  quarter: 'Quarter',
  year: 'Year',
};

const UNIT_FORMAT: Readonly<Record<Unit, ValueFormat>> = {
  currency: { kind: 'money' },
  count: { kind: 'count' },
  percent: { kind: 'percent' },
  number: { kind: 'number' },
};

/** How a value in `unit` is shown; a plain number without one. */
export function unitFormat(unit: Unit | undefined): ValueFormat {
  return unit ? UNIT_FORMAT[unit] : { kind: 'number' };
}

/** `spent_on` → "Spent on". */
export function humanize(name: string): string {
  const words = name.replaceAll('_', ' ').replace(/\s+/g, ' ').trim();
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : name;
}

/** How to show a column: from its unit or grain when known, else from the type the database returned. */
function formatOf(type: ColumnType, unit: Unit | undefined, grain: Grain | null): ValueFormat {
  switch (type) {
    case 'integer':
    case 'number':
      return unit ? UNIT_FORMAT[unit] : type === 'integer' ? { kind: 'count' } : { kind: 'number' };
    case 'date':
      return { kind: 'date', grain };
    case 'timestamp':
      return { kind: 'timestamp' };
    case 'boolean':
      return { kind: 'boolean' };
    default:
      return { kind: 'text' };
  }
}

interface Meaning {
  label: string;
  unit?: Unit;
  grain?: Grain;
  dimension?: string;
  metric?: string;
}

function meaningOf(name: string, query: StructuredQuery | null, vocabulary: ReportVocabulary): Meaning {
  const relation = query ? vocabulary.relations.find((candidate) => candidate.name === query.relation) : undefined;
  if (query?.shape === 'aggregate') {
    if (query.metrics.includes(name)) {
      return { label: humanize(name), metric: name, unit: vocabulary.metrics.find((metric) => metric.name === name)?.unit };
    }
    if (query.dimensions.includes(name)) return { label: humanize(name), dimension: name };
    if (query.grain && relation?.time?.dimension === name) return { label: GRAIN_LABEL[query.grain], grain: query.grain };
    return { label: humanize(name) };
  }
  if (query?.shape === 'rows') {
    // A listing names the view's own columns; a column behind a dimension takes the dimension's name.
    const dimension = vocabulary.dimensions.find((candidate) => candidate.relation === query.relation && candidate.column === name);
    const time = relation?.time?.column === name ? relation.time.dimension : undefined;
    return {
      label: humanize(dimension?.name ?? time ?? name),
      unit: relation?.columns.find((column) => column.name === name)?.unit,
      dimension: dimension?.name,
    };
  }
  // Without a structured query, the names are all there is: a metric's, a dimension's, or a column's with a unit.
  const metric = vocabulary.metrics.find((candidate) => candidate.name === name);
  if (metric) return { label: humanize(name), metric: name, unit: metric.unit };
  const dimension = vocabulary.dimensions.find((candidate) => candidate.name === name);
  if (dimension) return { label: humanize(name), dimension: name };
  const units = new Set(
    vocabulary.relations.flatMap((candidate) => candidate.columns.filter((column) => column.name === name && column.unit).map((column) => column.unit)),
  );
  return { label: humanize(name), unit: units.size === 1 ? [...units][0] : undefined };
}

export function roleOf(column: { name: string; type: ColumnType }, query: StructuredQuery | null, vocabulary: ReportVocabulary): ColumnRole {
  const meaning = meaningOf(column.name, query, vocabulary);
  return {
    column: { key: column.name, label: meaning.label, format: formatOf(column.type, meaning.unit, meaning.grain ?? null) },
    dimension: meaning.dimension ?? null,
    metric: meaning.metric ?? null,
    time: meaning.grain !== undefined,
  };
}
