'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { saveBucketTargets } from '@/lib/actions/categories';
import { BUCKETS, type BucketKey } from '@/lib/categories';
import { cn } from '@/lib/utils';

export function TargetsEditor({ initial }: { initial: Record<BucketKey, number> }) {
  const [values, setValues] = useState<Record<BucketKey, string>>(
    () => Object.fromEntries(BUCKETS.map((b) => [b.key, String(initial[b.key])])) as Record<BucketKey, string>,
  );
  const [pending, start] = useTransition();

  const total = BUCKETS.reduce((s, b) => s + (Number(values[b.key]) || 0), 0);
  const balanced = Math.round(total) === 100;

  function save() {
    const targets = Object.fromEntries(
      BUCKETS.map((b) => [b.key, Number(values[b.key]) || 0]),
    ) as Record<BucketKey, number>;
    start(async () => {
      const res = await saveBucketTargets(targets);
      if (res.error) toast.error(res.error);
      else toast.success('Targets saved');
    });
  }

  return (
    <div className="flex flex-col gap-2 rounded-2xl border p-4">
      {BUCKETS.map((b) => (
        <div key={b.key} className="flex items-center gap-3">
          <label htmlFor={`target-${b.key}`} className="flex-1 text-sm font-medium">
            {b.label}
          </label>
          <div className="flex items-center gap-1 rounded-lg border px-3 py-1.5">
            <input
              id={`target-${b.key}`}
              value={values[b.key]}
              onChange={(e) => setValues((v) => ({ ...v, [b.key]: e.target.value }))}
              inputMode="numeric"
              placeholder="0"
              className="w-12 bg-transparent text-right font-medium tabular-nums outline-none"
            />
            <span className="text-muted-foreground">%</span>
          </div>
        </div>
      ))}

      <div className="mt-1 flex items-center justify-between border-t pt-3">
        <span className="text-sm text-muted-foreground">Total</span>
        <span
          className={cn(
            'text-sm font-semibold tabular-nums',
            balanced ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive',
          )}
        >
          {Math.round(total)}%
        </span>
      </div>

      <Button
        onClick={save}
        disabled={pending || !balanced}
        size="lg"
        className="mt-1 h-11 w-full"
      >
        {pending ? 'Saving…' : balanced ? 'Save targets' : 'Must total 100%'}
      </Button>
    </div>
  );
}
