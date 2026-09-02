-- Spencer — schema (squashed from the original 0001–0008 increments)
--
-- Tables: groups, profiles (mirror auth.users), spendings, income, categories,
-- bucket_targets, allowed_emails.
--
-- Security model: every row carries group_id; access is group-scoped via
-- private.current_group_id() (a non-API-exposed SECURITY DEFINER function, so
-- it can't be called via /rest/v1/rpc — RLS and column defaults use it
-- directly). A handle_new_user() trigger provisions a profile and assigns the
-- single default group on sign-up, gated by an allow-list.
--
-- Money: `amount` on spendings/income is always in the owning group's
-- currency (groups.currency). A spending entered in a different currency
-- additionally carries original_currency/original_amount/fx_rate — the rate
-- used is locked to spent_on (or 'latest' for same-day), so a past entry's
-- conversion never drifts as rates move later. Changing a group's currency
-- (Settings) re-converts every existing spending/income row at that point,
-- rather than merely relabeling stale numbers.

-- ============================================================
-- SCHEMAS
-- ============================================================
-- Non-API-exposed schema for internals that RLS/defaults need but that must
-- never be reachable via PostgREST (/rest/v1/rpc).
create schema if not exists private;
grant usage on schema private to anon, authenticated;

-- ============================================================
-- ENUMS
-- ============================================================
do $$
begin
  create type public.bucket as enum ('needs', 'wants', 'savings', 'emergency');
exception
  when duplicate_object then null;
end
$$;

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
-- HELPERS
-- ============================================================
-- Current user's group. SECURITY DEFINER + a non-API schema means it bypasses
-- RLS (so it can be referenced inside profiles' own policies without causing
-- infinite recursion) while staying unreachable via /rest/v1/rpc.
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

-- ============================================================
-- SPENDINGS
-- ============================================================
create table if not exists public.spendings (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) default private.current_group_id(),
  user_id uuid not null references public.profiles (id) default auth.uid(),  -- who entered it
  description text not null default '',
  amount numeric(12, 2) not null check (amount > 0),      -- exact decimal, in groups.currency
  category text not null,                                 -- validated app-side
  bucket public.bucket not null,                           -- derived from category by trigger below
  spent_on date not null default current_date,            -- expense date (TZ-safe)
  -- Set only when entered in a currency other than the group's (see header).
  original_currency text,
  original_amount numeric(12, 2),
  fx_rate numeric(18, 8),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint spendings_original_currency_consistent check (
    (original_currency is null) = (original_amount is null)
    and (original_currency is null) = (fx_rate is null)
  )
);
create index if not exists spendings_group_date_idx on public.spendings (group_id, spent_on desc);
create index if not exists spendings_group_cat_idx on public.spendings (group_id, category);
create index if not exists spendings_group_bucket_idx on public.spendings (group_id, bucket);
create index if not exists spendings_group_user_idx on public.spendings (group_id, user_id);

comment on column public.spendings.original_currency is
  'Currency the user actually typed the amount in, when it differs from the group''s currency. Null = entered directly in the group''s currency.';
comment on column public.spendings.original_amount is
  'The raw amount as typed, in original_currency. Null when original_currency is null.';
comment on column public.spendings.fx_rate is
  '1 original_currency = fx_rate group-currency, looked up for spent_on (or "latest" for today). amount = round(original_amount * fx_rate, 2). Null when original_currency is null.';

drop trigger if exists spendings_set_updated_at on public.spendings;
create trigger spendings_set_updated_at
  before update on public.spendings
  for each row execute function public.set_updated_at();

-- ============================================================
-- INCOME  (effective-dated monthly amounts, by category)
-- ============================================================
create table if not exists public.income (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) default private.current_group_id(),
  category text not null,
  amount numeric(12, 2) not null check (amount >= 0),      -- in groups.currency
  effective_from date not null default date_trunc('month', current_date)::date,
  created_by uuid references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now(),
  unique (group_id, category, effective_from)             -- upsert target
);
create index if not exists income_group_eff_idx on public.income (group_id, effective_from);

-- ============================================================
-- CATEGORIES  (per-group; expense + income; user-editable from Settings)
-- ============================================================
create table if not exists public.categories (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.groups (id) default private.current_group_id(),
  kind       text not null check (kind in ('expense', 'income')),
  key        text not null,                 -- stable slug; historical spendings/income rows reference it
  label      text not null,
  icon_name  text not null default 'circle',
  color      text not null default '#868e96',
  bucket     public.bucket,                 -- expense only (null for income)
  sort       integer not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (group_id, kind, key),
  constraint categories_expense_has_bucket check (kind <> 'expense' or bucket is not null)
);
create index if not exists categories_group_kind_idx
  on public.categories (group_id, kind, active);

