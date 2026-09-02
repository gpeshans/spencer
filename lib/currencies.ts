/** Currencies selectable in Settings. ISO 4217 codes; keep to ones formatMoney's
 * Intl.NumberFormat renders correctly out of the box. */
export const CURRENCIES = [
  { code: 'EUR', label: 'Euro' },
  { code: 'USD', label: 'US Dollar' },
  { code: 'GBP', label: 'British Pound' },
  { code: 'CHF', label: 'Swiss Franc' },
  { code: 'MKD', label: 'Macedonian Denar' },
  { code: 'RSD', label: 'Serbian Dinar' },
  { code: 'BGN', label: 'Bulgarian Lev' },
  { code: 'JPY', label: 'Japanese Yen' },
  { code: 'CAD', label: 'Canadian Dollar' },
  { code: 'AUD', label: 'Australian Dollar' },
] as const;

export type CurrencyCode = (typeof CURRENCIES)[number]['code'];

export function isSupportedCurrency(code: string): code is CurrencyCode {
  return CURRENCIES.some((c) => c.code === code);
}

/** The currency you'd switch to from `home` with one tap — EUR<->MKD is the
 * concrete travel case (Greece vs. home); anything else falls back to EUR. */
export function altCurrency(home: string): string {
  return home === 'EUR' ? 'MKD' : 'EUR';
}
