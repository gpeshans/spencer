'use client';

import { ChevronDown } from 'lucide-react';
import { useMemo, useState } from 'react';

import { CategoryBreakdown } from '@/components/category-breakdown';
import { SpendingActions } from '@/components/spending-actions';
import { SpendingRow } from '@/components/spending-row';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useFormatMoney } from '@/components/currency-provider';
import { initialsFrom } from '@/lib/format';
import type { MemberSeries } from '@/lib/members';
import { totalsByCategory } from '@/lib/totals';
import { cn } from '@/lib/utils';
import type { AuthoredSpending } from '@/types/models';

/** Row metrics, identical tappable or not, so a member with no spend keeps the rhythm. */
const ROW_BOX = '-mx-2 flex items-center gap-3 rounded-xl px-2 py-2 text-left';

/**
 * Identity for the split-by-member charts: avatar, name, share and amount. It's
 * the legend, so it is always present — the colour of a slice or a stack segment
 * only means something next to it. Values wear text tokens, never the member
 * colour; the avatar ring beside them carries the identity.
 *
 * Pass `spendings` (the month's rows) to make the rows tappable: one member
 * expands at a time into their categories and then their individual spendings.
 * The year view omits it — its loader doesn't fetch whole rows — so the rows
 * stay static there, exactly as the bucket goal chart behaves.
 */
export function MemberLegend({
  series,
  spendings,
}: {
  series: MemberSeries[];
  spendings?: AuthoredSpending[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  const fmt = useFormatMoney();

  const rowsByMember = useMemo(() => {
    const m = new Map<string, AuthoredSpending[]>();
    for (const s of spendings ?? []) {
      const arr = m.get(s.user_id);
      if (arr) arr.push(s);
      else m.set(s.user_id, [s]);
    }
    return m;
  }, [spendings]);

  return (
    <div className="flex flex-col">
      {series.map((m) => {
        const rows = rowsByMember.get(m.userId) ?? [];
        const expandable = rows.length > 0;
        const isOpen = expandable && open === m.userId;
        const panelId = `member-panel-${m.key}`;

        const content = (
          <>
            {/* The colour ring is what ties this row to its slice / stack segment. */}
            <Avatar className="size-8 shrink-0" style={{ boxShadow: `0 0 0 2px ${m.color}` }}>
              {m.avatarUrl ? (
                <AvatarImage src={m.avatarUrl} alt="" referrerPolicy="no-referrer" />
              ) : null}
              <AvatarFallback className="text-xs">
                {initialsFrom(m.name, m.email)}
              </AvatarFallback>
            </Avatar>
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="truncate text-sm font-medium">{m.name}</span>
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
            <span className="text-sm tabular-nums text-muted-foreground">
              {Math.round(m.pct)}%
            </span>
            <span className="w-24 text-right text-sm font-medium tabular-nums">
              {fmt(m.total)}
            </span>
          </>
        );

        return (
          <div key={m.userId} className="flex flex-col">
            {expandable ? (
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setOpen(isOpen ? null : m.userId)}
                className={cn(ROW_BOX, 'transition hover:bg-muted/50 active:bg-muted')}
              >
                {content}
              </button>
            ) : (
              <div className={ROW_BOX}>{content}</div>
            )}

            {isOpen && <MemberPanel id={panelId} member={m} rows={rows} />}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Drill-down for one member: their categories, then the spendings behind them.
 * Ordered by the breakdown so it reads as a table of contents for the list —
 * the same treatment the bucket drill-down gets.
 */
function MemberPanel({
  id,
  member,
  rows,
}: {
  id: string;
  member: MemberSeries;
  rows: AuthoredSpending[];
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
      aria-label={`${member.name}'s spendings`}
      className="mt-1 mb-2 border-l-2 pl-3"
      style={{ borderColor: `${member.color}66` }}
    >
      <CategoryBreakdown data={byCategory} total={member.total} />
      <div className="mt-2 divide-y border-t">
        {ordered.map((s) => (
          <SpendingRow
            key={s.id}
            category={s.category}
            description={s.description}
            amount={s.amount}
            authorName={s.authorName}
            originalCurrency={s.original_currency}
            originalAmount={s.original_amount}
            trailing={<SpendingActions spending={s} />}
          />
        ))}
      </div>
    </div>
  );
}
