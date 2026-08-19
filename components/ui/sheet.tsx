'use client';

import { Dialog } from '@base-ui/react/dialog';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * A dialog anchored to the bottom of the screen. The app is mobile-first, so
 * overlays slide up into the thumb zone instead of landing in the middle of the
 * viewport. Base UI ships the primitive; this file is only the app's styling of
 * it — the same approach components/user-menu.tsx takes with Base UI's Menu.
 *
 * Named "sheet" rather than "dialog" so a centred dialog can be added alongside
 * it later without a collision.
 *
 * Positioning notes: the portal renders at the end of <body>, outside the app's
 * `mx-auto max-w-md` column, so the viewport re-establishes it. z-[60] clears
 * the fixed bottom nav (z-50).
 */
const Sheet = Dialog.Root;
const SheetTrigger = Dialog.Trigger;
const SheetClose = Dialog.Close;

function SheetContent({ className, children, ...props }: ComponentProps<typeof Dialog.Popup>) {
  return (
    <Dialog.Portal>
      <Dialog.Backdrop
        className={cn(
          'fixed inset-0 z-[60] bg-black/50',
          'transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0',
        )}
      />
      <Dialog.Viewport className="fixed inset-x-0 bottom-0 z-[60] mx-auto max-w-md">
        <Dialog.Popup
          className={cn(
            'flex max-h-[85dvh] flex-col overflow-y-auto overscroll-contain rounded-t-2xl border-t bg-background outline-none',
            'pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-[0_-8px_32px_rgb(0_0_0/0.12)]',
            'transition-transform duration-200 ease-out data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full',
            className,
          )}
          {...props}
        >
          {/* Grab handle: the conventional "this is a sheet, it dismisses downward" cue. */}
          <div
            aria-hidden
            className="mx-auto mt-2.5 h-1 w-9 shrink-0 rounded-full bg-muted-foreground/25"
          />
          {children}
        </Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
  );
}

function SheetTitle({ className, ...props }: ComponentProps<typeof Dialog.Title>) {
  return (
    <Dialog.Title
      className={cn('text-base font-semibold tracking-tight', className)}
      {...props}
    />
  );
}

function SheetDescription({ className, ...props }: ComponentProps<typeof Dialog.Description>) {
  return <Dialog.Description className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

export { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle, SheetTrigger };
