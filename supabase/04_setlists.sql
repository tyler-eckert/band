-- ============================================================================
-- Trailer Folk HQ — 04: setlists as their own thing
-- A setlist can now exist before there's a gig, then be assigned to one later.
-- Each gig has at most one setlist; deleting a gig keeps its setlist as a draft.
-- Moves every existing gig setlist into band.setlists. Safe to re-run.
-- Run after 01–03.
-- ============================================================================

create table if not exists band.setlists (
  id           uuid primary key default gen_random_uuid(),
  name         text,                          -- blank = use the gig's name
  notes        text,
  gig_id       uuid unique references band.gigs(id) on delete set null,
  start_time   text,                          -- blank = use the gig's start time
  hours        numeric,                       -- slot length incl. breaks; blank = gig's hours
  set_count    int,
  break_count  int,
  break_min    int,
  plan         jsonb,                         -- optimizer preferences
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table band.setlist_items add column if not exists setlist_id uuid references band.setlists(id) on delete cascade;
alter table band.setlist_items alter column gig_id drop not null;   -- legacy column; the app now uses setlist_id

-- one setlist per gig that already has songs
insert into band.setlists (gig_id, set_count, break_count, break_min, plan)
select g.id, g.set_count, g.break_count, g.break_min, g.plan
from band.gigs g
where exists (select 1 from band.setlist_items i where i.gig_id = g.id and i.setlist_id is null)
  and not exists (select 1 from band.setlists l where l.gig_id = g.id);

update band.setlist_items i set setlist_id = l.id
from band.setlists l
where i.setlist_id is null and l.gig_id = i.gig_id;

delete from band.setlist_items where setlist_id is null;          -- orphans (none expected)
alter table band.setlist_items alter column setlist_id set not null;
create index if not exists setlist_items_list_idx on band.setlist_items (setlist_id, set_no, position);

drop trigger if exists touch on band.setlists;
create trigger touch before update on band.setlists for each row execute function band.touch_updated_at();

alter table band.setlists enable row level security;
drop policy if exists read_members on band.setlists;
create policy read_members on band.setlists for select to authenticated using (band.is_member());
drop policy if exists write_members on band.setlists;
create policy write_members on band.setlists for all to authenticated using (band.is_member()) with check (band.is_member());

grant select, insert, update, delete on band.setlists to authenticated;
grant all on band.setlists to service_role;

notify pgrst, 'reload schema';
