/**
 * The report a finished run shows, and how to format its values. Nothing here
 * reaches the database, the LLM or the SQL parser, so a browser can import it
 * (`report-engine/report`).
 */
export { buildVocabulary } from '../plan/vocabulary';
export { buildReport, DEFAULT_PALETTE, type ReportOptions } from './build';
export { chartFor, isColor, MAX_BARS, MAX_SERIES, MAX_SLICES, type ChartInput } from './chart';
export { humanize, roleOf, unitFormat, type ColumnRole, type ReportVocabulary } from './columns';
export type {
  ChartPoint,
  ChartSeries,
  ChartSpec,
  Figure,
  Narrative,
  NarrativeText,
  ReportBlock,
  ReportColumn,
  ReportDocument,
  ReportPeriod,
  ReportSection,
  ReportSource,
  ReportStyles,
  ReportTable,
  ValueFormat,
  ValueStyle,
  Verification,
} from './document';
export { formatNarrative, formatPeriod, formatValue, isNumeric, MISSING, reportFileName, toNumber, type FormatOptions } from './format';
