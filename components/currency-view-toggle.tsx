'use client';

import { useCurrency, useDisplayCurrency } from '@/components/currency-provider';
import { cn } from '@/lib/utils';

/** EUR/DEN switch for what currency reports (totals, charts) render in — a
 * view preference only, doesn't touch stored data. Same pill style as the
 * entry-time currency toggle on Add. */
export function CurrencyViewToggle() {
  const home = useCurrency();
  const { display, alt, setDisplay } = useDisplayCurrency();
  const options = [home, alt];

  return (
    <div className="flex justify-center gap-1.5">
      {options.map((code) => {
        const isActive = display === code;
        return (
          <button
            key={code}
            type="button"
            aria-pressed={isActive}
            onClick={() => setDisplay(code)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition active:scale-95',
              isActive
                ? 'border-transparent bg-foreground text-background'
                : 'border-border bg-card text-muted-foreground',
            )}
          >
            {code}
          </button>
        );
      })}
    </div>
  );
}
