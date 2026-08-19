-- Spencer — editable spendings (align UPDATE with DELETE) + per-member index
--
-- v1 had no edit UI, and the UPDATE policy was pinned to `user_id = auth.uid()`
-- while DELETE has always been group-wide. That asymmetry meant a member could
-- delete their partner's typo but not fix it. Now that spendings are editable
-- in-app, the two policies match: anyone in the group may edit any row in it.
--
-- The row's author still can't be reassigned in practice — the app never sends
-- `user_id`, and the WITH CHECK below keeps the row inside the caller's group
-- either way. (Pinning `user_id` to its pre-update value would need a trigger;
-- RLS can't reference the old row from WITH CHECK.)
--
-- `spendings.bucket` and `spendings.updated_at` stay trigger-owned: 0004's
-- spendings_set_bucket already fires `before insert or update of category`, so
-- re-categorising a spending re-derives its bucket with no app-side help.

-- ============================================================
-- SPENDINGS: group-wide UPDATE, matching the DELETE policy
-- ============================================================
drop policy if exists "update group spendings" on public.spendings;
create policy "update group spendings" on public.spendings
  for update to authenticated
  using (group_id = private.current_group_id())
  with check (group_id = private.current_group_id());

-- ============================================================
-- Per-member reporting ("Split by member" on the month + year views)
-- ============================================================
create index if not exists spendings_group_user_idx
  on public.spendings (group_id, user_id);
