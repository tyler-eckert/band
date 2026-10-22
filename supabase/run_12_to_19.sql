-- ============================================================================
-- Trailer Folk HQ - run 12 to 19 in one go (everything except 16)
-- Paste this whole file into Supabase -> SQL Editor -> Run. Safe to run again.
-- Assumes 01-11 are already in. 16 (the Monday-digest schedule) is separate on purpose:
-- run it AFTER band-digest is deployed and its email secrets are set.
-- ============================================================================

-- ################ 12_catchup_columns.sql ################
-- ============================================================================
-- Trailer Folk HQ — 12: catch-up for any column the app needs.
-- Safe to run any time, any number of times. Fixes errors like
--   "Could not find the 'is_closer' column of 'songs' in the schema cache".
-- (This covers the columns from 05, 06, 08, 09 and 11. The storage bucket for
--  photos/charts and the policies still come from 06, 07 and 10.)
-- ============================================================================
alter table band.songs add column if not exists is_opener boolean not null default false;
alter table band.songs add column if not exists is_closer boolean not null default false;
alter table band.songs add column if not exists is_encore boolean not null default false;
alter table band.songs add column if not exists bpm int;

alter table band.gigs add column if not exists load_in_time     text;
alter table band.gigs add column if not exists paperwork_signed boolean not null default false;
alter table band.gigs add column if not exists invoice_sent     boolean not null default false;
alter table band.gigs add column if not exists paid_in_full     boolean not null default false;
alter table band.gigs add column if not exists details_sent     boolean not null default false;
alter table band.gigs add column if not exists photos           jsonb   not null default '[]'::jsonb;
alter table band.gigs add column if not exists checklist_na     jsonb   not null default '[]'::jsonb;

-- from 15 (trash, day sheet, digest opt-out) — the activity table itself is created by 15
alter table band.gigs     add column if not exists deleted_at timestamptz;
alter table band.songs    add column if not exists deleted_at timestamptz;
alter table band.setlists add column if not exists deleted_at timestamptz;
alter table band.clients  add column if not exists deleted_at timestamptz;
alter table band.expenses add column if not exists deleted_at timestamptz;
alter table band.gigs add column if not exists soundcheck_time text;
alter table band.gigs add column if not exists onsite_contact  text;
alter table band.gigs add column if not exists onsite_phone    text;
alter table band.gigs add column if not exists parking         text;
alter table band.gigs add column if not exists dress_code      text;
alter table band.gigs add column if not exists stage_power     text;
alter table band.gigs add column if not exists food_notes      text;
alter table band.gigs add column if not exists gear_notes      text;
alter table band.settings add column if not exists digest_optout jsonb not null default '[]'::jsonb;

-- from 17 (website booking inquiries)
alter table band.gigs add column if not exists lead_source       text;
alter table band.gigs add column if not exists lead_received_at  timestamptz;
alter table band.gigs add column if not exists lead_event_type   text;
alter table band.gigs add column if not exists lead_budget       text;
alter table band.gigs add column if not exists lead_outside_okc  text;
alter table band.gigs add column if not exists lead_guests       text;
alter table band.gigs add column if not exists lead_setting      text;
alter table band.gigs add column if not exists lead_power        text;
alter table band.gigs add column if not exists lead_heard_from   text;
alter table band.gigs add column if not exists lead_contact_pref text;
alter table band.gigs add column if not exists lead_date_flex    boolean;

-- from 18 (editable Contact Us form)
alter table band.settings add column if not exists inquiry_form jsonb;

-- make the API notice the new columns right away
notify pgrst, 'reload schema';

-- ################ 13_chart_marks.sql ################
-- ============================================================================
-- Trailer Folk HQ — 13: Apple Pencil markup on PDF charts
-- Each member's pen marks are private to them, one row per song per chart.
-- Safe to re-run. Run after 10.
-- ============================================================================
create table if not exists band.chart_marks (
  member_id  uuid not null references band.members(id) on delete cascade,
  song_id    uuid not null references band.songs(id)   on delete cascade,
  chart_path text not null,
  strokes    jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (member_id, song_id, chart_path)
);
alter table band.chart_marks enable row level security;
drop policy if exists own_marks on band.chart_marks;
create policy own_marks on band.chart_marks for all to authenticated
  using (member_id = band.my_member_id()) with check (member_id = band.my_member_id());
grant select, insert, update, delete on band.chart_marks to authenticated;
grant all on band.chart_marks to service_role;
notify pgrst, 'reload schema';

