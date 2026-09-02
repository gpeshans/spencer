'use client';

import { createContext, useContext, useEffect, useState } from 'react';

import { altCurrency } from '@/lib/currencies';
import { formatMoney } from '@/lib/format';

type CurrencyValue = {
  /** The group's currency, set in Settings — what amounts are stored/entered
   * in by default. Unaffected by the view toggle below. */
  home: string;
  /** What totals are currently rendered in — defaults to `home`, switchable
   * via the EUR/DEN toggle. Not persisted anywhere: every load starts back at
   * `home` for every viewer, so nobody's screen is silently showing a
   * different currency than everyone else's without them noticing — a switch
   * is a visible, momentary "let me peek" on that one screen, not a lasting
   * per-person setting. */
  display: string;
  setDisplay: (code: string) => void;
  /** home -> display, live (today's rate) — 1 when display === home. */
  rate: number;
};

const CurrencyContext = createContext<CurrencyValue | null>(null);

export function CurrencyProvider({
  currency,
  children,
}: {
  currency: string;
  children: React.ReactNode;
}) {
  const [display, setDisplay] = useState(currency);
  const [rate, setRate] = useState(1);

  useEffect(() => {
    if (display === currency) {
      setRate(1);
      return;
    }
    let cancelled = false;
    fetch(`/api/fx-rate?from=${currency}&to=${display}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('fx-rate request failed'))))
      .then((data: { rate: number }) => {
        if (!cancelled) setRate(data.rate);
      })
      .catch(() => {
        // Keep the previous rate rather than silently showing wrong numbers
        // as if the conversion were 1:1.
      });
    return () => {
      cancelled = true;
    };
  }, [currency, display]);

  return (
    <CurrencyContext.Provider value={{ home: currency, display, setDisplay, rate }}>
      {children}
    </CurrencyContext.Provider>
  );
}

function useCurrencyContext(): CurrencyValue {
  const ctx = useContext(CurrencyContext);
  if (!ctx) throw new Error('useCurrency* must be used within a CurrencyProvider');
  return ctx;
}

/** The group's currency (e.g. "EUR"), set in Settings — for the entry-time
 * currency picker (SpendingFields) and its default. Not affected by the view
 * toggle: what you type into is a separate question from what you view in. */
export function useCurrency(): string {
  return useCurrencyContext().home;
}

/** The currency reports are currently displayed in, and its 2-way toggle
 * (home <-> `altCurrency(home)`), for a switch UI. */
export function useDisplayCurrency(): { display: string; alt: string; setDisplay: (code: string) => void } {
  const { home, display, setDisplay } = useCurrencyContext();
  return { display, alt: altCurrency(home), setDisplay };
}

/** Formats an amount that's stored in the group's (home) currency, converted
 * live into whatever the viewer currently has reports displayed in. */
export function useFormatMoney(): (amountInHome: number) => string {
  const { display, rate } = useCurrencyContext();
  return (amountInHome: number) => formatMoney(amountInHome * rate, display);
}
