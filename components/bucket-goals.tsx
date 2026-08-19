'use client';

import { ChevronDown } from 'lucide-react';
import { useMemo, useState } from 'react';

import { CategoryBreakdown } from '@/components/category-breakdown';
import { SpendingActions } from '@/components/spending-actions';
import { SpendingRow } from '@/components/spending-row';
import { BUCKETS, type Bucket, type BucketKey } from '@/lib/categories';
import { formatMoney } from '@/lib/format';
import { totalsByCategory } from '@/lib/totals';
import { cn } from '@/lib/utils';
import type { AuthoredSpending, BucketTotal } from '@/types/models';

/** Box metrics for one bar, identical whether or not it's tappable, so an empty
 *  (non-expandable) bucket keeps the chart's vertical rhythm. */
const BAR_BOX = '-mx-2 flex flex-col gap-1.5 rounded-xl px-2 py-1 text-left';

/**
 * Bullet-style goal chart: one bar per bucket comparing actual spend to its
 * target share of income. The colored fill is the actual % of income; the
 * vertical tick marks the target %. Each bar has its own scale (with headroom)
 * so small buckets stay readable — identity is carried by label + amounts.
 *
 * Pass `spendings` (the month's rows) to make the bars tappable: one bucket
 * expands at a time into a panel listing its categories and then its individual
 * spendings. The year view omits it — its loader doesn't fetch whole rows — so
 * the bars stay static there.
 */
export function BucketGoals({
  data,
  income,
  targets,
  spendings,
}: {
  data: BucketTotal[];
  income: number;
  targets: Record<BucketKey, number>;
  spendings?: AuthoredSpending[];
}) {
  const actualByBucket = new Map(data.map((d) => [d.bucket, d.total]));
  const hasIncome = income > 0;

  const [open, setOpen] = useState<BucketKey | null>(null);

  // Group on the row's own `bucket` column — the same field totalsByBucket()
  // aggregates for the bar amounts, so a panel always sums to its bar.
  const rowsByBucket = useMemo(() => {
    const m = new Map<string, AuthoredSpending[]>();
    for (const s of spendings ?? []) {
      const arr = m.get(s.bucket);
      if (arr) arr.push(s);
      else m.set(s.bucket, [s]);
    }
    return m;
  }, [spendings]);

  return (
    <div className="flex flex-col gap-4">
      {BUCKETS.map((b) => {
        const actual = actualByBucket.get(b.key) ?? 0;
        const targetPct = targets[b.key] ?? b.defaultTargetPct;
        const targetAmount = (income * targetPct) / 100;
        const actualPct = hasIncome ? (actual / income) * 100 : 0;
        const scaleMax = Math.max(actualPct, targetPct, 1) * 1.25;

        const rows = rowsByBucket.get(b.key) ?? [];
        const expandable = rows.length > 0;
        const isOpen = expandable && open === b.key;
        const panelId = `bucket-panel-${b.key}`;

        const bar = (
          <>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: b.color }} />
                <span className="truncate font-medium">{b.label}</span>
                {expandable && (
                  <ChevronDown
                    aria-hidden
                    className={cn(
                      'size-4 shrink-0 text-muted-foreground transition-transform',
                      isOpen && 'rotate-180',
                    )}
                  />
                )}
              </span>
              <span className="shrink-0 tabular-nums">
                <span className="font-medium">{formatMoney(actual)}</span>
                {hasIncome && (
                  <span className="text-muted-foreground"> / {formatMoney(targetAmount)}</span>
                )}
              </span>
            </div>

            <div className="relative h-2.5 rounded-full bg-muted">
              <div
                className="absolute inset-y-0 left-0 rounded-full"
                style={{ width: `${(actualPct / scaleMax) * 100}%`, background: b.color }}
              />
              {hasIncome && (
                <span
                  aria-hidden
                  className="absolute inset-y-[-2px] w-0.5 rounded-full bg-foreground/70"
                  style={{ left: `${(targetPct / scaleMax) * 100}%` }}
                />
              )}
            </div>

            {hasIncome && (
              <div className="flex justify-between text-xs tabular-nums text-muted-foreground">
                <span>{Math.round(actualPct)}% of income</span>
                <span>goal {Math.round(targetPct)}%</span>
              </div>
            )}
          </>
        );

        return (
          <div key={b.key} className="flex flex-col gap-1.5">
            {expandable ? (
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setOpen(isOpen ? null : b.key)}
                className={cn(BAR_BOX, 'transition hover:bg-muted/50 active:bg-muted')}
              >
                {bar}
              </button>
            ) : (
              <div className={BAR_BOX}>{bar}</div>
            )}

            {isOpen && <BucketPanel id={panelId} bucket={b} rows={rows} total={actual} />}
          </div>
        );
      })}

      {!hasIncome && (
        <p className="text-xs text-muted-foreground">
          Set your monthly income to compare spending against your goals.
        </p>
      )}
    </div>
  );
}

/**
 * Drill-down for one bucket: its categories, then the spendings behind them.
 * The rows follow the breakdown's order (and are biggest-first inside each
 * category) so the breakdown reads as a table of contents for the list — the
 * rows don't show dates, so their stored date order would look arbitrary here.
 */
function BucketPanel({
  id,
  bucket,
  rows,
  total,
}: {
  id: string;
  bucket: Bucket;
  rows: AuthoredSpending[];
  total: number;
}) {
  const byCategory = totalsByCategory(rows);
  const rank = new Map(byCategory.map((c, i) => [c.category, i]));
  const ordered = [...rows].sort(
    (a, b) =>
      (rank.get(a.category) ?? 0) - (rank.get(b.category) ?? 0) ||
      Number(b.amount) - Number(a.amount),
  );

  return (
    <div
      id={id}
      role="region"
      aria-label={`${bucket.label} spendings`}
      className="mt-1 border-l-2 pl-3"
      style={{ borderColor: `${bucket.color}66` }}
    >
      <CategoryBreakdown data={byCategory} total={total} />
      <div className="mt-2 divide-y border-t">
        {ordered.map((s) => (
          <SpendingRow
            key={s.id}
            category={s.category}
            description={s.description}
            amount={s.amount}
            authorName={s.authorName}
            trailing={<SpendingActions spending={s} />}
          />
        ))}
      </div>
    </div>
  );
}
