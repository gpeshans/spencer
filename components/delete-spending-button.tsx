'use client';

import { Trash2 } from 'lucide-react';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { deleteSpending } from '@/lib/actions/spendings';

export function DeleteSpendingButton({ id }: { id: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      aria-label="Delete spending"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const res = await deleteSpending(id);
          if (res.error) toast.error(res.error);
          else toast.success('Deleted');
        })
      }
      className="ml-1 inline-flex size-11 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:text-destructive active:scale-90 disabled:opacity-40"
    >
      <Trash2 className="size-4" />
    </button>
  );
}
