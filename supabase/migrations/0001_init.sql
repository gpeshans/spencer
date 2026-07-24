-- Spencer — initial schema
-- Tables: groups, profiles (mirror auth.users), spendings, income
-- Security model: every row carries group_id; access is group-scoped via
-- current_group_id(); a handle_new_user() trigger provisions a profile and
-- assigns the single default group on sign-up.

-- ============================================================
-- GROUPS
-- ============================================================
create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  currency text not null default 'EUR',
  created_at timestamptz not null default now()
);

-- The single family group (stable id so it can be referenced if ever needed).
insert into public.groups (id, name)
values ('00000000-0000-0000-0000-000000000001', 'Family')
on conflict (id) do nothing;

-- ============================================================
-- PROFILES  (one row per auth user; carries the group)
-- ============================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  group_id uuid not null references public.groups (id),
  email text,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now()
);
create index if not exists profiles_group_id_idx on public.profiles (group_id);

-- ============================================================
-- SPENDINGS
-- ============================================================
create table if not exists public.spendings (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id),
  user_id uuid not null references public.profiles (id),  -- who entered it
  description text not null default '',
  amount numeric(12, 2) not null check (amount > 0),      -- exact decimal
  category text not null,                                 -- validated app-side
  spent_on date not null default current_date,            -- expense date (TZ-safe)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists spendings_group_date_idx on public.spendings (group_id, spent_on desc);
create index if not exists spendings_group_cat_idx on public.spendings (group_id, category);

-- ============================================================
-- INCOME  (effective-dated monthly amounts, by category)
-- ============================================================
create table if not exists public.income (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id),
  category text not null,
  amount numeric(12, 2) not null check (amount >= 0),
  effective_from date not null default date_trunc('month', current_date)::date,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (group_id, category, effective_from)             -- upsert target
);
create index if not exists income_group_eff_idx on public.income (group_id, effective_from);

-- ============================================================
-- HELPERS
-- ============================================================
-- Current user's group. SECURITY DEFINER + owned by the migration role means it
-- bypasses RLS, so it can be referenced inside profiles' own policies without
-- causing infinite recursion.
create or replace function public.current_group_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select group_id from public.profiles where id = auth.uid()
$$;

-- Auto-fill ownership columns from the caller's session, so inserts only need
-- the business fields and the values can't be spoofed. RLS WITH CHECK still
-- validates them. (Defined here because they depend on current_group_id().)
alter table public.spendings
  alter column group_id set default public.current_group_id(),
  alter column user_id set default auth.uid();

alter table public.income
  alter column group_id set default public.current_group_id(),
  alter column created_by set default auth.uid();

-- Keep spendings.updated_at fresh (used if editing is added later).
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists spendings_set_updated_at on public.spendings;
create trigger spendings_set_updated_at
  before update on public.spendings
  for each row execute function public.set_updated_at();

-- ============================================================
-- ALLOW-LIST: only these emails may create an account. Enforced below in the
-- sign-up trigger so the DATABASE — not just the app — gates who gets in.
-- ============================================================
create table if not exists public.allowed_emails (
  email text primary key
);
alter table public.allowed_emails enable row level security;
-- No policies and no grants: unreadable/unwritable through the API. Only the
-- SECURITY DEFINER trigger (and the dashboard / service role) can see it.

-- Seed your family's emails (lowercase). Keep in sync with the ALLOWED_EMAILS
-- env var, which drives the app's friendly "not allowed" message:
--   insert into public.allowed_emails (email) values
--     ('you@example.com'),
--     ('partner@example.com')
--   on conflict do nothing;

-- ============================================================
-- NEW-USER TRIGGER: reject non-allow-listed emails; otherwise create a profile
-- + assign the default group.
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  default_group uuid;
begin
  -- Hard gate: block sign-ups from non-allow-listed emails at the auth layer, so
  -- no unauthorized account, session, or profile is ever created.
  if not exists (
    select 1 from public.allowed_emails
    where lower(email) = lower(new.email)
  ) then
    raise exception 'Email % is not authorized for Spencer', new.email
      using errcode = 'check_violation';
  end if;

  select id into default_group
  from public.groups
  order by created_at asc
  limit 1;

  insert into public.profiles (id, group_id, email, display_name, avatar_url)
  values (
    new.id,
    default_group,
    new.email,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      new.email
    ),
    new.raw_user_meta_data ->> 'avatar_url'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table public.groups enable row level security;
alter table public.profiles enable row level security;
alter table public.spendings enable row level security;
alter table public.income enable row level security;

-- Coarse table grants (RLS still restricts on top of these).
grant select on public.groups to authenticated;
grant select on public.profiles to authenticated;
-- Only these columns are user-updatable — a user must never be able to change
-- their own group_id (which would grant access to another group's data).
grant update (display_name, avatar_url) on public.profiles to authenticated;
grant select, insert, update, delete on public.spendings to authenticated;
grant select, insert, update, delete on public.income to authenticated;

-- GROUPS: read your own group only.
drop policy if exists "read own group" on public.groups;
create policy "read own group" on public.groups
  for select to authenticated
  using (id = public.current_group_id());

-- PROFILES: read members of your group; update only yourself.
drop policy if exists "read group members" on public.profiles;
create policy "read group members" on public.profiles
  for select to authenticated
  using (group_id = public.current_group_id());

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- SPENDINGS: group-scoped; inserts must be attributed to the caller.
drop policy if exists "read group spendings" on public.spendings;
create policy "read group spendings" on public.spendings
  for select to authenticated
  using (group_id = public.current_group_id());

drop policy if exists "insert own spendings" on public.spendings;
create policy "insert own spendings" on public.spendings
  for insert to authenticated
  with check (group_id = public.current_group_id() and user_id = auth.uid());

drop policy if exists "update group spendings" on public.spendings;
create policy "update group spendings" on public.spendings
  for update to authenticated
  using (group_id = public.current_group_id() and user_id = auth.uid())
  with check (group_id = public.current_group_id() and user_id = auth.uid());

drop policy if exists "delete group spendings" on public.spendings;
create policy "delete group spendings" on public.spendings
  for delete to authenticated
  using (group_id = public.current_group_id());

-- INCOME: group-scoped read + write.
drop policy if exists "read group income" on public.income;
create policy "read group income" on public.income
  for select to authenticated
  using (group_id = public.current_group_id());

drop policy if exists "write group income" on public.income;
create policy "write group income" on public.income
  for all to authenticated
  using (group_id = public.current_group_id())
  with check (group_id = public.current_group_id());
