import type { LucideIcon } from 'lucide-react';
import {
  Baby,
  Building2,
  Car,
  Clapperboard,
  Coins,
  Gift,
  HeartPulse,
  House,
  MoreHorizontal,
  Plane,
  ShoppingBag,
  ShoppingCart,
  TrendingUp,
  UtensilsCrossed,
  Wallet,
  Zap,
} from 'lucide-react';

export type Category = {
  key: string;
  label: string;
  icon: LucideIcon;
  /** Hex color used by the category pie chart. */
  color: string;
};

// Fixed, predefined lists (single source of truth for the whole app).
// Colors are a spread-out categorical palette used as a SECONDARY cue on the
// charts — identity is always carried by text labels + legend, never color
// alone (11 categories can't be made CVD-safe by color; see the pie/legend).
export const EXPENSE_CATEGORIES: Category[] = [
  { key: 'groceries', label: 'Groceries', icon: ShoppingCart, color: '#2f9e44' },
  { key: 'dining', label: 'Dining', icon: UtensilsCrossed, color: '#e8590c' },
  { key: 'transport', label: 'Transport', icon: Car, color: '#1c7ed6' },
  { key: 'housing', label: 'Housing', icon: House, color: '#6741d9' },
  { key: 'utilities', label: 'Utilities', icon: Zap, color: '#f59f00' },
  { key: 'health', label: 'Health', icon: HeartPulse, color: '#e03131' },
  { key: 'shopping', label: 'Shopping', icon: ShoppingBag, color: '#e64980' },
  { key: 'entertainment', label: 'Entertainment', icon: Clapperboard, color: '#ae3ec9' },
  { key: 'kids', label: 'Kids', icon: Baby, color: '#9c6644' },
  { key: 'travel', label: 'Travel', icon: Plane, color: '#15aabf' },
  { key: 'other', label: 'Other', icon: MoreHorizontal, color: '#868e96' },
];

export const INCOME_CATEGORIES: Category[] = [
  { key: 'salary', label: 'Salary', icon: Wallet, color: '#2f9e44' },
  { key: 'bonus', label: 'Bonus', icon: Gift, color: '#ae3ec9' },
  { key: 'rental', label: 'Rental', icon: Building2, color: '#1c7ed6' },
  { key: 'investments', label: 'Investments', icon: TrendingUp, color: '#f59f00' },
  { key: 'other', label: 'Other', icon: Coins, color: '#868e96' },
];

const indexBy = (list: Category[]): Record<string, Category> =>
  Object.fromEntries(list.map((c) => [c.key, c]));

export const EXPENSE_BY_KEY = indexBy(EXPENSE_CATEGORIES);
export const INCOME_BY_KEY = indexBy(INCOME_CATEGORIES);

export const EXPENSE_CATEGORY_KEYS = EXPENSE_CATEGORIES.map((c) => c.key);
export const INCOME_CATEGORY_KEYS = INCOME_CATEGORIES.map((c) => c.key);

const FALLBACK: Category = { key: 'other', label: 'Other', icon: MoreHorizontal, color: '#64748b' };

export function expenseCategory(key: string): Category {
  return EXPENSE_BY_KEY[key] ?? { ...FALLBACK, key, label: key };
}

export function incomeCategory(key: string): Category {
  return INCOME_BY_KEY[key] ?? { ...FALLBACK, key, label: key, icon: Coins };
}

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
