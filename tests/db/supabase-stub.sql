-- Stand-in for the parts of Supabase's platform that spencer's migrations
-- rely on. It runs as the container superuser (supabase_admin). The migrations
-- then run as `postgres`, which, as on Supabase, is not a superuser: it can
-- create roles and bypass RLS, nothing more.
--
-- Shapes only. Vault here stores plain text, and auth.users has only the
-- columns the sign-up trigger reads.

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role postgres login createrole bypassrls;
grant anon, authenticated, service_role to postgres with inherit false, set true;

grant create on database postgres to postgres;
-- Assume the strictest public schema: no privileges for PUBLIC, so the
-- migrations can't rely on Postgres defaults that Supabase may not keep.
revoke all on schema public from public;
grant usage, create on schema public to postgres;
grant usage on schema public to anon, authenticated, service_role;

-- Supabase grants ALL on new public objects to the API roles (see 0007).
alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated, service_role;

-- auth --------------------------------------------------------------
create schema auth;
grant usage on schema auth to postgres, anon, authenticated, service_role;

create table auth.users (
  id                 uuid primary key,
  email              text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);
grant all on auth.users to postgres;

create function auth.uid() returns uuid
language sql stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    ),
    ''
  )::uuid
$$;

-- extensions --------------------------------------------------------
create schema extensions;
grant usage on schema extensions to postgres, anon, authenticated, service_role;
create extension pgcrypto with schema extensions;

-- vault ---------------------------------------------------------------
create schema vault;
create table vault.secrets (
  id     uuid primary key default gen_random_uuid(),
  name   text unique,
  secret text not null
);
create view vault.decrypted_secrets as
  select id, name, secret as decrypted_secret from vault.secrets;
create function vault.create_secret(
  new_secret text,
  new_name text default null,
  new_description text default ''
) returns uuid
language sql
as $$
  insert into vault.secrets (name, secret) values (new_name, new_secret) returning id
$$;
grant usage on schema vault to postgres;
grant select on vault.decrypted_secrets to postgres;
grant execute on function vault.create_secret(text, text, text) to postgres;
