'use server';

import { revalidatePath } from 'next/cache';

import { isSupportedCurrency } from '@/lib/currencies';
import { fetchFxRate } from '@/lib/fx';
import { todayISO } from '@/lib/format';
import { getGroupContext } from '@/lib/session';

type Result = { error: string | null };

function revalidateAll() {
  revalidatePath('/');
  revalidatePath('/overview');
  revalidatePath('/year');
  revalidatePath('/income');
  revalidatePath('/settings');
}

/**
 * Changing the group's currency must re-convert every existing amount, not
 * just relabel it — `amount` is stored in "whatever the group's currency was
 * at the time", so switching EUR -> MKD without this would leave a "10.00"
 * that used to mean €10 now silently read as 10 MKD (~60x too small).
 *
 * For a spending, the currency it was actually in before this change is
 * `original_currency` if set (it was entered in something other than the old
 * base currency), otherwise the old base currency itself. Income has no
 * per-entry currency — it was always in the old base currency.
 */
export async function saveCurrency(currency: string): Promise<Result> {
  const ctx = await getGroupContext();
  if (!ctx) return { error: 'Not authorized' };
  if (!isSupportedCurrency(currency)) return { error: 'Pick a supported currency' };

  const oldCurrency = ctx.group.currency;
  if (currency === oldCurrency) return { error: null };

  const today = todayISO();
  const rateCache = new Map<string, Promise<number>>();
  function getRate(from: string, dateOrLatest: string): Promise<number> {
    if (from === currency) return Promise.resolve(1);
    const key = `${from}|${dateOrLatest}`;
    let p = rateCache.get(key);
    if (!p) {
      p = fetchFxRate(from, currency, dateOrLatest);
      rateCache.set(key, p);
    }
    return p;
  }

  try {
    const [{ data: spendings, error: spendErr }, { data: incomes, error: incomeErr }] =
      await Promise.all([
        ctx.supabase
          .from('spendings')
          .select('id, amount, spent_on, original_currency, original_amount')
          .eq('group_id', ctx.group.id),
        ctx.supabase.from('income').select('id, amount, effective_from').eq('group_id', ctx.group.id),
      ]);
    if (spendErr) return { error: spendErr.message };
    if (incomeErr) return { error: incomeErr.message };

    // All FX lookups happen here, before any write — if a rate can't be
    // fetched, nothing has been touched yet and the action just errors out.
    const spendingUpdates = await Promise.all(
      (spendings ?? []).map(async (row) => {
        const sourceCurrency = row.original_currency ?? oldCurrency;
        const sourceAmount = row.original_amount ?? Number(row.amount);
        const dateOrLatest = row.spent_on < today ? row.spent_on : 'latest';
        const rate = await getRate(sourceCurrency, dateOrLatest);
        const amount = Math.round(sourceAmount * rate * 100) / 100;
        const differs = sourceCurrency !== currency;
        return {
          id: row.id,
          amount,
          original_currency: differs ? sourceCurrency : null,
          original_amount: differs ? sourceAmount : null,
          fx_rate: differs ? rate : null,
        };
      }),
    );

    const incomeUpdates = await Promise.all(
      (incomes ?? []).map(async (row) => {
        const dateOrLatest = row.effective_from < today ? row.effective_from : 'latest';
        const rate = await getRate(oldCurrency, dateOrLatest);
        return { id: row.id, amount: Math.round(Number(row.amount) * rate * 100) / 100 };
      }),
    );

    for (const u of spendingUpdates) {
      const { error } = await ctx.supabase
        .from('spendings')
        .update({
          amount: u.amount,
          original_currency: u.original_currency,
          original_amount: u.original_amount,
          fx_rate: u.fx_rate,
        })
        .eq('id', u.id);
      if (error) return { error: error.message };
    }
    for (const u of incomeUpdates) {
      const { error } = await ctx.supabase.from('income').update({ amount: u.amount }).eq('id', u.id);
      if (error) return { error: error.message };
    }

    const { error } = await ctx.supabase.from('groups').update({ currency }).eq('id', ctx.group.id);
    if (error) return { error: error.message };
  } catch {
    return { error: 'Could not fetch exchange rates to convert existing entries — try again' };
  }

  revalidateAll();
  return { error: null };
}
