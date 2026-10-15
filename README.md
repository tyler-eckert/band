# Trailer Folk HQ — band.eckerthaus.com

Band admin app: gigs & leads, calendar sync, quotes/invoices (PDF), setlists, song book with ratings, money (pay/tips/merch/expenses/payouts).
Static site on GitHub Pages (same pattern as TurfOps) + a `band` schema in the **lawn-master** Supabase project.

```
index.html, app.js, CNAME, assets/, vendor/   ← the website (push these to the Pages repo)
supabase/01_schema.sql                        ← tables, RLS, helper functions
supabase/02_seed.sql                          ← your data from Trailer Folk Master Sheet.xlsx  (do NOT commit to a public repo)
supabase/03_setlist_planner.sql               ← genre/energy/tuning on songs, breaks on gigs, pinned setlist songs
supabase/functions/band-calendar/index.ts     ← live calendar feed
```

## One-time setup (about 15 minutes)

1. **Schema** — Supabase → SQL Editor → paste `supabase/01_schema.sql` → Run. (Safe to re-run.)
2. **Expose it** — Project Settings → Data API → *Exposed schemas* → add `band` → Save.
3. **Seed** — open `supabase/02_seed.sql`, put your login email on the `update band.members … where name = 'Tyler'` line near the bottom (and bandmates' if you have them), then Run it.
   Loads 94 gigs/practices/passes, 111 songs, 530 setlist rows, 4 clients, 2 pay-tos.
   Then run `supabase/03_setlist_planner.sql` (adds the setlist-planner fields and a starting genre + energy for every song).
4. **Logins** — Authentication → Users → *Add user* for each member using the same email (or let them use "Email me a sign-in link" once their email is on the roster).
   Add `https://band.eckerthaus.com` to Authentication → URL Configuration → Redirect URLs so magic links come back to the app.
   A login only sees band data if its email is on the roster — TurfOps users without a roster row see nothing.
5. **Website** — new GitHub repo (e.g. `band`), push `index.html app.js CNAME assets/ vendor/`, Settings → Pages → deploy from `main` / root.
   DNS: CNAME record `band` → `<your-github-username>.github.io`. Tick *Enforce HTTPS* once the cert issues.
6. **Calendar feed (optional, recommended)** —
   `supabase functions deploy band-calendar --no-verify-jwt --project-ref uomhdexfwovuovtarycz`
   Then Calendar page → *Copy URL* → subscribe on each phone (Apple: tap *Open in Apple Calendar*; Google: Other calendars → From URL).
7. **Live updates (optional)** — uncomment the last line of `01_schema.sql` and run it so bandmates see each other's edits without reloading. (The app also refreshes whenever you come back to the tab.)

## Who can do what
- Every active member: read everything; add/edit gigs, setlists, songs, clients, merch, expenses; rate songs (only their own stars).
- Managers (Tyler): also edit the roster and band settings.

## Notes
- Only the **publishable** key is in `app.js`. Never put the secret key in the site.
- Invoice numbers follow your existing pattern: `CLIENTCODE_YYYYMM` (e.g. `OUHSC_202604`). Set the client's invoice code on the gig page.
- Line-item text `{hours}` fills from the gig's hours, e.g. "Load-in, setup, soundcheck, music (2hrs), load-out".
- Things the seed couldn't know: client emails/phones, deposit dates, and real merch items — add them as you go.

## Setlist planner
On any setlist: enter start time, slot length (hours, breaks included), number of sets, number of breaks and break length → the app sizes each set and shows clock times.
**Optimize setlist** picks songs from the pools you tick and orders them to: follow an energy shape, keep instrument swaps and retunes to a minimum (half-step songs get grouped at a set start), avoid same-key and same-singer runs, spread genres, favor the band's top-rated songs, and rest songs from the last gig. Pin (⚑) any song to keep it where it is (first dance, closer). Nothing changes until you press *Use this setlist*.
Genre and energy (1–5) were pre-filled from the song's original style — adjust them on the Songs page so they match how *you* play it.
