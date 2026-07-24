'use server';

import { revalidatePath } from 'next/cache';

import { EXPENSE_BY_KEY } from '@/lib/categories';
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
  if (!EXPENSE_BY_KEY[input.category]) return { error: 'Pick a category' };
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

export async function deleteSpending(id: string): Promise<Result> {
  const authed = await getAuthed();
  if (!authed) return { error: 'Not authorized' };

  // RLS restricts the delete to the caller's own group.
  const { error } = await authed.supabase.from('spendings').delete().eq('id', id);
  if (error) return { error: error.message };

  revalidateAll();
  return { error: null };
}
