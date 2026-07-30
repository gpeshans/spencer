'use client';

import { useOptimistic, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { SpendingRow } from '@/components/spending-row';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { addSpending } from '@/lib/actions/spendings';
import { EXPENSE_CATEGORIES, textOn } from '@/lib/categories';
import { parseAmount } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AuthoredSpending } from '@/types/models';

export function AddSpendingForm({
  recent,
  today,
}: {
  recent: AuthoredSpending[];
  today: string;
}) {
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(today);
  const [isPending, startTransition] = useTransition();
  const amountRef = useRef<HTMLInputElement>(null);
  const [optimisticRecent, addOptimistic] = useOptimistic<AuthoredSpending[], AuthoredSpending>(
    recent,
    (state, item) => [item, ...state].slice(0, 8),
  );

  function handleSubmit() {
    const amt = parseAmount(amount);
    if (!amt || amt <= 0) {
      toast.error('Enter an amount');
      return;
    }
    if (!category) {
      toast.error('Pick a category');
      return;
    }

    const nowIso = new Date().toISOString();
    const optimistic: AuthoredSpending = {
      id: `optimistic-${nowIso}`,
      group_id: '',
      user_id: '',
      amount: amt,
      category,
      description: description.trim(),
      spent_on: date,
      created_at: nowIso,
      updated_at: nowIso,
      authorName: 'You',
    };

    startTransition(async () => {
      addOptimistic(optimistic);
      const res = await addSpending({ amount: amt, category, description, spentOn: date });
      if (res.error) toast.error(res.error);
      else toast.success('Spending added');
    });

    // Reset for rapid entry; keep category + date, and keep the amount focused.
    setAmount('');
    setDescription('');
    amountRef.current?.focus();
  }

  return (
    <>
      <div className="flex flex-col gap-6 px-4 pt-4 pb-[calc(6rem+env(safe-area-inset-bottom))]">
        <h1 className="text-xl font-semibold tracking-tight">Add spending</h1>

        {/* Amount — the primary input */}
        <div className="flex items-end justify-center gap-1 rounded-2xl bg-muted/50 px-4 py-8">
          <span className="pb-2 text-2xl font-medium text-muted-foreground">€</span>
          <input
            ref={amountRef}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSubmit();
            }}
            inputMode="decimal"
            enterKeyHint="done"
            autoFocus
            placeholder="0"
            aria-label="Amount"
            className="w-full max-w-[65%] bg-transparent text-center text-5xl font-semibold tabular-nums outline-none placeholder:text-muted-foreground/40"
          />
        </div>

        {/* Category chips */}
        <div>
          <p className="mb-2 text-sm font-medium text-muted-foreground">Category</p>
          <div className="grid grid-cols-4 gap-2">
            {EXPENSE_CATEGORIES.map((c) => {
              const Icon = c.icon;
              const active = category === c.key;
              return (
                <button
                  key={c.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setCategory(c.key)}
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
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Note (optional)"
            maxLength={200}
            className="h-11"
          />
          <label className="flex items-center justify-between rounded-lg border px-3 py-3 text-sm">
            <span className="text-muted-foreground">Date</span>
            <input
              type="date"
              value={date}
              max={today}
              onChange={(e) => setDate(e.target.value)}
              className="bg-transparent text-right font-medium outline-none"
            />
          </label>
        </div>

        {optimisticRecent.length > 0 && (
          <div>
            <p className="mb-1 text-sm font-medium text-muted-foreground">Recent</p>
            <div className="divide-y">
              {optimisticRecent.map((s) => (
                <SpendingRow
                  key={s.id}
                  category={s.category}
                  description={s.description}
                  amount={s.amount}
                  authorName={s.authorName}
                  dimmed={s.id.startsWith('optimistic-')}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Fixed thumb-zone action bar, sitting just above the bottom nav */}
      <div className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-40 mx-auto max-w-md border-t bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <Button
          onClick={handleSubmit}
          disabled={isPending}
          size="lg"
          className="h-14 w-full text-base"
        >
          {isPending ? 'Adding…' : 'Add spending'}
        </Button>
      </div>
    </>
  );
}
