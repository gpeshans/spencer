'use server';

import { revalidatePath } from 'next/cache';

import { getCategories } from '@/lib/categories-data';
import { isSupportedCurrency } from '@/lib/currencies';
import { fetchFxRate } from '@/lib/fx';
import { todayISO } from '@/lib/format';
import { getAuthed, getGroupContext } from '@/lib/session';

type Result = { error: string | null };

function revalidateAll() {
  revalidatePath('/');
  revalidatePath('/overview');
  revalidatePath('/year');
}

/**
 * `amount` is always stored in the group's currency, so every report/total
 * keeps summing it with no awareness of multi-currency entries. When the
 * entered currency differs, convert at the rate for spentOn — locked to that
 * date, not "live" — so a March EUR spend keeps March's rate even if the rate
 * moves later. A same-day entry uses 'latest' (that day's file may not be
 * published yet).
 */
type Converted =
  | { ok: true; amount: number; original: { original_currency: string; original_amount: number; fx_rate: number } | null }
  | { ok: false; error: string };

async function convert(
  rawAmount: number,
  currency: string,
  groupCurrency: string,
  spentOn: string,
): Promise<Converted> {
  if (currency === groupCurrency) return { ok: true, amount: rawAmount, original: null };

  try {
    const dateOrLatest = spentOn < todayISO() ? spentOn : 'latest';
    const rate = await fetchFxRate(currency, groupCurrency, dateOrLatest);
    const amount = Math.round(rawAmount * rate * 100) / 100;
    return {
      ok: true,
      amount,
      original: { original_currency: currency, original_amount: rawAmount, fx_rate: rate },
    };
  } catch {
    return { ok: false, error: 'Could not fetch the exchange rate — try again' };
  }
}

export async function addSpending(input: {
  amount: number;
  currency: string;
  category: string;
  description: string;
  spentOn: string;
}): Promise<Result> {
  const ctx = await getGroupContext();
  if (!ctx) return { error: 'Not authorized' };

  const rawAmount = Math.round(Number(input.amount) * 100) / 100;
  if (!Number.isFinite(rawAmount) || rawAmount <= 0) return { error: 'Enter a valid amount' };
  if (!isSupportedCurrency(input.currency)) return { error: 'Pick a supported currency' };
  const { expense } = await getCategories();
  if (!expense.some((c) => c.active && c.key === input.category)) {
    return { error: 'Pick a category' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.spentOn)) return { error: 'Invalid date' };

  const converted = await convert(rawAmount, input.currency, ctx.group.currency, input.spentOn);
  if (!converted.ok) return { error: converted.error };

  // group_id + user_id are filled by DB column defaults from the session.
  const { error } = await ctx.supabase.from('spendings').insert({
    amount: converted.amount,
    category: input.category,
    description: input.description.trim().slice(0, 200),
    spent_on: input.spentOn,
    original_currency: converted.original?.original_currency ?? null,
    original_amount: converted.original?.original_amount ?? null,
    fx_rate: converted.original?.fx_rate ?? null,
  });
  if (error) return { error: error.message };

  revalidateAll();
  return { error: null };
}

export async function updateSpending(input: {
  id: string;
  amount: number;
  currency: string;
  category: string;
  description: string;
  spentOn: string;
}): Promise<Result> {
  const ctx = await getGroupContext();
  if (!ctx) return { error: 'Not authorized' };

  const rawAmount = Math.round(Number(input.amount) * 100) / 100;
  if (!Number.isFinite(rawAmount) || rawAmount <= 0) return { error: 'Enter a valid amount' };
  if (!isSupportedCurrency(input.currency)) return { error: 'Pick a supported currency' };
  // Archived categories are accepted here but not in addSpending: an old row
  // filed under a since-retired category must stay editable (fixing its amount
  // shouldn't force re-categorising it). New rows still can't be filed there.
  const { expense } = await getCategories();
  if (!expense.some((c) => c.key === input.category)) {
    return { error: 'Pick a category' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.spentOn)) return { error: 'Invalid date' };

  const converted = await convert(rawAmount, input.currency, ctx.group.currency, input.spentOn);
  if (!converted.ok) return { error: converted.error };

  // bucket + updated_at are trigger-owned (spendings_set_bucket fires on a
  // category change), so they're never sent. Selecting the id back is the only
  // way to notice an update the RLS policy filtered out: those report no error,
  // just zero rows, which would otherwise look like a successful save.
  const { data, error } = await ctx.supabase
    .from('spendings')
    .update({
      amount: converted.amount,
      category: input.category,
      description: input.description.trim().slice(0, 200),
      spent_on: input.spentOn,
      original_currency: converted.original?.original_currency ?? null,
      original_amount: converted.original?.original_amount ?? null,
      fx_rate: converted.original?.fx_rate ?? null,
    })
    .eq('id', input.id)
    .select('id');
  if (error) return { error: error.message };
  if (!data?.length) return { error: 'Spending not found' };

  revalidateAll();
  return { error: null };
}

export async function deleteSpending(id: string): Promise<Result> {
  const authed = await getAuthed();
  if (!authed) return { error: 'Not authorized' };

  // RLS restricts the delete to the caller's own group.
  const { error } = await authed.supabase.from('spendings').delete().eq('id', id);
  if (error) return { error: error.message };

  revalidateAll();
  return { error: null };
}
