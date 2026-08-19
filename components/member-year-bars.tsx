'use client';

import { Bar, BarChart, CartesianGrid, XAxis } from 'recharts';

import { MemberLegend } from '@/components/member-legend';
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import { formatMoney } from '@/lib/format';
import { buildMemberSeries } from '@/lib/members';
import type { GroupMember, MemberTotal } from '@/types/models';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Year view: the same twelve monthly totals as "Spending by month", split by
 * who spent them. One Bar per member sharing a stackId; the segments are keyed
 * by slot (`m0`, `m1`, …) because ChartStyle interpolates the key straight into
 * a `--color-<key>` custom property and member UUIDs aren't valid there.
 */
export function MemberYearBars({
  byMonth,
  data,
  members,
}: {
  byMonth: { month: number; byMember: Record<string, number> }[];
  data: MemberTotal[];
  members: GroupMember[];
}) {
  const series = buildMemberSeries(members, data);

  const chartData = byMonth.map((m) => ({
    month: MONTH_NAMES[m.month],
    ...Object.fromEntries(series.map((s) => [s.key, m.byMember[s.userId] ?? 0])),
  }));

  const config: ChartConfig = Object.fromEntries(
    series.map((s) => [s.key, { label: s.name, color: s.color }]),
  );

  return (
    <div className="flex flex-col gap-2">
      <ChartContainer config={config} className="aspect-[4/3] w-full">
        <BarChart data={chartData} margin={{ left: 0, right: 0, top: 8, bottom: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="month"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            tickFormatter={(v) => String(v).slice(0, 1)}
          />
          <ChartTooltip
            content={<ChartTooltipContent formatter={(value) => formatMoney(Number(value))} />}
          />
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              stackId="spent"
              fill={`var(--color-${s.key})`}
              // 2px of surface between segments so the stack reads as parts,
              // and a rounded cap on the topmost one only.
              stroke="var(--color-background)"
              strokeWidth={2}
              radius={i === series.length - 1 ? [4, 4, 0, 0] : 0}
            />
          ))}
        </BarChart>
      </ChartContainer>

      <MemberLegend series={series} />
    </div>
  );
}
