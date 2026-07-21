import type { NextRequest } from 'next/server';

import { updateSession } from '@/lib/supabase/proxy-session';

// Next.js 16 renamed Middleware to Proxy. This runs on the Node runtime and is
// used only to keep the Supabase session cookie fresh + soft-redirect. Real
// authorization happens in the (app) layout and Server Actions.
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // Everything except Next internals, static assets, the manifest and icons.
    '/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|icon|apple-icon|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
