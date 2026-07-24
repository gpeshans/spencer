import 'server-only';

import type { SupabaseClient, User } from '@supabase/supabase-js';

import { isAllowed } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import type { Database, Profile } from '@/types/database';

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

/** Like getAuthed(), plus the user's profile (group_id, display_name, ...). */
export async function getProfile(): Promise<(Authed & { profile: Profile }) | null> {
  const authed = await getAuthed();
  if (!authed) return null;
  const { data: profile } = await authed.supabase
    .from('profiles')
    .select('*')
    .eq('id', authed.user.id)
    .single();
  if (!profile) return null;
  return { ...authed, profile };
}
