-- Lock down public.allowed_emails and clear the "RLS enabled, no policy" advisor.
--
-- This table is read ONLY by the SECURITY DEFINER handle_new_user() trigger,
-- which bypasses RLS — no API client ever needs it. We make that explicit:
--   * revoke the default API grants  -> anon/authenticated get a hard denial
--   * add an explicit deny-all policy -> satisfies the linter, documents intent
-- service_role retains access (for admin use) and the trigger is unaffected.

revoke all on public.allowed_emails from anon, authenticated;

drop policy if exists "deny all api access" on public.allowed_emails;
create policy "deny all api access" on public.allowed_emails
  for all
  to anon, authenticated
  using (false)
  with check (false);
