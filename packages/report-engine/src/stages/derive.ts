import type { QueryColumn } from '../pg';
import type { AggregateQuery } from '../plan/query';
import type { Vocabulary } from '../plan/vocabulary';
import { additive } from '../report/chart';
import { unitFormat } from '../report/columns';
import type { ValueFormat } from '../report/document';
import { toNumber } from '../report/format';
import type { CrossCheck, DerivedKind, DerivedValue, PlanSection, ReportPlan } from './plan';
import { expectedColumns } from './sql';

/**
 * Stage 7, post-processing (docs/report-engine-spec.md §4): code, no LLM.
 * It computes the plan's derived values from the sections' rows and runs the
 * plan's cross-checks. Both read the rows that will be shown, so they also
 * cover a compiled result that stood in for the LLM's.
 */

/** What stage 7 reads of a section's outcome. */
export interface ComputedSection {
  section: string;
  status: 'ok' | 'failed';
  columns: QueryColumn[];
  rows: Record<string, unknown>[];
  truncated: false | 'rows' | 'bytes';
}

export interface DerivedRow {
  /** The section row's key columns: its dimensions and its time column. */
  key: Record<string, unknown>;
  value: number | null;
}

export interface DerivedResult {
  id: string;
  kind: DerivedKind;
  label: string;
  /** The section it is computed from; it is shown with that section's rows. */
  section: string;
  format: ValueFormat;
  /** One per row of the section, in its order. Empty when skipped. */
  rows: DerivedRow[];
  /** Why it couldn't be computed; null when it was. */
  skipped: string | null;
}

export interface CheckResult extends CrossCheck {
  verdict: 'pass' | 'fail' | 'skipped';
  detail: string;
}

const PERCENT: ValueFormat = { kind: 'percent' };

const metricValue = (row: Record<string, unknown>, metric: string) => toNumber(row[metric]) ?? 0;

/**
 * What a section's rows are keyed by: its dimensions, then its time column.
 * Two sections being combined share their dimensions and grain (checkPlan),
 * but each view names its own time column (spent_on, income_month), so rows
 * match on the values: the dimensions in name order, then the period.
 */
interface Keys {
  /** The key columns as the section has them, for showing a derived row. */
  all: string[];
  dimensions: string[];
  time: string | null;
}

function keysOf(query: AggregateQuery, vocabulary: Vocabulary): Keys {
  const all = expectedColumns(query, vocabulary).filter((name) => !query.metrics.includes(name));
  const time = query.grain ? (vocabulary.relation(query.relation)?.time?.dimension ?? null) : null;
  return { all, dimensions: [...query.dimensions].sort(), time };
}

const valueOf = (row: Record<string, unknown>, name: string | null) => (name === null || row[name] === undefined ? null : row[name]);
const dimensionKey = (row: Record<string, unknown>, keys: Keys) => JSON.stringify(keys.dimensions.map((name) => valueOf(row, name)));
const fullKey = (row: Record<string, unknown>, keys: Keys) => JSON.stringify([...keys.dimensions.map((name) => valueOf(row, name)), valueOf(row, keys.time)]);

const pick = (row: Record<string, unknown>, names: readonly string[]) => Object.fromEntries(names.map((name) => [name, row[name] ?? null]));

/** Why a section can't be used, or null when it can. */
function unusable(id: string, result: ComputedSection | undefined): string | null {
  if (!result || result.status !== 'ok') return `section ${id} couldn't be computed`;
  if (result.truncated) return `section ${id} was cut short, so its totals are incomplete`;
  return null;
}

/**
 * The other side's values, matched to the base rows. Change over a grain
 * matches by position, because a comparison period has other dates: the
 * first month against the first month, and so on.
 */
function matched(base: ComputedSection, baseKeys: Keys, other: ComputedSection, otherKeys: Keys, metric: string, byPosition: boolean) {
  if (!byPosition || !baseKeys.time || !otherKeys.time) {
    const values = new Map(other.rows.map((row) => [fullKey(row, otherKeys), metricValue(row, metric)]));
    return base.rows.map((row) => values.get(fullKey(row, baseKeys)));
  }
  /** Each row's place among the rows with the same dimensions, in time order. */
  const ordinals = (rows: readonly Record<string, unknown>[], keys: Keys) => {
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const row of rows) groups.set(dimensionKey(row, keys), [...(groups.get(dimensionKey(row, keys)) ?? []), row]);
    const at = new Map<Record<string, unknown>, string>();
    for (const [group, members] of groups) {
      [...members]
        .sort((a, b) => String(valueOf(a, keys.time)).localeCompare(String(valueOf(b, keys.time))))
        .forEach((row, index) => at.set(row, `${group}#${index}`));
    }
    return at;
  };
  const otherAt = ordinals(other.rows, otherKeys);
  const values = new Map(other.rows.map((row) => [otherAt.get(row)!, metricValue(row, metric)]));
  const baseAt = ordinals(base.rows, baseKeys);
  return base.rows.map((row) => values.get(baseAt.get(row)!));
}

