import type { RunState, SectionResult } from '../pipeline/state';
import type { Period } from '../plan/query';
import type { CheckResult, DerivedResult } from '../stages/derive';
import type { PlanSection } from '../stages/plan';
import { chartFor, isColor } from './chart';
import { roleOf, type ColumnRole, type ReportVocabulary } from './columns';
import type { ReportBlock, ReportDocument, ReportPeriod, ReportSection, ReportStyles, ReportTable, Verification } from './document';
import { dayBefore } from './format';

/**
 * Turns a finished run into the report people see (docs/report-engine-spec.md
 * §8): each section's numbers with their formats and derived values, its
 * chart when the plan wants one, how far its numbers are checked, and the
 * narrative. A sentence per section says how its numbers were computed, but
 * nothing else of it reaches the report (SQL, cost, repairs).
 */

/** Colours for series without their own: Open Color steps that read on light and dark. */
export const DEFAULT_PALETTE: readonly string[] = [
  '#1c7ed6',
  '#f08c00',
  '#2f9e44',
  '#7048e8',
  '#e8590c',
  '#0ca678',
  '#c2255c',
  '#ae3ec9',
  '#15aabf',
  '#9c6644',
];

export interface ReportOptions {
  /** ISO 4217 code of every amount, e.g. EUR. */
  currency: string;
  /** Labels and colours for dimension values, e.g. each category's colour. */
  styles?: ReportStyles;
  /** Colours for series that have none of their own. */
  palette?: readonly string[];
}

/** Null until the run has results to show: it succeeded, or finished with gaps. */
export function buildReport(run: RunState, vocabulary: ReportVocabulary, options: ReportOptions): ReportDocument | null {
  if ((run.status !== 'succeeded' && run.status !== 'partial') || !run.plan) return null;
  const results = new Map((run.results ?? []).map((result) => [result.section, result]));
  const context: Context = {
    vocabulary,
    styles: options.styles ?? {},
    palette: options.palette?.some(isColor) ? options.palette.filter(isColor) : DEFAULT_PALETTE,
  };
  const derived = (run.derived ?? []).filter((value) => value.skipped === null);
  const failedChecks = (run.checks ?? []).filter((check) => check.verdict === 'fail');
  return {
    version: 2,
    title: run.plan.title,
    summary: run.plan.summary,
    request: run.request,
    status: run.status,
    currency: options.currency,
    period: periodOf(run.intent?.period ?? null),
    comparison: periodOf(run.intent?.comparison ?? null),
    assumptions: run.intent?.assumptions ?? [],
    narrative: run.narrative ?? null,
    sections: run.plan.sections.map((section) =>
      buildSection(section, results.get(section.id), context, derived.filter((value) => value.section === section.id), failedChecks),
    ),
    sources: run.plan.sections.flatMap((section) => {
      const result = results.get(section.id);
      return result?.status === 'ok' && result.summary ? [{ section: section.id, title: section.title, summary: result.summary }] : [];
    }),
  };
}

interface Context {
  vocabulary: ReportVocabulary;
  styles: ReportStyles;
  palette: readonly string[];
}

/** A half-open period (`to` not included) as the days it covers. */
const periodOf = (period: Period | null): ReportPeriod | null => (period ? { first: period.from, last: dayBefore(period.to) } : null);

function verificationOf(id: string, result: SectionResult | undefined, failedChecks: readonly CheckResult[]): Verification | null {
  if (!result || result.status !== 'ok' || result.check === undefined) return null;
  if (result.truncated) return 'truncated';
  if (failedChecks.some((check) => check.parts === id || check.total === id)) return 'unverified';
  return result.check === 'match' || result.check === 'mismatch' || result.check === 'fallback' ? 'verified' : 'unverified';
}

function buildSection(
  section: PlanSection,
  result: SectionResult | undefined,
  context: Context,
  derived: readonly DerivedResult[],
  failedChecks: readonly CheckResult[],
): ReportSection {
  const head = { id: section.id, title: section.title };
  if (section.display === 'text') return { ...head, description: null, block: { kind: 'text', text: section.purpose }, verification: null };
  // Compiled SQL describes itself in a code-written sentence; that one goes in the sources.
  const description = (result?.source !== 'compiled' && result?.summary) || section.purpose;
  return { ...head, description, block: blockOf(section, result, context, derived), verification: verificationOf(section.id, result, failedChecks) };
}

function blockOf(section: PlanSection, result: SectionResult | undefined, context: Context, derived: readonly DerivedResult[]): ReportBlock {
  if (!result || result.status === 'failed') return { kind: 'failed' };
  if (result.rows.length === 0) return { kind: 'empty' };
  const roles = result.columns.map((column) => roleOf(column, section.query, context.vocabulary));
  const table: ReportTable = {
    columns: roles.map((role) => role.column),
    rows: labelled(result.rows, roles, context.styles),
    truncated: result.truncated,
  };
  // Derived values sit beside the rows they were computed from: one more column, or one more figure.
  for (const value of derived) {
    if (value.rows.length !== table.rows.length) continue;
    const key = `derived:${value.id}`;
    table.columns.push({ key, label: value.label, format: value.format });
    value.rows.forEach((row, index) => {
      table.rows[index]![key] = row.value;
    });
  }
  if (section.display === 'figure' && table.rows.length === 1) {
    const [row] = table.rows;
    return { kind: 'figures', figures: table.columns.map((column) => ({ label: column.label, value: row![column.key], format: column.format })) };
  }
  if (section.display === 'bar' || section.display === 'line' || section.display === 'pie') {
    const chart = chartFor({
      display: section.display,
      query: section.query,
      roles,
      rows: result.rows,
      metrics: context.vocabulary.metrics,
      styles: context.styles,
      palette: context.palette,
    });
    if (chart) return { kind: 'chart', chart, table };
  }
  return { kind: 'table', table };
}

/** Rows with each styled value shown by its label, e.g. the bucket "needs" as "Needs". */
function labelled(rows: ReadonlyArray<Record<string, unknown>>, roles: readonly ColumnRole[], styles: ReportStyles) {
  const styled = roles.flatMap((role) => {
    const values = role.dimension ? styles[role.dimension] : undefined;
    return values ? [{ key: role.column.key, values }] : [];
  });
  if (styled.length === 0) return rows.map((row) => ({ ...row }));
  return rows.map((row) => {
    const copy = { ...row };
    for (const { key, values } of styled) {
      const label = row[key] === null || row[key] === undefined ? undefined : values[String(row[key])]?.label;
      if (label) copy[key] = label;
    }
    return copy;
  });
}
