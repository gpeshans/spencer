'use client';

import { useOptimistic, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { useExpenseCategories } from '@/components/categories-provider';
import { SpendingActions } from '@/components/spending-actions';
import { SpendingFields, type SpendingFieldValues } from '@/components/spending-fields';
import { SpendingRow } from '@/components/spending-row';
import { Button } from '@/components/ui/button';
import { addSpending } from '@/lib/actions/spendings';
import { parseAmount } from '@/lib/format';
import type { AuthoredSpending } from '@/types/models';

export function AddSpendingForm({
  recent,
  today,
}: {
  recent: AuthoredSpending[];
  today: string;
}) {
  const [values, setValues] = useState<SpendingFieldValues>({
    amount: '',
    category: null,
    description: '',
    date: today,
  });
  const [isPending, startTransition] = useTransition();
  const categories = useExpenseCategories();
  const amountRef = useRef<HTMLInputElement>(null);
  const [optimisticRecent, addOptimistic] = useOptimistic<AuthoredSpending[], AuthoredSpending>(
    recent,
    (state, item) => [item, ...state].slice(0, 8),
  );

  const patch = (p: Partial<SpendingFieldValues>) => setValues((v) => ({ ...v, ...p }));

  function handleSubmit() {
    const { amount, category, description, date } = values;
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
      bucket: categories.find((c) => c.key === category)?.bucket ?? 'wants',
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
    patch({ amount: '', description: '' });
    amountRef.current?.focus();
  }

  return (
    <>
      <div className="flex flex-col gap-6 px-4 pt-4 pb-[calc(6rem+env(safe-area-inset-bottom))]">
        <h1 className="text-xl font-semibold tracking-tight">Add spending</h1>

        <SpendingFields
          value={values}
          onChange={patch}
          today={today}
          amountRef={amountRef}
          autoFocusAmount
          onAmountEnter={handleSubmit}
        />

        {optimisticRecent.length > 0 && (
          <div>
            <p className="mb-1 text-sm font-medium text-muted-foreground">Recent</p>
            <div className="divide-y">
              {optimisticRecent.map((s) => {
                // An optimistic row's id is synthetic, so editing or deleting it
                // would address a row the server doesn't have. It gets its
                // actions once revalidation swaps it for the stored one.
                const pending = s.id.startsWith('optimistic-');
                return (
                  <SpendingRow
                    key={s.id}
                    category={s.category}
                    description={s.description}
                    amount={s.amount}
                    authorName={s.authorName}
                    dimmed={pending}
                    trailing={pending ? undefined : <SpendingActions spending={s} />}
                  />
                );
              })}
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
