'use client';

import { Label, Pie, PieChart } from 'recharts';

import { useExpenseResolver } from '@/components/categories-provider';
import { useFormatMoney } from '@/components/currency-provider';
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import type { CategoryTotal } from '@/types/models';

export function CategoryPie({ data, total }: { data: CategoryTotal[]; total: number }) {
  const resolve = useExpenseResolver();
  const fmt = useFormatMoney();

  const chartData = data.map((d) => ({
    category: d.category,
    value: d.total,
    fill: resolve(d.category).color,
  }));

  const config: ChartConfig = Object.fromEntries(
    data.map((d) => {
      const cat = resolve(d.category);
      return [d.category, { label: cat.label, color: cat.color }];
    }),
  );

  return (
    <ChartContainer config={config} className="mx-auto aspect-square w-full max-w-[260px]">
      <PieChart>
        <ChartTooltip
          content={
            <ChartTooltipContent
              nameKey="category"
              hideLabel
              formatter={(value, name) => (
                <div className="flex w-full items-center justify-between gap-3">
                  <span className="text-muted-foreground">
                    {resolve(String(name)).label}
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
          nameKey="category"
          innerRadius={70}
          outerRadius={110}
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
  );
}
