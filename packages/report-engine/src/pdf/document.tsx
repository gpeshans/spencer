import { Circle, Document, Line, Page, Path, Polyline, Rect, StyleSheet, Svg, Text, View } from '@react-pdf/renderer';
import type { ReactNode } from 'react';

import type { ChartPoint, ChartSpec, Figure, ReportBlock, ReportDocument, ReportSection, ReportTable } from '../report/document';
import { formatNarrative, formatPeriod, formatValue, isNumeric, type FormatOptions } from '../report/format';
import { extent, labelEvery, niceTicks, pieSlices } from './geometry';

/**
 * The PDF of a report: an A4 document drawn from the same ReportDocument as
 * the app's page. Components here use no hooks, so they render wherever
 * react-pdf's own React lives.
 */

export interface PdfLook {
  /** BCP 47, e.g. de-DE. */
  locale: string;
  /** The registered font family. */
  family: string;
  /** "Data as of …", already formatted. */
  asOf: string | null;
  /** A name for the header and footer, e.g. the app's. */
  brand: string | null;
}

const INK = '#0a0a0a';
const MUTED = '#737373';
const LINE = '#e5e5e5';
const AXIS = '#a3a3a3';
const SOFT = '#f5f5f5';
const DANGER = '#b91c1c';

const PAGE_WIDTH = 595.28;
const MARGIN = 40;
const WIDTH = PAGE_WIDTH - 2 * MARGIN;

const styles = StyleSheet.create({
  page: {
    paddingTop: MARGIN,
    paddingBottom: 60,
    paddingHorizontal: MARGIN,
    fontSize: 9,
    color: INK,
    // No line height here: inherited by the page-number text, it throws that
    // text off the page. Text styles set their own.
    // No ligatures, so copied text reads "first", not "frst"; even-width digits line up.
    fontFeatureSettings: { liga: false, tnum: true },
  },
  brand: { fontSize: 8, color: MUTED, letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6 },
  title: { fontSize: 18, fontWeight: 'bold', lineHeight: 1.2 },
  summary: { fontSize: 10, color: MUTED, marginTop: 4, lineHeight: 1.35 },
  meta: { fontSize: 8, color: MUTED, marginTop: 2, lineHeight: 1.35 },
  header: { marginBottom: 2, paddingBottom: 12, borderBottomWidth: 0.75, borderBottomColor: LINE },
  note: { fontSize: 8, color: MUTED, marginTop: 4, lineHeight: 1.35 },
  callout: { fontSize: 9, color: MUTED, backgroundColor: SOFT, padding: 8, borderRadius: 4, marginTop: 16, lineHeight: 1.35 },
  section: { marginTop: 20 },
  sectionTitle: { fontSize: 12, fontWeight: 'bold', lineHeight: 1.35 },
  marker: { fontSize: 8, fontWeight: 'normal', color: MUTED },
  headline: { fontSize: 11, fontWeight: 'bold', lineHeight: 1.4 },
  insight: { fontSize: 9.5, lineHeight: 1.4, marginTop: 3 },
  narrative: { marginTop: 14 },
  sources: { marginTop: 24, paddingTop: 8, borderTopWidth: 0.75, borderTopColor: LINE },
  sourcesTitle: { fontSize: 8, fontWeight: 'bold', color: MUTED, marginBottom: 2 },
  description: { fontSize: 8.5, color: MUTED, marginTop: 2, marginBottom: 8, lineHeight: 1.35 },
  failed: { fontSize: 9, color: DANGER },
  text: { fontSize: 9.5, lineHeight: 1.35 },
  figures: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  figure: { minWidth: 120, flexGrow: 1, backgroundColor: SOFT, borderRadius: 4, padding: 10 },
  figureLabel: { fontSize: 8, color: MUTED },
  figureValue: { fontSize: 16, fontWeight: 'bold', marginTop: 2 },
  table: { marginTop: 8 },
  row: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: LINE },
  headRow: { borderBottomWidth: 0.75, borderBottomColor: AXIS },
  cell: { paddingVertical: 3.5, paddingHorizontal: 4, fontSize: 8.5, lineHeight: 1.35 },
  headCell: { color: MUTED, fontWeight: 'bold' },
  numeric: { textAlign: 'right' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 6 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  swatch: { width: 8, height: 8, borderRadius: 2 },
  small: { fontSize: 7.5, color: MUTED },
  footer: { position: 'absolute', bottom: 28, left: MARGIN, right: MARGIN, fontSize: 7.5, color: MUTED },
});

