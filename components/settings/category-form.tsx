'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { CategoryIcon } from '@/components/category-icon';
import { IconPicker } from '@/components/settings/icon-picker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createCategory, updateCategory } from '@/lib/actions/categories';
import {
  BUCKETS,
  type BucketKey,
  type CategoryDTO,
  type CategoryKind,
} from '@/lib/categories';
import { cn } from '@/lib/utils';

// The app's category palette (Open Color family) offered as quick swatches.
const PALETTE = [
  '#2f9e44', '#099268', '#15aabf', '#1c7ed6', '#3b5bdb', '#6741d9', '#ae3ec9',
  '#e64980', '#c2255c', '#e03131', '#e8590c', '#f59f00', '#9c6644', '#868e96',
];

export function CategoryForm({
  kind,
  initial,
  onDone,
}: {
  kind: CategoryKind;
  initial?: CategoryDTO;
  onDone: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [iconName, setIconName] = useState(initial?.iconName ?? 'circle');
  const [color, setColor] = useState(initial?.color ?? PALETTE[0]);
  const [bucket, setBucket] = useState<BucketKey>(initial?.bucket ?? 'needs');
  const [pending, start] = useTransition();

  function submit() {
    start(async () => {
      const payload = { kind, label, iconName, color, bucket: kind === 'expense' ? bucket : null };
      const res = initial?.id
        ? await updateCategory({ id: initial.id, ...payload })
        : await createCategory(payload);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(initial ? 'Category updated' : 'Category added');
      onDone();
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-muted/30 p-3">
      {/* Live preview + name */}
      <div className="flex items-center gap-3">
        <div
          className="flex size-10 shrink-0 items-center justify-center rounded-full"
          style={{ backgroundColor: `${color}1a`, color }}
        >
          <CategoryIcon name={iconName} className="size-5" />
        </div>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Category name"
          maxLength={40}
          className="h-10"
          autoFocus
        />
      </div>

      {/* Color */}
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">Color</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={c}
              onClick={() => setColor(c)}
              className={cn(
                'size-6 rounded-full transition active:scale-90',
                color.toLowerCase() === c
                  ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background'
                  : 'ring-1 ring-black/10',
              )}
              style={{ backgroundColor: c }}
            />
          ))}
          <label
            className="inline-flex size-6 cursor-pointer items-center justify-center rounded-full border border-dashed text-muted-foreground"
            aria-label="Custom color"
          >
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="sr-only"
            />
            <span className="text-xs leading-none">+</span>
          </label>
        </div>
      </div>

      {/* Icon */}
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">Icon</p>
        <IconPicker value={iconName} color={color} onChange={setIconName} />
      </div>

      {/* Bucket (expense only) */}
      {kind === 'expense' && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Bucket</p>
          <div className="grid grid-cols-2 gap-1.5">
            {BUCKETS.map((b) => {
              const active = bucket === b.key;
              return (
                <button
                  key={b.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setBucket(b.key)}
                  className={cn(
                    'rounded-lg border px-2.5 py-2 text-xs font-medium transition active:scale-95',
                    active
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border text-muted-foreground hover:bg-muted',
                  )}
                >
                  {b.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <Button onClick={submit} disabled={pending} size="lg" className="h-10 flex-1">
          {pending ? 'Saving…' : initial ? 'Save' : 'Add category'}
        </Button>
        <Button onClick={onDone} disabled={pending} variant="outline" size="lg" className="h-10">
          Cancel
        </Button>
      </div>
    </div>
  );
}
