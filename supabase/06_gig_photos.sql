-- ============================================================================
-- Trailer Folk HQ — 06: gig photos
-- A photos list on each gig + a private storage bucket for the pictures.
-- Safe to re-run. Run after 05.
-- ============================================================================
alter table band.gigs add column if not exists photos jsonb not null default '[]'::jsonb;

insert into storage.buckets (id, name, public)
values ('band-photos', 'band-photos', false)
on conflict (id) do nothing;

drop policy if exists "band photos read"   on storage.objects;
drop policy if exists "band photos add"    on storage.objects;
drop policy if exists "band photos change" on storage.objects;
drop policy if exists "band photos remove" on storage.objects;

create policy "band photos read"   on storage.objects for select to authenticated
  using (bucket_id = 'band-photos' and band.is_member());
create policy "band photos add"    on storage.objects for insert to authenticated
  with check (bucket_id = 'band-photos' and band.is_member());
create policy "band photos change" on storage.objects for update to authenticated
  using (bucket_id = 'band-photos' and band.is_member());
create policy "band photos remove" on storage.objects for delete to authenticated
  using (bucket_id = 'band-photos' and band.is_member());
