import { catchAllLast } from '@/lib/categories';
import type { CategoryTotal, MemberTotal } from '@/types/models';

// Pure aggregation shared by the server loaders (lib/reports.ts) and the
// client-side bucket drill-down, so both produce the same rows in the same
// order. Kept out of reports.ts, which is `server-only`.

/** Sum amounts per category, biggest first, with the catch-all pinned last. */
export function totalsByCategory(rows: { category: string; amount: number }[]): CategoryTotal[] {
  const m = new Map<string, number>();
  rows.forEach((r) => m.set(r.category, (m.get(r.category) ?? 0) + Number(r.amount)));
  return [...m.entries()]
    .map(([category, total]) => ({ category, total }))
    .sort((a, b) => catchAllLast(a.category) - catchAllLast(b.category) || b.total - a.total);
}

/** Sum amounts per member, biggest first. */
export function totalsByUser(rows: { user_id: string; amount: number }[]): MemberTotal[] {
  const m = new Map<string, number>();
  rows.forEach((r) => m.set(r.user_id, (m.get(r.user_id) ?? 0) + Number(r.amount)));
  return [...m.entries()]
    .map(([userId, total]) => ({ userId, total }))
    .sort((a, b) => b.total - a.total);
}
