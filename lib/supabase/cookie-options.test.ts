import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Drives a real session write through spencer's server client and the real
 * @supabase/ssr storage, and checks the attributes each cookie is written with.
 * `next/headers` is mocked, and the Auth server's answer is stubbed locally.
 */

type Write = { name: string; value: string; options: Record<string, unknown> };
const writes: Write[] = [];

vi.mock('next/headers', () => ({
  cookies: async () => ({
    getAll: () => [],
    set: (name: string, value: string, options: Record<string, unknown>) => writes.push({ name, value, options }),
  }),
}));

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const fakeAccessToken = () =>
  `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
    sub: 'u1',
    aud: 'authenticated',
    role: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.${Buffer.from('not-a-real-signature').toString('base64url')}`;
const USER = {
  id: 'u1',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'ada@example.test',
  app_metadata: {},
  user_metadata: {},
  created_at: new Date().toISOString(),
};

async function sessionCookieWrites(nodeEnv: 'production' | 'development'): Promise<Write[]> {
  writes.length = 0;
  vi.resetModules();
  vi.stubEnv('NODE_ENV', nodeEnv);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
  // setSession checks the token with the Auth server; answer it here instead.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(USER), { status: 200, headers: { 'content-type': 'application/json' } })),
  );
  const { createClient } = await import('./server');
  const supabase = await createClient();
  const { error } = await supabase.auth.setSession({ access_token: fakeAccessToken(), refresh_token: 'refresh' });
  expect(error).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return writes.filter((write) => write.value !== '');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('session cookies', () => {
  it('are Secure in production', async () => {
    const cookies = await sessionCookieWrites('production');
    expect(cookies.length).toBeGreaterThan(0);
    for (const cookie of cookies) expect(cookie.options, cookie.name).toMatchObject({ secure: true, path: '/', sameSite: 'lax' });
  });

  it('are not Secure in development, where the app runs on http://localhost', async () => {
    const cookies = await sessionCookieWrites('development');
    expect(cookies.length).toBeGreaterThan(0);
    for (const cookie of cookies) expect(cookie.options.secure, cookie.name).toBe(false);
  });
});
