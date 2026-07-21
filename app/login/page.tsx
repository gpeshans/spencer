import { Wallet } from 'lucide-react';
import { redirect } from 'next/navigation';

import { GoogleSignInButton } from '@/components/google-sign-in-button';
import { getAuthed } from '@/lib/session';

const ERROR_MESSAGES: Record<string, string> = {
  not_allowed: 'This Google account is not on the allow-list for Spencer.',
  auth: 'Sign-in failed. Please try again.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // Already signed in + allowed -> skip the login screen.
  if (await getAuthed()) redirect('/');

  const { error } = await searchParams;
  const message = error ? (ERROR_MESSAGES[error] ?? 'Something went wrong.') : null;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-10 px-6">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="flex size-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
          <Wallet className="size-8" />
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Spencer</h1>
          <p className="text-muted-foreground">Simple family spending tracker</p>
        </div>
      </div>

      {message && (
        <p
          role="alert"
          className="w-full rounded-lg bg-destructive/10 px-4 py-3 text-center text-sm text-destructive"
        >
          {message}
        </p>
      )}

      <div className="w-full">
        <GoogleSignInButton />
        <p className="mt-3 text-center text-xs text-muted-foreground">
          Only allow-listed accounts can sign in.
        </p>
      </div>
    </main>
  );
}
