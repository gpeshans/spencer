'use client';

import { Label, Pie, PieChart } from 'recharts';

import { MemberLegend } from '@/components/member-legend';
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import { useFormatMoney } from '@/components/currency-provider';
import { buildMemberSeries } from '@/lib/members';
import type { AuthoredSpending, GroupMember, MemberTotal } from '@/types/models';

/**
 * Month view: who the month's spend went through. A donut for the split at a
 * glance with the month's total in the middle, then the legend, which carries
 * the actual numbers and the drill-down.
 */
export function MemberSplit({
  data,
  members,
  total,
  spendings,
}: {
  data: MemberTotal[];
  members: GroupMember[];
  total: number;
  spendings: AuthoredSpending[];
}) {
  const fmt = useFormatMoney();
  const series = buildMemberSeries(members, data);
  // A zero slice renders as nothing but still claims a paddingAngle gap.
  // Slices are keyed by slot, not by display name: ChartStyle interpolates the
  // config key into a `--color-<key>` custom property, and a name with a space
  // in it would emit an invalid declaration.
  const chartData = series
    .filter((m) => m.total > 0)
    .map((m) => ({ member: m.key, value: m.total, fill: m.color }));

  const config: ChartConfig = Object.fromEntries(
    series.map((m) => [m.key, { label: m.name, color: m.color }]),
  );
  const nameByKey = new Map(series.map((m) => [m.key, m.name]));

  return (
    <div className="flex flex-col gap-2">
      <ChartContainer config={config} className="mx-auto aspect-square w-full max-w-[240px]">
        <PieChart>
          <ChartTooltip
            content={
              <ChartTooltipContent
                nameKey="member"
                hideLabel
                formatter={(value, name) => (
                  <div className="flex w-full items-center justify-between gap-3">
                    <span className="text-muted-foreground">
                      {nameByKey.get(String(name)) ?? String(name)}
                    </span>
                    <span className="font-medium tabular-nums text-foreground">
                      {fmt(Number(value))}
                    </span>
                  </div>
                )}
              />
            }
          />
          <Pie
            data={chartData}
            dataKey="value"
            nameKey="member"
            innerRadius={64}
            outerRadius={100}
            paddingAngle={2}
            strokeWidth={2}
          >
            <Label
              content={({ viewBox }) => {
                if (!viewBox || !('cx' in viewBox) || !('cy' in viewBox)) return null;
                const cx = Number(viewBox.cx);
                const cy = Number(viewBox.cy);
                return (
                  <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle">
                    <tspan x={cx} y={cy - 6} className="fill-foreground text-lg font-semibold">
                      {fmt(total)}
                    </tspan>
                    <tspan x={cx} y={cy + 14} className="fill-muted-foreground text-xs">
                      spent
                    </tspan>
                  </text>
                );
              }}
            />
          </Pie>
        </PieChart>
      </ChartContainer>

      <MemberLegend series={series} spendings={spendings} />
    </div>
  );
}
