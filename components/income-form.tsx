'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { useIncomeCategories } from '@/components/categories-provider';
import { useCurrency } from '@/components/currency-provider';
import { Button } from '@/components/ui/button';
import { saveIncome } from '@/lib/actions/income';
import { formatMoney, parseAmount } from '@/lib/format';

const toNumber = (s: string | undefined) => parseAmount(s ?? '') || 0;

export function IncomeForm({ current }: { current: Record<string, number> }) {
  const categories = useIncomeCategories();
  const currency = useCurrency();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      categories.map((c) => [c.key, current[c.key] ? String(current[c.key]) : '']),
    ),
  );
  const [isPending, startTransition] = useTransition();

  const total = categories.reduce((s, c) => s + toNumber(values[c.key]), 0);

  function save() {
    const items = categories.map((c) => ({ category: c.key, amount: toNumber(values[c.key]) }));
    startTransition(async () => {
      const res = await saveIncome(items);
      if (res.error) toast.error(res.error);
      else toast.success('Income saved');
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {categories.map((c) => {
        const Icon = c.icon;
        return (
          <div key={c.key} className="flex items-center gap-3">
            <div
              className="flex size-10 shrink-0 items-center justify-center rounded-full"
              style={{ backgroundColor: `${c.color}1a`, color: c.color }}
            >
              <Icon className="size-5" />
            </div>
            <label htmlFor={`inc-${c.key}`} className="flex-1 font-medium">
              {c.label}
            </label>
            <div className="flex items-center gap-1 rounded-lg border px-3 py-2">
              <span className="text-muted-foreground">€</span>
              <input
                id={`inc-${c.key}`}
                value={values[c.key]}
                onChange={(e) => setValues((v) => ({ ...v, [c.key]: e.target.value }))}
                inputMode="decimal"
                placeholder="0"
                className="w-24 bg-transparent text-right font-medium tabular-nums outline-none"
              />
            </div>
          </div>
        );
      })}

      <div className="flex items-center justify-between border-t pt-4">
        <span className="text-sm text-muted-foreground">Monthly total</span>
        <span className="text-lg font-semibold tabular-nums">{formatMoney(total, currency)}</span>
      </div>

      <Button onClick={save} disabled={isPending} size="lg" className="h-12 w-full">
        {isPending ? 'Saving…' : 'Save income'}
      </Button>
    </div>
  );
}
