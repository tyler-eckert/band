-- ============================================================================
-- Trailer Folk HQ — 10: personal PDF charts + gig mode
-- Each member keeps their own PDF per song (private storage bucket), can
-- choose a bandmate's chart for a song, or set a default bandmate to fall back on.
-- Safe to re-run. Run after 01–09.
-- ============================================================================
create table if not exists band.song_charts (
  id         uuid primary key default gen_random_uuid(),
  song_id    uuid not null references band.songs(id)   on delete cascade,
  member_id  uuid not null references band.members(id) on delete cascade,
  path       text not null,
  filename   text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (song_id, member_id)
);
create table if not exists band.chart_prefs (          -- "for this song, I use <member>'s chart"
  member_id     uuid not null references band.members(id) on delete cascade,
  song_id       uuid not null references band.songs(id)   on delete cascade,
  use_member_id uuid not null references band.members(id) on delete cascade,
  primary key (member_id, song_id)
);
create table if not exists band.chart_defaults (       -- "when I have no chart of my own, I use <member>'s"
  member_id     uuid primary key references band.members(id) on delete cascade,
  use_member_id uuid not null references band.members(id) on delete cascade
);

drop trigger if exists touch on band.song_charts;
create trigger touch before update on band.song_charts for each row execute function band.touch_updated_at();

do $$
declare t text;
begin
  foreach t in array array['song_charts','chart_prefs','chart_defaults'] loop
    execute format('alter table band.%I enable row level security', t);
    execute format('drop policy if exists read_members on band.%I', t);
    execute format('create policy read_members on band.%I for select to authenticated using (band.is_member())', t);
    execute format('drop policy if exists write_own on band.%I', t);
    execute format('create policy write_own on band.%I for all to authenticated
                    using (member_id = band.my_member_id()) with check (member_id = band.my_member_id())', t);
  end loop;
end $$;

grant select, insert, update, delete on band.song_charts, band.chart_prefs, band.chart_defaults to authenticated;
grant all on band.song_charts, band.chart_prefs, band.chart_defaults to service_role;

-- private bucket; each member can only write inside their own folder (<member_id>/<song_id>.pdf)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('band-charts', 'band-charts', false, 52428800, array['application/pdf'])
on conflict (id) do nothing;

drop policy if exists "band charts read"   on storage.objects;
drop policy if exists "band charts add"    on storage.objects;
drop policy if exists "band charts change" on storage.objects;
drop policy if exists "band charts remove" on storage.objects;
create policy "band charts read"   on storage.objects for select to authenticated
  using (bucket_id = 'band-charts' and band.is_member());
create policy "band charts add"    on storage.objects for insert to authenticated
  with check (bucket_id = 'band-charts' and (storage.foldername(name))[1] = band.my_member_id()::text);
create policy "band charts change" on storage.objects for update to authenticated
  using (bucket_id = 'band-charts' and (storage.foldername(name))[1] = band.my_member_id()::text);
create policy "band charts remove" on storage.objects for delete to authenticated
  using (bucket_id = 'band-charts' and (storage.foldername(name))[1] = band.my_member_id()::text);