export function ReportPdf({ report, look }: { report: ReportDocument; look: PdfLook }) {
  const format: FormatOptions = { locale: look.locale, currency: report.currency };
  const footer = [look.brand, report.title].filter(Boolean).join(' · ');
  return (
    <Document title={report.title} subject={report.summary} creator={look.brand ?? undefined} producer={look.brand ?? undefined} language={look.locale}>
      <Page size="A4" style={[styles.page, { fontFamily: look.family }]} wrap>
        {/*
          Two full-width fixed texts, one aligned left and one right. A fixed row, or a
          text pinned by its right edge, goes missing on pages beside the tables' fixed headers.
        */}
        <Text style={[styles.footer, { paddingRight: 80, maxLines: 1, textOverflow: 'ellipsis' }]} fixed>
          {footer}
        </Text>
        {/* No maxLines here: react-pdf sizes a render text before it has its words. */}
        <Text
          style={[styles.footer, { textAlign: 'right' }]}
          fixed
          render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
        />
        <View style={styles.header}>
          {look.brand && <Text style={styles.brand}>{look.brand}</Text>}
          <Text style={styles.title}>{report.title}</Text>
          {report.summary && <Text style={styles.summary}>{report.summary}</Text>}
          <Text style={[styles.meta, { marginTop: 8 }]}>Question: “{report.request}”</Text>
          {report.period && (
            <Text style={styles.meta}>
              Period: {formatPeriod(report.period, format)}
              {report.comparison ? `, compared with ${formatPeriod(report.comparison, format)}` : ''}
            </Text>
          )}
          {report.assumptions.length > 0 && <Text style={styles.meta}>Assumes: {report.assumptions.join(' ')}</Text>}
          {look.asOf && <Text style={styles.meta}>Data as of {look.asOf}</Text>}
        </View>
        {report.narrative && (
          <View style={styles.narrative} wrap={false}>
            {report.narrative.headline && <Text style={styles.headline}>{formatNarrative(report.narrative.headline, format)}</Text>}
            {report.narrative.insights.map((insight, index) => (
              <Text key={index} style={styles.insight}>
                • {formatNarrative(insight, format)}
              </Text>
            ))}
          </View>
        )}
        {report.status === 'partial' && (
          <Text style={styles.callout}>Some sections couldn’t be computed; they say so below.</Text>
        )}
        {report.sections.map((section) => (
          <SectionView key={section.id} section={section} format={format} />
        ))}
        {report.sources.length > 0 && (
          <View style={styles.sources} wrap={false}>
            <Text style={styles.sourcesTitle}>How these numbers were computed</Text>
            {report.sources.map((source) => (
              <Text key={source.section} style={styles.meta}>
                {source.title}: {source.summary}
              </Text>
            ))}
          </View>
        )}
      </Page>
    </Document>
  );
}

/**
 * A section's parts are the page's own children, not one wrapping view:
 * react-pdf keeps a title with what follows only among siblings that have
 * something before them on the page.
 */
function SectionView({ section, format }: { section: ReportSection; format: FormatOptions }) {
  const { block } = section;
  const head = (
    <>
      <Text style={styles.sectionTitle}>
        {section.title}
        {section.verification === 'unverified' && <Text style={styles.marker}>  Unverified: these numbers couldn’t be double-checked.</Text>}
      </Text>
      {section.description ? <Text style={styles.description}>{section.description}</Text> : <View style={{ height: 6 }} />}
    </>
  );
  // A title stays on the page of what it heads: a chart or figures move with
  // it, and a table starts under it. Only a table's rows run on to the next page.
  switch (block.kind) {
    case 'table':
      return (
        <>
          <View style={styles.section} wrap={false} minPresenceAhead={64}>
            {head}
          </View>
          <TableView table={block.table} format={format} />
        </>
      );
    case 'chart':
      return (
        <>
          <View style={styles.section} wrap={false}>
            {head}
            <ChartView chart={block.chart} format={format} />
          </View>
          <TableView table={block.table} format={format} />
        </>
      );
    default:
      return (
        <View style={styles.section} wrap={false}>
          {head}
          <BlockView block={block} format={format} />
        </View>
      );
  }
}

