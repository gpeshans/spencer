'use client';

import { useExpenseResolver } from '@/components/categories-provider';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

export function SpendingRow({
  category,
  description,
  amount,
  authorName,
  dimmed,
  trailing,
}: {
  category: string;
  description: string;
  amount: number;
  authorName: string;
  dimmed?: boolean;
  trailing?: React.ReactNode;
}) {
  const cat = useExpenseResolver()(category);
  const Icon = cat.icon;

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
        </p>
      </div>
      <div className="flex items-center gap-1">
        <span className="font-medium tabular-nums">{formatMoney(amount)}</span>
        {trailing}
      </div>
    </div>
  );
}
