'use client';

import { type Ref, useMemo } from 'react';

import { useExpenseCategories, useExpenseResolver } from '@/components/categories-provider';
import { useCurrency } from '@/components/currency-provider';
import { Input } from '@/components/ui/input';
import { textOn } from '@/lib/categories';
import { altCurrency } from '@/lib/currencies';
import { cn } from '@/lib/utils';

export type SpendingFieldValues = {
  /** Raw text, parsed with parseAmount() on submit so the locale round-trips. */
  amount: string;
  /** The currency the amount was typed in — usually the group's currency, but
   * switchable (e.g. entering a EUR spend while traveling in an MKD group). */
  currency: string;
  category: string | null;
  description: string;
  /** 'yyyy-MM-dd'. */
  date: string;
};

/**
 * The four inputs every spending is made of, shared by the add screen and the
 * edit sheet. Only the fields live here — each caller keeps its own chrome
 * (the add screen is a full page with a fixed action bar and rapid-entry reset;
 * the sheet is a scrollable overlay with Cancel/Save), which is the part that
 * genuinely differs between them.
 */
export function SpendingFields({
  value,
  onChange,
  today,
  compact,
  amountRef,
  autoFocusAmount,
  onAmountEnter,
}: {
  value: SpendingFieldValues;
  onChange: (patch: Partial<SpendingFieldValues>) => void;
  today: string;
  /** Shrinks the amount block for the sheet, where vertical space is scarce. */
  compact?: boolean;
  amountRef?: Ref<HTMLInputElement>;
  autoFocusAmount?: boolean;
  onAmountEnter?: () => void;
}) {
  const active = useExpenseCategories();
  const resolve = useExpenseResolver();
  const homeCurrency = useCurrency();
  const alt = altCurrency(homeCurrency);
  // Almost always just [home, alt] — a third pill only appears for the rare
  // edit of an entry filed in some other currency, so it's never hidden.
  const currencyOptions = [homeCurrency, alt, value.currency].filter(
    (c, i, arr) => arr.indexOf(c) === i,
  );

  // Editing a spending filed under a since-retired category must not force
  // re-categorising it, so the selected key is always offered even when it has
  // been archived out of the picker. (The add form never hits this branch.)
  const categories = useMemo(() => {
    const selected = value.category;
    if (!selected || active.some((c) => c.key === selected)) return active;
    return [...active, resolve(selected)];
  }, [active, resolve, value.category]);

  return (
    <>
      {/* Amount — the primary input */}
      <div
        className={cn(
          'flex items-end justify-center gap-1 rounded-2xl bg-muted/50 px-4',
          compact ? 'py-5' : 'py-8',
        )}
      >
        <input
          ref={amountRef}
          value={value.amount}
          onChange={(e) => onChange({ amount: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onAmountEnter?.();
          }}
          inputMode="decimal"
          enterKeyHint="done"
          autoFocus={autoFocusAmount}
          placeholder="0"
          aria-label="Amount"
          className={cn(
            'w-full max-w-[65%] bg-transparent text-center font-semibold tabular-nums outline-none placeholder:text-muted-foreground/40',
            compact ? 'text-4xl' : 'text-5xl',
          )}
        />
      </div>

      {/* Currency — one tap to switch (home vs. the other you actually travel with) */}
      <div className="-mt-3 flex justify-center gap-1.5">
        {currencyOptions.map((code) => {
          const isActive = value.currency === code;
          return (
            <button
              key={code}
              type="button"
              aria-pressed={isActive}
              onClick={() => onChange({ currency: code })}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition active:scale-95',
                isActive
                  ? 'border-transparent bg-foreground text-background'
                  : 'border-border bg-card text-muted-foreground',
              )}
            >
              {code}
            </button>
          );
        })}
      </div>

      {/* Category chips */}
      <div>
        <p className="mb-2 text-sm font-medium text-muted-foreground">Category</p>
        <div className="grid grid-cols-4 gap-2">
          {categories.map((c) => {
            const Icon = c.icon;
            const active = value.category === c.key;
            return (
              <button
                key={c.key}
                type="button"
                aria-pressed={active}
                onClick={() => onChange({ category: c.key })}
                className={cn(
                  'flex flex-col items-center gap-1 rounded-xl border p-2 text-[11px] font-medium transition active:scale-95',
                  active ? 'border-transparent' : 'border-border bg-card text-muted-foreground',
                )}
                style={active ? { backgroundColor: c.color, color: textOn(c.color) } : undefined}
              >
                <Icon className="size-5" />
                <span className="w-full truncate text-center">{c.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Note + date */}
      <div className="flex flex-col gap-3">
        <Input
          value={value.description}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="Note (optional)"
          maxLength={200}
          className="h-11"
        />
        <label className="flex items-center justify-between rounded-lg border px-3 py-3 text-sm">
          <span className="text-muted-foreground">Date</span>
          <input
            type="date"
            value={value.date}
            max={today}
            onChange={(e) => onChange({ date: e.target.value })}
            className="bg-transparent text-right font-medium outline-none"
          />
        </label>
      </div>
    </>
  );
}