drop trigger if exists categories_set_updated_at on public.categories;
create trigger categories_set_updated_at
  before update on public.categories
  for each row execute function public.set_updated_at();

-- Seed every existing group from the app's default lists. `sort` preserves the
-- default on-screen order; icon_name is the lucide (kebab-case) icon name.
insert into public.categories (group_id, kind, key, label, icon_name, color, bucket, sort)
select g.id, s.kind, s.key, s.label, s.icon_name, s.color, s.bucket, s.sort
from public.groups g
cross join (values
  ('expense', 'groceries',     'Groceries',     'shopping-cart',   '#2f9e44', 'needs'::public.bucket,      10),
  ('expense', 'dining',        'Dining',        'utensils-crossed','#e8590c', 'wants'::public.bucket,      20),
  ('expense', 'transport',     'Transport',     'car',             '#1c7ed6', 'needs'::public.bucket,      30),
  ('expense', 'housing',       'Housing',       'house',           '#6741d9', 'needs'::public.bucket,      40),
  ('expense', 'utilities',     'Utilities',     'zap',             '#f59f00', 'needs'::public.bucket,      50),
  ('expense', 'health',        'Health',        'heart-pulse',     '#e03131', 'needs'::public.bucket,      60),
  ('expense', 'shopping',      'Shopping',      'shopping-bag',    '#e64980', 'wants'::public.bucket,      70),
  ('expense', 'entertainment', 'Entertainment', 'clapperboard',    '#ae3ec9', 'wants'::public.bucket,      80),
  ('expense', 'kids',          'Kids',          'baby',            '#9c6644', 'needs'::public.bucket,      90),
  ('expense', 'travel',        'Travel',        'plane',           '#15aabf', 'wants'::public.bucket,     100),
  ('expense', 'savings',       'Savings',       'piggy-bank',      '#099268', 'savings'::public.bucket,   110),
  ('expense', 'investments',   'Investments',   'trending-up',     '#3b5bdb', 'savings'::public.bucket,   120),
  ('expense', 'emergency',     'Emergency',     'umbrella',        '#c2255c', 'emergency'::public.bucket, 130),
  ('expense', 'other',         'Other',         'more-horizontal', '#868e96', 'wants'::public.bucket,     140),
  ('income',  'salary',        'Salary',        'wallet',          '#2f9e44', null::public.bucket,         10),
  ('income',  'bonus',         'Bonus',         'gift',            '#ae3ec9', null::public.bucket,         20),
  ('income',  'rental',        'Rental',        'building-2',      '#1c7ed6', null::public.bucket,         30),
  ('income',  'investments',   'Investments',   'trending-up',     '#f59f00', null::public.bucket,         40),
  ('income',  'other',         'Other',         'coins',           '#868e96', null::public.bucket,         50)
) as s(kind, key, label, icon_name, color, bucket, sort)
on conflict (group_id, kind, key) do nothing;

-- Bucket is a pure function of category, kept current by this trigger so the
-- app never sends it and it can't be spoofed (like group_id / user_id).
create or replace function public.set_spending_bucket()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  select c.bucket into new.bucket
  from public.categories c
  where c.group_id = new.group_id
    and c.kind = 'expense'
    and c.key = new.category;

  if new.bucket is null then
    new.bucket := 'wants'::public.bucket;   -- safety net for unmapped categories
  end if;

  return new;
end;
$$;
-- Not callable via the API (advisor hygiene); triggers fire regardless of this.
revoke execute on function public.set_spending_bucket() from public, anon, authenticated;

drop trigger if exists spendings_set_bucket on public.spendings;
create trigger spendings_set_bucket
  before insert or update of category on public.spendings
  for each row execute function public.set_spending_bucket();

-- ============================================================
-- BUCKET TARGETS  (per-group target ratio; editable in Settings)
-- ============================================================
create table if not exists public.bucket_targets (
  group_id   uuid not null references public.groups (id) default private.current_group_id(),
  bucket     public.bucket not null,
  target_pct numeric(5, 2) not null check (target_pct >= 0 and target_pct <= 100),
  updated_at timestamptz not null default now(),
  primary key (group_id, bucket)
);

drop trigger if exists bucket_targets_set_updated_at on public.bucket_targets;
create trigger bucket_targets_set_updated_at
  before update on public.bucket_targets
  for each row execute function public.set_updated_at();

