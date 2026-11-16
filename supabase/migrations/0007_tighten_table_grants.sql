-- ============================================================
-- 0007: reset table grants to the privileges 0001-0005 intended
-- ============================================================
--
-- Supabase grants ALL privileges on every new table in `public` to `anon` and
-- `authenticated`. Migrations 0001-0005 added the grants they intended on top
-- of those defaults but never revoked them, so the intended limits never took
-- effect:
--
--   * 0001 grants UPDATE on profiles only for (display_name, avatar_url), but
--     a column grant doesn't remove a table grant. `authenticated` kept
--     table-wide UPDATE, and the "update own profile" policy only checks
--     id = auth.uid(), so a signed-in user could change their own
--     profiles.group_id and move into another household.
--   * `anon` held every privilege on every app table (RLS still hid all rows).
--   * Both roles held TRUNCATE, which RLS does not apply to.
--
-- This revokes the defaults and re-grants exactly what 0001-0005 intended.
-- RLS policies are unchanged. allowed_emails was already locked down by 0002.
--
-- Revoking a table privilege also revokes the matching column privileges, so
-- the column-level UPDATE on profiles is granted again after the revoke.
--
-- New tables still receive Supabase's defaults: later migrations must revoke
-- and grant explicitly.

revoke all on table
  public.groups,
  public.profiles,
  public.spendings,
  public.income,
  public.categories,
  public.bucket_targets
from anon, authenticated;

-- GROUPS: read your own group only (writes are not allowed to anyone).
grant select on public.groups to authenticated;

-- PROFILES: read group members; update only your own display name and avatar.
grant select on public.profiles to authenticated;
grant update (display_name, avatar_url) on public.profiles to authenticated;

-- Group-scoped data the app reads and writes (RLS restricts the rows).
grant select, insert, update, delete on
  public.spendings,
  public.income,
  public.categories,
  public.bucket_targets
to authenticated;
