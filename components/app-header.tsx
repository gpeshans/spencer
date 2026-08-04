import Link from 'next/link';

import { UserMenu } from '@/components/user-menu';
import { Wordmark } from '@/components/wordmark';
import type { GroupMember } from '@/types/models';

/**
 * Slim sticky top bar: the "Spencer" wordmark on the left, the profile menu on
 * the right. Owns the top safe-area inset (the notch) for every (app) screen, so
 * pages below it only manage their own vertical rhythm.
 */
export function AppHeader({
  me,
  groupName,
  members,
}: {
  me: GroupMember;
  groupName: string;
  members: GroupMember[];
}) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 pt-[env(safe-area-inset-top)] backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="flex h-14 items-center justify-between px-4">
        <Link
          href="/"
          aria-label="Spencer home"
          className="rounded-md outline-none transition-opacity hover:opacity-80 focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <Wordmark />
        </Link>
        <UserMenu me={me} groupName={groupName} members={members} />
      </div>
    </header>
  );
}
