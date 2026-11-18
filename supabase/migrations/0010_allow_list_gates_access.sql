-- ============================================================
-- 0010: the allow-list gates all data access, not just sign-up
-- ============================================================
--
-- Until now the allow-list did two separate jobs, and neither reached the data:
--   * public.allowed_emails gates SIGN-UP (handle_new_user, 0001);
--   * the ALLOWED_EMAILS env var gates the APP (lib/session.ts getAuthed).
-- RLS only asked "which household is this profile in?" (private.current_group_id,
-- 0003). So a member removed from both lists kept full read, insert and delete
-- on the household's data through PostgREST, with the session they already
-- held. Deleting their auth user doesn't help either: spendings.user_id and
-- income.created_by reference their profile, which blocks the cascade.
--
-- From here, private.current_group_id() returns the household only while the
-- profile's email is still on allowed_emails. Every group policy (0001–0006) and
-- every group_id column default calls it, so removing an address cuts off all
-- reads and writes at once — even for a session that is already open — and
-- re-adding it restores them. Nothing is deleted; the member's history stays
-- attributed to them.
--
-- The identity used is profiles.email, written by the sign-up trigger (members
-- may update only display_name and avatar_url, 0007), not auth.users, so RLS
-- doesn't depend on privileges over the auth schema.
--
-- The report tables' owner-based policies (0008) and a member's own profile
-- update don't go through the function, so they get the same gate here.
-- profiles.display_name and avatar_url also get generous bounds, NOT VALID like
-- 0009's: enforced on new and updated rows, existing rows aren't rescanned.
--
-- Idempotent: re-running it is harmless.

-- ------------------------------------------------------------
-- 1. The household lookup behind every group policy
-- ------------------------------------------------------------
-- Same signature as 0003, so its grants and every policy that calls it stay.
-- It runs as its owner, which owns profiles and allowed_emails, so neither
-- table's RLS applies inside it.
create or replace function private.current_group_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.group_id
  from public.profiles p
  where p.id = auth.uid()
    and exists (
      select 1
      from public.allowed_emails a
      where lower(a.email) = lower(p.email)
    )
$$;

-- ------------------------------------------------------------
-- 2. Policies that don't go through current_group_id()
-- ------------------------------------------------------------
-- A report run, its queries and its template belong to the household they were
-- made in; usage and audit rows belong to their owner. Each now also requires
-- the reader to be allow-listed.
alter policy "read own runs" on public.report_runs
  using (
    owner_id = (select auth.uid())
    and group_id = (select private.current_group_id())
  );

alter policy "read own run queries" on public.report_queries
  using (exists (
    select 1
    from public.report_runs r
    where r.id = report_queries.run_id
      and r.owner_id = (select auth.uid())
      and r.group_id = (select private.current_group_id())
  ));

alter policy "read own or shared templates" on public.report_templates
  using (
    group_id = (select private.current_group_id())
    and (owner_id = (select auth.uid()) or shared)
  );

alter policy "read own llm calls" on public.report_llm_calls
  using (
    owner_id = (select auth.uid())
    and (select private.current_group_id()) is not null
  );

alter policy "read own report events" on public.report_events
  using (
    actor_id = (select auth.uid())
    and (select private.current_group_id()) is not null
  );

-- A removed member can't change how they appear to the household.
alter policy "update own profile" on public.profiles
  using (
    id = (select auth.uid())
    and (select private.current_group_id()) is not null
  )
  with check (
    id = (select auth.uid())
    and (select private.current_group_id()) is not null
  );

-- ------------------------------------------------------------
-- 3. Bound what a member can write to their own profile (NOT VALID)
-- ------------------------------------------------------------
-- Members may update display_name and avatar_url (0007). Google's values fit
-- well inside these bounds, and so does the sign-up trigger's email fallback
-- for the name (an address is at most 254 characters), so a sign-up never
-- trips them. The CSP already confines avatar images to googleusercontent.com;
-- this keeps the stored value an https URL of sane length.
alter table public.profiles drop constraint if exists profiles_display_name_len;
alter table public.profiles
  add constraint profiles_display_name_len check (char_length(display_name) <= 256) not valid;
alter table public.profiles drop constraint if exists profiles_avatar_url_https;
alter table public.profiles
  add constraint profiles_avatar_url_https
  check (avatar_url is null or (char_length(avatar_url) <= 2048 and avatar_url ~ '^https://')) not valid;
