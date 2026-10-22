-- ============================================================================
-- Trailer Folk HQ - 19: fix "new row violates row-level security policy for table settings"
-- The app saves settings with an "upsert" (insert, or update if it exists). Postgres checks the INSERT rule
-- for that, and the settings table only had an UPDATE rule. This adds the missing one for active members.
-- Safe to re-run.
-- ============================================================================
drop policy if exists insert_members on band.settings;
create policy insert_members on band.settings for insert to authenticated with check (band.is_member());
notify pgrst, 'reload schema';
