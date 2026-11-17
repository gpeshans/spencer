'use client';

import type { ReactNode } from 'react';
import {
  Bar,
  BarChart,
  type BarShapeProps,
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  Rectangle,
  XAxis,
  YAxis,
} from 'recharts';
import { formatValue, type ChartSpec, type FormatOptions } from 'report-engine/report';

import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';

/**
 * A section drawn as the engine's chart spec says: the same chart the PDF
 * draws, in Recharts. Series keys (s0, s1, …) double as the colour variables
 * ChartContainer sets, --color-s0 and so on. Nothing animates: a report is
 * read, not watched, and it appears whole.
 */

interface Datum {
  x: string;
  /** A colour of the point's own: one bar of a single series. */
  color?: string;
  [series: string]: unknown;
}

const truncate = (text: string, max = 14) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function TooltipRow({ label, value }: { label: ReactNode; value: string }) {
  return (
    <div className="flex w-full items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums text-foreground">{value}</span>
    </div>
  );
}

/** One bar of a single series, in its value's own colour when it has one. */
function ColouredBar(props: BarShapeProps) {
  const own = (props.payload as Datum | undefined)?.color;
  return <Rectangle {...props} fill={own ?? props.fill} />;
}

export function ReportChart({ chart, format }: { chart: ChartSpec; format: FormatOptions }) {
  const compact: FormatOptions = { ...format, compact: true };
  const config: ChartConfig = Object.fromEntries(chart.series.map((series) => [series.key, { label: series.label, color: series.color }]));
  const label = (point: ChartSpec['points'][number]) => point.label ?? formatValue(point.x, chart.x.format, compact);
  const show = (value: unknown) => formatValue(value, chart.value, format);
  const tick = (value: unknown) => formatValue(value, chart.value, compact);

  if (chart.type === 'pie') return <Ring chart={chart} format={format} config={config} label={label} />;

  const data: Datum[] = chart.points.map((point) => ({ x: label(point), ...(point.color ? { color: point.color } : {}), ...point.values }));
  const single = chart.series.length === 1;
  const tooltip = (
    <ChartTooltip
      content={<ChartTooltipContent formatter={(value, name) => <TooltipRow label={config[String(name)]?.label ?? name} value={show(value)} />} />}
    />
  );
  const legend = single ? null : <ChartLegend content={<ChartLegendContent />} />;

  if (chart.type === 'bar' && chart.orientation === 'horizontal') {
    // One row per point, so long names fit on a phone; the value sits at the end of a lone series' bar.
    const rowHeight = chart.stacked || single ? 30 : 14 * chart.series.length + 12;
    return (
      <ChartContainer config={config} className="aspect-auto w-full" style={{ height: Math.max(96, data.length * rowHeight + (legend ? 40 : 8)) }}>
        <BarChart data={data} layout="vertical" margin={{ left: 0, right: single ? 76 : 8, top: 0, bottom: 0 }}>
          <XAxis type="number" hide />
          <YAxis
            type="category"
            dataKey="x"
            width={112}
            interval={0}
            tickLine={false}
            axisLine={false}
            tickFormatter={(value: string) => truncate(value)}
          />
          {tooltip}
          {chart.series.map((series) => (
            <Bar
              key={series.key}
              dataKey={series.key}
              fill={`var(--color-${series.key})`}
              stackId={chart.stacked ? 'stack' : undefined}
              radius={chart.stacked ? 0 : 4}
              shape={single ? ColouredBar : undefined}
              isAnimationActive={false}
            >
              {single && <LabelList dataKey={series.key} position="right" className="fill-foreground" formatter={(value) => show(value)} />}
            </Bar>
          ))}
          {legend}
        </BarChart>
      </ChartContainer>
    );
  }

  const axes = (
    <>
      <CartesianGrid vertical={false} />
      <XAxis dataKey="x" tickLine={false} axisLine={false} tickMargin={8} minTickGap={12} />
      <YAxis width={68} tickLine={false} axisLine={false} tickFormatter={tick} />
    </>
  );

  if (chart.type === 'line') {
    return (
      <ChartContainer config={config} className="aspect-[4/3] w-full">
        <LineChart data={data} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
          {axes}
          {tooltip}
          {chart.series.map((series) => (
            <Line
              key={series.key}
              dataKey={series.key}
              type="linear"
              stroke={`var(--color-${series.key})`}
              strokeWidth={2}
              dot={data.length <= 40}
              isAnimationActive={false}
            />
          ))}
          {legend}
        </LineChart>
      </ChartContainer>
    );
  }

  return (
    <ChartContainer config={config} className="aspect-[4/3] w-full">
      <BarChart data={data} margin={{ left: 0, right: 0, top: 8, bottom: 0 }}>
        {axes}
        {tooltip}
        {chart.series.map((series) => (
          <Bar
            key={series.key}
            dataKey={series.key}
            fill={`var(--color-${series.key})`}
            stackId={chart.stacked ? 'stack' : undefined}
            radius={chart.stacked ? 0 : 4}
            shape={single ? ColouredBar : undefined}
            isAnimationActive={false}
          />
        ))}
        {legend}
      </BarChart>
    </ChartContainer>
  );
}

/** A ring of slices, with each slice's value and share listed under it. */
function Ring({
  chart,
  format,
  config,
  label,
}: {
  chart: ChartSpec;
  format: FormatOptions;
  config: ChartConfig;
  label: (point: ChartSpec['points'][number]) => string;
}) {
  const series = chart.series[0]!;
  const slices = chart.points.map((point) => ({ x: label(point), value: point.values[series.key] ?? 0, fill: point.color ?? series.color }));
  const total = slices.reduce((sum, slice) => (slice.value > 0 ? sum + slice.value : sum), 0);
  return (
    <div className="flex flex-col gap-3">
      <ChartContainer config={config} className="mx-auto aspect-square w-full max-w-[240px]">
        <PieChart>
          <ChartTooltip
            content={
              <ChartTooltipContent
                hideLabel
                nameKey="x"
                formatter={(value, name) => <TooltipRow label={name} value={formatValue(value, chart.value, format)} />}
              />
            }
          />
          <Pie
            data={slices}
            dataKey="value"
            nameKey="x"
            innerRadius={60}
            outerRadius={100}
            paddingAngle={2}
            strokeWidth={2}
            isAnimationActive={false}
          />
        </PieChart>
      </ChartContainer>
      <ul className="flex flex-col gap-1.5 text-sm">
        {slices.map((slice, index) => (
          <li key={index} className="flex items-center gap-2">
            <span className="size-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: slice.fill }} />
            <span className="min-w-0 flex-1 truncate">{slice.x}</span>
            <span className="tabular-nums">{formatValue(slice.value, chart.value, format)}</span>
            <span className="w-12 text-right text-xs text-muted-foreground tabular-nums">
              {total > 0 && slice.value > 0 ? formatValue((slice.value / total) * 100, { kind: 'percent' }, format) : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
