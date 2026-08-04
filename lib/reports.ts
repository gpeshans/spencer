import 'server-only';

import { addMonths, startOfMonth, startOfYear } from 'date-fns';
import type { SupabaseClient } from '@supabase/supabase-js';

import { isoDate, monthRange, todayISO, yearRange } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';
import type { Database, Income, Spending } from '@/types/database';
import type { AuthoredSpending, BucketTotal, CategoryTotal } from '@/types/models';

type DB = SupabaseClient<Database>;

// --- helpers -------------------------------------------------------------

async function authorNames(supabase: DB): Promise<Map<string, string>> {
  const { data } = await supabase.from('profiles').select('id, display_name, email');
  const map = new Map<string, string>();
  (data ?? []).forEach((p) => map.set(p.id, p.display_name ?? p.email ?? 'Member'));
  return map;
}

function attachAuthors(
  rows: Spending[] | null,
  authors: Map<string, string>,
): AuthoredSpending[] {
  return (rows ?? []).map((r) => ({ ...r, authorName: authors.get(r.user_id) ?? 'Member' }));
}

function totalsByCategory(rows: { category: string; amount: number }[]): CategoryTotal[] {
  const m = new Map<string, number>();
  rows.forEach((r) => m.set(r.category, (m.get(r.category) ?? 0) + Number(r.amount)));
  return [...m.entries()]
    .map(([category, total]) => ({ category, total }))
    .sort((a, b) => b.total - a.total);
}

function totalsByBucket(rows: { bucket: string; amount: number }[]): BucketTotal[] {
  const m = new Map<string, number>();
  rows.forEach((r) => m.set(r.bucket, (m.get(r.bucket) ?? 0) + Number(r.amount)));
  return [...m.entries()].map(([bucket, total]) => ({ bucket, total }));
}

function sum(rows: { amount: number }[]): number {
  return rows.reduce((s, r) => s + Number(r.amount), 0);
}

/** Sum of the latest income per category effective on/before the given month. */
function incomeTotalForMonth(rows: Income[], monthStartISO: string): number {
  const latest = new Map<string, number>();
  rows
    .filter((r) => r.effective_from <= monthStartISO)
    .sort((a, b) => a.effective_from.localeCompare(b.effective_from))
    .forEach((r) => latest.set(r.category, Number(r.amount)));
  let total = 0;
  latest.forEach((v) => (total += v));
  return total;
}

// --- loaders -------------------------------------------------------------

export async function getRecentSpendings(limit = 8): Promise<AuthoredSpending[]> {
  const supabase = await createClient();
  const [{ data }, authors] = await Promise.all([
    supabase
      .from('spendings')
      .select('*')
      .order('spent_on', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(limit),
    authorNames(supabase),
  ]);
  return attachAuthors(data, authors);
}

export type MonthData = {
  spendings: AuthoredSpending[];
  byCategory: CategoryTotal[];
  byBucket: BucketTotal[];
  spentTotal: number;
  incomeTotal: number;
};

export async function getMonthData(month: Date): Promise<MonthData> {
  const supabase = await createClient();
  const { start, end } = monthRange(month);
  const [{ data: rows }, { data: incomeRows }, authors] = await Promise.all([
    supabase
      .from('spendings')
      .select('*')
      .gte('spent_on', start)
      .lte('spent_on', end)
      .order('spent_on', { ascending: false })
      .order('created_at', { ascending: false }),
    supabase.from('income').select('*').lte('effective_from', start),
    authorNames(supabase),
  ]);

  const spendings = attachAuthors(rows, authors);
  return {
    spendings,
    byCategory: totalsByCategory(spendings),
    byBucket: totalsByBucket(spendings),
    spentTotal: sum(spendings),
    incomeTotal: incomeTotalForMonth(incomeRows ?? [], start),
  };
}

export type YearData = {
  byMonth: { month: number; spent: number; income: number }[];
  byCategory: CategoryTotal[];
  byBucket: BucketTotal[];
  spentTotal: number;
  incomeTotal: number;
};

export async function getYearData(year: Date): Promise<YearData> {
  const supabase = await createClient();
  const { start, end } = yearRange(year);
  const [{ data: rows }, { data: incomeRows }] = await Promise.all([
    supabase
      .from('spendings')
      .select('category, amount, spent_on, bucket')
      .gte('spent_on', start)
      .lte('spent_on', end),
    supabase.from('income').select('*').lte('effective_from', end),
  ]);

  const spendings = (rows ?? []) as {
    category: string;
    amount: number;
    spent_on: string;
    bucket: string;
  }[];
  const income = incomeRows ?? [];

  const todayStr = todayISO();
  const nowYear = Number(todayStr.slice(0, 4));
  const nowMonth = Number(todayStr.slice(5, 7)) - 1;
  const yearNum = year.getFullYear();

  const byMonth = Array.from({ length: 12 }, (_, m) => {
    const monthStartISO = isoDate(startOfMonth(addMonths(startOfYear(year), m)));
    const spent = sum(spendings.filter((s) => Number(s.spent_on.slice(5, 7)) === m + 1));
    // Only count income for months that have already occurred, so a partial
    // (current) year compares income-to-date against spend-to-date.
    const hasOccurred = yearNum < nowYear || (yearNum === nowYear && m <= nowMonth);
    const monthIncome = hasOccurred ? incomeTotalForMonth(income, monthStartISO) : 0;
    return { month: m, spent, income: monthIncome };
  });

  return {
    byMonth,
    byCategory: totalsByCategory(spendings),
    byBucket: totalsByBucket(spendings),
    spentTotal: sum(spendings),
    incomeTotal: byMonth.reduce((s, m) => s + m.income, 0),
  };
}

/** Latest income amount per category as of today (for the income editor). */
export async function getCurrentIncome(): Promise<Record<string, number>> {
  const supabase = await createClient();
  const today = todayISO();
  const { data } = await supabase
    .from('income')
    .select('*')
    .lte('effective_from', today)
    .order('effective_from', { ascending: true });

  const map: Record<string, number> = {};
  (data ?? []).forEach((r) => {
    map[r.category] = Number(r.amount);
  });
  return map;
}
