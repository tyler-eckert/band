// Trailer Folk HQ — live calendar feed (iCalendar).
// Deploy:  supabase functions deploy band-calendar --no-verify-jwt --project-ref uomhdexfwovuovtarycz
// Subscribe URL (shown in the app):  https://uomhdexfwovuovtarycz.functions.supabase.co/band-calendar?token=<settings.ics_token>
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by Supabase automatically.
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  db: { schema: "band" },
  auth: { persistSession: false },
});
const APP = "https://band.eckerthaus.com/";
const LABEL: Record<string, string> = { inquiry: "Inquiry", quoted: "Quoted", confirmed: "Booked", complete: "Played" };

const esc = (s: unknown) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
function parseTime(t: string | null): [number, number] | null {
  const m = String(t ?? "").trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;
  let h = +m[1]; const mi = +(m[2] ?? 0); const ap = (m[3] ?? "").toLowerCase();
  if (ap === "pm" && h < 12) h += 12; if (ap === "am" && h === 12) h = 0; if (!ap && h < 9) h += 12;
  return [h, mi];
}
const addDay = (d: string) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6) + 1)).toISOString().slice(0, 10).replace(/-/g, "");
const pad = (n: number) => String(n).padStart(2, "0");
// d = YYYYMMDD, m = minutes from midnight (>= 1440 rolls to the next day)
const stampOf = (d: string, m: number) => { let day = d; if (m >= 1440) { m -= 1440; day = addDay(d); } return `${day}T${pad(Math.floor(m / 60))}${pad(m % 60)}00`; };
const mins = (t: [number, number]) => t[0] * 60 + t[1];
// Gigs start at load-in (else start time) and end one hour after the show ends. Practices: start to end as entered.
function span(g: any): [number, number] | null {
  const st = parseTime(g.start_time), en = parseTime(g.end_time);
  const li = g.kind === "gig" ? parseTime(g.load_in_time) : null;
  const first = li ?? st; if (!first) return null;
  const start = mins(first);
  let end: number;
  if (en) end = mins(en);
  else if (st) end = mins(st) + (g.hours ? Number(g.hours) * 60 : 120);
  else end = start + 120;
  if (end <= start) end += 1440;
  if (g.kind === "gig") end += 60;
  return [start, end];
}
// fold long lines at 75 octets per RFC 5545
const fold = (l: string) => l.length <= 74 ? l : l.match(/.{1,74}/g)!.join("\r\n ");

Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(token)) return new Response("Not found", { status: 404 });
  const { data: st } = await db.from("settings").select("ics_token").eq("id", 1).single();
  if (!st || st.ics_token !== token) return new Response("Not found", { status: 404 });

  const since = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
  const { data: gigs, error } = await db.from("gigs")
    .select("id,kind,status,title,gig_date,start_time,end_time,load_in_time,venue,address,notes,hours")
    .gte("gig_date", since).order("gig_date");
  if (error) return new Response("Feed error", { status: 500 });

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const out = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Trailer Folk//Band HQ//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:Trailer Folk", "X-WR-TIMEZONE:America/Chicago", "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H",
    "BEGIN:VTIMEZONE", "TZID:America/Chicago",
    "BEGIN:DAYLIGHT", "TZOFFSETFROM:-0600", "TZOFFSETTO:-0500", "TZNAME:CDT", "DTSTART:19700308T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "END:DAYLIGHT",
    "BEGIN:STANDARD", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0600", "TZNAME:CST", "DTSTART:19701101T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "END:STANDARD",
    "END:VTIMEZONE"];
  for (const g of gigs ?? []) {
    if (g.kind === "gig" && ["passed", "cancelled"].includes(g.status)) continue;
    const d = g.gig_date.replace(/-/g, "");
    const sp = span(g);
    out.push("BEGIN:VEVENT", `UID:${g.id}@band.eckerthaus.com`, `DTSTAMP:${stamp}`);
    if (sp) {
      out.push(`DTSTART;TZID=America/Chicago:${stampOf(d, sp[0])}`, `DTEND;TZID=America/Chicago:${stampOf(d, sp[1])}`);
    } else {
      const nx = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6) + 1)).toISOString().slice(0, 10).replace(/-/g, "");
      out.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${nx}`);
    }
    const tag = g.kind === "gig" && g.status !== "confirmed" && g.status !== "complete" ? ` (${LABEL[g.status] ?? g.status})` : "";
    out.push(`SUMMARY:${esc(g.kind === "practice" ? "Trailer Folk practice" : `Trailer Folk: ${g.title}${tag}`)}`);
    if (g.venue || g.address) out.push(`LOCATION:${esc([g.venue, g.address].filter(Boolean).join(", "))}`);
    const times = g.kind === "gig"
      ? [g.load_in_time ? `Load-in: ${g.load_in_time}` : "", g.start_time ? `Start: ${g.start_time}` : "", g.end_time ? `End: ${g.end_time}` : ""].filter(Boolean).join("\n")
      : "";
    out.push(`DESCRIPTION:${esc([times, g.notes ?? "", `${APP}#gig/${g.id}`].filter(Boolean).join("\n"))}`, `URL:${APP}#gig/${g.id}`);
    out.push("END:VEVENT");
  }
  out.push("END:VCALENDAR");
  return new Response(out.map(fold).join("\r\n") + "\r\n", {
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "public, max-age=900", "Content-Disposition": 'inline; filename="trailer-folk.ics"' },
  });
});
