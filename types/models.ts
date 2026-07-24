import type { Spending } from './database';

/** A spending row plus the display name of whoever entered it. */
export type AuthoredSpending = Spending & { authorName: string };

/** A category and its summed amount, used by charts and breakdowns. */
export type CategoryTotal = { category: string; total: number };
