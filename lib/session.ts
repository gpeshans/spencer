import 'server-only';

import { cache } from 'react';
import type { SupabaseClient, User } from '@supabase/supabase-js';

import { isAllowed } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import type { Database, Profile } from '@/types/database';
import type { GroupMember } from '@/types/models';

type Authed = { supabase: SupabaseClient<Database>; user: User };

/**
 * Returns the signed-in + whitelisted user and a Supabase client, or null.
 * Every Server Action calls this — actions are reachable via direct POST, so
 * they must re-verify authorization themselves.
 */
export async function getAuthed(): Promise<Authed | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isAllowed(user.email)) return null;
  return { supabase, user };
}

/**
 * Like getAuthed(), plus the user's profile (group_id, display_name, ...).
 * React-cached so the (app) layout's auth guard and a page that also needs the
 * group both resolve from one round trip. The cache is per-request, so it can
 * never carry across users.
 */
export const getProfile = cache(async function getProfile(): Promise<
  (Authed & { profile: Profile }) | null
> {
  const authed = await getAuthed();
  if (!authed) return null;
  const { data: profile } = await authed.supabase
    .from('profiles')
    .select('*')
    .eq('id', authed.user.id)
    .single();
  if (!profile) return null;
  return { ...authed, profile };
});

/**
 * getProfile(), plus the user's group (id + name) and everyone else in it.
 * Powers the header's profile menu + family list, and the "Split by member"
 * charts on the month/year screens; the group and members are readable under
 * the group-scoped RLS SELECT policies. React-cached like getProfile().
 */
export const getGroupContext = cache(async function getGroupContext(): Promise<
  | (Authed & {
      profile: Profile;
      group: { id: string; name: string; currency: string };
      members: GroupMember[];
    })
  | null
> {
  const authed = await getProfile();
  if (!authed) return null;
  const { supabase, profile } = authed;
  const [{ data: group }, { data: members }] = await Promise.all([
    supabase.from('groups').select('id, name, currency').eq('id', profile.group_id).single(),
    supabase
      .from('profiles')
      .select('id, display_name, email, avatar_url')
      .eq('group_id', profile.group_id)
      .order('created_at', { ascending: true }),
  ]);
  if (!group) return null;
  return { ...authed, group, members: members ?? [] };
});