-- ################ 14_checklist_na.sql ################
-- ============================================================================
-- Trailer Folk HQ — 14: "N/A" (struck-through) items on the gig checklist.
-- Safe to re-run.
-- ============================================================================
alter table band.gigs add column if not exists checklist_na jsonb not null default '[]'::jsonb;
notify pgrst, 'reload schema';

-- ################ 15_trash_activity_daysheet.sql ################
-- ============================================================================
-- Trailer Folk HQ — 15: Trash & Undo, Activity log, Day sheet fields, digest opt-out
-- Safe to re-run. Run after 01–14.
-- ============================================================================

-- ---- Trash: deleted rows stay in the table (deleted_at set) until someone deletes them forever
alter table band.gigs     add column if not exists deleted_at timestamptz;
alter table band.songs    add column if not exists deleted_at timestamptz;
alter table band.setlists add column if not exists deleted_at timestamptz;
alter table band.clients  add column if not exists deleted_at timestamptz;
alter table band.expenses add column if not exists deleted_at timestamptz;

-- ---- Day sheet: day-of details on each gig
alter table band.gigs add column if not exists soundcheck_time text;
alter table band.gigs add column if not exists onsite_contact  text;
alter table band.gigs add column if not exists onsite_phone    text;
alter table band.gigs add column if not exists parking         text;
alter table band.gigs add column if not exists dress_code      text;
alter table band.gigs add column if not exists stage_power     text;
alter table band.gigs add column if not exists food_notes      text;
alter table band.gigs add column if not exists gear_notes      text;

-- ---- Weekly digest: members who opted out (list of member ids)
alter table band.settings add column if not exists digest_optout jsonb not null default '[]'::jsonb;

-- ---- Activity log: who changed what
create table if not exists band.activity (
  id         uuid primary key default gen_random_uuid(),
  at         timestamptz not null default now(),
  member_id  uuid references band.members(id) on delete set null,
  who        text,
  action     text not null,
  entity     text not null,
  entity_id  uuid,
  title      text,
  changes    jsonb not null default '[]'::jsonb
);
create index if not exists activity_at_idx on band.activity (at desc);
alter table band.activity enable row level security;
drop policy if exists read_members on band.activity;
create policy read_members on band.activity for select to authenticated using (band.is_member());
drop policy if exists add_own on band.activity;
create policy add_own on band.activity for insert to authenticated with check (band.is_member() and member_id = band.my_member_id());
drop policy if exists edit_own on band.activity;
create policy edit_own on band.activity for update to authenticated using (member_id = band.my_member_id()) with check (member_id = band.my_member_id());
grant select, insert, update on band.activity to authenticated;
grant all on band.activity to service_role;

notify pgrst, 'reload schema';

-- ################ 17_inquiry_leads.sql ################
-- ============================================================================
-- Trailer Folk HQ - 17: booking inquiries from the website's Contact Us form
-- Safe to re-run. Run after 15. The form itself talks to the band-inquiry edge function.
-- ============================================================================
alter table band.gigs add column if not exists lead_source       text;         -- 'website' for form submissions
alter table band.gigs add column if not exists lead_received_at  timestamptz;
alter table band.gigs add column if not exists lead_event_type   text;
alter table band.gigs add column if not exists lead_budget       text;
alter table band.gigs add column if not exists lead_outside_okc  text;         -- Yes / No / Not sure
alter table band.gigs add column if not exists lead_guests       text;
alter table band.gigs add column if not exists lead_setting      text;         -- Indoor / Outdoor / Both or not sure
alter table band.gigs add column if not exists lead_power        text;         -- power available at the venue?
alter table band.gigs add column if not exists lead_heard_from   text;
alter table band.gigs add column if not exists lead_contact_pref text;
alter table band.gigs add column if not exists lead_date_flex    boolean;
notify pgrst, 'reload schema';

-- ################ 18_inquiry_form_settings.sql ################
-- ============================================================================
-- Trailer Folk HQ - 18: the Contact Us form's dropdowns are editable from Admin -> Contact form
-- Safe to re-run. Run after 17.
-- ============================================================================
alter table band.settings add column if not exists inquiry_form jsonb;     -- null = the built-in defaults
notify pgrst, 'reload schema';

-- ################ 19_settings_insert_policy.sql ################
-- ============================================================================
-- Trailer Folk HQ - 19: fix "new row violates row-level security policy for table settings"
-- The app saves settings with an "upsert" (insert, or update if it exists). Postgres checks the INSERT rule
-- for that, and the settings table only had an UPDATE rule. This adds the missing one for active members.
-- Safe to re-run.
-- ============================================================================
drop policy if exists insert_members on band.settings;
create policy insert_members on band.settings for insert to authenticated with check (band.is_member());
notify pgrst, 'reload schema';
