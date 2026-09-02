'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { useCurrency } from '@/components/currency-provider';
import { SpendingFields, type SpendingFieldValues } from '@/components/spending-fields';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { updateSpending } from '@/lib/actions/spendings';
import { formatAmountInput, formatShortDate, parseAmount, todayISO } from '@/lib/format';
import type { AuthoredSpending } from '@/types/models';

/**
 * Bottom sheet for editing one spending. The form lives in a child component so
 * that closing the sheet (which unmounts the portal) discards its state — the
 * next open re-seeds from the row as it now stands, after revalidation.
 */
export function EditSpendingSheet({
  spending,
  open,
  onOpenChange,
}: {
  spending: AuthoredSpending;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="gap-5 px-4 pt-3" aria-label="Edit spending">
        <EditSpendingForm spending={spending} onDone={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  );
}

function EditSpendingForm({
  spending,
  onDone,
}: {
  spending: AuthoredSpending;
  onDone: () => void;
}) {
  const groupCurrency = useCurrency();
  // Edit shows what was actually typed, not the converted total — reopening a
  // MKD entry re-shows MKD, not the EUR figure it rolled up into.
  const [values, setValues] = useState<SpendingFieldValues>({
    amount: formatAmountInput(spending.original_amount ?? spending.amount),
    currency: spending.original_currency ?? groupCurrency,
    category: spending.category,
    description: spending.description,
    date: spending.spent_on,
  });
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    const amt = parseAmount(values.amount);
    if (!amt || amt <= 0) {
      toast.error('Enter an amount');
      return;
    }
    const category = values.category;
    if (!category) {
      toast.error('Pick a category');
      return;
    }

    startTransition(async () => {
      const res = await updateSpending({
        id: spending.id,
        amount: amt,
        currency: values.currency,
        category,
        description: values.description,
        spentOn: values.date,
      });
      // Leave the sheet open on failure so the edits aren't thrown away.
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success('Spending updated');
      onDone();
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <SheetTitle>Edit spending</SheetTitle>
        <p className="text-xs text-muted-foreground">
          Added by {spending.authorName} · {formatShortDate(spending.created_at)}
        </p>
      </div>

      <SpendingFields
        value={values}
        onChange={(patch) => setValues((v) => ({ ...v, ...patch }))}
        today={todayISO()}
        compact
        onAmountEnter={handleSave}
      />

      <div className="grid grid-cols-[1fr_2fr] gap-2">
        <Button variant="outline" size="lg" className="h-12" onClick={onDone} disabled={isPending}>
          Cancel
        </Button>
        <Button size="lg" className="h-12" onClick={handleSave} disabled={isPending}>
          {isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
