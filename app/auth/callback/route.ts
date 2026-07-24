import { NextResponse } from 'next/server';

import { isAllowed } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');

  // Guard against open-redirects: only allow same-site relative paths.
  const nextParam = searchParams.get('next') ?? '/';
  const next = nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : '/';

  // On Vercel the request host is behind a proxy — prefer x-forwarded-host.
  const forwardedHost = request.headers.get('x-forwarded-host');
  const isLocal = process.env.NODE_ENV === 'development';
  // Prefer the configured canonical site URL in production so a spoofed
  // X-Forwarded-Host header can't redirect the just-authenticated user offsite.
  const configuredSite = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, '');
  const base = isLocal
    ? origin
    : (configuredSite ?? (forwardedHost ? `https://${forwardedHost}` : origin));
  const redirectTo = (path: string) => NextResponse.redirect(`${base}${path}`);

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (isAllowed(user?.email)) {
        return redirectTo(next);
      }

      // Authenticated with Google but not on the allow-list: end the session.
      await supabase.auth.signOut();
      return redirectTo('/login?error=not_allowed');
    }
  }

  return redirectTo('/login?error=auth');
}
