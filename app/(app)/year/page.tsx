import { isValid, parse, parseISO, startOfYear } from 'date-fns';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';

import { BucketGoals } from '@/components/bucket-goals';
import { CategoryBreakdown } from '@/components/category-breakdown';
import { MemberYearBars } from '@/components/member-year-bars';
import { Stat } from '@/components/stat';
import { YearBars } from '@/components/year-bars';
import { getBucketTargets } from '@/lib/categories-data';
import { formatMoney, todayISO } from '@/lib/format';
import { getYearData } from '@/lib/reports';
import { getGroupContext } from '@/lib/session';

function parseYear(y?: string): Date {
  if (y && /^\d{4}$/.test(y)) {
    const d = parse(y, 'yyyy', new Date());
    if (isValid(d)) return startOfYear(d);
  }
  return startOfYear(parseISO(todayISO()));
}

export default async function YearPage({
  searchParams,
}: {
  searchParams: Promise<{ y?: string }>;
}) {
  const { y } = await searchParams;
  const year = parseYear(y);
  // getGroupContext() is React-cached, so this reuses the layout's auth round trip.
  const [data, targets, ctx] = await Promise.all([
    getYearData(year),
    getBucketTargets(),
    getGroupContext(),
  ]);

  const yearNum = year.getFullYear();
  const currentYear = Number(todayISO().slice(0, 4));
  const canGoNext = yearNum < currentYear;
  const saved = data.incomeTotal - data.spentTotal;

  return (
    <div className="flex flex-col gap-6 px-4 pb-6 pt-4">
      {/* Year switcher */}
      <div className="flex items-center justify-between">
        <Link
          href={`/year?y=${yearNum - 1}`}
          aria-label="Previous year"
          className="rounded-full p-3 text-muted-foreground hover:bg-muted"
        >
          <ChevronLeft className="size-5" />
        </Link>
        <h1 className="text-lg font-semibold tracking-tight">{yearNum}</h1>
        {canGoNext ? (
          <Link
            href={`/year?y=${yearNum + 1}`}
            aria-label="Next year"
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
          label="Saved"
          value={formatMoney(saved)}
          tone={saved >= 0 ? 'positive' : 'negative'}
        />
      </div>

      {data.spentTotal === 0 ? (
        <div className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          No spendings recorded in {yearNum}.
        </div>
      ) : (
        <>
          <div>
            <h2 className="mb-2 text-sm font-medium text-muted-foreground">Spending by month</h2>
            <YearBars data={data.byMonth} />
          </div>
          <div>
            <h2 className="mb-3 text-sm font-medium text-muted-foreground">Buckets vs. goals</h2>
            <BucketGoals data={data.byBucket} income={data.incomeTotal} targets={targets} />
          </div>
          <div>
            <h2 className="mb-1 text-sm font-medium text-muted-foreground">By category</h2>
            <CategoryBreakdown data={data.byCategory} total={data.spentTotal} />
          </div>
          <div>
            <h2 className="mb-2 text-sm font-medium text-muted-foreground">Split by member</h2>
            <MemberYearBars
              byMonth={data.byMonth}
              data={data.byMember}
              members={ctx?.members ?? []}
            />
          </div>
        </>
      )}
    </div>
  );
}
