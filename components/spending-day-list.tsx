import { DeleteSpendingButton } from '@/components/delete-spending-button';
import { SpendingRow } from '@/components/spending-row';
import { formatDayHeading, formatMoney } from '@/lib/format';
import type { AuthoredSpending } from '@/types/models';

// Groups spendings by day (input is already sorted spent_on desc, created_at desc).
export function SpendingDayList({ spendings }: { spendings: AuthoredSpending[] }) {
  const groups = new Map<string, AuthoredSpending[]>();
  for (const s of spendings) {
    const arr = groups.get(s.spent_on);
    if (arr) arr.push(s);
    else groups.set(s.spent_on, [s]);
  }

  return (
    <div className="flex flex-col gap-5">
      {[...groups.entries()].map(([day, items]) => {
        const dayTotal = items.reduce((sum, i) => sum + Number(i.amount), 0);
        return (
          <div key={day}>
            <div className="mb-0.5 flex items-baseline justify-between">
              <h3 className="text-sm font-medium text-muted-foreground">
                {formatDayHeading(day)}
              </h3>
              <span className="text-sm tabular-nums text-muted-foreground">
                {formatMoney(dayTotal)}
              </span>
            </div>
            <div className="divide-y">
              {items.map((s) => (
                <SpendingRow
                  key={s.id}
                  category={s.category}
                  description={s.description}
                  amount={s.amount}
                  authorName={s.authorName}
                  trailing={<DeleteSpendingButton id={s.id} />}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
