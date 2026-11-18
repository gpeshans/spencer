import type { CookieOptionsWithName } from '@supabase/ssr';

/**
 * Options for the Supabase session cookies, shared by the browser, server and
 * Proxy clients so every write uses the same attributes. `secure` keeps a
 * browser from ever sending the session over plain HTTP; it stays off in
 * development, where the app runs on http://localhost. Everything else keeps
 * @supabase/ssr's defaults (path /, SameSite=Lax, readable by the browser
 * client, which needs it, and a 400-day lifetime).
 *
 * Existing sessions pick the attribute up on their next refresh.
 */
export const SESSION_COOKIE_OPTIONS: CookieOptionsWithName = {
  secure: process.env.NODE_ENV === 'production',
};
