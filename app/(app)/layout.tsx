import { redirect } from 'next/navigation';

import { AppHeader } from '@/components/app-header';
import { BottomNav } from '@/components/bottom-nav';
import { CategoriesProvider } from '@/components/categories-provider';
import { CurrencyProvider } from '@/components/currency-provider';
import { getCategories } from '@/lib/categories-data';
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

  // Load the group's editable categories once and hand them to the client
  // provider, so every screen resolves category label/icon/color/bucket from one
  // source (kept serializable — icons are resolved from names client-side).
  const { expense, income } = await getCategories();

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col">
      <AppHeader me={ctx.profile} groupName={ctx.group.name} members={ctx.members} />
      <CurrencyProvider currency={ctx.group.currency}>
        <CategoriesProvider expense={expense} income={income}>
          <main className="flex-1 pb-[calc(4rem+env(safe-area-inset-bottom))]">
            {children}
          </main>
        </CategoriesProvider>
      </CurrencyProvider>
      <BottomNav />
    </div>
  );
}
