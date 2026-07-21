import { redirect } from 'next/navigation';

import { BottomNav } from '@/components/bottom-nav';
import { getAuthed } from '@/lib/session';

// The real auth + email-whitelist boundary: every page under (app) renders
// through this server guard.
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const authed = await getAuthed();
  if (!authed) redirect('/login');

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col">
      <main className="flex-1 pb-[calc(4rem+env(safe-area-inset-bottom))]">
        {children}
      </main>
      <BottomNav />
    </div>
  );
}
