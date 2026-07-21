import { expenseCategory } from '@/lib/categories';
import { formatMoney } from '@/lib/format';
import type { CategoryTotal } from '@/types/models';

/** Text-first category breakdown: color swatch + label + % + amount. */
export function CategoryBreakdown({ data, total }: { data: CategoryTotal[]; total: number }) {
  return (
    <div className="flex flex-col">
      {data.map((c) => {
        const cat = expenseCategory(c.category);
        const pct = total > 0 ? Math.round((c.total / total) * 100) : 0;
        return (
          <div key={c.category} className="flex items-center gap-3 py-1.5">
            <span className="size-3 shrink-0 rounded-[3px]" style={{ background: cat.color }} />
            <span className="flex-1 truncate text-sm">{cat.label}</span>
            <span className="text-sm tabular-nums text-muted-foreground">{pct}%</span>
            <span className="w-24 text-right text-sm font-medium tabular-nums">
              {formatMoney(c.total)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
