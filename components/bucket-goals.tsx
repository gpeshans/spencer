import { BUCKETS, type BucketKey } from '@/lib/categories';
import { formatMoney } from '@/lib/format';
import type { BucketTotal } from '@/types/models';

/**
 * Bullet-style goal chart: one bar per bucket comparing actual spend to its
 * target share of income. The colored fill is the actual % of income; the
 * vertical tick marks the target %. Each bar has its own scale (with headroom)
 * so small buckets stay readable — identity is carried by label + amounts.
 */
export function BucketGoals({
  data,
  income,
  targets,
}: {
  data: BucketTotal[];
  income: number;
  targets: Record<BucketKey, number>;
}) {
  const actualByBucket = new Map(data.map((d) => [d.bucket, d.total]));
  const hasIncome = income > 0;

  return (
    <div className="flex flex-col gap-4">
      {BUCKETS.map((b) => {
        const actual = actualByBucket.get(b.key) ?? 0;
        const targetPct = targets[b.key] ?? b.defaultTargetPct;
        const targetAmount = (income * targetPct) / 100;
        const actualPct = hasIncome ? (actual / income) * 100 : 0;
        const scaleMax = Math.max(actualPct, targetPct, 1) * 1.25;

        return (
          <div key={b.key} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: b.color }} />
                <span className="truncate font-medium">{b.label}</span>
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
