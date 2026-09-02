'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { saveCurrency } from '@/lib/actions/settings';
import { CURRENCIES } from '@/lib/currencies';

export function CurrencyEditor({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  const [pending, start] = useTransition();

  const dirty = value !== initial;

  function save() {
    start(async () => {
      const res = await saveCurrency(value);
      if (res.error) toast.error(res.error);
      else toast.success('Currency saved');
    });
  }

  return (
    <div className="flex items-center gap-2 rounded-2xl border p-4">
      <label htmlFor="currency" className="flex-1 text-sm font-medium">
        Currency
      </label>
      <select
        id="currency"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="rounded-lg border bg-transparent px-3 py-1.5 text-sm font-medium outline-none"
      >
        {CURRENCIES.map((c) => (
          <option key={c.code} value={c.code}>
            {c.code} — {c.label}
          </option>
        ))}
      </select>
      <Button onClick={save} disabled={pending || !dirty} size="sm">
        {pending ? 'Saving…' : 'Save'}
      </Button>
    </div>
  );
}
