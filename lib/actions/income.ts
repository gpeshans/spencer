'use server';

import { revalidatePath } from 'next/cache';

import { getCategories } from '@/lib/categories-data';
import { currentMonthStartISO } from '@/lib/format';
import { getProfile } from '@/lib/session';

type Result = { error: string | null };

export async function saveIncome(
  items: { category: string; amount: number }[],
): Promise<Result> {
  const ctx = await getProfile();
  if (!ctx) return { error: 'Not authorized' };

  // Effective from the start of the current month -> applies this month onward,
  // leaving previous months' reports unchanged.
  const effective_from = currentMonthStartISO();

  const { income } = await getCategories();
  const allowed = new Set(income.filter((c) => c.active).map((c) => c.key));

  const rows = items
    .filter((i) => allowed.has(i.category) && Number.isFinite(i.amount) && i.amount >= 0)
    .map((i) => ({
      group_id: ctx.profile.group_id, // explicit so the upsert conflict target is complete
      category: i.category,
      amount: Math.round(Number(i.amount) * 100) / 100,
      effective_from,
    }));

  if (rows.length === 0) return { error: null };

  const { error } = await ctx.supabase
    .from('income')
    .upsert(rows, { onConflict: 'group_id,category,effective_from' });
  if (error) return { error: error.message };

  revalidatePath('/income');
  revalidatePath('/overview');
  revalidatePath('/year');
  return { error: null };
}
