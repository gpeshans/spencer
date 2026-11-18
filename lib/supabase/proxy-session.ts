import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import type { Database } from '@/types/database';

/**
 * Refreshes the Supabase auth cookie on each request, soft-redirects signed-out
 * users to /login, and sets the security headers — above all a per-request,
 * nonce-based Content-Security-Policy (Next's documented pattern for the Proxy).
 *
 * The session refresh and redirect are a UX convenience only — the real auth +
 * email-whitelist enforcement lives in app/(app)/layout.tsx and in each Server
 * Action. Never rely on the proxy alone for authorization.
 */

/** The Supabase origin the browser client talks to, for connect-src. */
const SUPABASE_ORIGIN = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').origin;
  } catch {
    return 'https://*.supabase.co';
  }
})();

/**
 * A strict CSP. Scripts run only with the per-request nonce (and what those
 * scripts load, via strict-dynamic), so an injected inline <script> is blocked
 * even if a sink regresses. Inline styles stay allowed: Tailwind, next/font and
 * the chart colour <style> inject un-nonced CSS, and a style can't execute JS.
 */
function contentSecurityPolicy(nonce: string, isDev: boolean): string {
  return [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' https://*.googleusercontent.com data: blob:`,
    `font-src 'self'`,
    // PostgREST / auth from the browser Supabase client; ws: for dev HMR.
    `connect-src 'self' ${SUPABASE_ORIGIN}${isDev ? ' ws: wss:' : ''}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

/** Headers set on every response the proxy returns. */
function securityHeaders(nonce: string): Headers {
  const isDev = process.env.NODE_ENV === 'development';
  const headers = new Headers();
  headers.set('Content-Security-Policy', contentSecurityPolicy(nonce, isDev));
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  return headers;
}

function applyHeaders(response: NextResponse, extra: Headers): NextResponse {
  extra.forEach((value, key) => response.headers.set(key, value));
  return response;
}

export async function updateSession(request: NextRequest) {
  // A fresh nonce per request; Next reads it from the request's CSP header and
  // applies it to its own framework and page scripts during SSR.
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const extra = securityHeaders(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', extra.get('Content-Security-Policy')!);

  let response = NextResponse.next({ request: { headers: requestHeaders } });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request: { headers: requestHeaders } });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // IMPORTANT: do not run other code between creating the client and getUser().
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isPublicPath = pathname.startsWith('/login') || pathname.startsWith('/auth');

  if (!user && !isPublicPath) {
    // A fetch from the app gets a 401 it can act on, not the login page's HTML.
    if (pathname.startsWith('/api/')) {
      return applyHeaders(
        NextResponse.json({ error: { code: 'unauthorized', message: 'Sign in first.' } }, { status: 401 }),
        extra,
      );
    }
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return applyHeaders(NextResponse.redirect(url), extra);
  }

  return applyHeaders(response, extra);
}
