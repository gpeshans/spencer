'use server';

import { revalidatePath } from 'next/cache';

import { BUCKET_KEYS, type BucketKey, type CategoryKind } from '@/lib/categories';
import { CATEGORY_ICONS } from '@/lib/category-icons';
import { getAuthed, getProfile } from '@/lib/session';

type Result = { error: string | null };

function revalidateAll() {
  revalidatePath('/');
  revalidatePath('/overview');
  revalidatePath('/year');
  revalidatePath('/income');
  revalidatePath('/settings');
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** A URL/DB-safe slug used as the stable category key. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

type CategoryInput = {
  kind: CategoryKind;
  label: string;
  iconName: string;
  color: string;
  bucket: BucketKey | null;
};

function validateShape(input: CategoryInput): string | null {
  if (!input.label.trim()) return 'Enter a name';
  if (!(input.iconName in CATEGORY_ICONS)) return 'Pick an icon';
  if (!HEX.test(input.color)) return 'Pick a valid color';
  if (input.kind === 'expense' && (!input.bucket || !BUCKET_KEYS.includes(input.bucket))) {
    return 'Pick a bucket';
  }
  return null;
}

export async function createCategory(input: CategoryInput): Promise<Result> {
  const authed = await getAuthed();
  if (!authed) return { error: 'Not authorized' };

  const problem = validateShape(input);
  if (problem) return { error: problem };

  const key = slugify(input.label);
  if (!key) return { error: 'Enter a name with letters or numbers' };

  // Append to the end of its list (max sort + 10). "Other" is pinned last at
  // render time (compareCategories), so a new category still lands above it.
  const { data: last } = await authed.supabase
    .from('categories')
    .select('sort')
    .eq('kind', input.kind)
    .order('sort', { ascending: false })
    .limit(1)
    .maybeSingle();

  // group_id is filled by the DB default (current_group_id()).
  const { error } = await authed.supabase.from('categories').insert({
    kind: input.kind,
    key,
    label: input.label.trim(),
    icon_name: input.iconName,
    color: input.color,
    bucket: input.kind === 'expense' ? input.bucket : null,
    sort: (last?.sort ?? 0) + 10,
  });
  if (error) {
    if (error.code === '23505') return { error: 'A category with that name already exists' };
    return { error: error.message };
  }

  revalidateAll();
  return { error: null };
}

export async function updateCategory(input: { id: string } & CategoryInput): Promise<Result> {
  const authed = await getAuthed();
  if (!authed) return { error: 'Not authorized' };

  const problem = validateShape(input);
  if (problem) return { error: problem };

  // `key` is intentionally immutable — historical spendings/income reference it.
  const { error } = await authed.supabase
    .from('categories')
    .update({
      label: input.label.trim(),
      icon_name: input.iconName,
      color: input.color,
      bucket: input.kind === 'expense' ? input.bucket : null,
    })
    .eq('id', input.id);
  if (error) return { error: error.message };

  revalidateAll();
  return { error: null };
}

/** Archive / restore. We never hard-delete: past rows still resolve by `key`. */
export async function setCategoryActive(id: string, active: boolean): Promise<Result> {
  const authed = await getAuthed();
  if (!authed) return { error: 'Not authorized' };

  const { error } = await authed.supabase.from('categories').update({ active }).eq('id', id);
  if (error) return { error: error.message };

  revalidateAll();
  return { error: null };
}

export async function saveBucketTargets(targets: Record<BucketKey, number>): Promise<Result> {
  const ctx = await getProfile();
  if (!ctx) return { error: 'Not authorized' };

  const entries = BUCKET_KEYS.map((k) => [k, Number(targets[k])] as const);
  if (entries.some(([, v]) => !Number.isFinite(v) || v < 0 || v > 100)) {
    return { error: 'Each target must be between 0 and 100%' };
  }
  const sum = entries.reduce((s, [, v]) => s + v, 0);
  if (Math.round(sum) !== 100) {
    return { error: `Targets must total 100% (currently ${Math.round(sum)}%)` };
  }

  const rows = entries.map(([bucket, target_pct]) => ({
    group_id: ctx.profile.group_id, // explicit so the upsert conflict target is complete
    bucket,
    target_pct,
  }));

  const { error } = await ctx.supabase
    .from('bucket_targets')
    .upsert(rows, { onConflict: 'group_id,bucket' });
  if (error) return { error: error.message };

  revalidateAll();
  return { error: null };
}
