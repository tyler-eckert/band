-- ============================================================================
-- Trailer Folk HQ — `band` schema for the lawn-master Supabase project
-- Run in the Supabase SQL editor (as postgres). Safe to re-run: objects are
-- created if missing and policies are dropped/recreated.
--
-- After running:
--   1. Project Settings → Data API → Exposed schemas: add `band`.
--   2. Run 02_seed.sql (edit the member emails at the bottom first).
--   3. Authentication → Users: create a login for each member (same emails).
-- ============================================================================

create schema if not exists band;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- tables ----

create table if not exists band.members (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  email       text,
  user_id     uuid unique references auth.users(id) on delete set null,
  instrument  text,
  role        text not null default 'member' check (role in ('manager','member')),
  photo       text,
  active      boolean not null default true,
  sort        int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists band.settings (
  id                   int primary key default 1 check (id = 1),
  band_name            text not null default 'Trailer Folk',
  band_email           text default 'TrailerFolkBand@gmail.com',
  instagram            text default '@trailer_folk',
  youtube              text default '@TrailerFolk',
  default_terms        text not null default 'NET30',
  default_description  text default 'A night full of awesome music!',
  default_line_item    text default 'Load-in, setup, soundcheck, music ({hours}hrs), load-out',
  default_line_note    text default 'Including sound and lighting equipment',
  quote_valid_days     int not null default 30,
  deposit_pct          numeric not null default 0,
  band_fund_pct        numeric not null default 0,
  song_buffer_sec      int not null default 10,
  set_target_min       int not null default 40,
  remind_setlist_days  int not null default 14,
  remind_quote_days    int not null default 10,
  ics_token            uuid not null default gen_random_uuid(),
  updated_at           timestamptz not null default now()
);
insert into band.settings (id) values (1) on conflict (id) do nothing;

create table if not exists band.payees (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  org             text,
  address1        text,
  city_state_zip  text,
  check_note      text,
  is_default      boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists band.clients (
  id              uuid primary key default gen_random_uuid(),
  code            text,                 -- used in invoice numbers, e.g. OUHSC_202604
  org             text,
  contact_name    text,
  address1        text,
  city_state_zip  text,
  email           text,
  phone           text,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- One table for gigs, practices and leads; `kind` + `status` tell them apart.
create table if not exists band.gigs (
  id                   uuid primary key default gen_random_uuid(),
  kind                 text not null default 'gig' check (kind in ('gig','practice')),
  status               text check (status in ('inquiry','quoted','confirmed','complete','passed','cancelled')),
  title                text not null,
  gig_date             date,
  start_time           text,
  end_time             text,
  venue                text,
  address              text,
  client_id            uuid references band.clients(id) on delete set null,
  payee_id             uuid references band.payees(id) on delete set null,
  notes                text,
  quote                numeric,
  hours                numeric,
  line_item            text,
  deposit_amount       numeric,
  deposit_received     boolean not null default false,
  deposit_received_on  date,
  paid                 numeric,         -- received at/after the gig, less deposit
  paid_on              date,
  tips                 numeric,
  merch                numeric,         -- merch $ entered directly on the gig
  quote_no             text,
  quoted_on            date,
  invoice_no           text,
  invoiced_on          date,
  set_count            int,
  songs_played_legacy  int,             -- count from the old sheet when no setlist exists
  created_by           uuid default auth.uid(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists gigs_date_idx on band.gigs (gig_date);

create table if not exists band.songs (
  id             uuid primary key default gen_random_uuid(),
  title          text not null,
  artist         text,
  status         text not null default 'active' check (status in ('active','bench','learning','retired','holiday')),
  length_min     numeric,
  song_key       text,
  capo           int,
  year           int,
  added_on       date,
  comment        text,
  starter        text,
  lead_vox       text,
  parts          jsonb,                 -- {"Tyler":"Guitar","Jessie":"Vocal",...}
  chart_url      text,
  default_set    int,
  default_order  int,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists band.setlist_items (
  id        uuid primary key default gen_random_uuid(),
  gig_id    uuid not null references band.gigs(id) on delete cascade,
  set_no    int not null default 1,
  position  int not null default 1,
  song_id   uuid not null references band.songs(id) on delete cascade,
  played    boolean not null default true,
  note      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists setlist_gig_idx on band.setlist_items (gig_id, set_no, position);

create table if not exists band.song_ratings (
  song_id    uuid not null references band.songs(id) on delete cascade,
  member_id  uuid not null references band.members(id) on delete cascade,
  rating     smallint not null check (rating between 1 and 5),
  updated_at timestamptz not null default now(),
  primary key (song_id, member_id)
);

create table if not exists band.merch_items (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  price      numeric,
  cost       numeric,
  stock      int not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists band.merch_sales (
  id         uuid primary key default gen_random_uuid(),
  sold_on    date not null default current_date,
  gig_id     uuid references band.gigs(id) on delete set null,
  item_id    uuid references band.merch_items(id) on delete set null,
  qty        int not null default 1,
  amount     numeric not null,
  method     text,
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists band.expenses (
  id          uuid primary key default gen_random_uuid(),
  spent_on    date not null default current_date,
  gig_id      uuid references band.gigs(id) on delete set null,
  category    text not null default 'Gear',
  amount      numeric not null,
  note        text,
  paid_by     uuid references band.members(id) on delete set null,
  reimbursed  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ------------------------------------------------------- updated_at stamp ---

create or replace function band.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;

do $$
declare t text;
begin
  foreach t in array array['members','settings','payees','clients','gigs','songs',
                           'setlist_items','song_ratings','merch_items','merch_sales','expenses']
  loop
    execute format('drop trigger if exists touch on band.%I', t);
    execute format('create trigger touch before update on band.%I
                    for each row execute function band.touch_updated_at()', t);
  end loop;
end $$;

-- ------------------------------------------------------ access helpers -----
-- Membership is the gate: a signed-in Supabase user sees band data only when
-- band.members links to them. Other apps in this project (TurfOps) are unaffected.

create or replace function band.my_member_id() returns uuid
language sql stable security definer set search_path = band, pg_temp as $$
  select id from band.members where user_id = auth.uid() and active limit 1
$$;

create or replace function band.is_member() returns boolean
language sql stable security definer set search_path = band, pg_temp as $$
  select exists (select 1 from band.members where user_id = auth.uid() and active)
$$;

create or replace function band.is_manager() returns boolean
language sql stable security definer set search_path = band, pg_temp as $$
  select exists (select 1 from band.members where user_id = auth.uid() and active and role = 'manager')
$$;

-- Called by the app right after sign-in: links the login to the member row
-- whose email matches, the first time that person signs in.
create or replace function band.claim_membership() returns uuid
language plpgsql security definer set search_path = band, pg_temp as $$
declare mid uuid; em text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if auth.uid() is null or em = '' then return null; end if;
  update band.members set user_id = auth.uid()
   where user_id is null and lower(email) = em and active
   returning id into mid;
  return coalesce(mid, band.my_member_id());
end $$;

-- ---------------------------------------------------------------- RLS ------

do $$
declare t text;
begin
  foreach t in array array['members','settings','payees','clients','gigs','songs',
                           'setlist_items','song_ratings','merch_items','merch_sales','expenses']
  loop
    execute format('alter table band.%I enable row level security', t);
    execute format('drop policy if exists read_members on band.%I', t);
    execute format('create policy read_members on band.%I for select to authenticated using (band.is_member())', t);
  end loop;

  -- shared working data: any active member can add / edit / remove
  foreach t in array array['payees','clients','gigs','songs','setlist_items',
                           'merch_items','merch_sales','expenses']
  loop
    execute format('drop policy if exists write_members on band.%I', t);
    execute format('create policy write_members on band.%I for all to authenticated
                    using (band.is_member()) with check (band.is_member())', t);
  end loop;
end $$;

-- roster + band settings: managers only
drop policy if exists write_managers on band.members;
create policy write_managers on band.members for all to authenticated
  using (band.is_manager()) with check (band.is_manager());
drop policy if exists write_managers on band.settings;
create policy write_managers on band.settings for update to authenticated
  using (band.is_manager()) with check (band.is_manager());

-- ratings: everyone sees all, each member writes only their own
drop policy if exists write_own on band.song_ratings;
create policy write_own on band.song_ratings for all to authenticated
  using (member_id = band.my_member_id()) with check (member_id = band.my_member_id());

-- ------------------------------------------------------------- grants ------

grant usage on schema band to authenticated, service_role;
grant select, insert, update, delete on all tables in schema band to authenticated;
grant all on all tables in schema band to service_role;
grant execute on function band.my_member_id(), band.is_member(), band.is_manager(),
                          band.claim_membership() to authenticated;
revoke all on schema band from anon;
alter default privileges in schema band grant select, insert, update, delete on tables to authenticated;

-- Optional: live updates between bandmates' open tabs (Supabase Realtime).
-- alter publication supabase_realtime add table band.gigs, band.setlist_items, band.songs, band.song_ratings;
