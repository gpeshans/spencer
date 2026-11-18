-- ============================================================
-- 0009: hardening — constrain what a signed-in member can write directly
-- ============================================================
--
-- A signed-in member holds the publishable key and their JWT, so they can call
-- PostgREST directly and bypass the app's own input validation. RLS and table
-- constraints are the real boundary; the app layer is not. RLS (0001–0008)
-- already blocks every cross-household read and write. This migration closes the
-- remaining intra-household integrity gaps and bounds the free-text columns that
-- reports and charts render.
--
-- Adds triggers and CHECK constraints only — no column, policy or grant changes
-- to existing data. The format/length checks are added NOT VALID: they apply
-- instantly and enforce on every new and updated row, without rescanning rows
-- that predate them (which the app already kept within these bounds).
--
-- Idempotent: re-running it is harmless.

-- ------------------------------------------------------------
-- 1. spendings.user_id: the author can't be reassigned on UPDATE
-- ------------------------------------------------------------
-- The UPDATE policy is group-wide (0006) and the app never sends user_id, but a
-- direct PATCH could set it to any profile id. Pin it to the stored value.
create or replace function public.pin_spending_author()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.user_id := old.user_id;
  return new;
end;
$$;
revoke execute on function public.pin_spending_author() from public, anon, authenticated;

drop trigger if exists spendings_pin_author on public.spendings;
create trigger spendings_pin_author
  before update on public.spendings
  for each row execute function public.pin_spending_author();

-- ------------------------------------------------------------
-- 2. spendings.bucket: always re-derived from the category
-- ------------------------------------------------------------
-- 0004's trigger fired only `before insert or update OF category`, so a direct
-- UPDATE of bucket alone slipped past it and could set any value. Fire on every
-- update so bucket stays a pure function of category. set_spending_bucket()
-- (0005) is unchanged; this only widens when it runs.
drop trigger if exists spendings_set_bucket on public.spendings;
create trigger spendings_set_bucket
  before insert or update on public.spendings
  for each row execute function public.set_spending_bucket();

-- ------------------------------------------------------------
-- 3. income.created_by: pinned to the caller on INSERT
-- ------------------------------------------------------------
-- The column default is auth.uid(), but a direct INSERT could name another
-- member. Force it. (On an upsert's conflict path the row keeps its stored
-- created_by, since the app's UPDATE never touches the column.)
create or replace function public.pin_income_creator()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_by := auth.uid();
  return new;
end;
$$;
revoke execute on function public.pin_income_creator() from public, anon, authenticated;

drop trigger if exists income_pin_creator on public.income;
create trigger income_pin_creator
  before insert on public.income
  for each row execute function public.pin_income_creator();

-- ------------------------------------------------------------
-- 4. Bound and validate the free-text columns (NOT VALID)
-- ------------------------------------------------------------
-- The app validates these (description sliced to 200, colour a 6-hex string,
-- keys slugified), but a direct write skips that. These back the app's checks at
-- the database — above all the colour, which a report renders into a chart's
-- stylesheet. drop-then-add keeps the migration idempotent.
alter table public.spendings drop constraint if exists spendings_description_len;
alter table public.spendings
  add constraint spendings_description_len check (char_length(description) <= 500) not valid;
alter table public.spendings drop constraint if exists spendings_category_len;
alter table public.spendings
  add constraint spendings_category_len check (char_length(category) <= 64) not valid;

alter table public.categories drop constraint if exists categories_color_hex;
alter table public.categories
  add constraint categories_color_hex check (color ~ '^#[0-9a-fA-F]{6}$') not valid;
alter table public.categories drop constraint if exists categories_label_len;
alter table public.categories
  add constraint categories_label_len check (char_length(label) <= 80) not valid;
alter table public.categories drop constraint if exists categories_icon_len;
alter table public.categories
  add constraint categories_icon_len check (char_length(icon_name) <= 64) not valid;
alter table public.categories drop constraint if exists categories_key_len;
alter table public.categories
  add constraint categories_key_len check (char_length(key) <= 64) not valid;

-- ------------------------------------------------------------
-- 5. Deny-by-default grants for future public tables
-- ------------------------------------------------------------
-- Supabase grants ALL on every new public table to anon and authenticated.
-- 0007 and 0008 revoke that per table; this makes deny-the-default standing, so
-- a table added later (a migration, or the dashboard) is not silently exposed
-- to the API. Later migrations still grant the access they intend, explicitly.
-- Only affects objects created after this runs; existing tables are untouched.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
