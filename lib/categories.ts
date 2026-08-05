import type { LucideIcon } from 'lucide-react';

import { iconByName } from '@/lib/category-icons';

// Categories are user-editable and live per-group in the database (see
// supabase/migrations/0005_editable_categories.sql). This module is now the
// type + helper layer around them: bucket metadata, the serializable DTO shape,
// the DTO→render converter, and the default seed lists used as a fallback when a
// group has no categories yet. Runtime lists come from lib/categories-data.ts
// (server) and the CategoriesProvider (client).

// ── Buckets ──────────────────────────────────────────────────────────────────
// The four hidden umbrella buckets that group expense categories, so we can track
// how income is distributed vs. targets. The set is fixed; labels + targets are
// editable (bucket_targets), and categories move between them.

export type BucketKey = 'needs' | 'wants' | 'savings' | 'emergency';

export type Bucket = {
  key: BucketKey;
  label: string;
  /** Hex color used by the bucket goal charts. */
  color: string;
  /** Default share of income this bucket should get, in percent (sums to 100). */
  defaultTargetPct: number;
};

export const BUCKETS: Bucket[] = [
  { key: 'needs', label: 'Needs', color: '#1971c2', defaultTargetPct: 20 },
  { key: 'wants', label: 'Wants', color: '#f08c00', defaultTargetPct: 10 },
  { key: 'savings', label: 'Savings & Investments', color: '#2f9e44', defaultTargetPct: 40 },
  { key: 'emergency', label: 'Emergency', color: '#7048e8', defaultTargetPct: 30 },
];

export const BUCKET_BY_KEY = Object.fromEntries(BUCKETS.map((b) => [b.key, b])) as Record<
  BucketKey,
  Bucket
>;

export const BUCKET_KEYS = BUCKETS.map((b) => b.key);

// ── Categories ───────────────────────────────────────────────────────────────

export type CategoryKind = 'expense' | 'income';

/**
 * A category as stored/transported — icon is a lucide *name*, so the shape is
 * serializable and can cross the server→client (RSC) boundary safely.
 */
export type CategoryDTO = {
  id?: string;
  kind: CategoryKind;
  key: string;
  label: string;
  iconName: string;
  color: string;
  bucket: BucketKey | null; // expense only
  sort: number;
  active: boolean;
};

/** A category resolved for rendering — icon is a component. */
export type Category = {
  key: string;
  label: string;
  icon: LucideIcon;
  color: string;
  bucket: BucketKey | null;
};

const FALLBACK_COLOR = '#64748b';

export function toCategory(dto: CategoryDTO): Category {
  return {
    key: dto.key,
    label: dto.label,
    icon: iconByName(dto.iconName),
    color: dto.color,
    bucket: dto.bucket,
  };
}

/** Resolve a key against a by-key map, with a readable fallback for unknown keys. */
export function resolveCategory(byKey: Record<string, Category>, key: string): Category {
  return (
    byKey[key] ?? { key, label: key, icon: iconByName('circle'), color: FALLBACK_COLOR, bucket: null }
  );
}

// ── Ordering ─────────────────────────────────────────────────────────────────
// "Other" is the catch-all, not a peer category, so it's pinned to the end of
// every list — pickers, the settings manager, and the spend breakdowns — no
// matter its `sort` or its total. Newly added categories can never push past it.

/** Key of the catch-all category (same slug for both expense and income). */
export const CATCH_ALL_KEY = 'other';

/** First sort key that pins the catch-all last: 1 for "Other", 0 for the rest. */
export const catchAllLast = (key: string): number => (key === CATCH_ALL_KEY ? 1 : 0);

/** Order categories by their `sort`, with the catch-all always last. */
export function compareCategories(
  a: { key: string; sort: number },
  b: { key: string; sort: number },
): number {
  return catchAllLast(a.key) - catchAllLast(b.key) || a.sort - b.sort;
}

