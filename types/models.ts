import type { Profile, Spending } from './database';

/** A spending row plus the display name of whoever entered it. */
export type AuthoredSpending = Spending & { authorName: string };

/** A category and its summed amount, used by charts and breakdowns. */
export type CategoryTotal = { category: string; total: number };

/** A bucket and its summed spend, used by the bucket goal charts. */
export type BucketTotal = { bucket: string; total: number };

/** A member and their summed spend, used by the split-by-member charts. */
export type MemberTotal = { userId: string; total: number };

/** The public subset of a profile shown in the header + family list. */
export type GroupMember = Pick<Profile, 'id' | 'display_name' | 'email' | 'avatar_url'>;
