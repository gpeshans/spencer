'use client';

import { useFormatMoney } from '@/components/currency-provider';
import { cn } from '@/lib/utils';

export function Stat({
  label,
  amount,
  tone,
}: {
  label: string;
  /** Stored in the group's home currency — formatted in whatever reports are
   * currently displayed in. */
  amount: number;
  tone?: 'positive' | 'negative';
}) {
  const fmt = useFormatMoney();
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          'mt-0.5 text-sm font-semibold leading-tight tabular-nums',
          tone === 'positive' && 'text-green-700 dark:text-green-400',
          tone === 'negative' && 'text-red-600 dark:text-red-400',
        )}
      >
        {fmt(amount)}
      </p>
    </div>
  );
}