// ── Default seed lists ────────────────────────────────────────────────────────
// Fallback used only when a group has no categories yet. Mirrors the seed in
// supabase/migrations/0005_editable_categories.sql.
export const DEFAULT_EXPENSE_CATEGORIES: CategoryDTO[] = [
  { kind: 'expense', key: 'groceries', label: 'Groceries', iconName: 'shopping-cart', color: '#2f9e44', bucket: 'needs', sort: 10, active: true },
  { kind: 'expense', key: 'dining', label: 'Dining', iconName: 'utensils-crossed', color: '#e8590c', bucket: 'wants', sort: 20, active: true },
  { kind: 'expense', key: 'transport', label: 'Transport', iconName: 'car', color: '#1c7ed6', bucket: 'needs', sort: 30, active: true },
  { kind: 'expense', key: 'housing', label: 'Housing', iconName: 'house', color: '#6741d9', bucket: 'needs', sort: 40, active: true },
  { kind: 'expense', key: 'utilities', label: 'Utilities', iconName: 'zap', color: '#f59f00', bucket: 'needs', sort: 50, active: true },
  { kind: 'expense', key: 'health', label: 'Health', iconName: 'heart-pulse', color: '#e03131', bucket: 'needs', sort: 60, active: true },
  { kind: 'expense', key: 'shopping', label: 'Shopping', iconName: 'shopping-bag', color: '#e64980', bucket: 'wants', sort: 70, active: true },
  { kind: 'expense', key: 'entertainment', label: 'Entertainment', iconName: 'clapperboard', color: '#ae3ec9', bucket: 'wants', sort: 80, active: true },
  { kind: 'expense', key: 'kids', label: 'Kids', iconName: 'baby', color: '#9c6644', bucket: 'needs', sort: 90, active: true },
  { kind: 'expense', key: 'travel', label: 'Travel', iconName: 'plane', color: '#15aabf', bucket: 'wants', sort: 100, active: true },
  { kind: 'expense', key: 'savings', label: 'Savings', iconName: 'piggy-bank', color: '#099268', bucket: 'savings', sort: 110, active: true },
  { kind: 'expense', key: 'investments', label: 'Investments', iconName: 'trending-up', color: '#3b5bdb', bucket: 'savings', sort: 120, active: true },
  { kind: 'expense', key: 'emergency', label: 'Emergency', iconName: 'umbrella', color: '#c2255c', bucket: 'emergency', sort: 130, active: true },
  { kind: 'expense', key: 'other', label: 'Other', iconName: 'more-horizontal', color: '#868e96', bucket: 'wants', sort: 140, active: true },
];

export const DEFAULT_INCOME_CATEGORIES: CategoryDTO[] = [
  { kind: 'income', key: 'salary', label: 'Salary', iconName: 'wallet', color: '#2f9e44', bucket: null, sort: 10, active: true },
  { kind: 'income', key: 'bonus', label: 'Bonus', iconName: 'gift', color: '#ae3ec9', bucket: null, sort: 20, active: true },
  { kind: 'income', key: 'rental', label: 'Rental', iconName: 'building-2', color: '#1c7ed6', bucket: null, sort: 30, active: true },
  { kind: 'income', key: 'investments', label: 'Investments', iconName: 'trending-up', color: '#f59f00', bucket: null, sort: 40, active: true },
  { kind: 'income', key: 'other', label: 'Other', iconName: 'coins', color: '#868e96', bucket: null, sort: 50, active: true },
];

// ── Color contrast helper (unchanged) ────────────────────────────────────────
// Readable text color (near-black or white) for a solid category-color fill —
// picks whichever gives higher WCAG contrast, so chip labels stay legible.
function channelLuminance(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function textOn(hex: string): string {
  const r = channelLuminance(parseInt(hex.slice(1, 3), 16));
  const g = channelLuminance(parseInt(hex.slice(3, 5), 16));
  const b = channelLuminance(parseInt(hex.slice(5, 7), 16));
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const whiteContrast = 1.05 / (L + 0.05);
  const blackContrast = (L + 0.05) / 0.05;
  return blackContrast >= whiteContrast ? '#111827' : '#ffffff';
}
