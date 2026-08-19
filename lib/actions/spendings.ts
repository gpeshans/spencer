'use server';

import { revalidatePath } from 'next/cache';

import { getCategories } from '@/lib/categories-data';
import { getAuthed } from '@/lib/session';

type Result = { error: string | null };

function revalidateAll() {
  revalidatePath('/');
  revalidatePath('/overview');
  revalidatePath('/year');
}

export async function addSpending(input: {
  amount: number;
  category: string;
  description: string;
  spentOn: string;
}): Promise<Result> {
  const authed = await getAuthed();
  if (!authed) return { error: 'Not authorized' };

  const amount = Math.round(Number(input.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'Enter a valid amount' };
  const { expense } = await getCategories();
  if (!expense.some((c) => c.active && c.key === input.category)) {
    return { error: 'Pick a category' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.spentOn)) return { error: 'Invalid date' };

  // group_id + user_id are filled by DB column defaults from the session.
  const { error } = await authed.supabase.from('spendings').insert({
    amount,
    category: input.category,
    description: input.description.trim().slice(0, 200),
    spent_on: input.spentOn,
  });
  if (error) return { error: error.message };

  revalidateAll();
  return { error: null };
}

export async function updateSpending(input: {
  id: string;
  amount: number;
  category: string;
  description: string;
  spentOn: string;
}): Promise<Result> {
  const authed = await getAuthed();
  if (!authed) return { error: 'Not authorized' };

  const amount = Math.round(Number(input.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'Enter a valid amount' };
  // Archived categories are accepted here but not in addSpending: an old row
  // filed under a since-retired category must stay editable (fixing its amount
  // shouldn't force re-categorising it). New rows still can't be filed there.
  const { expense } = await getCategories();
  if (!expense.some((c) => c.key === input.category)) {
    return { error: 'Pick a category' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.spentOn)) return { error: 'Invalid date' };

  // bucket + updated_at are trigger-owned (spendings_set_bucket fires on a
  // category change), so they're never sent. Selecting the id back is the only
  // way to notice an update the RLS policy filtered out: those report no error,
  // just zero rows, which would otherwise look like a successful save.
  const { data, error } = await authed.supabase
    .from('spendings')
    .update({
      amount,
      category: input.category,
      description: input.description.trim().slice(0, 200),
      spent_on: input.spentOn,
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
