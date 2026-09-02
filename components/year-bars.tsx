'use client';

import { Bar, BarChart, CartesianGrid, XAxis } from 'recharts';

import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import { useFormatMoney } from '@/components/currency-provider';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const config = { spent: { label: 'Spent', color: '#1c7ed6' } } satisfies ChartConfig;

export function YearBars({ data }: { data: { month: number; spent: number }[] }) {
  const fmt = useFormatMoney();
  const chartData = data.map((d) => ({ month: MONTH_NAMES[d.month], spent: d.spent }));

  return (
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
          content={<ChartTooltipContent formatter={(value) => fmt(Number(value))} />}
        />
        <Bar dataKey="spent" fill="var(--color-spent)" radius={4} />
      </BarChart>
    </ChartContainer>
  );
}
