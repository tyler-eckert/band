-- ============================================================================
-- Trailer Folk HQ — 07: let every active member edit band settings
-- (quotes & invoices text, reminders, calendar link). The roster (band.members)
-- stays manager-only. Safe to re-run.
-- ============================================================================
drop policy if exists write_managers on band.settings;
drop policy if exists write_members  on band.settings;
create policy write_members on band.settings for update to authenticated
  using (band.is_member()) with check (band.is_member());