-- Seed defaults for every existing group: needs 20 · wants 10 · savings 40 · emergency 30.
insert into public.bucket_targets (group_id, bucket, target_pct)
select g.id, t.bucket, t.target_pct
from public.groups g
cross join (values
  ('needs'::public.bucket,     20),
  ('wants'::public.bucket,     10),
  ('savings'::public.bucket,   40),
  ('emergency'::public.bucket, 30)
) as t(bucket, target_pct)
on conflict (group_id, bucket) do nothing;

-- ============================================================
-- ALLOW-LIST: only these emails may create an account. Enforced below in the
-- sign-up trigger so the DATABASE — not just the app — gates who gets in.
-- ============================================================
create table if not exists public.allowed_emails (
  email text primary key
);
alter table public.allowed_emails enable row level security;
-- No positive grants: unreadable/unwritable through the API. Only the
-- SECURITY DEFINER trigger (and the dashboard / service role) can see it. The
-- deny-all policy below is redundant given that but documents intent and
-- clears the "RLS enabled, no policy" advisor.
revoke all on public.allowed_emails from anon, authenticated;

drop policy if exists "deny all api access" on public.allowed_emails;
create policy "deny all api access" on public.allowed_emails
  for all
  to anon, authenticated
  using (false)
  with check (false);

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
-- Not callable via the API; it's a trigger and fires regardless of this.
revoke execute on function public.handle_new_user() from public, anon, authenticated;

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
alter table public.categories enable row level security;
alter table public.bucket_targets enable row level security;

-- Coarse table grants (RLS still restricts on top of these).
grant select on public.groups to authenticated;
-- Currency is the only group-level field a member can change (Settings).
grant update (currency) on public.groups to authenticated;
grant select on public.profiles to authenticated;
-- Only these columns are user-updatable — a user must never be able to change
-- their own group_id (which would grant access to another group's data).
grant update (display_name, avatar_url) on public.profiles to authenticated;
grant select, insert, update, delete on public.spendings to authenticated;
grant select, insert, update, delete on public.income to authenticated;
grant select, insert, update, delete on public.categories to authenticated;
grant select, insert, update, delete on public.bucket_targets to authenticated;

-- GROUPS: read your own group; change only its currency.
drop policy if exists "read own group" on public.groups;
create policy "read own group" on public.groups
  for select to authenticated
  using (id = private.current_group_id());

drop policy if exists "update own group currency" on public.groups;
create policy "update own group currency" on public.groups
  for update to authenticated
  using (id = private.current_group_id())
  with check (id = private.current_group_id());

-- PROFILES: read members of your group; update only yourself.
drop policy if exists "read group members" on public.profiles;
create policy "read group members" on public.profiles
  for select to authenticated
  using (group_id = private.current_group_id());

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- SPENDINGS: group-scoped; inserts must be attributed to the caller; edits are
-- group-wide (any member may fix any row, matching delete).
drop policy if exists "read group spendings" on public.spendings;
create policy "read group spendings" on public.spendings
  for select to authenticated
  using (group_id = private.current_group_id());

drop policy if exists "insert own spendings" on public.spendings;
create policy "insert own spendings" on public.spendings
  for insert to authenticated
  with check (group_id = private.current_group_id() and user_id = auth.uid());

drop policy if exists "update group spendings" on public.spendings;
create policy "update group spendings" on public.spendings
  for update to authenticated
  using (group_id = private.current_group_id())
  with check (group_id = private.current_group_id());

drop policy if exists "delete group spendings" on public.spendings;
create policy "delete group spendings" on public.spendings
  for delete to authenticated
  using (group_id = private.current_group_id());

-- INCOME: group-scoped read + write.
drop policy if exists "read group income" on public.income;
create policy "read group income" on public.income
  for select to authenticated
  using (group_id = private.current_group_id());

drop policy if exists "write group income" on public.income;
create policy "write group income" on public.income
  for all to authenticated
  using (group_id = private.current_group_id())
  with check (group_id = private.current_group_id());

-- CATEGORIES: group-scoped read + write.
drop policy if exists "read group categories" on public.categories;
create policy "read group categories" on public.categories
  for select to authenticated
  using (group_id = private.current_group_id());

drop policy if exists "write group categories" on public.categories;
create policy "write group categories" on public.categories
  for all to authenticated
  using (group_id = private.current_group_id())
  with check (group_id = private.current_group_id());

-- BUCKET TARGETS: group-scoped read + write.
drop policy if exists "read group targets" on public.bucket_targets;
create policy "read group targets" on public.bucket_targets
  for select to authenticated
  using (group_id = private.current_group_id());

drop policy if exists "write group targets" on public.bucket_targets;
create policy "write group targets" on public.bucket_targets
  for all to authenticated
  using (group_id = private.current_group_id())
  with check (group_id = private.current_group_id());
