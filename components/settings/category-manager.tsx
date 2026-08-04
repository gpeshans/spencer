'use client';

import { Archive, Pencil, Plus, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { CategoryIcon } from '@/components/category-icon';
import { CategoryForm } from '@/components/settings/category-form';
import { Button } from '@/components/ui/button';
import { setCategoryActive } from '@/lib/actions/categories';
import { BUCKET_BY_KEY, type CategoryDTO, type CategoryKind } from '@/lib/categories';

const bySort = (a: CategoryDTO, b: CategoryDTO) => a.sort - b.sort;

export function CategoryManager({
  kind,
  categories,
}: {
  kind: CategoryKind;
  categories: CategoryDTO[];
}) {
  // Which row is being edited: a category id, 'new', or null.
  const [editing, setEditing] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const active = categories.filter((c) => c.active).sort(bySort);
  const archived = categories.filter((c) => !c.active).sort(bySort);
  const title = kind === 'expense' ? 'Expense categories' : 'Income categories';

  async function toggle(c: CategoryDTO) {
    if (!c.id) return;
    setBusyId(c.id);
    const res = await setCategoryActive(c.id, !c.active);
    setBusyId(null);
    if (res.error) toast.error(res.error);
    else toast.success(c.active ? 'Category archived' : 'Category restored');
  }

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
        {editing !== 'new' && (
          <Button size="sm" variant="outline" onClick={() => setEditing('new')}>
            <Plus /> Add
          </Button>
        )}
      </div>

      {editing === 'new' && <CategoryForm kind={kind} onDone={() => setEditing(null)} />}

      <div className="flex flex-col divide-y">
        {active.map((c) =>
          editing === c.id ? (
            <div key={c.id} className="py-2">
              <CategoryForm kind={kind} initial={c} onDone={() => setEditing(null)} />
            </div>
          ) : (
            <Row
              key={c.id ?? c.key}
              c={c}
              busy={busyId === c.id}
              onEdit={() => c.id && setEditing(c.id)}
              onToggle={() => toggle(c)}
            />
          ),
        )}
      </div>

      {archived.length > 0 && (
        <>
          <p className="mt-2 text-xs font-medium text-muted-foreground">Archived</p>
          <div className="flex flex-col divide-y opacity-60">
            {archived.map((c) => (
              <Row
                key={c.id ?? c.key}
                c={c}
                archived
                busy={busyId === c.id}
                onEdit={() => c.id && setEditing(c.id)}
                onToggle={() => toggle(c)}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function Row({
  c,
  archived,
  busy,
  onEdit,
  onToggle,
}: {
  c: CategoryDTO;
  archived?: boolean;
  busy: boolean;
  onEdit: () => void;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center gap-3 py-2">
      <div
        className="flex size-9 shrink-0 items-center justify-center rounded-full"
        style={{ backgroundColor: `${c.color}1a`, color: c.color }}
      >
        <CategoryIcon name={c.iconName} className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{c.label}</p>
        {c.bucket && (
          <p className="truncate text-xs text-muted-foreground">{BUCKET_BY_KEY[c.bucket].label}</p>
        )}
      </div>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`Edit ${c.label}`}
        onClick={onEdit}
        disabled={busy}
      >
        <Pencil />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`${archived ? 'Restore' : 'Archive'} ${c.label}`}
        onClick={onToggle}
        disabled={busy}
      >
        {archived ? <RotateCcw /> : <Archive />}
      </Button>
    </div>
  );
}
