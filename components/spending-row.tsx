'use client';

import { useExpenseResolver } from '@/components/categories-provider';
import { useDisplayCurrency, useFormatMoney } from '@/components/currency-provider';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

export function SpendingRow({
  category,
  description,
  amount,
  authorName,
  originalCurrency,
  originalAmount,
  dimmed,
  trailing,
}: {
  category: string;
  description: string;
  amount: number;
  authorName: string;
  /** Set only when entered in a currency other than the group's. */
  originalCurrency?: string | null;
  originalAmount?: number | null;
  dimmed?: boolean;
  trailing?: React.ReactNode;
}) {
  const cat = useExpenseResolver()(category);
  const Icon = cat.icon;
  const fmt = useFormatMoney();
  const { display } = useDisplayCurrency();

  // `amount` is stored in the home currency, converted once at entry time —
  // exact. Re-converting it AGAIN live (fmt) for display only introduces
  // avoidable rounding drift when the row's own original currency already
  // *is* what's being displayed (e.g. a 300 MKD entry, viewed in MKD, showing
  // "300.11" because it round-tripped through two independent rate lookups).
  // When that's the case, show the exact figure that was actually typed.
  const isOriginalShownAsMain = !!(
    originalCurrency &&
    originalAmount != null &&
    originalCurrency === display
  );
  const mainAmount = isOriginalShownAsMain
    ? formatMoney(originalAmount!, originalCurrency!)
    : fmt(amount);

  return (
    <div className={cn('flex items-center gap-3 py-2.5', dimmed && 'opacity-50')}>
      <div
        className="flex size-10 shrink-0 items-center justify-center rounded-full"
        style={{ backgroundColor: `${cat.color}1a`, color: cat.color }}
      >
        <Icon className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{description || cat.label}</p>
        <p className="truncate text-xs text-muted-foreground">
          {cat.label} · {authorName}
          {originalCurrency && originalAmount != null && !isOriginalShownAsMain && (
            <> · {formatMoney(originalAmount, originalCurrency)}</>
          )}
        </p>
      </div>
      <div className="flex items-center gap-1">
        <span className="font-medium tabular-nums">{mainAmount}</span>
        {trailing}
      </div>
    </div>
  );
}
