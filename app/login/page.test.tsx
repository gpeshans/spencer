import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getAuthed, getProfile } from '@/lib/session';

import LoginPage from './page';

vi.mock('@/lib/session', () => ({ getAuthed: vi.fn(), getProfile: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  }),
}));

const signedIn = { supabase: {}, user: { id: 'u1', email: 'ada@example.test' } };
const page = async (error?: string) =>
  renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve(error ? { error } : {}) }));

describe('the login page', () => {
  beforeEach(() => {
    vi.mocked(getAuthed).mockResolvedValue(null);
    vi.mocked(getProfile).mockResolvedValue(null);
  });

  it('sends a signed-in member on to the app', async () => {
    vi.mocked(getAuthed).mockResolvedValue(signedIn as never);
    vi.mocked(getProfile).mockResolvedValue({ ...signedIn, profile: { id: 'u1' } } as never);
    await expect(page()).rejects.toThrow('REDIRECT /');
  });

  it('keeps a session whose access was removed here, instead of bouncing it to the app and back', async () => {
    // Still on ALLOWED_EMAILS, but off the allowed_emails table: RLS hides the profile (0010).
    vi.mocked(getAuthed).mockResolvedValue(signedIn as never);
    const html = await page();
    expect(html).toContain('not on the allow-list');
    expect(html).toContain('Continue with Google');
  });

  it('shows a plain sign-in page when signed out', async () => {
    const html = await page();
    expect(html).not.toContain('role="alert"');
    expect(html).toContain('Continue with Google');
  });

  it('explains a failed sign-in', async () => {
    expect(await page('auth')).toContain('Sign-in failed');
  });
});
