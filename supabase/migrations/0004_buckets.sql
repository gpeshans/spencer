-- Spencer — expense "buckets" (hidden umbrella categories) + distribution targets
--
-- Four umbrella buckets group the expense categories so we can track how income
-- is distributed vs. our goals, on a monthly and yearly level:
--   needs 20% · wants 10% · savings & investments 40% · emergency 30%
--
-- Design mirrors the existing group_id/user_id pattern — DB-authoritative and
-- un-spoofable:
--   * public.bucket          an enum of the four buckets
--   * category_buckets       category -> bucket map; the single source of truth
--                            for auto-assignment, editable without a deploy
--   * spendings.bucket       denormalized onto EVERY row, auto-filled by a trigger
--                            from category_buckets, and backfilled for old rows
--   * bucket_targets         per-group target ratio per bucket (seeded defaults)
--
-- The buckets themselves are hidden from the UI; only the categories are
-- user-facing (this migration's category set now also covers savings,
-- investments and emergency so all four buckets can actually be populated).

-- ============================================================
-- BUCKET ENUM
-- ============================================================
do $$
begin
  create type public.bucket as enum ('needs', 'wants', 'savings', 'emergency');
exception
  when duplicate_object then null;
end
$$;

-- ============================================================
-- CATEGORY -> BUCKET MAP  (global reference data)
-- Keep in sync with CATEGORY_BUCKET in lib/categories.ts.
-- ============================================================
create table if not exists public.category_buckets (
  category text primary key,        -- an EXPENSE category key (lib/categories.ts)
  bucket   public.bucket not null
);

insert into public.category_buckets (category, bucket) values
  ('groceries',     'needs'),
  ('transport',     'needs'),
  ('housing',       'needs'),
  ('utilities',     'needs'),
  ('health',        'needs'),
  ('kids',          'needs'),
  ('dining',        'wants'),
  ('shopping',      'wants'),
  ('entertainment', 'wants'),
  ('travel',        'wants'),
  ('other',         'wants'),
  ('savings',       'savings'),
  ('investments',   'savings'),
  ('emergency',     'emergency')
on conflict (category) do update set bucket = excluded.bucket;

-- ============================================================
-- spendings.bucket  (denormalized; auto-filled + backfilled)
-- ============================================================
alter table public.spendings
  add column if not exists bucket public.bucket;

-- Backfill existing rows from the map. Unknown categories -> 'wants' (the app
-- validates against a fixed list, so this is only a safety net). Done BEFORE the
-- trigger exists so the computed value sticks verbatim.
update public.spendings s
set bucket = coalesce(
  (select cb.bucket from public.category_buckets cb where cb.category = s.category),
  'wants'::public.bucket
)
where s.bucket is null;

alter table public.spendings
  alter column bucket set not null;

create index if not exists spendings_group_bucket_idx
  on public.spendings (group_id, bucket);

-- Trigger keeps bucket a pure function of category on insert / category change,
-- so the app never sends it and it can't be spoofed (like group_id / user_id).
create or replace function public.set_spending_bucket()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  select cb.bucket into new.bucket
  from public.category_buckets cb
  where cb.category = new.category;

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

-- category_buckets is public reference data: readable by all authenticated users,
-- writable only by the service role / migrations (no write policy).
alter table public.category_buckets enable row level security;
grant select on public.category_buckets to authenticated;

drop policy if exists "read category buckets" on public.category_buckets;
create policy "read category buckets" on public.category_buckets
  for select to authenticated
  using (true);

-- ============================================================
-- BUCKET TARGETS  (per-group target ratio; editable later)
-- ============================================================
create table if not exists public.bucket_targets (
  group_id   uuid not null references public.groups (id),
  bucket     public.bucket not null,
  target_pct numeric(5, 2) not null check (target_pct >= 0 and target_pct <= 100),
  updated_at timestamptz not null default now(),
  primary key (group_id, bucket)
);
alter table public.bucket_targets
  alter column group_id set default private.current_group_id();

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

grant select, insert, update, delete on public.bucket_targets to authenticated;

drop trigger if exists bucket_targets_set_updated_at on public.bucket_targets;
create trigger bucket_targets_set_updated_at
  before update on public.bucket_targets
  for each row execute function public.set_updated_at();

alter table public.bucket_targets enable row level security;

drop policy if exists "read group targets" on public.bucket_targets;
create policy "read group targets" on public.bucket_targets
  for select to authenticated
  using (group_id = private.current_group_id());

drop policy if exists "write group targets" on public.bucket_targets;
create policy "write group targets" on public.bucket_targets
  for all to authenticated
  using (group_id = private.current_group_id())
  with check (group_id = private.current_group_id());