function derive(value: DerivedValue, plan: ReportPlan, results: ReadonlyMap<string, ComputedSection>, vocabulary: Vocabulary): DerivedResult {
  const format = value.kind === 'difference' ? unitFormat(vocabulary.metric(value.metric)?.unit) : value.kind === 'ratio' ? { kind: 'number' as const } : PERCENT;
  const head = { id: value.id, kind: value.kind, label: value.label, section: value.section, format };
  const skip = (reason: string): DerivedResult => ({ ...head, rows: [], skipped: reason });

  const section: PlanSection | undefined = plan.sections.find((candidate) => candidate.id === value.section);
  if (section?.query?.shape !== 'aggregate') return skip(`section ${value.section} has no breakdown to compute from`);
  const keys = keysOf(section.query, vocabulary);
  const base = results.get(value.section);
  const baseProblem = unusable(value.section, base);
  if (baseProblem || !base) return skip(baseProblem ?? `section ${value.section} couldn't be computed`);
  const own = base.rows.map((row) => metricValue(row, value.metric));
  const row = (index: number, result: number | null): DerivedRow => ({ key: pick(base.rows[index]!, keys.all), value: result });

  if (value.kind === 'share_of_total') {
    const total = own.reduce((sum, item) => sum + item, 0);
    return { ...head, rows: own.map((item, index) => row(index, total === 0 ? null : (item / total) * 100)), skipped: null };
  }
  if (!value.against) return skip(`${value.kind} needs another section to compare with`);
  const against = value.against;
  const otherSection = plan.sections.find((candidate) => candidate.id === against.section);
  if (otherSection?.query?.shape !== 'aggregate') return skip(`section ${against.section} has no breakdown to compare with`);
  const other = results.get(against.section);
  const otherProblem = unusable(against.section, other);
  if (otherProblem || !other) return skip(otherProblem ?? `section ${against.section} couldn't be computed`);
  const theirs = matched(base, keys, other, keysOf(otherSection.query, vocabulary), against.metric, value.kind === 'change');
  const rows = own.map((mine, index) => {
    const other = theirs[index];
    switch (value.kind) {
      case 'difference':
        return row(index, mine - (other ?? 0));
      case 'ratio':
        return row(index, other === undefined || other === 0 ? null : mine / other);
      default:
        return row(index, other === undefined || other === 0 ? null : ((mine - other) / Math.abs(other)) * 100);
    }
  });
  return { ...head, rows, skipped: null };
}

export function computeDerived(plan: ReportPlan, results: ReadonlyMap<string, ComputedSection>, vocabulary: Vocabulary): DerivedResult[] {
  return plan.derived.map((value) => derive(value, plan, results, vocabulary));
}

/** The parts must add up to the total to the cent. */
const SUM_TOLERANCE = 0.01;

export function runCrossChecks(plan: ReportPlan, results: ReadonlyMap<string, ComputedSection>, vocabulary: Vocabulary): CheckResult[] {
  return plan.crossChecks.map((check): CheckResult => {
    const skip = (detail: string): CheckResult => ({ ...check, verdict: 'skipped', detail });
    if (!additive(check.metric, vocabulary.metrics)) return skip(`${check.metric} is not a sum or a count, so its parts don't add up to it`);
    const parts = results.get(check.parts);
    const total = results.get(check.total);
    const problem = unusable(check.parts, parts) ?? unusable(check.total, total);
    if (problem || !parts || !total) return skip(problem ?? 'a section is missing');
    const sum = parts.rows.reduce((acc, row) => acc + metricValue(row, check.metric), 0);
    const whole = total.rows.length > 0 ? metricValue(total.rows[0]!, check.metric) : 0;
    const round = (value: number) => Math.round(value * 100) / 100;
    const detail = `The parts of ${check.parts} add up to ${round(sum)}; the total in ${check.total} is ${round(whole)}.`;
    const pass = Math.abs(sum - whole) <= SUM_TOLERANCE + 1e-9 * Math.max(Math.abs(sum), Math.abs(whole));
    return { ...check, verdict: pass ? 'pass' : 'fail', detail };
  });
}
