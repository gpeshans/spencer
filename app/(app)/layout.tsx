import { redirect } from 'next/navigation';

import { AppHeader } from '@/components/app-header';
import { BottomNav } from '@/components/bottom-nav';
import { getGroupContext } from '@/lib/session';

// The real auth + email-whitelist boundary: every page under (app) renders
// through this server guard.
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await getGroupContext();
  if (!ctx) redirect('/login');

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col">
      <AppHeader me={ctx.profile} groupName={ctx.group.name} members={ctx.members} />
      <main className="flex-1 pb-[calc(4rem+env(safe-area-inset-bottom))]">
        {children}
      </main>
      <BottomNav />
    </div>
  );
}
