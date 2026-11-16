import { quoteIdentifier, quoteQualified } from '../core/sql';
import type { QueryOutcome, ReportQuery } from '../pg';
import type { Period } from '../plan/query';
import type { Vocabulary } from '../plan/vocabulary';
import type { Intent } from './intent';

/**
 * Stage 2: feasibility and state (docs/report-engine-spec.md §4). Code-built
 * probes, run through the executor in the run's scope, check that each view
 * the request needs has data in the requested period. The executor has
 * already verified that the scope resolves to the expected household.
 */

export interface Coverage {
  relation: string;
  /** First and last day with data, over all time; null when the view is empty or has no date. */
  first: string | null;
  last: string | null;
  /** Rows in the period, or in the whole view when there is no period. */
  rows: number;
  /** Rows in the comparison period, when there is one. */
  comparisonRows: number | null;
}

export interface Feasibility {
  status: 'ok' | 'partial' | 'no';
  coverage: Coverage[];
  /** What's missing, in plain words. */
  gaps: string[];
  /** What the person could ask instead. */
  alternatives: string[];
}

/** The views the intent reads: those of its metrics, or of its dimensions for a listing. */
export function relationsFor(intent: Intent, vocabulary: Vocabulary): string[] {
  const fromMetrics = intent.metrics.flatMap((name) => vocabulary.metric(name)?.relation ?? []);
  const fromDimensions = [...intent.dimensions, ...intent.filters.map((filter) => filter.dimension)].flatMap(
    (name) => vocabulary.dimension(name)?.relation ?? [],
  );
  return [...new Set(fromMetrics.length > 0 ? fromMetrics : fromDimensions)].sort();
}

const queryId = (relation: string) => `coverage.${relation}`;

export function feasibilityQueries(intent: Intent, vocabulary: Vocabulary): ReportQuery[] {
  return relationsFor(intent, vocabulary).map((name) => {
    const time = vocabulary.relation(name)?.time;
    const from = quoteQualified(name);
    if (!time) return { id: queryId(name), sql: `select count(*)::int as rows from ${from}`, params: [] };

    const column = quoteIdentifier(time.column);
    const params: string[] = [];
    const countIn = (period: Period | null, alias: string) => {
      if (!period) return `count(*)::int as ${alias}`;
      params.push(period.from, period.to);
      const [start, end] = [params.length - 1, params.length];
      return `count(*) filter (where ${column} >= $${start}::date and ${column} < $${end}::date)::int as ${alias}`;
    };
    const columns = [
      `min(${column})::text as first`,
      `max(${column})::text as last`,
      countIn(intent.period, 'rows'),
      ...(intent.comparison ? [countIn(intent.comparison, 'comparison_rows')] : []),
    ];
    return { id: queryId(name), sql: `select ${columns.join(', ')} from ${from}`, params };
  });
}

const dayBefore = (isoDate: string) => {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
};

const describe = (period: Period) => `${period.from} to ${dayBefore(period.to)}`;
const asCount = (value: unknown) => (typeof value === 'number' ? value : Number(value ?? 0));
const asDate = (value: unknown) => (typeof value === 'string' ? value : null);

export interface FeasibilityContext {
  /** False when the semantic model no longer matches the database. */
  modelFresh: boolean;
}

export function judgeFeasibility(
  intent: Intent,
  vocabulary: Vocabulary,
  outcomes: readonly QueryOutcome[],
  context: FeasibilityContext,
): Feasibility {
  if (!context.modelFresh) {
    return {
      status: 'no',
      coverage: [],
      gaps: ['The semantic model is out of date: the database changed since it was generated.'],
      alternatives: ['Regenerate the semantic model, review it, and try again.'],
    };
  }

  const coverage: Coverage[] = [];
  const gaps: string[] = [];
  const alternatives: string[] = [];
  let empty = 0;
  for (const relation of relationsFor(intent, vocabulary)) {
    const outcome = outcomes.find((candidate) => candidate.id === queryId(relation));
    if (!outcome?.ok) {
      gaps.push(`The data in ${relation} couldn't be checked.`);
      continue;
    }
    const row = outcome.rows[0] ?? {};
    const entry: Coverage = {
      relation,
      first: asDate(row.first),
      last: asDate(row.last),
      rows: asCount(row.rows),
      comparisonRows: intent.comparison ? asCount(row.comparison_rows) : null,
    };
    coverage.push(entry);

    const dated = entry.first && entry.last;
    if (entry.rows === 0) {
      empty += 1;
      if (!dated && vocabulary.relation(relation)?.time) {
        gaps.push(`There is no data in ${relation} yet.`);
      } else if (intent.period && dated) {
        gaps.push(`${relation} has no data from ${describe(intent.period)}.`);
        alternatives.push(`Ask about ${entry.first} to ${entry.last}, where ${relation} has data.`);
      } else {
        gaps.push(`There is no data in ${relation}.`);
      }
      continue;
    }
    if (intent.period && entry.first && entry.first > intent.period.from) {
      gaps.push(`${relation} has data only from ${entry.first}, so the period is covered from then on.`);
    }
    if (intent.comparison && entry.comparisonRows === 0) {
      gaps.push(`${relation} has no data for the comparison period, ${describe(intent.comparison)}.`);
    }
  }

  const checked = coverage.length;
  const status = checked > 0 && empty === checked ? 'no' : gaps.length > 0 ? 'partial' : 'ok';
  return { status, coverage, gaps, alternatives: [...new Set(alternatives)] };
}
