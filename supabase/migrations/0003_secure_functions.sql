-- Address Supabase security advisors on our helper/trigger functions.
--
--   0011 function_search_path_mutable  -> pin search_path on set_updated_at
--   0028 / 0029 security-definer fn is API-executable ->
--        * current_group_id(): moved into a non-exposed `private` schema so it
--          can't be called via /rest/v1/rpc, while RLS + column defaults keep
--          using it (behaviour is identical — same expression, new schema).
--        * handle_new_user(): EXECUTE revoked from the API roles; it's a trigger
--          and fires regardless, so it can no longer be reached via rpc either.

-- 1) set_updated_at: pin search_path (stays SECURITY INVOKER, in public).
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- 2) current_group_id(): relocate to a private (non-API) schema.
create schema if not exists private;
grant usage on schema private to anon, authenticated;

create or replace function private.current_group_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select group_id from public.profiles where id = auth.uid()
$$;
grant execute on function private.current_group_id() to anon, authenticated;

-- Repoint every reference public.current_group_id() -> private.current_group_id()
alter table public.spendings alter column group_id set default private.current_group_id();
alter table public.income    alter column group_id set default private.current_group_id();

alter policy "read own group"         on public.groups
  using (id = private.current_group_id());
alter policy "read group members"     on public.profiles
  using (group_id = private.current_group_id());
alter policy "read group spendings"   on public.spendings
  using (group_id = private.current_group_id());
alter policy "insert own spendings"   on public.spendings
  with check (group_id = private.current_group_id() and user_id = auth.uid());
alter policy "update group spendings" on public.spendings
  using (group_id = private.current_group_id() and user_id = auth.uid())
  with check (group_id = private.current_group_id() and user_id = auth.uid());
alter policy "delete group spendings" on public.spendings
  using (group_id = private.current_group_id());
alter policy "read group income"      on public.income
  using (group_id = private.current_group_id());
alter policy "write group income"     on public.income
  using (group_id = private.current_group_id())
  with check (group_id = private.current_group_id());

-- Nothing references the public copy anymore -> drop it.
drop function public.current_group_id();

-- 3) handle_new_user(): keep as the signup trigger, but remove API executability.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
