'use client';

import { CategoryIcon } from '@/components/category-icon';
import { CATEGORY_ICON_NAMES } from '@/lib/category-icons';
import { textOn } from '@/lib/categories';
import { cn } from '@/lib/utils';

/** A scrollable grid of the curated category icons; the selected one is filled. */
export function IconPicker({
  value,
  color,
  onChange,
}: {
  value: string;
  color: string;
  onChange: (name: string) => void;
}) {
  return (
    <div className="grid max-h-40 grid-cols-8 gap-1 overflow-y-auto rounded-lg border p-2">
      {CATEGORY_ICON_NAMES.map((name) => {
        const active = name === value;
        return (
          <button
            key={name}
            type="button"
            aria-label={name}
            aria-pressed={active}
            onClick={() => onChange(name)}
            className={cn(
              'flex aspect-square items-center justify-center rounded-md transition active:scale-90',
              !active && 'text-muted-foreground hover:bg-muted',
            )}
            style={active ? { backgroundColor: color, color: textOn(color) } : undefined}
          >
            <CategoryIcon name={name} className="size-4" />
          </button>
        );
      })}
    </div>
  );
}
