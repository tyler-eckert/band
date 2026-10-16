-- ============================================================================
-- Trailer Folk HQ — 05: load-in time + gig checklist
-- Adds a load-in time and the checklist booleans used on the gig page.
-- Safe to re-run. Run after 01–04.
-- ============================================================================
alter table band.gigs add column if not exists load_in_time     text;
alter table band.gigs add column if not exists paperwork_signed boolean not null default false;
alter table band.gigs add column if not exists invoice_sent     boolean not null default false;
alter table band.gigs add column if not exists paid_in_full     boolean not null default false;
alter table band.gigs add column if not exists details_sent     boolean not null default false;

-- Backfill from what the app already knows, so old gigs don't show up as "to do".
update band.gigs set invoice_sent = true where invoice_no is not null and not invoice_sent;
update band.gigs set paid_in_full = true
 where kind = 'gig' and status = 'complete' and not paid_in_full
   and coalesce(quote, 0) > 0
   and (case when deposit_received then coalesce(deposit_amount, 0) else 0 end) + coalesce(paid, 0) >= quote;
update band.gigs set paperwork_signed = true, details_sent = true
 where kind = 'gig' and status = 'complete' and not paperwork_signed;
