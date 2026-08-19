'use client';

import { Pencil } from 'lucide-react';
import { useState } from 'react';

import { DeleteSpendingButton } from '@/components/delete-spending-button';
import { EditSpendingSheet } from '@/components/edit-spending-sheet';
import type { AuthoredSpending } from '@/types/models';

/**
 * The per-row trailing controls: edit + delete. Goes into SpendingRow's
 * `trailing` slot, which keeps SpendingRow itself presentational and means the
 * "Recent" list on the add screen — whose optimistic rows carry synthetic ids —
 * simply doesn't opt in.
 *
 * It also supplies the client boundary the sheet needs: SpendingDayList is a
 * server component and can't own dialog state, but it can render this.
 */
export function SpendingActions({ spending }: { spending: AuthoredSpending }) {
  const [editing, setEditing] = useState(false);

  return (
    <>
      <button
        type="button"
        aria-label={`Edit ${spending.description || 'spending'}`}
        onClick={() => setEditing(true)}
        className="ml-1 inline-flex size-11 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:text-foreground active:scale-90"
      >
        <Pencil className="size-4" />
      </button>
      <DeleteSpendingButton id={spending.id} />
      <EditSpendingSheet spending={spending} open={editing} onOpenChange={setEditing} />
    </>
  );
}