function BlockView({ block, format }: { block: Exclude<ReportBlock, { kind: 'table' | 'chart' }>; format: FormatOptions }) {
  switch (block.kind) {
    case 'figures':
      return <Figures figures={block.figures} format={format} />;
    case 'text':
      return <Text style={styles.text}>{block.text}</Text>;
    case 'empty':
      return <Text style={styles.note}>No data for this section.</Text>;
    case 'failed':
      return <Text style={styles.failed}>This section couldn’t be computed.</Text>;
  }
}

function Figures({ figures, format }: { figures: Figure[]; format: FormatOptions }) {
  return (
    <View style={styles.figures}>
      {figures.map((figure, index) => (
        <View key={index} style={styles.figure}>
          <Text style={styles.figureLabel}>{figure.label}</Text>
          <Text style={styles.figureValue}>{formatValue(figure.value, figure.format, format)}</Text>
        </View>
      ))}
    </View>
  );
}

function TableView({ table, format }: { table: ReportTable; format: FormatOptions }) {
  // Names get more room than numbers and dates.
  const widths = table.columns.map((column) => (column.format.kind === 'text' ? 2 : 1));
  const cell = (index: number) => [styles.cell, { flex: widths[index] }, ...(isNumeric(table.columns[index]!.format) ? [styles.numeric] : [])];
  return (
    <View style={styles.table}>
      {/* Fixed: the header row repeats on every page the table runs onto. */}
      <View style={[styles.row, styles.headRow]} fixed>
        {table.columns.map((column, index) => (
          <Text key={index} style={[...cell(index), styles.headCell]}>
            {column.label}
          </Text>
        ))}
      </View>
      {table.rows.map((row, rowIndex) => (
        <View key={rowIndex} style={styles.row} wrap={false}>
          {table.columns.map((column, index) => (
            <Text key={index} style={cell(index)}>
              {formatValue(row[column.key], column.format, format)}
            </Text>
          ))}
        </View>
      ))}
      {table.truncated && <Text style={styles.note}>Only the first rows are shown: the result was too large.</Text>}
    </View>
  );
}

const xLabel = (chart: ChartSpec, point: ChartPoint, format: FormatOptions) =>
  point.label ?? formatValue(point.x, chart.x.format, { ...format, compact: true });

