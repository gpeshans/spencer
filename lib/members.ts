import type { GroupMember, MemberTotal } from '@/types/models';

// Colour + naming for the "Split by member" charts. Pure and client-safe, so
// the month drill-down and the year bars derive identical slots.

/**
 * Categorical slots for group members. Assigned by the member's position in the
 * group (join order), never by how much they spent — a month where one member
 * outspends the other must not repaint both.
 *
 * Open Color steps, validated for colour-blind separation and >= 3:1 contrast
 * against both the light and dark surface, on every pair. Because each step
 * clears both lightness bands the same hexes serve both themes, so chart
 * configs need `color` only, no light/dark split. Deliberately clear of the
 * bucket palette's blue/green so the section doesn't read as a restatement of
 * "Buckets vs. goals" above it.
 */
export const MEMBER_COLORS = ['#ae3ec9', '#e8590c', '#0ca678', '#c2255c'] as const;

/** For spend by an author who is no longer in the group. */
const FORMER_MEMBER_COLOR = '#868e96';

/** Display name for a member: "Ada Lovelace", else "ada" from the email. */
export function memberName(m: GroupMember): string {
  return m.display_name?.trim() || m.email?.split('@')[0] || 'Member';
}

export type MemberSeries = {
  userId: string;
  /**
   * Stable per-chart key. Recharts configs interpolate this into a
   * `--color-<key>` custom property, so it has to be a plain ident — member
   * UUIDs are not.
   */
  key: string;
  name: string;
  avatarUrl: string | null;
  email: string | null;
  color: string;
  total: number;
  /** Share of the period's spend, 0-100. */
  pct: number;
};

/**
 * The group's members in stable order, each with its colour slot and share of
 * the period. Members who spent nothing are kept (at 0) so the section holds
 * its shape month to month; authors who have left the group are appended in
 * grey so the slice totals still add up to the period total.
 */
export function buildMemberSeries(
  members: GroupMember[],
  totals: MemberTotal[],
): MemberSeries[] {
  const byId = new Map(totals.map((t) => [t.userId, t.total]));
  const grand = totals.reduce((s, t) => s + t.total, 0);
  const share = (total: number) => (grand > 0 ? (total / grand) * 100 : 0);

  const series: MemberSeries[] = members.map((m, i) => {
    const total = byId.get(m.id) ?? 0;
    return {
      userId: m.id,
      key: `m${i}`,
      name: memberName(m),
      avatarUrl: m.avatar_url,
      email: m.email,
      color: MEMBER_COLORS[i % MEMBER_COLORS.length],
      total,
      pct: share(total),
    };
  });

  const known = new Set(members.map((m) => m.id));
  totals
    .filter((t) => !known.has(t.userId))
    .forEach((t, i) => {
      series.push({
        userId: t.userId,
        key: `former${i}`,
        name: 'Former member',
        avatarUrl: null,
        email: null,
        color: FORMER_MEMBER_COLOR,
        total: t.total,
        pct: share(t.total),
      });
    });

  return series;
}
