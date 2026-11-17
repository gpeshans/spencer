import type { RunState, SectionResult } from '../pipeline/state';
import type { PlanSection } from '../stages/plan';
import { chartFor, isColor } from './chart';
import { roleOf, type ColumnRole, type ReportVocabulary } from './columns';
import type { ReportBlock, ReportDocument, ReportSection, ReportStyles, ReportTable } from './document';

/**
 * Turns a finished run into the report people see (docs/report-engine-spec.md
 * §8): each section's numbers with their formats, its chart when the plan
 * wants one, and nothing about how they were computed (SQL, cost, repairs).
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
  return {
    version: 1,
    title: run.plan.title,
    summary: run.plan.summary,
    request: run.request,
    status: run.status,
    currency: options.currency,
    sections: run.plan.sections.map((section) => buildSection(section, results.get(section.id), context)),
  };
}

interface Context {
  vocabulary: ReportVocabulary;
  styles: ReportStyles;
  palette: readonly string[];
}

function buildSection(section: PlanSection, result: SectionResult | undefined, context: Context): ReportSection {
  const head = { id: section.id, title: section.title };
  if (section.display === 'text') return { ...head, description: null, block: { kind: 'text', text: section.purpose } };
  return { ...head, description: result?.summary || section.purpose, block: blockOf(section, result, context) };
}

function blockOf(section: PlanSection, result: SectionResult | undefined, context: Context): ReportBlock {
  if (!result || result.status === 'failed') return { kind: 'failed' };
  if (result.rows.length === 0) return { kind: 'empty' };
  const roles = result.columns.map((column) => roleOf(column, section.query, context.vocabulary));
  const table: ReportTable = {
    columns: roles.map((role) => role.column),
    rows: labelled(result.rows, roles, context.styles),
    truncated: result.truncated,
  };
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
