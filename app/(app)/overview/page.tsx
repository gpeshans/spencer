import { addMonths, format, isValid, parse, parseISO, startOfMonth, subMonths } from 'date-fns';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';

import { BucketGoals } from '@/components/bucket-goals';
import { CategoryBreakdown } from '@/components/category-breakdown';
import { CategoryPie } from '@/components/category-pie';
import { SpendingDayList } from '@/components/spending-day-list';
import { Stat } from '@/components/stat';
import { getBucketTargets } from '@/lib/categories-data';
import { currentMonthStartISO, formatMoney, formatMonthTitle } from '@/lib/format';
import { getMonthData } from '@/lib/reports';

function parseMonth(m?: string): Date {
  if (m) {
    const d = parse(m, 'yyyy-MM', new Date());
    if (isValid(d)) return startOfMonth(d);
  }
  return startOfMonth(parseISO(currentMonthStartISO()));
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>;
}) {
  const { m } = await searchParams;
  const month = parseMonth(m);
  const [data, targets] = await Promise.all([getMonthData(month), getBucketTargets()]);

  const monthKey = format(month, 'yyyy-MM');
  const currentKey = currentMonthStartISO().slice(0, 7);
  const prevKey = format(subMonths(month, 1), 'yyyy-MM');
  const nextKey = format(addMonths(month, 1), 'yyyy-MM');
  const canGoNext = monthKey < currentKey;

  const remaining = data.incomeTotal - data.spentTotal;

  return (
    <div className="flex flex-col gap-6 px-4 pb-6 pt-4">
      {/* Month switcher */}
      <div className="flex items-center justify-between">
        <Link
          href={`/overview?m=${prevKey}`}
          aria-label="Previous month"
          className="rounded-full p-3 text-muted-foreground hover:bg-muted"
        >
          <ChevronLeft className="size-5" />
        </Link>
        <h1 className="text-lg font-semibold tracking-tight">{formatMonthTitle(month)}</h1>
        {canGoNext ? (
          <Link
            href={`/overview?m=${nextKey}`}
            aria-label="Next month"
            className="rounded-full p-3 text-muted-foreground hover:bg-muted"
          >
            <ChevronRight className="size-5" />
          </Link>
        ) : (
          <span className="p-3 text-muted-foreground/30">
            <ChevronRight className="size-5" />
          </span>
        )}
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-2 rounded-2xl border p-4 text-center">
        <Stat label="Income" value={formatMoney(data.incomeTotal)} />
        <Stat label="Spent" value={formatMoney(data.spentTotal)} />
        <Stat
          label="Left"
          value={formatMoney(remaining)}
          tone={remaining >= 0 ? 'positive' : 'negative'}
        />
      </div>

      {data.spentTotal === 0 ? (
        <div className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          No spendings this month yet.
        </div>
      ) : (
        <>
          <section>
            <h2 className="mb-3 text-sm font-medium text-muted-foreground">Buckets vs. goals</h2>
            <BucketGoals
              data={data.byBucket}
              income={data.incomeTotal}
              targets={targets}
              spendings={data.spendings}
            />
          </section>
          <CategoryPie data={data.byCategory} total={data.spentTotal} />
          <CategoryBreakdown data={data.byCategory} total={data.spentTotal} />
          <div>
            <h2 className="mb-2 text-sm font-medium text-muted-foreground">All spendings</h2>
            <SpendingDayList spendings={data.spendings} />
          </div>
        </>
      )}
    </div>
  );
}
