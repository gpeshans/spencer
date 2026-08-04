import 'server-only';

import { cache } from 'react';

import {
  BUCKETS,
  type BucketKey,
  type CategoryDTO,
  DEFAULT_EXPENSE_CATEGORIES,
  DEFAULT_INCOME_CATEGORIES,
} from '@/lib/categories';
import { createClient } from '@/lib/supabase/server';
import type { CategoryRow } from '@/types/database';

function toDTO(r: CategoryRow): CategoryDTO {
  return {
    id: r.id,
    kind: r.kind,
    key: r.key,
    label: r.label,
    iconName: r.icon_name,
    color: r.color,
    bucket: r.bucket,
    sort: r.sort,
    active: r.active,
  };
}

export type CategoryLists = { expense: CategoryDTO[]; income: CategoryDTO[] };

/**
 * All of the group's categories (active + archived), sorted. Falls back to the
 * built-in defaults when the group has none yet (e.g. before the seed runs).
 * cache() dedupes the query across a single render (layout + page).
 */
export const getCategories = cache(async (): Promise<CategoryLists> => {
  const supabase = await createClient();
  const { data } = await supabase.from('categories').select('*').order('sort', { ascending: true });
  const rows = (data ?? []) as CategoryRow[];

  if (rows.length === 0) {
    return { expense: DEFAULT_EXPENSE_CATEGORIES, income: DEFAULT_INCOME_CATEGORIES };
  }
  return {
    expense: rows.filter((r) => r.kind === 'expense').map(toDTO),
    income: rows.filter((r) => r.kind === 'income').map(toDTO),
  };
});

/** Target share of income per bucket (percent), with defaults for any missing. */
export const getBucketTargets = cache(async (): Promise<Record<BucketKey, number>> => {
  const supabase = await createClient();
  const { data } = await supabase.from('bucket_targets').select('bucket, target_pct');

  const map = Object.fromEntries(BUCKETS.map((b) => [b.key, b.defaultTargetPct])) as Record<
    BucketKey,
    number
  >;
  (data ?? []).forEach((r) => {
    map[r.bucket] = Number(r.target_pct);
  });
  return map;
});
