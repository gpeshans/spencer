import { quoteIdentifier, quoteQualified } from '../core/sql';
import type { QueryOutcome, ReportQuery } from '../pg';
import type { Vocabulary } from '../plan/vocabulary';

/**
 * The values each dimension takes in the household's data, e.g. its category
 * names. Code needs them to check the values a request names; a deployment may
 * also show them to the LLM, so it can map "groceries" onto the real name.
 *
 * They are read with code-built queries, through the same executor and scope
 * as every other query.
 */

/** A dimension with more values than this isn't listed; its values are matched in SQL only. */
export const MAX_LISTED_VALUES = 100;

/** Values by dimension name. A dimension is missing when its values couldn't be listed. */
export type HouseholdValues = Readonly<Record<string, readonly string[]>>;

const queryId = (dimension: string) => `values.${dimension}`;

export function valueQueries(vocabulary: Vocabulary): ReportQuery[] {
  return vocabulary.dimensions.map((dimension) => {
    const column = quoteIdentifier(dimension.column);
    return {
      id: queryId(dimension.name),
      sql:
        `select distinct ${column}::text as value from ${quoteQualified(dimension.relation)} ` +
        `where ${column} is not null order by value limit ${MAX_LISTED_VALUES + 1}`,
      params: [],
    };
  });
}

export function readValues(vocabulary: Vocabulary, outcomes: readonly QueryOutcome[]): HouseholdValues {
  const values: Record<string, readonly string[]> = {};
  for (const dimension of vocabulary.dimensions) {
    const outcome = outcomes.find((candidate) => candidate.id === queryId(dimension.name));
    if (!outcome?.ok || outcome.truncated) continue;
    const listed = outcome.rows.map((row) => row.value).filter((value): value is string => typeof value === 'string');
    if (listed.length > MAX_LISTED_VALUES) continue;
    values[dimension.name] = listed;
  }
  return values;
}
