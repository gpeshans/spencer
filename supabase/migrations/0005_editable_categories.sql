-- Spencer — user-editable categories (move the category source of truth into the DB)
--
-- Categories used to be a fixed list in lib/categories.ts. To let the family
-- add / rename / retire categories and re-assign them to buckets from the app,
-- they now live per-group in public.categories. The spendings.bucket trigger
-- (0004) is repointed at categories.bucket, and 0004's global category_buckets
-- map is superseded by it.
--
-- The four buckets stay a fixed enum — only their labels/targets are editable
-- (bucket_targets, from 0004) and categories move between them.

-- ============================================================
-- CATEGORIES  (per-group; expense + income)
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

alter table public.categories
  alter column group_id set default private.current_group_id();

-- Seed every existing group from the app's default lists. `sort` preserves the
-- current on-screen order; icon_name is the lucide (kebab-case) icon name.
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

-- ============================================================
-- Repoint the spendings bucket trigger at categories.bucket (per group).
-- new.group_id is already filled by its column default before this BEFORE trigger
-- runs, so the lookup is scoped to the row's own group.
-- ============================================================
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
revoke execute on function public.set_spending_bucket() from public, anon, authenticated;

-- category_buckets (0004) is now superseded by categories.bucket.
drop policy if exists "read category buckets" on public.category_buckets;
drop table if exists public.category_buckets;

-- ============================================================
-- GRANTS · TRIGGERS · RLS  (group-scoped read + write, like income)
-- ============================================================
grant select, insert, update, delete on public.categories to authenticated;

drop trigger if exists categories_set_updated_at on public.categories;
create trigger categories_set_updated_at
  before update on public.categories
  for each row execute function public.set_updated_at();

alter table public.categories enable row level security;

drop policy if exists "read group categories" on public.categories;
create policy "read group categories" on public.categories
  for select to authenticated
  using (group_id = private.current_group_id());

drop policy if exists "write group categories" on public.categories;
create policy "write group categories" on public.categories
  for all to authenticated
  using (group_id = private.current_group_id())
  with check (group_id = private.current_group_id());
