import 'server-only';

// Free, no-key, no-rate-limit daily exchange rates, ECB/central-bank sourced,
// 200+ currencies (broader than ECB-only providers — covers MKD, RSD, etc).
// https://github.com/fawazahmed0/exchange-api
const SOURCES = (dateOrLatest: string) => [
  `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${dateOrLatest}/v1/currencies`,
  `https://${dateOrLatest}.currency-api.pages.dev/v1/currencies`,
];

/**
 * 1 `from` = ? `to`, using the rate published for `dateOrLatest` ('yyyy-MM-dd'
 * or 'latest'), so a past spending's conversion never drifts as rates move
 * later. Throws if no source has the rate (network issue, or a currency pair
 * gap — CURRENCIES only lists codes this provider actually carries).
 */
export async function fetchFxRate(from: string, to: string, dateOrLatest: string): Promise<number> {
  const f = from.toLowerCase();
  const t = to.toLowerCase();
  if (f === t) return 1;

  for (const base of SOURCES(dateOrLatest)) {
    try {
      const res = await fetch(`${base}/${f}.json`, { next: { revalidate: 60 * 60 * 24 } });
      if (!res.ok) continue;
      const data = (await res.json()) as Record<string, Record<string, number>>;
      const rate = data[f]?.[t];
      if (typeof rate === 'number' && Number.isFinite(rate)) return rate;
    } catch {
      // try the next source
    }
  }
  throw new Error(`Could not fetch the ${from}→${to} exchange rate`);
}