function ChartView({ chart, format }: { chart: ChartSpec; format: FormatOptions }) {
  const body =
    chart.type === 'pie' ? (
      <PieChart chart={chart} format={format} />
    ) : chart.type === 'bar' && chart.orientation === 'horizontal' ? (
      <HorizontalBars chart={chart} format={format} />
    ) : (
      <ColumnsOrLines chart={chart} format={format} />
    );
  return (
    <View style={{ marginTop: 4, marginBottom: 6 }}>
      {body}
      {chart.type !== 'pie' && chart.series.length > 1 && (
        <View style={styles.legend}>
          {chart.series.map((series) => (
            <View key={series.key} style={styles.legendItem}>
              <View style={[styles.swatch, { backgroundColor: series.color }]} />
              <Text style={styles.small}>{series.label}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

/** Bars running across the page, one row per point, so long names fit beside them. */
function HorizontalBars({ chart, format }: { chart: ChartSpec; format: FormatOptions }) {
  const [low, high] = extent(chart);
  const span = high - low || 1;
  const at = (value: number) => ((value - low) / span) * 100;
  const zero = at(0);
  const grouped = !chart.stacked && chart.series.length > 1;
  const rowHeight = grouped ? Math.max(14, 6 * chart.series.length + 4) : 14;
  return (
    <View>
      {chart.points.map((point, index) => {
        const bars: Array<{ key: string; left: number; width: number; top: number; height: number; color: string }> = [];
        let up = 0;
        let down = 0;
        chart.series.forEach((series, seriesIndex) => {
          const value = point.values[series.key];
          if (value === null || value === undefined) return;
          const color = point.color ?? series.color;
          if (chart.stacked) {
            const from = value >= 0 ? up : down + value;
            if (value >= 0) up += value;
            else down += value;
            bars.push({ key: series.key, left: at(from), width: Math.abs(at(from + Math.abs(value)) - at(from)), top: 0, height: 10, color });
          } else {
            const top = grouped ? (seriesIndex * (rowHeight - 4)) / chart.series.length : 0;
            const height = grouped ? (rowHeight - 4) / chart.series.length - 1 : 10;
            bars.push({ key: series.key, left: Math.min(at(value), zero), width: Math.abs(at(value) - zero), top, height, color });
          }
        });
        const total = chart.series.length === 1 ? point.values[chart.series[0]!.key] : chart.stacked ? up + down : null;
        return (
          <View key={index} style={{ flexDirection: 'row', alignItems: 'center', height: rowHeight }}>
            <Text style={[styles.small, { width: 120, paddingRight: 6, textAlign: 'right', maxLines: 1, textOverflow: 'ellipsis' }]}>
              {xLabel(chart, point, format)}
            </Text>
            <View style={{ flex: 1, height: rowHeight - 4, position: 'relative' }}>
              {low < 0 && <View style={{ position: 'absolute', left: `${zero}%`, top: 0, bottom: 0, width: 0.5, backgroundColor: AXIS }} />}
              {bars.map((bar) => (
                <View
                  key={bar.key}
                  style={{
                    position: 'absolute',
                    left: `${bar.left}%`,
                    width: `${Math.max(bar.width, 0.2)}%`,
                    top: bar.top,
                    height: bar.height,
                    backgroundColor: bar.color,
                    borderRadius: 1.5,
                  }}
                />
              ))}
            </View>
            <Text style={[styles.small, { width: 70, paddingLeft: 6, color: INK }]}>
              {total === null || total === undefined ? '' : formatValue(total, chart.value, format)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const CHART_HEIGHT = 180;
const LEFT = 52;
const RIGHT = 6;
const TOP = 8;
const BOTTOM = 18;

/** Upright bars or lines over a value axis, drawn in SVG; the labels are text laid over it. */
function ColumnsOrLines({ chart, format }: { chart: ChartSpec; format: FormatOptions }) {
  const ticks = niceTicks(...extent(chart));
  const low = ticks[0]!;
  const high = ticks[ticks.length - 1]!;
  const plotWidth = WIDTH - LEFT - RIGHT;
  const plotBottom = CHART_HEIGHT - BOTTOM;
  const y = (value: number) => plotBottom - ((value - low) / (high - low)) * (plotBottom - TOP);
  const band = plotWidth / Math.max(1, chart.points.length);
  const center = (index: number) => LEFT + band * (index + 0.5);
  const every = labelEvery(chart.points.length, Math.floor(plotWidth / 48));
  const compact: FormatOptions = { ...format, compact: true };

  const shapes: ReactNode[] = [];
  if (chart.type === 'bar') {
    const groupWidth = band * 0.7;
    chart.points.forEach((point, index) => {
      const left = center(index) - groupWidth / 2;
      let up = 0;
      let down = 0;
      chart.series.forEach((series, seriesIndex) => {
        const value = point.values[series.key];
        if (value === null || value === undefined) return;
        const color = point.color ?? series.color;
        let from = 0;
        let x = left;
        let width = groupWidth;
        if (chart.stacked) {
          from = value >= 0 ? up : down;
          if (value >= 0) up += value;
          else down += value;
        } else if (chart.series.length > 1) {
          width = groupWidth / chart.series.length;
          x = left + seriesIndex * width;
        }
        const top = Math.min(y(from), y(from + value));
        const height = Math.max(Math.abs(y(from + value) - y(from)), 0.5);
        shapes.push(<Rect key={`${index}-${series.key}`} x={x} y={top} width={Math.max(width - 0.5, 0.5)} height={height} fill={color} />);
      });
    });
  } else {
    // Dots on every point while there's room; otherwise only on points a gap leaves alone.
    const dots = chart.points.length <= 40;
    chart.series.forEach((series) => {
      // A missing value breaks the line rather than bridging it.
      const runs: Array<Array<{ x: number; y: number }>> = [[]];
      chart.points.forEach((point, index) => {
        const value = point.values[series.key];
        if (value === null || value === undefined) runs.push([]);
        else runs[runs.length - 1]!.push({ x: center(index), y: y(value) });
      });
      runs.forEach((run, runIndex) => {
        if (run.length > 1) {
          const points = run.map((at) => `${at.x.toFixed(2)},${at.y.toFixed(2)}`).join(' ');
          shapes.push(<Polyline key={`${series.key}-${runIndex}`} points={points} stroke={series.color} strokeWidth={1.5} fill="none" />);
        }
        if (dots || run.length === 1) {
          run.forEach((at, atIndex) =>
            shapes.push(<Circle key={`${series.key}-${runIndex}-${atIndex}`} cx={at.x} cy={at.y} r={1.7} fill={series.color} />),
          );
        }
      });
    });
  }

  return (
    <View style={{ width: WIDTH, height: CHART_HEIGHT, position: 'relative' }}>
      <Svg width={WIDTH} height={CHART_HEIGHT} style={{ position: 'absolute', left: 0, top: 0 }}>
        {ticks.map((tick) => (
          <Line
            key={`grid-${tick}`}
            x1={LEFT}
            x2={WIDTH - RIGHT}
            y1={y(tick)}
            y2={y(tick)}
            stroke={tick === 0 ? AXIS : LINE}
            strokeWidth={tick === 0 ? 0.75 : 0.5}
          />
        ))}
        {shapes}
      </Svg>
      {ticks.map((tick) => (
        <Text key={`tick-${tick}`} style={[styles.small, { position: 'absolute', left: 0, top: y(tick) - 4.5, width: LEFT - 6, textAlign: 'right' }]}>
          {formatValue(tick, chart.value, compact)}
        </Text>
      ))}
      {chart.points.map((point, index) =>
        index % every === 0 ? (
          <Text
            key={`x-${index}`}
            style={[styles.small, { position: 'absolute', left: center(index) - 30, top: plotBottom + 4, width: 60, textAlign: 'center', maxLines: 1 }]}
          >
            {xLabel(chart, point, format)}
          </Text>
        ) : null,
      )}
    </View>
  );
}

/** A ring of slices, with each slice's value and share beside it. */
function PieChart({ chart, format }: { chart: ChartSpec; format: FormatOptions }) {
  const series = chart.series[0]!;
  const values = chart.points.map((point) => point.values[series.key] ?? 0);
  const total = values.reduce((sum, value) => (value > 0 ? sum + value : sum), 0);
  const size = 150;
  const paths = pieSlices(values, size / 2, size / 2, size / 2 - 2, size / 2 - 32);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 18 }}>
      <Svg width={size} height={size}>
        {paths.map((path, index) =>
          path ? <Path key={index} d={path} fill={chart.points[index]!.color ?? series.color} stroke="#ffffff" strokeWidth={1} /> : null,
        )}
      </Svg>
      <View style={{ flex: 1, gap: 4 }}>
        {chart.points.map((point, index) => (
          <View key={index} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={[styles.swatch, { backgroundColor: point.color ?? series.color }]} />
            <Text style={{ flex: 1, fontSize: 8.5, maxLines: 1, textOverflow: 'ellipsis' }}>{xLabel(chart, point, format)}</Text>
            <Text style={{ width: 80, fontSize: 8.5, textAlign: 'right' }}>{formatValue(values[index], chart.value, format)}</Text>
            <Text style={[styles.small, { width: 40, textAlign: 'right' }]}>
              {total > 0 && values[index]! > 0 ? formatValue((values[index]! / total) * 100, { kind: 'percent' }, format) : ''}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}
