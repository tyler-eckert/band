/* Trailer Folk HQ — band admin app.
   Data lives in the `band` schema of the lawn-master Supabase project.
   Plain JS, no build step: edit and push to GitHub Pages. */
'use strict';

const SUPABASE_URL = 'https://uomhdexfwovuovtarycz.supabase.co';
const SUPABASE_KEY = 'sb_publishable_GP4wq5bwrQ3M0qCTwQei4A_Lsk_zBcK';   // publishable key only — never the secret key
const CAL_FUNCTION = 'band-calendar';                                        // Edge Function name for the live calendar feed

/* ============================================================ data layer */
const TABLES = ['members','settings','payees','clients','gigs','songs','setlists','setlist_items','song_ratings','merch_items','merch_sales','expenses','song_charts','chart_prefs','chart_defaults'];
const OPTIONAL = ['song_charts','chart_prefs','chart_defaults'];      // newer tables: the app still loads if their SQL hasn't been run yet
const PK = { song_ratings: ['song_id','member_id'], settings: ['id'], chart_prefs: ['member_id','song_id'], chart_defaults: ['member_id'] };

const supa = window.__BAND_MOCK__ ? null :
  (window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { db: { schema: 'band' } }) : null);

const api = window.__BAND_MOCK__ || {
  async session() { const { data } = await supa.auth.getSession(); return data.session; },
  onAuth(fn) { supa.auth.onAuthStateChange((_e, s) => fn(s)); },
  async signIn(email, password) { const { error } = await supa.auth.signInWithPassword({ email, password }); if (error) throw error; },
  async magic(email) { const { error } = await supa.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname, shouldCreateUser: false } }); if (error) throw error; },
  async signOut() { await supa.auth.signOut(); },
  async rpc(fn, args) { const { data, error } = await supa.rpc(fn, args || {}); if (error) throw error; return data; },
  async all(table) {
    const out = []; const step = 1000;
    for (let from = 0; ; from += step) {
      const { data, error } = await supa.from(table).select('*').range(from, from + step - 1);
      if (error) throw error;
      out.push(...data); if (data.length < step) break;
    }
    return out;
  },
  async upsert(table, rows) {
    const { data, error } = await supa.from(table).upsert(rows, { onConflict: (PK[table] || ['id']).join(',') }).select();
    if (error) throw error; return data;
  },
  async uploadPhoto(path, blob) { const { error } = await supa.storage.from('band-photos').upload(path, blob, { contentType: 'image/jpeg' }); if (error) throw error; },
  async photoUrl(path) { const { data, error } = await supa.storage.from('band-photos').createSignedUrl(path, 3600); if (error) throw error; return data.signedUrl; },
  async removePhoto(path) { const { error } = await supa.storage.from('band-photos').remove([path]); if (error) throw error; },
  async uploadChart(path, blob) { const { error } = await supa.storage.from('band-charts').upload(path, blob, { contentType: 'application/pdf', upsert: true }); if (error) throw error; },
  async downloadChart(path) { const { data, error } = await supa.storage.from('band-charts').download(path); if (error) throw error; return data; },
  async removeChart(path) { const { error } = await supa.storage.from('band-charts').remove([path]); if (error) throw error; },
  async upsertMarks(rows) { const { error } = await supa.from('chart_marks').upsert(rows, { onConflict: 'member_id,song_id,chart_path' }); if (error) throw error; },
  async getMarks(songIds) { const { data, error } = await supa.from('chart_marks').select('*').in('song_id', songIds); if (error) throw error; return data || []; },
  async remove(table, match) {
    let q = supa.from(table).delete();
    for (const [k, v] of Object.entries(match)) q = Array.isArray(v) ? q.in(k, v) : q.eq(k, v);
    const { error } = await q; if (error) throw error;
  },
};

const S = { session: null, me: null, loaded: false };
TABLES.forEach(t => S[t] = []);
S._noteOpen = {}; S.offline = false;
const APP_V = 46;                                                  // matches app.js?v=… in index.html; shown under Band → My preferences
const OFFLINE_MSG = 'You’re offline — this is view-only until you’re back online.';
['upsert', 'remove', 'uploadPhoto', 'uploadChart', 'removePhoto', 'removeChart'].forEach(k => { const f = api[k]; if (f) api[k] = (...a) => S.offline ? Promise.reject(new Error(OFFLINE_MSG)) : f.apply(api, a); });
const timeoutP = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
const isNetErr = e => /failed to fetch|networkerror|load failed|network request|timeout|fetch/i.test(String((e && e.message) || e));

async function loadAll() {
  const res = await Promise.all(TABLES.map(t => api.all(t).catch(e => { if (OPTIONAL.includes(t)) return []; throw e; })));
  TABLES.forEach((t, i) => S[t] = res[i]);
  S.loaded = true;
  S.me = S.members.find(m => S.session && m.user_id === S.session.user.id) || null;
  snapSaveSoon(); setTimeout(prefetchUpcoming, 2500);
}
/* a copy of the data on this device, so the app can open with no signal (view only) */
let snapTimer = null;
function snapSaveSoon() { clearTimeout(snapTimer); snapTimer = setTimeout(snapSave, 1500); }
async function snapSave() {
  if (S.offline || !S.me || !S.loaded || !S.session) return;
  const tables = {}; TABLES.forEach(t => tables[t] = S[t]);
  await idbPut('snap', 'data', { at: Date.now(), user: { id: S.session.user.id, email: S.session.user.email }, meId: S.me.id, tables });
}
const snapLoad = () => idbGet('snap', 'data');
function bootOffline(snap, msg) {
  TABLES.forEach(t => S[t] = snap.tables[t] || []);
  S.session = { user: snap.user, offline: true }; S.offline = true; S.loaded = true;
  S.me = S.members.find(m => m.id === snap.meId) || null;
  render(); if (msg) toast(msg);
}
async function reachable() {                                         // is Supabase actually answering?
  try { return await Promise.race([fetch(SUPABASE_URL + '/auth/v1/health', { mode: 'no-cors', cache: 'no-store' }).then(() => true), new Promise(r => setTimeout(() => r(false), 3500))]); } catch { return false; }
}
async function tryOnline(quiet) {
  if (!S.offline) return;
  try { await timeoutP(loadAll(), 10000); S.offline = false; if (!quiet) toast('Back online'); render(); }
  catch (e) { if (!quiet) toast('Still can’t reach the server.', true); }
}
let preRunning = false;
async function prefetchUpcoming() {                                  // save charts and photos for the next two weeks of gigs while there's signal
  if (preRunning || S.offline || !S.me) return; preRunning = true;
  try {
    const t = todayIso();
    for (const g of S.gigs.filter(x => x.kind === 'gig' && x.status === 'confirmed' && x.gig_date && x.gig_date >= t && days(t, x.gig_date) <= 14)) {
      for (const p of photosOf(g)) { try { await photoSrc(p.path); } catch {} }
      const L = listOf(g.id); if (!L) continue;
      for (const i of itemsOf(L.id)) { const c = i.played && chartFor(i.song_id); if (c) { try { await chartData(c.chart); } catch {} } }
    }
  } finally { preRunning = false; }
}
/* If Supabase doesn't have a newer column yet, save everything else and say so (instead of refusing the whole save). */
async function upsertTolerant(table, rows) {
  rows = rows.map(r => ({ ...r })); const dropped = new Set();
  for (let k = 0; k < 8; k++) {
    try { const out = await api.upsert(table, rows); if (dropped.size) toast(`Saved — but ${[...dropped].join(', ')} can’t be stored until the latest SQL update is run in Supabase.`, true); return out; }
    catch (e) { const m = /Could not find the '(\w+)' column of '(\w+)'/.exec((e && e.message) || ''); if (!m || !(m[1] in rows[0])) throw e; dropped.add(m[1]); rows.forEach(r => delete r[m[1]]); }
  }
  throw new Error('Could not save — the database is missing several columns. Run the latest SQL update in Supabase.');
}
async function save(table, row) {
  const [saved] = await upsertTolerant(table, [row]);
  const keys = PK[table] || ['id'];
  const i = S[table].findIndex(r => keys.every(k => r[k] === saved[k]));
  if (i >= 0) S[table][i] = saved; else S[table].push(saved);
  snapSaveSoon(); return saved;
}
async function saveMany(table, rows) {
  if (!rows.length) return [];
  const saved = await upsertTolerant(table, rows);
  const keys = PK[table] || ['id'];
  saved.forEach(r => { const i = S[table].findIndex(x => keys.every(k => x[k] === r[k])); if (i >= 0) S[table][i] = r; else S[table].push(r); });
  snapSaveSoon(); return saved;
}
async function del(table, id) {
  await api.remove(table, { id });
  S[table] = S[table].filter(r => r.id !== id); snapSaveSoon();
  return true;
}
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));

/* ============================================================ helpers */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n0 = v => (v == null || v === '' || isNaN(v)) ? 0 : Number(v);
const money = (v, cents) => (v == null || v === '') ? '—' : (Number(v) < 0 ? '−' : '') + '$' + Math.abs(Number(v)).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
const money2 = v => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pd = s => { if (!s) return null; const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const todayIso = () => iso(today());
const days = (a, b) => Math.round((pd(b) - pd(a)) / 864e5);
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const fmtDate = (s, long) => { const d = pd(s); if (!d) return 'Date TBD'; return long ? d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : `${DOW[d.getDay()]} ${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; };
const mdY = s => { const d = pd(s); return d ? `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}` : ''; };
const mins = m => { if (!m && m !== 0) return '—'; const t = Math.round(m * 60); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
const hm = m => { const t = Math.round(m); return t >= 60 ? `${Math.floor(t / 60)}h ${t % 60}m` : `${t}m`; };
const byId = (t, id) => S[t].find(r => r.id === id);
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : '';
const settings = () => S.settings[0] || {};
const isMgr = () => S.me && S.me.role === 'manager';
const activeMembers = () => S.members.filter(m => m.active).sort((a, b) => a.sort - b.sort);
const photo = m => m && m.photo ? `assets/${m.photo}.jpg` : 'assets/icon.png';

function toast(msg, err) {
  const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), err ? 5000 : 2200);
}
async function guard(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
  catch (e) { console.error(e); toast(e.message || 'Something went wrong — nothing was saved.', true); }
}
function copy(text) {
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast('Copied'), () => {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Copied'); } catch { toast('Select and copy manually', true); } ta.remove();
  });
}
function download(filename, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: type || 'text/plain' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/* ============================================================ domain */
const STATUSES = ['inquiry','quoted','confirmed','complete','passed','cancelled'];
const STATUS_LABEL = { inquiry: 'Lead', quoted: 'Lead', confirmed: 'Booked', complete: 'Played', passed: 'Passed/Cancelled', cancelled: 'Passed/Cancelled' };
const STATUS_PICK = [['inquiry', 'Lead', ['inquiry', 'quoted']], ['confirmed', 'Booked', ['confirmed']], ['complete', 'Played', ['complete']], ['passed', 'Passed/Cancelled', ['passed', 'cancelled']]];
const isGig = g => g.kind === 'gig';
const live = g => isGig(g) && !['passed','cancelled'].includes(g.status);
const salesFor = id => S.merch_sales.filter(s => s.gig_id === id).reduce((a, s) => a + n0(s.amount), 0);
const expensesFor = id => S.expenses.filter(e => e.gig_id === id).reduce((a, e) => a + n0(e.amount), 0);
const depositIn = g => g.deposit_received ? n0(g.deposit_amount) : 0;
const pay = g => depositIn(g) + n0(g.paid);                                  // performance fee received
const merchOf = g => n0(g.merch) + salesFor(g.id);
const gross = g => pay(g) + n0(g.tips) + merchOf(g);
const balanceDue = g => g.status === 'complete' && !g.paid_in_full && n0(g.quote) > 0 ? Math.max(0, n0(g.quote) - pay(g)) : 0;
const itemsOf = lid => S.setlist_items.filter(i => i.setlist_id === lid).sort((a, b) => a.set_no - b.set_no || a.position - b.position);
const listOf = gid => S.setlists.find(l => l.gig_id === gid);
const setItems = gid => { const l = listOf(gid); return l ? itemsOf(l.id) : []; };
const gigOf = L => L && L.gig_id ? byId('gigs', L.gig_id) : null;
const slName = L => L.name || (gigOf(L) || {}).title || 'Untitled setlist';
// a setlist with its gig's details filled in where the setlist leaves them blank
const slCtx = L => { const g = gigOf(L) || {}; return { ...L, start_time: L.start_time || g.start_time || null, hours: L.hours != null ? L.hours : (g.hours ?? null), title: slName(L), gig_date: g.gig_date || null }; };
const songsPlayed = g => { const it = setItems(g.id).filter(i => i.played); return it.length || n0(g.songs_played_legacy); };
const upcoming = (kinds = ['gig','practice']) => S.gigs.filter(g => g.gig_date && g.gig_date >= todayIso() && kinds.includes(g.kind) && (g.kind === 'practice' || ['confirmed','quoted','inquiry'].includes(g.status))).sort((a, b) => a.gig_date.localeCompare(b.gig_date));
const statusPill = g => g.kind === 'practice' ? '<span class="pill st-practice">Practice</span>' : `<span class="pill st-${g.status}">${STATUS_LABEL[g.status] || g.status}</span>`;
const yearOf = s => s ? Number(s.slice(0, 4)) : null;
const clientOf = g => g.client_id ? byId('clients', g.client_id) : null;
const payeeOf = g => (g.payee_id && byId('payees', g.payee_id)) || S.payees.find(p => p.is_default) || S.payees[0] || {};
const songStats = () => {
  const m = {};
  S.setlist_items.forEach(i => {
    if (!i.played) return; const g = gigOf(byId('setlists', i.setlist_id)); if (!g || g.status !== 'complete') return;
    const s = m[i.song_id] || (m[i.song_id] = { plays: 0, last: null }); s.plays++; if (!s.last || g.gig_date > s.last) s.last = g.gig_date;
  });
  return m;
};
const ratingsFor = id => S.song_ratings.filter(r => r.song_id === id);
const avgRating = id => { const r = ratingsFor(id); return r.length ? r.reduce((a, x) => a + x.rating, 0) / r.length : null; };
const myRating = id => S.me ? (S.song_ratings.find(r => r.song_id === id && r.member_id === S.me.id) || {}).rating || 0 : 0;
const songLabel = s => `${s.song_key || '?'}${s.capo ? ' · capo ' + s.capo : ''}`;

/* ----- “needs attention” — the admin queue ----- */
function attention() {
  const st = settings(), t = todayIso(), out = [];
  const add = (sev, g, text, act) => out.push({ sev, g, text, act });
  const terms = parseInt((st.default_terms || 'NET30').replace(/\D/g, '')) || 30;
  S.gigs.filter(isGig).forEach(g => {
    const d = g.gig_date;
    if (g.status === 'confirmed' && d && d < t) add('hi', g, `Played ${fmtDate(d)}? Mark it played and log pay, tips & merch.`, 'Wrap up');
    if (g.status === 'complete') {
      if (n0(g.quote) > 0 && !g.invoice_no && !g.invoice_sent && !isNA(g, 'invoice_sent') && balanceDue(g) > 0) add('hi', g, `No invoice sent — ${money(balanceDue(g))} still due.`, 'Invoice');
      else if (g.invoiced_on && balanceDue(g) > 0 && days(g.invoiced_on, t) > terms) add('hi', g, `Invoice ${g.invoice_no} is ${days(g.invoiced_on, t) - terms} days past ${st.default_terms || 'NET30'} — ${money(balanceDue(g))} due.`, 'Follow up');
      else if (g.invoiced_on && balanceDue(g) > 0) add('lo', g, `Waiting on payment for ${g.invoice_no} (${money(balanceDue(g))}, due ${mdY(iso(new Date(pd(g.invoiced_on).getTime() + terms * 864e5)))}).`, 'Open');
    }
    if (g.status === 'confirmed' && d && d >= t && days(t, d) <= 30 && !g.paperwork_signed && !isNA(g, 'paperwork_signed')) add('md', g, 'Paperwork not signed yet.', 'Paperwork');
    if (g.status === 'confirmed' && d && d >= t && days(t, d) <= 7 && !g.details_sent && !isNA(g, 'details_sent')) add('md', g, 'Gig-week details not sent to the client yet.', 'Details');
    if (g.status === 'confirmed' && n0(g.deposit_amount) > 0 && !g.deposit_received && !isNA(g, 'deposit_received')) add('md', g, `Deposit of ${money(g.deposit_amount)} not received yet.`, 'Deposit');
    if (['confirmed'].includes(g.status) && d && d >= t && days(t, d) <= (st.remind_setlist_days || 14) && !setItems(g.id).length) add(days(t, d) <= 5 ? 'hi' : 'md', g, `Gig in ${days(t, d)} days and no setlist yet.`, 'Build set');
    if (g.status === 'confirmed' && d && d >= t && days(t, d) <= 21 && (!g.start_time || !g.venue || /tbd/i.test(g.venue || ''))) add('md', g, 'Missing start time or venue — lock in details with the client.', 'Details');
    if (g.status === 'confirmed' && !d) add('md', g, 'Booked but no date set.', 'Details');
    if (g.status === 'inquiry' && !g.quote) add('md', g, 'New lead — send a quote.', 'Quote');
    if (g.status === 'quoted' && g.quoted_on && days(g.quoted_on, t) >= (st.remind_quote_days || 10)) add('md', g, `Quote sent ${days(g.quoted_on, t)} days ago with no answer — follow up.`, 'Follow up');
    if (g.status === 'quoted' && d && d < t) add('lo', g, 'Quoted date has passed — mark it passed or update the date.', 'Update');
  });
  const nextGig = upcoming(['gig']).find(g => g.status === 'confirmed');
  if (nextGig && days(t, nextGig.gig_date) <= 21) {
    const prac = S.gigs.some(p => p.kind === 'practice' && p.gig_date >= t && p.gig_date <= nextGig.gig_date);
    if (!prac) add('md', nextGig, `No practice on the calendar before ${nextGig.title}.`, 'Add practice');
  }
  S.expenses.filter(e => !e.reimbursed && e.paid_by).forEach(e => {
    const m = byId('members', e.paid_by); out.push({ sev: 'lo', g: null, text: `Reimburse ${m ? m.name : 'member'} ${money(e.amount, true)} for ${e.note || e.category}.`, act: 'Money', href: '#money' });
  });
  if (S.me) {
    const unrated = S.songs.filter(s => s.status === 'active' && !myRating(s.id)).length;
    if (unrated) out.push({ sev: 'lo', g: null, text: `You haven't rated ${unrated} active song${unrated > 1 ? 's' : ''}.`, act: 'Rate', href: '#songs' });
  }
  const rank = { hi: 0, md: 1, lo: 2 };
  return out.sort((a, b) => rank[a.sev] - rank[b.sev] || ((a.g && a.g.gig_date) || '9').localeCompare((b.g && b.g.gig_date) || '9'));
}

/* ============================================================ shell */
const ICON = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  gigs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v4M8.5 21.5h7"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  set: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6.5h16M4 12h16M4 17.5h16"/></svg>',   // centred three-line icon (the old one had invisible dots on the left, so it looked shifted right)
  songs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z"/></svg>',
  money: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2v20M17 6.5c0-1.9-2.2-3-5-3s-5 1.3-5 3.3 2 2.8 5 3.4 5 1.4 5 3.5-2.2 3.3-5 3.3-5-1.1-5-3"/></svg>',
  sliders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6h9M19 6h1M4 12h3M13 12h7M4 18h11M21 18h-1"/><circle cx="16" cy="6" r="2.2"/><circle cx="10" cy="12" r="2.2"/><circle cx="18" cy="18" r="2.2"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M12 3l8 3v6c0 4.4-3.1 7.9-8 9-4.9-1.1-8-4.6-8-9V6z"/><path d="M9 12l2.2 2.2L15.5 10"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
};
const NAV = [['home','Home','home'],['gigs','Gigs','gigs'],['setlists','Sets','set'],['songs','Songs','songs'],['money','Metrics','money'],['prefs','Prefs','sliders'],['admin','Admin','shield']];

function shell(route, inner) {
  const sec = route.split('/')[0];
  const on = k => (k === sec || (k === 'gigs' && sec === 'gig') || (k === 'setlists' && sec === 'setlist')) ? 'on' : '';
  const me = S.me;
  return `
  <header class="top">
    <a class="brand" href="#home"><img src="assets/logo.png" alt="Trailer Folk"><span class="hide-sm">HQ</span></a>
    <div class="row" style="gap:0;align-items:stretch">
      <nav class="nav">${NAV.map(([k, l]) => `<a href="#${k}" class="${on(k)}">${l}</a>`).join('')}</nav>
      <button type="button" class="who" data-act="who-menu" title="Account">${me ? `<img src="${photo(me)}" alt=""><span class="nm small muted">${esc(me.name)}</span>` : ''}</button>
    </div>
    <div class="who-menu" id="whoMenu" hidden><button class="btn" data-act="signout">Sign out</button></div>
  </header>
  ${S.offline ? '<div class="offline-bar"><span>Offline — showing the data saved on this device. View only.</span><button class="btn sm" data-act="go-online">Retry</button></div>' : ''}
  <div class="scroll"><main class="view">${inner}</main></div>
  <nav class="tabbar">${NAV.map(([k, l, i]) => `<a href="#${k}" class="${on(k)}">${ICON[i]}${l}</a>`).join('')}</nav>`;
}
const title = (t, sub) => `<h1 class="echo disp"><span class="solid">${esc(t)}</span></h1>${sub ? `<p class="muted" style="margin:-10px 0 22px">${sub}</p>` : ''}`;

const titleSolid = (t, sub) => `<h1 class="echo disp"><span class="solid">${esc(t)}</span></h1>${sub ? `<p class="muted" style="margin:-10px 0 16px">${sub}</p>` : ''}`;
const cbm = good => UI.cb ? (good ? '✓ ' : '▲ ') : '';

/* ============================================================ router */
let UI = { gigFilter: 'upcoming', gigSearch: '', gigYear: 'all', calMonth: null, songFilter: 'active', songSearch: '', songSort: 'title', moneyYear: String(new Date().getFullYear()), selSet: 1, libFilter: 'active', libSearch: '' };
try { Object.assign(UI, JSON.parse(localStorage.getItem('tfhq-ui') || '{}')); } catch {}
const keepUI = () => { try { localStorage.setItem('tfhq-ui', JSON.stringify(UI)); } catch {} };

function render() {
  document.body.classList.toggle('cb', !!UI.cb); document.body.classList.toggle('offline', !!S.offline);
  document.body.style.setProperty('--hdr', (UI.hdr != null ? UI.hdr : 56) + 'px'); document.body.style.setProperty('--ftr', (UI.fpx != null ? UI.fpx : 14) + 'px');
  document.body.style.setProperty('--tz', UI.tz != null ? UI.tz : (window.innerWidth >= 700 ? 1.12 : 1));
  const app = $('#app');
  if (!S.session) return app.innerHTML = loginView();
  if (!S.loaded) return app.innerHTML = shell('home', '<p class="muted">Loading the band book…</p>');
  if (!S.me) return app.innerHTML = notMemberView();
  let route = (location.hash || '#home').slice(1);
  if (route === 'calendar') { route = 'home'; history.replaceState(null, '', '#home'); }
  if (route === 'settings') { route = 'prefs'; history.replaceState(null, '', '#prefs'); }                // the old Band page was split into Prefs and Admin              // the calendar now lives at the bottom of Home
  const [sec, id] = route.split('/');
  const views = { home: homeView, gigs: gigsView, gig: () => gigView(id), setlists: setlistsView, setlist: () => setlistView(id), songs: songsView, money: moneyView, prefs: prefsView, admin: adminView };
  const sc0 = $('.scroll'), y = sc0 ? sc0.scrollTop : 0, same = S._route === route;
  // opening Gigs from anywhere (except coming back from a gig you just looked at) always starts on Upcoming
  if (sec === 'gigs' && !same && !String(S._route || '').startsWith('gig/')) { UI.gigFilter = 'upcoming'; UI.gigYear = 'all'; UI.gigSearch = ''; keepUI(); }
  app.innerHTML = shell(route, (views[sec] || homeView)());
  const sc1 = $('.scroll'); if (sc1) sc1.scrollTop = same ? y : 0;
  S._route = route;
  after(sec, id);
}
window.addEventListener('hashchange', () => { if (S.dirty && !confirmLeave()) return; const rid = (location.hash || '').split('/')[1]; if (S.editGig && S.editGig !== rid) S.editGig = null; if (S.editSl && S.editSl !== rid) S.editSl = null; render(); });
function confirmLeave() { S.dirty = false; return true; }

/* ============================================================ login */
function loginView() {
  return `<div class="login">
    <div class="ph" role="img" aria-label="Trailer Folk on stage"></div>
    <form class="fm" id="loginForm">
      <img src="assets/logo.png" alt="Trailer Folk">
      ${title('Band HQ')}
      <div class="stack">
        <label class="f">Email<input class="in" id="lgEmail" type="email" autocomplete="username" required></label>
        <label class="f">Password<input class="in" id="lgPass" type="password" autocomplete="current-password"></label>
        <div class="row"><button class="btn gold" type="submit">Sign in</button></div>
        <p class="small" id="lgMsg" style="color:var(--bad);min-height:1.5em"></p>
      </div>
    </form></div>`;
}
function notMemberView() {
  return shell('home', `${title('Almost in')}
   <div class="panel" style="max-width:620px"><p>You're signed in as <b>${esc(S.session.user.email)}</b>, but that email isn't on the Trailer Folk roster yet.</p>
   <p class="muted">Ask Tyler to add this email on the Band page, then reload.</p>
   <div class="row"><button class="btn gold" data-act="reload">Reload</button><button class="btn" data-act="signout">Sign out</button></div></div>`);
}

/* ============================================================ home */
function homeView() {
  const t = todayIso();
  const up = upcoming();
  const next = up[0];
  const nextGig = up.find(g => g.kind === 'gig' && g.status === 'confirmed');
  const lastGig = S.gigs.filter(g => isGig(g) && ['complete', 'confirmed'].includes(g.status) && g.gig_date && g.gig_date <= t).sort((a, b) => b.gig_date.localeCompare(a.gig_date))[0];
  const yr = new Date().getFullYear(), md = t.slice(5);
  const thru = (y, pick) => S.gigs.filter(g => pick(g) && g.gig_date && g.gig_date >= `${y}-01-01` && g.gig_date <= `${y}-${md}`).length;
  const isPlayed = g => isGig(g) && ['complete', 'confirmed'].includes(g.status);
  const isPrac = g => g.kind === 'practice';
  const gNow = thru(yr, isPlayed), gPrev = thru(yr - 1, isPlayed), pNow = thru(yr, isPrac), pPrev = thru(yr - 1, isPrac);
  const vs = (a, b) => `${a > b ? '▲ ' : a < b ? '▼ ' : ''}${b} at this point last year${a === b ? ' (even)' : ' (' + (a > b ? '+' : '−') + Math.abs(a - b) + ')'}`;
  const att = attention();
  const n = next ? days(t, next.gig_date) : null;
  const nd = nextGig ? days(t, nextGig.gig_date) : null;
  return `
  ${next ? `<a class="next" href="#gig/${next.id}" style="text-decoration:none;color:inherit;margin-bottom:18px">
     <div><div class="eyebrow">${next.kind === 'practice' ? 'Next practice' : 'Next gig'}</div>
       <div class="when">${n === 0 ? 'Tonight' : n === 1 ? 'Tomorrow' : 'In ' + n + ' days'}</div>
       <div class="what">${esc(next.kind === 'practice' ? 'Practice' + (next.notes ? ' — ' + next.notes : '') : next.title)}</div>
       <div class="muted">${fmtDate(next.gig_date, true)}${next.kind === 'gig' && next.load_in_time ? ' · Load-in ' + esc(next.load_in_time) : ''}${next.start_time ? ' · ' + (next.kind === 'gig' ? 'Start ' : '') + esc(next.start_time) : ''}${next.venue ? ' · ' + esc(next.venue) : ''}</div>
       ${next.kind === 'gig' ? `<div class="row" style="margin-top:12px">${statusPill(next)}<span class="small muted">${setItems(next.id).length ? setItems(next.id).length + ' songs on the setlist' : 'No setlist yet'}</span></div>` : ''}
     </div></a>` : `<div class="next" style="margin-bottom:18px"><div><div class="eyebrow">Next up</div><div class="when">Nothing booked</div><div class="muted">Add a lead or a practice to get the calendar moving.</div></div></div>`}
  <section class="panel" style="margin-bottom:18px">
    <div class="row"><h2 class="sec" style="margin:0">Coming up</h2><span class="spacer"></span><span class="small muted">${up.length} scheduled</span></div>
    <div class="list up-scroll" style="margin-top:8px">${up.map(g => gigLi(g, true)).join('') || '<div class="empty">Nothing on the calendar.</div>'}</div>
    ${addBtns(false)}
  </section>
  <section class="panel" style="margin-bottom:18px">
    <div class="row"><h2 class="sec" style="margin:0">Needs attention</h2><span class="spacer"></span><span class="small muted">${att.length} item${att.length === 1 ? '' : 's'}</span></div>
    <div class="list" style="margin-top:8px">${att.length ? att.slice(0, 14).map(a => `
      <a class="li" href="${a.act === 'Add practice' ? '#' : (a.href || (a.act === 'Build set' ? (listOf(a.g.id) ? '#setlist/' + listOf(a.g.id).id : '#gig/' + a.g.id) : '#gig/' + a.g.id))}" ${a.act === 'Add practice' ? 'data-act="new-practice"' : ''} style="align-items:flex-start">
        <span class="sev ${a.sev}"></span>
        <div class="grow"><div class="t">${a.g ? esc(a.g.title) : 'Band'}</div><div class="small muted" style="white-space:normal">${esc(a.text)}</div></div>
        <span class="btn sm">${a.act}</span></a>`).join('') : '<div class="empty">All caught up. Nothing needs you right now.</div>'}
    </div>
  </section>
  <div class="grid g4">
    ${kpi(gNow, `Gigs played in ${yr}`, vs(gNow, gPrev))}
    ${kpi(pNow, `Practices in ${yr}`, vs(pNow, pPrev))}
    ${kpi(nd == null ? '—' : nd, 'Days until next gig', nextGig ? esc(nextGig.title) + ' · ' + mdY(nextGig.gig_date) : 'No gig booked')}
    ${kpi(lastGig ? days(lastGig.gig_date, t) : '—', 'Days since last gig', lastGig ? esc(lastGig.title) + ' · ' + mdY(lastGig.gig_date) : '')}
  </div>
  ${calendarSection()}`;
}
const addBtns = (big, mt = '12px') => `<div class="row" style="margin:${mt} 0 ${big ? '14px' : '0'}"><button class="btn ${big ? '' : 'sm '}gold" data-act="new-gig">+ Gig / lead</button><button class="btn ${big ? '' : 'sm '}gold" data-act="new-practice">+ Practice</button></div>`;
const kpi = (v, l, d) => `<div class="panel kpi"><div class="l">${l}</div><div class="v num">${v}</div>${d ? `<div class="d">${d}</div>` : ''}</div>`;
function untilText(date) {                                          // "Today", "Tomorrow", "5 days", "3 wks 2d"
  const n = days(todayIso(), date); if (!date || n < 0) return '';
  if (n === 0) return 'Today'; if (n === 1) return 'Tomorrow'; if (n < 7) return n + ' days';
  const w = Math.floor(n / 7), r = n % 7; return `${w} wk${w === 1 ? '' : 's'}${r ? ' ' + r + 'd' : ''}`;
}
function gigLi(g, when) {
  const d = pd(g.gig_date);
  const amt = g.kind === 'practice' ? '' : g.status === 'complete' ? money(gross(g)) : g.quote ? money(g.quote) : '';
  return `<a class="li" href="#gig/${g.id}">
    <div class="date">${d ? `<small>${MON[d.getMonth()]}</small><b>${d.getDate()}</b><small>${String(d.getFullYear()).slice(2)}</small>` : '<small>TBD</small>'}</div>
    <div class="grow"><div class="t">${esc(g.kind === 'practice' ? 'Practice' : g.title)}</div>
      <div class="s">${[g.start_time, g.venue, g.kind === 'practice' ? g.notes : ''].filter(Boolean).map(esc).join(' · ') || '&nbsp;'}</div></div>
    ${when && g.gig_date ? `<div class="until" title="Weeks until">${untilText(g.gig_date)}</div>` : ''}${statusPill(g)}<div class="amt hide-sm" style="min-width:64px">${amt}</div></a>`;
}

/* ============================================================ gigs list */
function gigsView() {
  const t = todayIso(), f = UI.gigFilter, q = UI.gigSearch.toLowerCase();
  let rows = S.gigs.slice();
  const filt = {
    upcoming: g => g.gig_date >= t && (g.kind === 'practice' || ['confirmed','quoted','inquiry'].includes(g.status)) || (isGig(g) && !g.gig_date && live(g)),
    leads: g => isGig(g) && ['inquiry','quoted'].includes(g.status),
    booked: g => isGig(g) && g.status === 'confirmed',
    played: g => isGig(g) && g.status === 'complete',
    practices: g => g.kind === 'practice',
    passed: g => isGig(g) && ['passed','cancelled'].includes(g.status),
    all: () => true,
  }[f] || (() => true);
  rows = rows.filter(filt).filter(g => !q || [g.title, g.venue, g.notes, (clientOf(g) || {}).org, (clientOf(g) || {}).contact_name].join(' ').toLowerCase().includes(q));
  if (UI.gigYear !== 'all') rows = rows.filter(g => String(yearOf(g.gig_date)) === UI.gigYear);
  const asc = f === 'upcoming' || f === 'leads' || f === 'booked';
  rows.sort((a, b) => (a.gig_date || '9999').localeCompare(b.gig_date || '9999') * (asc ? 1 : -1));
  const years = [...new Set(S.gigs.map(g => yearOf(g.gig_date)).filter(Boolean))].sort((a, b) => b - a);
  const counts = k => S.gigs.filter({ leads: g => isGig(g) && ['inquiry','quoted'].includes(g.status), booked: g => isGig(g) && g.status === 'confirmed' }[k]).length;
  return `${title('Gigs')}
   ${addBtns(true, '0px')}
   <div class="row" style="margin-bottom:14px">
     <div class="chips">${[['upcoming','Upcoming'],['leads',`Leads (${counts('leads')})`],['booked',`Booked (${counts('booked')})`],['played','Played'],['practices','Practices'],['passed','Passed'],['all','All']].map(([k, l]) => `<button class="chip ${f === k ? 'on' : ''}" data-act="gig-filter" data-v="${k}">${l}</button>`).join('')}</div>
     <span class="spacer"></span>
     <select class="in" id="gigYear" style="width:auto"><option value="all">All years</option>${years.map(y => `<option ${UI.gigYear == y ? 'selected' : ''}>${y}</option>`).join('')}</select>
     <input class="in" id="gigSearch" placeholder="Search" value="${esc(UI.gigSearch)}" style="width:180px">
   </div>
   <section class="panel"><div class="list">${rows.map(gigLi).join('') || '<div class="empty">Nothing here.</div>'}</div></section>`;
}

/* ============================================================ gig detail */
function gigView(id) {
  const g = byId('gigs', id);
  if (!g) return `${title('Not found')}<p class="muted">That gig may have been deleted. <a href="#gigs">Back to gigs</a></p>`;
  return S.editGig === id ? gigEdit(g) : gigRead(g);
}
const longDate = d => { const x = pd(d); return x ? x.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : 'Date TBD'; };
function timeRange(s, e) {
  s = String(s || '').trim(); e = String(e || '').trim();
  if (!s || !e) return esc(s || e);
  const ap = x => (/\s*(am|pm)\s*$/i.exec(x) || [])[1];
  const s2 = ap(s) && ap(e) && ap(s).toLowerCase() === ap(e).toLowerCase() ? s.replace(/\s*(am|pm)\s*$/i, '') : s;
  return `${esc(s2)} - ${esc(e)}`;
}
function durText(g) {
  const a = parseTime(g.start_time), b = parseTime(g.end_time); let m = null;
  if (a && b) { m = b[0] * 60 + b[1] - (a[0] * 60 + a[1]); if (m <= 0) m += 1440; } else if (g.hours) m = n0(g.hours) * 60;
  return m ? ` (${+(m / 60).toFixed(1)}hr)` : '';
}
function gigHead(g) {
  const practice = g.kind === 'practice';
  const price = !practice && n0(g.quote) > 0 ? money(g.quote) : '';
  const tm = timeRange(g.start_time, g.end_time);
  return `${titleSolid(practice ? 'Practice' : g.title)}
  <div class="row" style="align-items:baseline;margin:-6px 0 16px;gap:10px"><div class="grow" style="font-size:16px;line-height:1.35">${esc(longDate(g.gig_date))}${tm ? ' <span class="muted num">' + tm + durText(g) + '</span>' : ''}</div>${price ? `<div class="num" style="font-size:26px;font-weight:800;color:var(--gold);white-space:nowrap" title="Quoted">${price}</div>` : ''}</div>`;
}
/* ---- gig photos (load-in map, stage plot…) ---- */
const photosOf = g => Array.isArray(g.photos) ? g.photos : [];
const photoCache = {};
async function photoSrc(path) {
  const c = photoCache[path]; if (c) return c;
  let rec = await idbGet('photo', path);
  if (!rec) { const url = await api.photoUrl(path); try { const r = await fetch(url); rec = { type: r.headers.get('content-type') || 'image/jpeg', buf: await r.arrayBuffer() }; idbPut('photo', path, rec); } catch { return url; } }
  return photoCache[path] = URL.createObjectURL(new Blob([rec.buf], { type: rec.type }));
}
function hydratePhotos() { $$('img[data-ph]').forEach(async img => { if (img.getAttribute('src')) return; try { img.src = await photoSrc(img.dataset.ph); } catch { img.alt = 'Photo unavailable'; } }); }
function downscale(file, max = 1800) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = () => { const k = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight)); const c = document.createElement('canvas'); c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k); c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); URL.revokeObjectURL(url); c.toBlob(b => b ? res(b) : rej(new Error('Could not read that image')), 'image/jpeg', .85); };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not read that image')); };
    im.src = url;
  });
}
async function addGigPhoto(g, file) {
  if (!g || !file) return;
  try {
    toast('Uploading photo…'); const blob = await downscale(file); const path = `gigs/${g.id}/${uuid()}.jpg`;
    await api.uploadPhoto(path, blob);
    const cur = byId('gigs', g.id);
    const ok = await guard(() => save('gigs', { ...cur, photos: [...photosOf(cur), { path, added: todayIso() }] }), 'Photo added');
    if (ok && !S.dirty) render(); else if (ok) toast('Photo added — it shows after you save.');
  } catch (e) { toast(e.message || 'Upload failed', true); }
}
function photosPanel(g, editing) {
  const ph = photosOf(g);
  return `<section class="panel"><div class="row"><h2 class="sec" style="margin:0">Photos</h2><span class="spacer"></span><label class="btn sm gold" style="cursor:pointer">+ Add photo<input type="file" accept="image/*" hidden data-photo="${g.id}"></label></div>
    ${ph.length ? `<div class="photos" style="margin-top:12px">${ph.map(p => `<div class="ph"><img data-ph="${esc(p.path)}" data-act="photo-open" alt="Gig photo">${editing ? `<button class="ib" data-act="photo-del" data-path="${esc(p.path)}" title="Remove photo">✕</button>` : ''}</div>`).join('')}</div>` : '<p class="small muted" style="margin:10px 0 0">Load-in map, stage plot, parking — add a photo and everyone can see it here.</p>'}</section>`;
}
const isNA = (g, k) => Array.isArray(g.checklist_na) && g.checklist_na.includes(k);
const CHECKS = [['deposit_received', 'Deposit received'], ['paperwork_signed', 'Paperwork signed'], ['invoice_sent', 'Invoice sent'], ['paid_in_full', 'Paid in full'], ['details_sent', 'Gig details sent to client']];
function checklistPanel(g) {
  const hint = { deposit_received: n0(g.deposit_amount) ? money(g.deposit_amount) + (g.deposit_received_on ? ' · ' + mdY(g.deposit_received_on) : '') : '', invoice_sent: g.invoice_no || '', paid_in_full: g.paid_in_full && g.paid_on ? mdY(g.paid_on) : '' };
  return `<section class="panel"><div class="row"><h2 class="sec" style="margin:0">Checklist</h2><span class="spacer"></span><span class="small faint">N/A strikes an item that doesn’t apply</span></div><div class="chk" style="margin-top:6px">${CHECKS.map(([k, l]) => { const na = isNA(g, k); return `
    <div class="crow ${na ? 'na' : ''}" data-row="${k}"><label class="check"><input type="checkbox" data-act="gig-chk" data-k="${k}" ${g[k] ? 'checked' : ''} ${na ? 'disabled' : ''}><span>${l}</span><span class="small faint" style="margin-left:auto">${esc(hint[k] || '')}</span></label><button type="button" class="na-btn" data-act="gig-na" data-k="${k}">${na ? 'Use' : 'N/A'}</button></div>`; }).join('')}</div></section>`;
}
/* read-only sets with clock times — used on the gig page and the setlist page */
function setlistSets(L, compact) {
  const g = slCtx(L), items = itemsOf(L.id).filter(i => i.played), plan = planOf(g), buf = plan.buf;
  if (!items.length) return '<p class="muted" style="margin:0">No songs on the setlist yet.</p>';
  const sets = Array.from({ length: plan.sets }, (_, i) => i + 1);
  const dur = {}; sets.forEach(n => dur[n] = items.filter(i => i.set_no === n).reduce((a, i) => a + songDur(byId('songs', i.song_id), buf), 0));
  const ros = runOfShow(g, plan, Object.fromEntries(sets.map(n => [n, dur[n] || plan.perSet])));
  return `<div class="sets">${sets.filter(n => dur[n]).map(n => {
    const its = items.filter(i => i.set_no === n), slot = ros.find(r => r.kind === 'set' && r.n === n), brk = ros[ros.indexOf(slot) + 1];
    let prev = null;
    return `<section class="panel set"><div class="row"><h3>Set ${n}</h3>${slot && slot.from ? `<span class="small muted">${slot.from}–${slot.to}</span>` : ''}<span class="spacer"></span><span class="small muted num">${hm(dur[n])}</span></div>
      ${its.map((i, k) => { const s = byId('songs', i.song_id) || { title: '(deleted song)' }; const c = changes(prev, s); prev = s;
        const warn = compact ? '' : [c.tuning ? `<span style="color:var(--bad)">${cbm(false)}retune → ${esc(s.tuning || 'Standard')}</span>` : '', ...c.inst.map(x => `<span style="color:var(--gold)">${esc(x.who)}: ${esc(x.to)}</span>`)].filter(Boolean).join(' · ');
        return `<div class="song"><span class="n">${k + 1}</span><div style="min-width:0"><div class="nm">${esc(s.title)}${s.is_encore ? ' <span class="small" style="color:var(--gold)">encore</span>' : ''}</div>
          <div class="meta">${esc(songLabel(s))}${compact ? '' : ' · ' + mins(s.length_min) + (s.lead_vox ? ' · ' + esc(s.lead_vox) : '')}</div>${warn ? `<div class="meta">⇄ ${warn}</div>` : ''}</div><span></span></div>${i.note ? `<div class="snote">${esc(i.note)}</div>` : ''}`; }).join('')}
      ${brk && brk.kind === 'break' && n < plan.sets ? `<div class="small muted" style="margin-top:10px;border-top:1px dashed var(--line);padding-top:8px">Break · ${brk.dur} min${brk.from ? ` · ${brk.from}–${brk.to}` : ''}</div>` : ''}
    </section>`; }).join('')}</div>`;
}
function gigRead(g) {
  const st = settings(), c = clientOf(g) || {}, practice = g.kind === 'practice', mgr = true, L = listOf(g.id);   // everything except the roster is open to all members
  const tbd = '<span class="faint">TBD</span>';
  const kv = (l, v) => `<div><div class="eyebrow">${l}</div><div class="v num">${v}</div></div>`;
  const mapUrl = (g.venue || g.address) ? 'https://maps.apple.com/?q=' + encodeURIComponent([g.venue, g.address].filter(Boolean).join(', ')) : '';
  const stepper = practice || !mgr ? '' : `<div class="chips" style="margin-bottom:14px">${STATUS_PICK.map(([s, l, grp]) => `<button class="chip ${grp.includes(g.status) ? 'on' : ''}" data-act="set-status" data-v="${s}">${l}</button>`).join('')}</div>`;
  const facts = practice
    ? [kv('Date', esc(fmtDate(g.gig_date))), kv('Start', g.start_time ? esc(g.start_time) : tbd), kv('End', g.end_time ? esc(g.end_time) : tbd), kv('Where', g.venue ? esc(g.venue) : tbd)]
    : [kv('Date', esc(fmtDate(g.gig_date))), kv('Load-in', g.load_in_time ? esc(g.load_in_time) : tbd), kv('Start', g.start_time ? esc(g.start_time) : tbd), kv('End', g.end_time ? esc(g.end_time) : tbd),
       kv('Venue', g.venue ? esc(g.venue) : tbd), g.address ? kv('Address', `<a href="${mapUrl}" target="_blank" rel="noopener">${esc(g.address)}</a>`) : ''];
  const setlistPanel = practice ? '' : `<section class="panel"><div class="row"><h2 class="sec" style="margin:0">Setlist</h2><span class="spacer"></span>${L ? `<a class="btn sm gold" href="#setlist/${L.id}">Open setlist</a>` : (mgr ? `<button class="btn sm gold" data-act="sl-new" data-gig="${g.id}">New setlist</button>` : '')}</div>
      <div style="margin-top:12px">${L ? setlistSets(L, true) : `<p class="muted" style="margin:0">${g.songs_played_legacy ? g.songs_played_legacy + ' songs played (count from the old sheet).' : 'No setlist yet.'}</p>`}</div></section>`;
  const left = `<section class="panel"><h2 class="sec">Details</h2><div class="kv">${facts.join('')}</div></section>
    ${g.notes ? `<section class="panel"><h2 class="sec">${practice ? 'Plan' : 'Notes'}</h2><p style="margin:0;white-space:pre-wrap">${esc(g.notes)}</p></section>` : ''}
    ${photosPanel(g, false)}
    ${setlistPanel}`;
  const money_rows = [['Quote', g.quote != null ? money(g.quote) : ''], ['Deposit', n0(g.deposit_amount) ? money(g.deposit_amount) + (g.deposit_received ? ' · received' : ' · owed') : ''], ['Paid (less deposit)', g.paid != null ? money(g.paid) : ''], ['Tips', n0(g.tips) ? money(g.tips) : ''], ['Merch', merchOf(g) ? money(merchOf(g)) : '']].filter(r => r[1]);
  const right = practice || !mgr ? '' : `
    ${checklistPanel(g)}
    <section class="panel"><h2 class="sec">Money</h2>
      ${money_rows.length ? `<table class="tbl"><tbody>${money_rows.map(([l, v]) => `<tr><td>${l}</td><td class="r num">${v}</td></tr>`).join('')}</tbody></table>` : '<p class="muted" style="margin:0">No quote yet.</p>'}
      <div class="row" style="margin-top:12px;gap:18px"><div><div class="eyebrow">Gross</div><div class="num" style="font-size:20px;font-weight:700">${money(gross(g))}</div></div>
        <div><div class="eyebrow">Balance due</div><div class="num" style="font-size:20px;font-weight:700;color:${balanceDue(g) ? 'var(--gold)' : 'inherit'}">${money(balanceDue(g))}</div></div></div></section>
    ${(c.contact_name || c.org || c.email || c.phone) ? `<section class="panel"><h2 class="sec">Client</h2><div><b>${esc(c.contact_name || c.org)}</b>${c.contact_name && c.org ? `<div class="muted">${esc(c.org)}</div>` : ''}</div>
      <div class="small" style="margin-top:6px">${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a><br>` : ''}${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : ''}</div></section>` : ''}
    <section class="panel"><h2 class="sec">Paperwork</h2><div class="stack">
      <div class="row"><div class="grow"><b>Quote</b><div class="small muted">${g.quote_no ? esc(g.quote_no) + ' · sent ' + mdY(g.quoted_on) : 'Not sent yet'}</div></div><button class="btn sm gold" data-act="pdf" data-v="quote">Quote PDF</button></div>
      <div class="row"><div class="grow"><b>Invoice</b><div class="small muted">${g.invoice_no ? esc(g.invoice_no) + ' · ' + mdY(g.invoiced_on) : 'Not invoiced yet'}</div></div><button class="btn sm gold" data-act="pdf" data-v="invoice">Invoice PDF</button></div>
      <div class="row" style="flex-wrap:wrap"><button class="btn sm" data-act="mail" data-v="quote">Quote email</button><button class="btn sm" data-act="mail" data-v="deposit">Deposit reminder</button><button class="btn sm" data-act="mail" data-v="details">Gig-week details</button><button class="btn sm" data-act="mail" data-v="invoice">Invoice email</button><button class="btn sm" data-act="mail" data-v="thanks">Thank-you</button></div>
    </div></section>`;
  return `
  <div class="row" style="margin-bottom:6px"><a href="#gigs" class="back">← Gigs</a></div>
  ${gigHead(g)}
  <div class="row" style="margin-bottom:14px">${statusPill(g)}<span class="spacer"></span>${!practice && L && itemsOf(L.id).some(i => i.played) ? '<button class="btn gold btn-go" data-act="gig-mode" aria-label="Gig mode"><b>&gt;&gt;</b> Gig mode</button>' : ''}<button class="btn" data-act="ics-one">Add to calendar</button><button class="btn gold" data-act="gig-edit">Edit</button></div>
  ${stepper}
  ${right ? `<div class="split"><div class="stack">${left}</div><div class="stack">${right}</div></div>` : `<div class="stack" style="max-width:820px">${left}</div>`}`;
}
function gigEdit(g) {
  const st = settings(), c = clientOf(g) || {}, practice = g.kind === 'practice';
  const items = setItems(g.id);
  const f = (key, label, type = 'text', cls = '', extra = '') => `<label class="f ${cls}">${label}<input class="in" data-f="${key}" type="${type}" value="${esc(g[key] ?? '')}" ${type === 'number' ? 'step="any" inputmode="decimal"' : ''} ${extra}></label>`;
  const stepper = practice ? '' : `<div class="chips" style="margin-bottom:6px">${STATUS_PICK.map(([s, l, grp]) => `<button class="chip ${grp.includes(g.status) ? 'on' : ''}" data-act="set-status" data-v="${s}">${l}</button>`).join('')}</div>`;
  const totalDur = items.reduce((a, i) => a + n0((byId('songs', i.song_id) || {}).length_min), 0);
  return `
  <div class="row" style="margin-bottom:6px"><a href="#gigs" class="back">← Gigs</a><span class="spacer"></span><span class="pill st-confirmed">Editing</span></div>
  ${gigHead(g)}
  <div class="row">${stepper}<span class="spacer"></span><button class="btn sm ghost" data-act="fold-all" data-v="1">Expand all</button><button class="btn sm ghost" data-act="fold-all" data-v="0">Collapse all</button></div>
  <div class="split" style="margin-top:14px">
   <div class="stack">
    <details class="panel fold" data-fold="details" ${foldOpen('details')}><summary><h2 class="sec">Details</h2><span class="sum">${esc([g.start_time, g.venue].filter(Boolean).join(' · '))}</span><span class="chev" aria-hidden="true">▾</span></summary><div class="fold-body">
      <div class="fgrid">
        ${practice ? '' : f('title', 'Name', 'text', 'w2')}
        ${f('gig_date', 'Date', 'date')}
        ${practice ? '' : f('load_in_time', 'Load-in', 'text', '', 'placeholder="4:30pm"')}
        ${f('start_time', 'Start', 'text', '', 'placeholder="7pm"')}
        ${practice ? f('end_time', 'End') : f('end_time', 'End', 'text', '', 'placeholder="9pm"')}
        ${f('venue', practice ? 'Where' : 'Venue', 'text', 'w2')}
        ${practice ? '' : f('address', 'Address', 'text', 'w4')}
        <label class="f w4">${practice ? 'Plan' : 'Notes'}<textarea class="in" data-f="notes">${esc(g.notes || '')}</textarea></label>
      </div>
    </div></details>
    ${practice ? '' : checklistPanel(g)}
    ${photosPanel(g, true)}
    ${practice ? '' : `
    <details class="panel fold" data-fold="client" ${foldOpen('client')}><summary><h2 class="sec">Client</h2><span class="sum">${esc([c.contact_name, c.org].filter(Boolean).join(' — ') || 'No client yet')}</span><span class="chev" aria-hidden="true">▾</span></summary><div class="fold-body">
      <div class="fgrid">
        <label class="f w2">Saved client<select class="in" data-f="client_id"><option value="">— New / none —</option>${S.clients.slice().sort((a, b) => (a.org || a.contact_name || '').localeCompare(b.org || b.contact_name || '')).map(x => `<option value="${x.id}" ${x.id === g.client_id ? 'selected' : ''}>${esc(x.org || x.contact_name)}${x.org && x.contact_name ? ' — ' + esc(x.contact_name) : ''}</option>`).join('')}</select></label>
        <label class="f">Invoice code<input class="in" data-c="code" value="${esc(c.code || '')}" placeholder="OUHSC"></label>
        <label class="f">Phone<input class="in" data-c="phone" value="${esc(c.phone || '')}"></label>
        <label class="f w2">Contact<input class="in" data-c="contact_name" value="${esc(c.contact_name || '')}"></label>
        <label class="f w2">Organization<input class="in" data-c="org" value="${esc(c.org || '')}"></label>
        <label class="f w2">Email<input class="in" data-c="email" type="email" value="${esc(c.email || '')}"></label>
        <label class="f w2">Street<input class="in" data-c="address1" value="${esc(c.address1 || '')}"></label>
        <label class="f w4">City, ST ZIP<input class="in" data-c="city_state_zip" value="${esc(c.city_state_zip || '')}"></label>
      </div>
    </div></details>
    <details class="panel fold" data-fold="money" ${foldOpen('money')}><summary><h2 class="sec">Money</h2><span class="sum">${g.status === 'complete' ? money(gross(g)) + ' gross' + (balanceDue(g) ? ' · <b style="color:var(--gold)">' + money(balanceDue(g)) + ' due</b>' : '') : (g.quote ? money(g.quote) + ' quoted' : 'No quote yet') + (n0(g.deposit_amount) ? ' · deposit ' + (g.deposit_received ? 'in' : '<b style="color:var(--gold)">owed</b>') : '')}</span><span class="chev" aria-hidden="true">▾</span></summary><div class="fold-body">
      <div class="fgrid">
        ${f('quote', 'Quote $', 'number')}${f('hours', 'Hours', 'number')}
        ${f('deposit_amount', 'Deposit $', 'number')}
        ${f('paid', 'Paid (less deposit) $', 'number')}${f('paid_on', 'Paid on', 'date')}
        ${f('tips', 'Tips $', 'number')}${f('merch', 'Merch $', 'number')}
        <label class="f w2">Pay to<select class="in" data-f="payee_id">${S.payees.map(p => `<option value="${p.id}" ${p.id === payeeOf(g).id ? 'selected' : ''}>${esc(p.name)}${p.org ? ' — ' + esc(p.org) : ''}</option>`).join('')}</select></label>
        <label class="f w2">Line item<input class="in" data-f="line_item" value="${esc(g.line_item || '')}" placeholder="${esc(lineItem(g, true))}"></label>
      </div>
      <div class="row" style="margin-top:14px;gap:18px">
        <div><div class="eyebrow">Gross</div><div class="num" style="font-size:20px;font-weight:700">${money(gross(g))}</div></div>
        <div><div class="eyebrow">Balance due</div><div class="num" style="font-size:20px;font-weight:700;color:${balanceDue(g) ? 'var(--gold)' : 'inherit'}">${money(balanceDue(g))}</div></div>
        ${salesFor(g.id) ? `<div><div class="eyebrow">Logged merch sales</div><div class="num" style="font-size:20px;font-weight:700">${money(salesFor(g.id))}</div></div>` : ''}
        ${expensesFor(g.id) ? `<div><div class="eyebrow">Expenses</div><div class="num" style="font-size:20px;font-weight:700">${money(expensesFor(g.id), true)}</div></div>` : ''}
      </div>
    </div></details>`}
    <div class="row"><button class="btn gold" data-act="save-gig">Save changes</button><button class="btn" data-act="gig-view">Cancel</button><span id="dirtyNote" class="small muted"></span><span class="spacer"></span>
      <span id="delWrap"><button class="btn danger sm" data-act="del-gig-ask">Delete</button></span></div>
   </div>
   <div class="stack">
    ${practice ? '' : `
    <details class="panel fold" data-fold="paper" ${foldOpen('paper')}><summary><h2 class="sec">Paperwork</h2><span class="sum">${esc([g.quote_no ? 'Quote sent' : '', g.invoice_no ? 'Invoiced ' + mdY(g.invoiced_on) : ''].filter(Boolean).join(' · ') || 'Nothing sent')}</span><span class="chev" aria-hidden="true">▾</span></summary><div class="fold-body">
      <div class="stack">
        <div class="row"><div class="grow"><b>Quote</b><div class="small muted">${g.quote_no ? esc(g.quote_no) + ' · sent ' + mdY(g.quoted_on) : 'Not sent yet'}</div></div><button class="btn sm gold" data-act="pdf" data-v="quote">Quote PDF</button></div>
        <div class="row"><div class="grow"><b>Invoice</b><div class="small muted">${g.invoice_no ? esc(g.invoice_no) + ' · ' + mdY(g.invoiced_on) : 'Not invoiced yet'}</div></div><button class="btn sm gold" data-act="pdf" data-v="invoice">Invoice PDF</button></div>
        <div class="row" style="flex-wrap:wrap"><button class="btn sm" data-act="mail" data-v="quote">Quote email</button><button class="btn sm" data-act="mail" data-v="deposit">Deposit reminder</button><button class="btn sm" data-act="mail" data-v="details">Gig-week details</button><button class="btn sm" data-act="mail" data-v="invoice">Invoice email</button><button class="btn sm" data-act="mail" data-v="thanks">Thank-you</button></div>
        <p class="small faint" style="margin:0">Generating a PDF stamps the quote/invoice number and date on this gig.</p>
      </div>
    </div></details>`}
    <details class="panel fold" data-fold="setlist" ${foldOpen('setlist')}><summary><h2 class="sec">Setlist</h2><span class="sum">${items.length ? items.length + ' songs' : '<span style="color:var(--gold)">None yet</span>'}</span><span class="chev" aria-hidden="true">▾</span></summary><div class="fold-body">
      ${items.length ? `<p class="muted" style="margin-top:0">${items.length} songs across ${new Set(items.map(i => i.set_no)).size} set(s) · about ${hm(totalDur + items.length * (st.song_buffer_sec || 10) / 60)} with transitions</p>` : `<p class="muted" style="margin-top:0">${g.songs_played_legacy ? g.songs_played_legacy + ' songs played (count from the old sheet).' : 'No setlist yet.'}</p>`}
      ${listOf(g.id) ? `<div class="row"><a class="btn sm gold" href="#setlist/${listOf(g.id).id}">Open setlist</a>${listOf(g.id).name ? `<span class="small muted">“${esc(listOf(g.id).name)}”</span>` : ''}</div>`
        : `<div class="row"><button class="btn sm gold" data-act="sl-new" data-gig="${g.id}">New setlist</button>${S.setlists.some(l => !l.gig_id) ? `<select class="in" data-act-change="sl-attach" data-gig="${g.id}" style="width:auto;max-width:220px"><option value="">Use a saved draft…</option>${S.setlists.filter(l => !l.gig_id).map(l => `<option value="${l.id}">${esc(slName(l))} (${itemsOf(l.id).length})</option>`).join('')}</select>` : ''}</div>`}
    </div></details>
    <details class="panel fold" data-fold="cal" ${foldOpen('cal')}><summary><h2 class="sec">Calendar</h2><span class="sum">Add to your phone</span><span class="chev" aria-hidden="true">▾</span></summary><div class="fold-body">
      <div class="row"><button class="btn sm" data-act="ics-one">Add to my calendar (.ics)</button></div>
    </div></details>
   </div>
  </div>`;
}
const FOLD_DEFAULT = { details: true, setlist: true, client: false, money: false, paper: false, cal: false, payout: false };
const foldOpen = k => ((UI.folds || {})[k] ?? FOLD_DEFAULT[k]) ? 'open' : '';
document.addEventListener('toggle', e => { const d = e.target; if (!d.matches || !d.matches('details[data-fold]')) return; UI.folds = { ...(UI.folds || {}), [d.dataset.fold]: d.open }; keepUI(); }, true);
function lineItem(g, plain) {
  const st = settings();
  const tpl = g.line_item || st.default_line_item || 'Load-in, setup, soundcheck, music ({hours}hrs), load-out';
  const h = g.hours ? String(+Number(g.hours).toFixed(2)) : '';
  return h ? tpl.replace('{hours}', h) : tpl.replace(/\s*\(\{hours\}hrs\)/, '').replace('{hours}', '');
}
function payoutPanel(g) {
  const st = settings(), ms = activeMembers();
  const exp = expensesFor(g.id), fund = Math.max(0, gross(g) - exp) * n0(st.band_fund_pct) / 100;
  const each = ms.length ? (gross(g) - exp - fund) / ms.length : 0;
  return `<details class="panel fold" data-fold="payout" ${foldOpen('payout')}><summary><h2 class="sec">Payout split</h2><span class="sum">${ms.length ? money(each, true) + ' each' : ''}</span><span class="chev" aria-hidden="true">▾</span></summary><div class="fold-body">
    <table class="tbl"><tbody>
      <tr><td>Gross</td><td class="r num">${money(gross(g), true)}</td></tr>
      ${exp ? `<tr><td>Gig expenses</td><td class="r num">−${money(exp, true)}</td></tr>` : ''}
      ${fund ? `<tr><td>Band fund (${n0(st.band_fund_pct)}%)</td><td class="r num">−${money(fund, true)}</td></tr>` : ''}
      ${ms.map(m => `<tr><td>${esc(m.name)}</td><td class="r num">${money(each, true)}</td></tr>`).join('')}
    </tbody></table></div></details>`;
}

/* ============================================================ calendar (bottom of Home) */
function calendarSection() {
  const base = UI.calMonth ? pd(UI.calMonth + '-01') : new Date(today().getFullYear(), today().getMonth(), 1);
  const three = UI.calSpan === '3mo', nMonths = three ? 3 : 1;
  const t = todayIso(), st = settings();
  const byDay = {};
  S.gigs.forEach(g => { if (g.gig_date) (byDay[g.gig_date] = byDay[g.gig_date] || []).push(g); });
  const monthGrid = (y, m) => {
    const start = new Date(y, m, 1 - new Date(y, m, 1).getDay()), cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i); const k = iso(d);
      if (i >= 35 && d.getMonth() !== m) break;
      const evs = (byDay[k] || []).map(g => {
        const cls = g.kind === 'practice' ? 'practice' : ['passed','cancelled'].includes(g.status) ? 'dead' : ['inquiry','quoted'].includes(g.status) ? 'lead' : 'gig';
        return `<a class="ev ${cls}" href="#gig/${g.id}" title="${esc(g.title)}"><span>${esc(g.start_time ? g.start_time + ' ' : '')}${esc(g.kind === 'practice' ? 'Practice' : g.title)}</span></a>`;
      }).join('');
      cells.push(`<div class="day ${d.getMonth() !== m ? 'out' : ''} ${k === t ? 'today' : ''}"><span class="dn">${d.getDate()}</span>${evs}</div>`);
    }
    return `<div class="cal ${three ? 'compact' : ''}">${DOW.map(d => `<div class="dow">${d}</div>`).join('')}${cells.join('')}</div>`;
  };
  const months = Array.from({ length: nMonths }, (_, i) => new Date(base.getFullYear(), base.getMonth() + i, 1));
  const last = months[months.length - 1];
  const rangeFrom = iso(months[0]), rangeTo = iso(new Date(last.getFullYear(), last.getMonth() + 1, 0));
  const label = three ? `${months[0].toLocaleDateString('en-US', { month: 'short' })} – ${last.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}` : base.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const feed = `${SUPABASE_URL}/functions/v1/${CAL_FUNCTION}?token=${st.ics_token || ''}`;
  const rangeList = S.gigs.filter(g => g.gig_date && g.gig_date >= rangeFrom && g.gig_date <= rangeTo).sort((a, b) => a.gig_date.localeCompare(b.gig_date));
  return `<h2 class="sec2">Calendar</h2>
   <div class="row" style="margin-bottom:12px">
     <button class="btn sm" data-act="cal-move" data-v="-1">←</button>
     <b class="disp" style="font-size:20px;color:var(--gold);min-width:210px;text-align:center">${label}</b>
     <button class="btn sm" data-act="cal-move" data-v="1">→</button>
     <button class="btn sm ghost" data-act="cal-move" data-v="0">Today</button>
     <span class="spacer"></span>
     <div class="chips"><button class="chip ${three ? '' : 'on'}" data-act="cal-span" data-v="month">Month</button><button class="chip ${three ? 'on' : ''}" data-act="cal-span" data-v="3mo">3 months</button></div>
   </div>
   <div class="legend" style="margin-bottom:10px"><span><i style="background:var(--gold)"></i>Booked / played</span><span><i style="background:var(--info)"></i>Lead</span><span><i style="background:var(--muted)"></i>Practice</span></div>
   <section class="panel" style="padding:10px">${months.map(d => `${three ? `<div class="cal-month">${d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</div>` : ''}${monthGrid(d.getFullYear(), d.getMonth())}`).join('')}</section>
   <div class="split" style="margin-top:16px">
     <section class="panel"><h2 class="sec">${three ? 'Next 3 months' : 'This month'}</h2><div class="list">${rangeList.map(gigLi).join('') || `<div class="empty">Nothing ${three ? 'in these months' : 'this month'}.</div>`}</div>
       ${addBtns(false)}</section>
     <section class="panel"><h2 class="sec">Sync to your phone</h2>
       <p class="small muted" style="margin-top:0">Subscribe once and every gig and practice shows up in your own calendar. Gigs start at load-in and run until an hour after the show ends. Updates flow in automatically (Apple refreshes about hourly; Google can take up to a day).</p>
       <label class="f">Calendar feed URL<input class="in" readonly value="${esc(feed)}" id="feedUrl"></label>
       <div class="row" style="margin-top:10px"><button class="btn sm gold" data-act="copy-feed">Copy URL</button><a class="btn sm" href="${esc(feed.replace(/^https:/, 'webcal:'))}">Open in Apple Calendar</a><button class="btn sm" data-act="ics-all">Download .ics instead</button></div>
       <p class="small faint">Google Calendar: Other calendars → + → From URL → paste. Anyone with this link can read the schedule${true ? '; <a href="#" data-act="rotate-token">reset the link</a> if it gets shared too widely' : ''}.</p>
     </section>
   </div>`;
}

/* ============================================================ setlists */
function slLi(L) {
  const g = gigOf(L), n = itemsOf(L.id).length, d = g && pd(g.gig_date);
  return `<a class="li" href="#setlist/${L.id}">
    <div class="date">${d ? `<small>${MON[d.getMonth()]}</small><b>${d.getDate()}</b><small>${String(d.getFullYear()).slice(2)}</small>` : '<small>Draft</small>'}</div>
    <div class="grow"><div class="t">${esc(slName(L))}</div><div class="s">${g ? (L.name && L.name !== g.title ? esc(g.title) + ' · ' : '') + esc(g.venue || STATUS_LABEL[g.status] || '') : 'Not assigned to a gig yet'}${L.notes ? ' · ' + esc(L.notes) : ''}</div></div>
    <span class="small muted">${n} songs</span></a>`;
}
function setlistsView() {
  const t = todayIso();
  const drafts = S.setlists.filter(L => !L.gig_id).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  const up = S.gigs.filter(g => isGig(g) && ['confirmed','quoted','inquiry'].includes(g.status) && (!g.gig_date || g.gig_date >= t)).sort((a, b) => (a.gig_date || '9').localeCompare(b.gig_date || '9'));
  const past = S.setlists.filter(L => { const g = gigOf(L); return g && !up.includes(g); }).sort((a, b) => (gigOf(b).gig_date || '').localeCompare(gigOf(a).gig_date || ''));
  const upRow = g => { const L = listOf(g.id); if (L) return slLi(L); const d = pd(g.gig_date);
    return `<div class="li"><div class="date">${d ? `<small>${MON[d.getMonth()]}</small><b>${d.getDate()}</b><small>${String(d.getFullYear()).slice(2)}</small>` : '<small>TBD</small>'}</div>
      <div class="grow"><div class="t">${esc(g.title)}</div><div class="s" style="color:var(--gold)">Needs a setlist</div></div>
      <button class="btn sm gold" data-act="sl-new" data-gig="${g.id}">New</button>
      ${drafts.length ? `<select class="in" data-act-change="sl-attach" data-gig="${g.id}" style="width:auto;max-width:170px"><option value="">Use a draft…</option>${drafts.map(L => `<option value="${L.id}">${esc(slName(L))}</option>`).join('')}</select>` : ''}</div>`; };
  return `${title('Setlists')}
   <div class="row" style="margin-bottom:14px"><button class="btn gold" data-act="sl-new">+ New setlist</button></div>
   <div class="grid g2" style="align-items:start">
     <div class="stack">
       <section class="panel"><h2 class="sec">Drafts</h2><div class="list">${drafts.map(slLi).join('') || '<div class="empty">No drafts. Start one with <b>+ New setlist</b>.</div>'}</div></section>
       <section class="panel"><h2 class="sec">Upcoming gigs</h2><div class="list">${up.map(upRow).join('') || '<div class="empty">No upcoming gigs.</div>'}</div></section>
     </div>
     <section class="panel"><h2 class="sec">Past setlists</h2><div class="list">${past.map(slLi).join('') || '<div class="empty">Nothing yet.</div>'}</div></section>
   </div>`;
}
/* ----- show plan: sets, breaks, clock times ----- */
function planOf(g, ignoreItems) {                      // g: a slCtx() setlist
  const st = settings(), items = ignoreItems ? [] : itemsOf(g.id);
  const sets = Math.max(n0(g.set_count), ...items.map(i => i.set_no), 1);
  const breaks = g.break_count != null ? Math.min(n0(g.break_count), Math.max(sets - 1, 0)) : Math.max(sets - 1, 0);
  const breakMin = g.break_min != null ? n0(g.break_min) : n0(st.default_break_min ?? 15);
  const slot = g.hours ? n0(g.hours) * 60 : null;                       // whole performance window, breaks included
  const music = slot != null ? Math.max(slot - breaks * breakMin, 0) : sets * (n0(st.set_target_min) || 40);
  return { sets, breaks, breakMin, slot, music, perSet: music / sets, buf: (st.song_buffer_sec ?? 10) / 60 };
}
const songDur = (s, buf) => n0(s && s.length_min) + buf;
function runOfShow(g, plan, setDur) {
  const t = parseTime(g.start_time); let clock = t ? t[0] * 60 + t[1] : null;
  const fmt = m => { if (clock == null) return ''; m = Math.round(m); let h = Math.floor(m / 60) % 24, mi = m % 60; const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12; return `${h}:${String(mi).padStart(2, '0')}${ap}`; };
  const out = [];
  for (let n = 1; n <= plan.sets; n++) {
    const d = setDur[n] != null ? setDur[n] : plan.perSet;
    out.push({ kind: 'set', n, from: fmt(clock), to: fmt(clock + d), dur: d }); if (clock != null) clock += d;
    if (n < plan.sets && n <= plan.breaks) { out.push({ kind: 'break', from: fmt(clock), to: fmt(clock + plan.breakMin), dur: plan.breakMin }); if (clock != null) clock += plan.breakMin; }
  }
  return out;
}
/* ----- flow analysis: what changes between two songs played back to back ----- */
const normPart = v => String(v || '').trim().toLowerCase();
function changes(a, b) {
  const out = { inst: [], tuning: false, sameKey: false, capo: false, sameVox: false, sameGenre: false };
  if (!a || !b) return out;
  const pa = a.parts || {}, pb = b.parts || {};
  activeMembers().forEach(m => { const x = normPart(pa[m.name]), y = normPart(pb[m.name]); if (x && y && x !== y) out.inst.push({ who: m.name, from: pa[m.name], to: pb[m.name] }); });
  out.tuning = (a.tuning || 'Standard') !== (b.tuning || 'Standard');
  out.sameKey = !!a.song_key && a.song_key === b.song_key;
  out.capo = n0(a.capo) !== n0(b.capo);
  out.sameVox = !!a.lead_vox && a.lead_vox === b.lead_vox;
  out.sameGenre = !!a.genre && a.genre === b.genre;
  return out;
}
function flowStats(setsSongs) {
  const r = { inst: 0, tuning: 0, sameKey: 0, voxRuns: 0, genreRuns: 0 };
  setsSongs.forEach(list => list.forEach((s, i) => {
    if (!i) return; const c = changes(list[i - 1], s);
    r.inst += c.inst.length; r.tuning += c.tuning ? 1 : 0; r.sameKey += c.sameKey ? 1 : 0;
    if (i >= 2 && c.sameVox && list[i - 2].lead_vox === s.lead_vox) r.voxRuns++;
    if (i >= 2 && c.sameGenre && list[i - 2].genre === s.genre) r.genreRuns++;
  }));
  return r;
}
const flowChips = (f) => `<div class="chips small">
  <span class="pill" style="color:${f.inst ? 'var(--gold)' : 'var(--ok)'}">${cbm(!f.inst)}${f.inst} instrument swap${f.inst === 1 ? '' : 's'}</span>
  <span class="pill" style="color:${f.tuning ? 'var(--bad)' : 'var(--ok)'}">${cbm(!f.tuning)}${f.tuning} retune${f.tuning === 1 ? '' : 's'} in a set</span>
  <span class="pill" style="color:${f.sameKey ? 'var(--gold)' : 'var(--ok)'}">${cbm(!f.sameKey)}${f.sameKey} same-key pair${f.sameKey === 1 ? '' : 's'}</span>
  <span class="pill" style="color:${f.voxRuns ? 'var(--gold)' : 'var(--ok)'}">${cbm(!f.voxRuns)}${f.voxRuns} 3-in-a-row singer</span>
  <span class="pill" style="color:${f.genreRuns ? 'var(--gold)' : 'var(--ok)'}">${cbm(!f.genreRuns)}${f.genreRuns} 3-in-a-row genre</span></div>`;

/* ----- export a setlist for playlist builders (Soundiiz, TuneMyMusic…) ----- */
function exportRows(L) {
  const seen = new Set();
  return itemsOf(L.id).filter(i => i.played).sort((a, b) => a.set_no - b.set_no || a.position - b.position)
    .map(i => ({ s: byId('songs', i.song_id), set: i.set_no })).filter(r => r.s && !seen.has(r.s.id) && seen.add(r.s.id))
    .map(r => ({ title: r.s.title, artist: r.s.artist || '', set: r.set }));
}
const exportText = rows => rows.map(r => r.artist ? `${r.title} - ${r.artist}` : r.title).join('\n');
const csvCell = v => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
const exportCsv = rows => ['Track,Artist,Set'].concat(rows.map(r => [r.title, r.artist, r.set].map(csvCell).join(','))).join('\r\n');
function exportModal(L) {
  const rows = exportRows(L), noArtist = rows.filter(r => !r.artist);
  return `<div class="scrim" data-act="modal-close"><div class="modal" data-stop style="width:min(640px,100%)">
    <div class="row"><h2 class="sec" style="margin:0">Playlist export</h2><span class="spacer"></span><button class="btn ghost" data-act="modal-close">✕</button></div>
    <p class="small muted" style="margin:10px 0">${rows.length} song${rows.length === 1 ? '' : 's'} in setlist order. Paste the list (or upload the CSV) into a playlist converter such as Soundiiz or TuneMyMusic, point it at Spotify, and it builds the playlist.</p>
    ${noArtist.length ? `<p class="small" style="color:var(--gold)">${noArtist.length} song${noArtist.length === 1 ? ' has' : 's have'} no artist (${noArtist.slice(0, 3).map(r => esc(r.title)).join(', ')}${noArtist.length > 3 ? '…' : ''}). Add the artist on the Songs page so they match the right recording.</p>` : ''}
    <textarea class="in" readonly rows="10" style="font-family:inherit;line-height:1.5">${esc(exportText(rows))}</textarea>
    <div class="row" style="margin-top:12px"><button class="btn gold" data-act="exp-copy" data-id="${L.id}">Copy list</button><button class="btn" data-act="exp-csv" data-id="${L.id}">Download CSV</button></div></div></div>`;
}

function setlistView(id) {
  const L = byId('setlists', id);
  if (!L) return `${title('Not found')}<p class="muted">That setlist may have been deleted. <a href="#setlists">Back to setlists</a></p>`;
  return S.editSl === id ? setlistEdit(id) : setlistRead(id);
}
function setlistRead(id) {
  const L = byId('setlists', id), gig = gigOf(L), g = slCtx(L), items = itemsOf(id).filter(i => i.played), plan = planOf(g);
  const total = items.reduce((a, i) => a + n0((byId('songs', i.song_id) || {}).length_min), 0);
  const tbd = '<span class="faint">TBD</span>';
  const kv = (l, v) => `<div><div class="eyebrow">${l}</div><div class="v num">${v}</div></div>`;
  const facts = [
    gig ? kv('Gig', `<a href="#gig/${gig.id}">${esc(gig.title)}</a>`) : kv('Gig', '<span class="muted">Not assigned</span>'),
    gig ? kv('Date', esc(fmtDate(gig.gig_date))) : '',
    gig && gig.kind === 'gig' ? kv('Load-in', gig.load_in_time ? esc(gig.load_in_time) : tbd) : '',
    kv('Start', g.start_time ? esc(g.start_time) : tbd),
    kv('Sets', `${plan.sets}${plan.breaks ? ` · ${plan.breaks} break${plan.breaks === 1 ? '' : 's'} (${plan.breakMin} min)` : ''}`),
    g.hours ? kv('Slot', hm(n0(g.hours) * 60)) : '',
  ].filter(Boolean);
  return `<div class="row" style="margin-bottom:6px"><a href="${gig ? '#gig/' + gig.id : '#setlists'}" class="back">← ${gig ? esc(gig.title) : 'Setlists'}</a></div>
  ${title(slName(L), `Setlist · ${items.length} songs · ${hm(total)} of music`)}
  <div class="row" style="margin-bottom:14px"><button class="btn gold btn-go" data-act="gig-mode" aria-label="Gig mode"><b>&gt;&gt;</b> Gig mode</button><button class="btn" data-act="sl-edit">Edit</button><button class="btn" data-act="pl-export">Playlist export</button><button class="btn" data-act="set-pdf">Stage PDF</button><button class="btn" data-act="set-text">Copy as text</button></div>
  <section class="panel" style="margin-bottom:14px"><div class="kv">${facts.join('')}</div>${L.notes ? `<p style="margin:14px 0 0;white-space:pre-wrap">${esc(L.notes)}</p>` : ''}</section>
  ${setlistSets(L, false)}`;
}
function setlistEdit(id) {
  const L = byId('setlists', id);
  const gig = gigOf(L), g = slCtx(L);
  const items = itemsOf(id), plan = planOf(g), buf = plan.buf;
  const sets = Array.from({ length: plan.sets }, (_, i) => i + 1);
  if (UI.selSet > plan.sets) UI.selSet = 1;
  const used = new Set(items.map(i => i.song_id));
  const target = plan.perSet;
  const setDur = {}; sets.forEach(n => setDur[n] = items.filter(i => i.set_no === n && i.played).reduce((a, i) => a + songDur(byId('songs', i.song_id), buf), 0));
  const ros = runOfShow(g, plan, Object.fromEntries(sets.map(n => [n, setDur[n] || plan.perSet])));
  const flow = flowStats(sets.map(n => items.filter(i => i.set_no === n && i.played).map(i => byId('songs', i.song_id)).filter(Boolean)));
  const setCards = sets.map(n => {
    const its = items.filter(i => i.set_no === n), dur = setDur[n];
    const over = dur > target + 2, slot = ros.find(r => r.kind === 'set' && r.n === n);
    const brk = ros[ros.indexOf(slot) + 1];
    let prev = null;
    return `<section class="panel set ${UI.selSet === n ? 'sel' : ''}" data-act="sel-set" data-v="${n}">
      <div class="row"><h3>Set ${n}</h3>${slot && slot.from ? `<span class="small muted">${slot.from}–${slot.to}</span>` : ''}<span class="spacer"></span><span class="small num" style="color:${over ? 'var(--bad)' : dur < target - 5 ? 'var(--muted)' : 'var(--ok)'}">${over ? cbm(false) : ''}${hm(dur)} / ${hm(target)}${over ? ' over' : ''}</span></div>
      <div class="bar"><i class="${over ? 'over' : ''}" style="width:${Math.min(100, dur / Math.max(target, 1) * 100)}%"></i></div>
      ${its.map((i, k) => { const s = byId('songs', i.song_id) || { title: '(deleted song)' }; const c = i.played ? changes(prev, s) : changes(null, null); if (i.played) prev = s;
        const warn = [c.tuning ? `<span style="color:var(--bad)">retune → ${esc(s.tuning || 'Standard')}</span>` : '', ...c.inst.map(x => `<span style="color:var(--gold)">${esc(x.who)}: ${esc(x.to)}</span>`)].filter(Boolean).join(' · ');
        return `
        <div class="song ${i.played ? '' : 'unplayed'}">
          <span class="n">${k + 1}</span>
          <div style="min-width:0"><div class="nm">${i.pinned ? '<span title="Pinned — the optimizer keeps it here" style="color:var(--gold)">⚑ </span>' : ''}${esc(s.title)}${s.is_encore ? ' <span class="small" style="color:var(--gold)">encore</span>' : ''}</div>
            <div class="meta">${esc(songLabel(s))} · ${mins(s.length_min)} · ${esc(s.lead_vox || '')}${s.genre ? ' · ' + esc(s.genre) : ''}${s.energy ? ' · ' + '▮'.repeat(s.energy) : ''}</div>
            ${warn ? `<div class="meta">⇄ ${warn}</div>` : ''}</div>
          <div class="acts">
            <button class="ib" title="Move up" data-act="si-move" data-id="${i.id}" data-v="-1">▲</button>
            <button class="ib" title="Move down" data-act="si-move" data-id="${i.id}" data-v="1">▼</button>
            ${sets.length > 1 ? `<button class="ib" title="Move to next set" data-act="si-set" data-id="${i.id}">⇄</button>` : ''}
            <button class="ib" title="${i.pinned ? 'Unpin' : 'Pin here (optimizer won’t move it)'}" data-act="si-pin" data-id="${i.id}" style="${i.pinned ? 'color:var(--gold)' : ''}">⚑</button>
            <button class="ib" title="${i.played ? 'Mark skipped' : 'Mark played'}" data-act="si-played" data-id="${i.id}">${i.played ? '✓' : '○'}</button>
            <button class="ib" title="Note after this song (announcement, swap…)" data-act="si-note" data-id="${i.id}" style="${i.note ? 'color:var(--gold)' : ''}">✎</button>
            <button class="ib" title="Remove" data-act="si-del" data-id="${i.id}">✕</button>
          </div></div>${i.note || S._noteOpen[i.id] ? `<div class="snote-edit" data-stop><textarea class="in" rows="2" data-si-note="${i.id}" placeholder="Between songs — announcement, instrument swap, story…">${esc(i.note || '')}</textarea></div>` : ''}`; }).join('') || '<p class="small muted">Click songs in the book to add them here, or let the optimizer build it.</p>'}
      ${brk && brk.kind === 'break' ? `<div class="small muted" style="margin-top:10px;border-top:1px dashed var(--line);padding-top:8px">Break · ${brk.dur} min${brk.from ? ` · ${brk.from}–${brk.to}` : ''}</div>` : ''}
    </section>`;
  }).join('');
  const others = S.setlists.filter(x => x.id !== id && itemsOf(x.id).length).sort((a, b) => ((gigOf(b) || {}).gig_date || b.updated_at || '').localeCompare((gigOf(a) || {}).gig_date || a.updated_at || ''));
  const openGigs = S.gigs.filter(x => isGig(x) && !listOf(x.id) && live(x)).sort((a, b) => (a.gig_date || '9').localeCompare(b.gig_date || '9'));
  const q = UI.libSearch.toLowerCase();
  const stats = songStats();
  const usedSel = new Set(items.filter(i => i.set_no === UI.selSet).map(i => i.song_id)), inSet = {}; items.forEach(i => { if (i.set_no !== UI.selSet) inSet[i.song_id] = i.set_no; });
  const lib = S.songs.filter(s => !usedSel.has(s.id) && (UI.libFilter === 'all' || s.status === UI.libFilter) && (!q || (s.title + ' ' + (s.artist || '') + ' ' + (s.genre || '')).toLowerCase().includes(q)))
    .sort((a, b) => (a.default_set || 99) - (b.default_set || 99) || (a.default_order || 999) - (b.default_order || 999) || a.title.localeCompare(b.title));
  const total = Object.values(setDur).reduce((a, b) => a + b, 0);
  const pf = (k, l, v, extra = '') => `<label class="f">${l}<input class="in" type="number" min="0" step="any" data-plan="${k}" value="${esc(v ?? '')}" ${extra}></label>`;
  return `<div class="row" style="margin-bottom:6px"><a href="${gig ? '#gig/' + gig.id : '#setlists'}" class="back">← ${gig ? esc(gig.title) : 'Setlists'}</a></div>
  ${title(slName(L), `Setlist · ${items.length} songs · ${hm(total)} of music`)}
  <div class="row" style="margin-bottom:14px"><span class="pill st-confirmed">Editing</span><span class="spacer"></span><button class="btn gold" data-act="sl-view">Done</button></div>
  <section class="panel" style="margin-bottom:14px">
    <div class="row" style="align-items:flex-end;gap:12px">
      <label class="f grow" style="min-width:200px">Setlist name<input class="in" id="slName" value="${esc(L.name || '')}" placeholder="${esc(gig ? gig.title : 'e.g. Wedding — 2 × 60')}"></label>
      <label class="f grow" style="min-width:200px">Notes<input class="in" id="slNotes" value="${esc(L.notes || '')}" placeholder="Who it's for, vibe, requests"></label>
    </div>
    <div class="row" style="margin-top:12px">
      ${gig ? `<span>Assigned to <a href="#gig/${gig.id}"><b>${esc(gig.title)}</b></a> · ${fmtDate(gig.gig_date)}</span> ${statusPill(gig)}<button class="btn sm" data-act="sl-unassign">Unassign</button>`
        : `<span class="muted">Not assigned to a gig.</span><select class="in" id="slAssign" style="width:auto;max-width:300px"><option value="">Assign to gig…</option>${openGigs.map(x => `<option value="${x.id}">${esc(x.title)} (${x.gig_date ? mdY(x.gig_date) : 'date TBD'})</option>`).join('')}</select>`}
      <span class="spacer"></span>
      <button class="btn sm" data-act="sl-dup">Duplicate</button>
      <span id="slDelWrap"><button class="btn sm danger" data-act="sl-del-ask">Delete setlist</button></span>
    </div>
  </section>
  <section class="panel" style="margin-bottom:14px">
    <div class="plangrid">
        <label class="f">Start<input class="in" data-plan="start_time" value="${esc(g.start_time || '')}" placeholder="7pm"></label>
        ${pf('hours', 'Slot (hours)', g.hours)}
        ${pf('set_count', 'Sets', plan.sets, 'step="1" min="1"')}
        ${pf('break_count', 'Breaks', plan.breaks, 'step="1"')}
        ${pf('break_min', 'Break (min)', plan.breakMin, 'step="1"')}
        <div class="row plan-acts"><button class="btn sm" data-act="plan-save">Update plan</button><button class="btn gold" data-act="opt-open">Optimize setlist</button></div>
    </div>
    <div class="row small muted" style="margin-top:12px;gap:6px 14px">
      ${plan.slot != null ? `<span><b class="num" style="color:var(--cream)">${hm(plan.music)}</b> of music in a ${hm(plan.slot)} slot → <b class="num" style="color:var(--cream)">${hm(plan.perSet)}</b> per set</span>` : `<span>Set a slot length to size the sets (using ${hm(plan.perSet)} per set for now).</span>`}
      <span class="spacer"></span>
      ${ros.map(r => r.kind === 'set' ? `<span><b style="color:var(--gold)">Set ${r.n}</b> ${r.from ? r.from + '–' + r.to : hm(r.dur)}</span>` : `<span>Break ${r.from ? r.from + '–' + r.to : r.dur + 'm'}</span>`).join('<span class="faint">·</span>')}
    </div>
    ${items.length ? `<div style="margin-top:12px">${flowChips(flow)}</div>` : ''}
  </section>
  <div class="row" style="margin-bottom:14px">
    <select class="in" id="copyFrom" style="width:auto;max-width:260px"><option value="">Copy from another setlist…</option>${others.map(o => { const og = gigOf(o); return `<option value="${o.id}">${esc(slName(o))}${og && og.gig_date ? ' (' + mdY(og.gig_date) + ')' : ' (draft)'}</option>`; }).join('')}</select>
    <span class="spacer"></span>
    <button class="btn sm gold" data-act="set-pdf">Stage PDF</button><button class="btn sm" data-act="set-text">Copy as text</button>
    <span id="clearWrap"><button class="btn sm danger" data-act="set-clear-ask">Clear</button></span>
  </div>
  <div class="split">
    <div class="sets">${setCards}</div>
    <section class="panel" style="position:sticky;top:0">
      <div class="row"><h2 class="sec" style="margin:0">Song book</h2><span class="spacer"></span><span class="small muted">adds to Set ${UI.selSet}${usedSel.size ? ` · ${usedSel.size} already in it hidden` : ''}</span></div>
      <div class="row" style="margin:10px 0"><input class="in" id="libSearch" placeholder="Search songs or genre" value="${esc(UI.libSearch)}">
        <div class="chips">${[['active','Active'],['bench','Bench'],['holiday','Holiday'],['all','All']].map(([k, l]) => `<button class="chip ${UI.libFilter === k ? 'on' : ''}" data-act="lib-filter" data-v="${k}">${l}</button>`).join('')}</div></div>
      <div class="lib">${lib.map(s => `<div class="libi ${inSet[s.id] ? 'used' : ''}" data-act="lib-add" data-id="${s.id}">
         <div class="grow"><div style="font-weight:600">${esc(s.title)}${s.is_opener ? ' <span class="small" style="color:var(--gold)">opener</span>' : ''}${s.is_closer ? ' <span class="small" style="color:var(--gold)">closer</span>' : ''}${s.is_encore ? ' <span class="small" style="color:var(--gold)">encore</span>' : ''}</div><div class="small muted">${esc(s.artist || '')} · ${esc(songLabel(s))} · ${mins(s.length_min)}${s.genre ? ' · ' + esc(s.genre) : ''}${inSet[s.id] ? ' · in Set ' + inSet[s.id] : ''}</div></div>
         <div style="text-align:right"><div class="stars ro">${starsRO(avgRating(s.id))}</div><div class="small faint">${(stats[s.id] || {}).plays || 0} plays</div></div></div>`).join('')}</div>
    </section>
  </div>`;
}

/* ============================================================ optimizer */
const OPT_DEFAULT = { pools: { active: true, bench: false, learning: false, holiday: false }, shape: 'build', keepPinned: true,
  encore: 1, w: { energy: 2, inst: 2, tuning: 3, key: 1, vox: 1, genre: 1, rating: 2, fresh: 1, oc: 2 } };
const SHAPES = { build: 'Start easy, finish big', party: 'High energy all night', dinner: 'Dinner first, then dance', waves: 'Each set builds' };
const WLAB = { energy: 'Energy arc', inst: 'Fewer instrument swaps', tuning: 'Group tunings (retune only at breaks)', key: 'Vary keys back-to-back', vox: 'Mix lead singers', genre: 'Spread genres', rating: 'Favor top-rated songs', fresh: 'Rest songs from the last gig', oc: 'Use the good openers & closers' };
function optPrefs(g) {
  const p = JSON.parse(JSON.stringify(OPT_DEFAULT)); const saved = (g.plan && g.plan.opt) || {};   // g: slCtx()
  Object.assign(p.pools, saved.pools || {}); Object.assign(p.w, saved.w || {}); if (saved.shape) p.shape = saved.shape; if (saved.keepPinned != null) p.keepPinned = saved.keepPinned; if (saved.encore != null) p.encore = saved.encore;
  if (!saved.pools && g.gig_date && /-12-/.test(g.gig_date)) p.pools.holiday = true;
  return p;
}
function energyTarget(shape, k, sets, p) {           // k: 0-based set, p: 0..1 position within set
  const night = (k + p) / sets;
  let t;
  if (shape === 'party') t = 4.2;
  else if (shape === 'dinner') t = night < .5 ? 2 + night : 2.6 + (night - .5) * 4.6;
  else if (shape === 'waves') t = 2.3 + 2.4 * p;
  else t = 2.2 + 2.6 * night;
  if (p < 0.12) t += 0.7;                              // open each set with something that grabs the room
  if (p > 0.85) t += 0.9;                              // close each set strong
  return Math.min(5, t);
}
function optimizeSetlist(g, prefs, seed) {
  let rnd = (seed || Date.now()) % 2147483647; const rand = () => (rnd = rnd * 48271 % 2147483647) / 2147483647;
  const plan = planOf(g, true), buf = plan.buf, W = prefs.w;       // g carries the plan values from the optimizer window
  const items = itemsOf(g.id);
  const pinned = prefs.keepPinned ? items.filter(i => i.pinned) : [];
  const pinnedIds = new Set(pinned.map(i => i.song_id));
  const lastGig = S.gigs.filter(x => isGig(x) && x.status === 'complete' && x.id !== g.gig_id && setItems(x.id).length && x.gig_date <= (g.gig_date || todayIso())).sort((a, b) => b.gig_date.localeCompare(a.gig_date))[0];
  const lastSet = new Set(lastGig ? setItems(lastGig.id).map(i => i.song_id) : []);
  const inPool = S.songs.filter(s => prefs.pools[s.status] && !pinnedIds.has(s.id) && n0(s.length_min) > 0);
  const pool = inPool.filter(s => !s.is_encore);                                  // encore songs are held back for after the last set
  const score = s => { const r = avgRating(s.id); return W.rating * ((r == null ? 3 : r) - 3) * 1.4 - (lastSet.has(s.id) ? W.fresh * 0.8 : 0) + ({ active: 3, holiday: 2, learning: 0.5 }[s.status] || 0) + ((s.is_opener || s.is_closer) ? (W.oc || 0) * 1.5 : 0); };   // active rotation first; bench fills gaps
  const sc = new Map(pool.map(s => [s.id, score(s)]));
  const encore = inPool.filter(s => s.is_encore).sort((a, b) => (score(b) + rand() * .8) - (score(a) + rand() * .8)).slice(0, Math.max(0, Math.round(n0(prefs.encore))));
  const encDur = encore.reduce((a, s) => a + songDur(s, buf), 0);
  // --- pick songs to fill the music time
  const pinDur = pinned.reduce((a, i) => a + songDur(byId('songs', i.song_id), buf), 0);
  const need = plan.music - pinDur - encDur;
  const ranked = pool.slice().sort((a, b) => (sc.get(b.id) + rand() * .8) - (sc.get(a.id) + rand() * .8));
  const chosen = []; let tot = 0;
  for (const s of ranked) { const d = songDur(s, buf); if (tot + d <= need + 1.5) { chosen.push(s); tot += d; } if (tot >= need - 1) break; }
  const bench = pool.filter(s => !chosen.includes(s));
  // --- state: unpinned songs per set; pinned anchored by index
  const N = plan.sets, sets = Array.from({ length: N }, () => []);
  chosen.slice().sort((a, b) => n0(a.energy) - n0(b.energy)).forEach((s, i) => sets[Math.min(N - 1, Math.floor(i * N / chosen.length))].push(s));
  sets.forEach(l => l.sort(() => rand() - .5));
  const pins = Array.from({ length: N }, () => []);
  pinned.forEach(i => { const k = Math.min(i.set_no, N) - 1; pins[k].push({ idx: items.filter(x => x.set_no === i.set_no).indexOf(i), song: byId('songs', i.song_id) }); });
  const full = k => { const l = sets[k].slice(); pins[k].slice().sort((a, b) => a.idx - b.idx).forEach(p => l.splice(Math.min(p.idx, l.length), 0, p.song)); if (k === N - 1) l.push(...encore); return l; };
  const brk = k => (k < N - 1 && k < plan.breaks) ? plan.breakMin : 0;           // minutes of break after set k (0-based); 0 = none
  const gap = m => Math.min(1, Math.max(0, 1 - m / 10));                         // share of a swap/retune penalty that still applies across that gap
  const OC = W.oc || 0;
  const flowCost = (x, f = 1) => f * (W.inst * 1.6 * x.inst.length + (x.tuning ? W.tuning * 7 : 0) + (x.sameKey ? W.key * 1.4 : 0) + (x.capo ? W.key * 0.25 : 0) + (x.sameVox ? W.vox * 0.8 : 0) + (x.sameGenre ? W.genre * 0.7 : 0));
  const cost = () => {
    let c = 0; const all = [];
    for (let k = 0; k < N; k++) {
      const l = full(k); all.push(l); const dur = l.reduce((a, s) => a + songDur(s, buf), 0);
      c += Math.pow(dur - plan.perSet, 2) * 0.35 + (dur > plan.perSet + 3 ? (dur - plan.perSet - 3) * 4 : 0);
      const lastI = l.length - 1 - (k === N - 1 ? encore.length : 0);                  // the encore sits after the closer
      l.forEach((s, i) => {
        const flaggedSlot = OC && ((i === 0 && s.is_opener) || (i === lastI && s.is_closer));   // a flagged opener/closer in its slot wins over the energy arc
        if (W.energy && s.energy && !flaggedSlot) c += W.energy * 0.55 * Math.pow(s.energy - energyTarget(prefs.shape, k, N, l.length > 1 ? i / (l.length - 1) : 0), 2);
        if (OC) {                                                               // openers start sets, closers end them (the show's first and last matter most)
          const realStart = k === 0 || brk(k - 1) >= 5, realEnd = k === N - 1 || brk(k) >= 5;
          if (i > lastI) return;
          if (s.is_opener) c += i === 0 ? -OC * (k === 0 ? 8 : realStart ? 2.5 : 1) : OC * 1;
          if (s.is_closer) c += i === lastI ? -OC * (k === N - 1 ? 8 : realEnd ? 2.5 : 1) : OC * 1;
        }
        if (!i) return; const x = changes(l[i - 1], s);
        c += flowCost(x);
        if (i >= 2) { if (x.sameVox && l[i - 2].lead_vox === s.lead_vox) c += W.vox * 1.8; if (x.sameGenre && l[i - 2].genre === s.genre) c += W.genre * 1.6; }
      });
      c -= sets[k].reduce((a, s) => a + sc.get(s.id), 0);
    }
    // across set breaks: a long break absorbs retunes and swaps; a short or missing one doesn't
    for (let k = 0; k < N - 1; k++) { const a = all[k], b = all[k + 1], f = gap(brk(k)); if (a.length && b.length && f) c += flowCost(changes(a[a.length - 1], b[0]), f); }
    return c;
  };
  let cur = cost(), best = cur, bestSets = sets.map(l => l.slice());
  const iters = 24000;
  for (let it = 0; it < iters; it++) {
    const T = 4 * Math.pow(0.012, it / iters);
    const r = rand(); let undo;
    const ka = Math.floor(rand() * N), la = sets[ka];
    if (r < 0.55) {                                    // swap two songs (any sets)
      const kb = Math.floor(rand() * N), lb = sets[kb]; if (!la.length || !lb.length) continue;
      const a = Math.floor(rand() * la.length), b = Math.floor(rand() * lb.length); if (ka === kb && a === b) continue;
      [la[a], lb[b]] = [lb[b], la[a]]; undo = () => { [la[a], lb[b]] = [lb[b], la[a]]; };
    } else if (r < 0.8) {                              // move a song to another spot
      if (!la.length) continue; const kb = Math.floor(rand() * N), lb = sets[kb];
      const a = Math.floor(rand() * la.length); const [s] = la.splice(a, 1); const b = Math.floor(rand() * (lb.length + 1)); lb.splice(b, 0, s);
      undo = () => { lb.splice(b, 1); la.splice(a, 0, s); };
    } else {                                           // trade a chosen song for one on the bench
      if (!la.length || !bench.length) continue; const a = Math.floor(rand() * la.length), b = Math.floor(rand() * bench.length);
      [la[a], bench[b]] = [bench[b], la[a]]; undo = () => { [la[a], bench[b]] = [bench[b], la[a]]; };
    }
    const nc = cost();
    if (nc <= cur || rand() < Math.exp((cur - nc) / T)) { cur = nc; if (nc < best) { best = nc; bestSets = sets.map(l => l.slice()); } } else undo();
  }
  bestSets.forEach((l, k) => sets[k] = l);
  // polish: try each flagged opener/closer at the very start or end of every set (by moving it, or swapping with the song there)
  if (OC) {
    const locate = s => { for (let k = 0; k < N; k++) { const i = sets[k].indexOf(s); if (i >= 0) return [k, i]; } return null; };
    for (let pass = 0; pass < 4; pass++) {
      let improved = false;
      for (const s of sets.flat().filter(x => x.is_opener || x.is_closer)) {
        const at = locate(s); if (!at) continue; const [ka, a] = at; let bestC = cost(), best = null;
        for (let kb = 0; kb < N; kb++) {
          const lb = sets[kb], la = sets[ka];
          for (const where of ['start', 'end']) {
            la.splice(a, 1); const p = where === 'start' ? 0 : lb.length; lb.splice(p, 0, s);                // move
            const c1 = cost(); if (c1 < bestC - 1e-9) { bestC = c1; best = { mv: [kb, p] }; }
            lb.splice(p, 1); la.splice(a, 0, s);
            const q = where === 'start' ? 0 : lb.length - 1; if (lb.length && !(kb === ka && q === a)) {          // swap
              const o = lb[q]; if (kb === ka) { [la[a], la[q]] = [la[q], la[a]]; } else { la[a] = o; lb[q] = s; }
              const c2 = cost(); if (c2 < bestC - 1e-9) { bestC = c2; best = { sw: [kb, q] }; }
              if (kb === ka) { [la[a], la[q]] = [la[q], la[a]]; } else { la[a] = s; lb[q] = o; }
            }
          }
        }
        if (best && best.mv) { sets[ka].splice(a, 1); sets[best.mv[0]].splice(best.mv[1], 0, s); improved = true; }
        else if (best && best.sw) { const [kb, q] = best.sw, o = sets[kb][q]; if (kb === ka) { [sets[ka][a], sets[ka][q]] = [sets[ka][q], sets[ka][a]]; } else { sets[ka][a] = o; sets[kb][q] = s; } improved = true; }
      }
      if (!improved) break;
    }
  }
  // a flagged opener must start the show and a flagged closer must end it (unless a pinned song holds that spot)
  if (OC) {
    const force = (isFlag, k, where) => {
      const l = sets[k]; if (!l.length || pins[k].length) return;
      const pos = where === 'start' ? 0 : l.length - 1; if (isFlag(l[pos])) return;
      let bestC = Infinity, pick = null;
      for (let kb = 0; kb < N; kb++) sets[kb].forEach((s, i) => {
        if (!isFlag(s)) return;
        const o = l[pos]; l[pos] = s; sets[kb][i] = o; if (kb === k && i === pos) return;
        const c = cost(); if (c < bestC) { bestC = c; pick = [kb, i]; }
        sets[kb][i] = s; l[pos] = o;
      });
      if (pick) { const [kb, i] = pick, s = sets[kb][i], o = l[pos]; l[pos] = s; sets[kb][i] = o; }
    };
    force(s => s.is_opener, 0, 'start'); force(s => s.is_closer, N - 1, 'end');
  }
  const result = Array.from({ length: N }, (_, k) => full(k));
  return { result, plan, flow: flowStats(result), durs: result.map(l => l.reduce((a, s) => a + songDur(s, buf), 0)), lastGig };
}
function optModal(g, prefs, res) {
  const pl = planOf(g, true), pv = S._opt && S._opt.plan || {};
  const pin = (k, l, v, extra = '') => `<label class="f">${l}<input class="in" data-optplan="${k}" type="${k === 'start_time' ? 'text' : 'number'}" ${k === 'start_time' ? '' : 'min="0" step="any"'} value="${esc(v ?? '')}" ${extra}></label>`;
  const chk = (path, label, on) => `<label class="check"><input type="checkbox" data-opt="${path}" ${on ? 'checked' : ''}> ${label}</label>`;
  const lvl = k => `<div class="row" style="justify-content:space-between;gap:8px"><span class="small">${WLAB[k]}</span><div class="chips">${[['0','Off'],['1','Low'],['2','Med'],['3','High']].map(([v, l]) => `<button class="chip ${String(prefs.w[k]) === v ? 'on' : ''}" data-act="opt-w" data-k="${k}" data-v="${v}">${l}</button>`).join('')}</div></div>`;
  const ros = res ? runOfShow(g, res.plan, Object.fromEntries(res.durs.map((d, i) => [i + 1, d]))) : [];
  return `<div class="scrim" data-act="modal-close"><div class="modal" data-stop style="width:min(980px,100%)">
    <div class="row"><h2 class="sec" style="margin:0">Optimize setlist</h2><span class="spacer"></span><button class="btn ghost" data-act="modal-close">✕</button></div>
    <div class="grid g2" style="margin-top:14px;align-items:start">
      <div class="stack">
        <div><div class="eyebrow" style="margin-bottom:6px">Show plan</div>
          <div class="fgrid" style="grid-template-columns:repeat(5,minmax(0,1fr))">${pin('start_time', 'Start', pv.start_time, 'placeholder="7pm"')}${pin('hours', 'Slot (hrs)', pv.hours)}${pin('set_count', 'Sets', pv.set_count)}${pin('break_count', 'Breaks', pv.break_count)}${pin('break_min', 'Break (min)', pv.break_min)}</div>
          <div class="small faint" style="margin-top:6px">${pl.slot != null ? `${hm(pl.music)} of music in a ${hm(pl.slot)} slot, ${pl.sets} set${pl.sets === 1 ? '' : 's'} of about ${hm(pl.perSet)}` : `No slot length — using ${hm(pl.perSet)} per set`}${pl.breaks ? `, ${pl.breaks} break${pl.breaks === 1 ? '' : 's'} of ${pl.breakMin} min` : ', no breaks'}. Retunes and instrument swaps are treated as free across a break of 10+ minutes.</div></div>
        <div><div class="eyebrow" style="margin-bottom:6px">Song pool</div><div class="row">${chk('pools.active', 'Active', prefs.pools.active)}${chk('pools.bench', 'Bench', prefs.pools.bench)}${chk('pools.learning', 'Learning', prefs.pools.learning)}${chk('pools.holiday', 'Holiday', prefs.pools.holiday)}</div></div>
        <div><div class="eyebrow" style="margin-bottom:6px">Energy shape</div><div class="chips">${Object.entries(SHAPES).map(([k, l]) => `<button class="chip ${prefs.shape === k ? 'on' : ''}" data-act="opt-shape" data-v="${k}">${l}</button>`).join('')}</div></div>
        <div class="stack" style="margin-top:4px">${Object.keys(WLAB).map(lvl).join('')}</div>
        ${chk('keepPinned', 'Keep pinned songs (⚑) where they are', prefs.keepPinned)}
        <label class="check">Encore songs after the last set <input class="in" type="number" min="0" max="4" step="1" data-optnum="encore" value="${esc(prefs.encore ?? 1)}" style="width:64px;margin-left:8px"></label>
        <div class="row"><button class="btn gold" data-act="opt-run">${res ? 'Try another version' : 'Build it'}</button><span class="small faint">Uses each song’s genre, energy, key, tuning, singer, parts, length and the band’s ratings.</span></div>
      </div>
      <div>${res ? `
        <div class="eyebrow" style="margin-bottom:6px">Proposed — ${res.result.reduce((a, l) => a + l.length, 0)} songs · ${res.plan.sets} set${res.plan.sets === 1 ? '' : 's'}${res.plan.breaks ? ' · ' + res.plan.breaks + ' break' + (res.plan.breaks === 1 ? '' : 's') + ' × ' + res.plan.breakMin + ' min' : ''}</div>
        ${flowChips(res.flow)}
        ${(() => { const short = res.plan.music - res.durs.reduce((a, b) => a + b, 0); return short > 3 ? `<p class="small" style="color:var(--gold);margin:8px 0 0">About ${hm(short)} short of the slot — the pool ran out of songs. Tick Bench (or Learning) to fill it, or plan on a longer break.</p>` : ''; })()}
        <div class="stack" style="margin-top:10px;max-height:52vh;overflow:auto">${res.result.map((l, k) => { const r = ros.find(x => x.kind === 'set' && x.n === k + 1); let prev = null; return `<div>
          <div class="row"><b style="color:var(--gold)">Set ${k + 1}</b><span class="small muted">${r && r.from ? r.from + '–' + r.to + ' · ' : ''}${hm(res.durs[k])} / ${hm(res.plan.perSet)}</span></div>
          ${l.map((s, i) => { const c = changes(prev, s); prev = s; return `<div class="small" style="display:grid;grid-template-columns:18px minmax(0,1fr) auto;gap:6px;padding:3px 0;border-top:1px solid var(--line-soft)"><span class="faint num">${i + 1}</span><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.title)} <span class="faint">${esc(s.song_key || '')}${s.capo ? '/' + s.capo : ''} · ${esc(s.lead_vox || '')}${c.inst.length ? ' · ⇄ ' + c.inst.map(x => esc(x.who)).join(', ') : ''}${c.tuning ? ' · retune' : ''}${i === 0 && s.is_opener ? ' · <b style="color:var(--gold)">opener</b>' : ''}${i === l.length - 1 && s.is_closer ? ' · <b style="color:var(--gold)">closer</b>' : ''}</span></span><span class="faint">${'▮'.repeat(s.energy || 0)}</span></div>`; }).join('')}
          ${k < res.result.length - 1 ? (k < res.plan.breaks ? `<div class="small muted" style="border-top:1px dashed var(--line);padding-top:6px;margin-top:4px">Break · ${res.plan.breakMin} min${(() => { const nx = r ? ros[ros.indexOf(r) + 1] : null; return nx && nx.kind === 'break' && nx.from ? ` · ${nx.from}–${nx.to}` : ''; })()}</div>` : `<div class="small" style="color:var(--gold);padding-top:6px">No break — runs straight into Set ${k + 2}</div>`) : ''}</div>`; }).join('')}</div>
        ${res.lastGig && prefs.w.fresh ? `<p class="small faint">Resting songs from ${esc(res.lastGig.title)} where it helps.</p>` : ''}
        <div class="row" style="margin-top:12px"><button class="btn gold" data-act="opt-apply">Use this setlist</button><span class="small faint">Replaces the unpinned songs on this gig.</span></div>`
      : '<div class="empty">Pick what matters and hit <b>Build it</b>. Nothing changes until you choose “Use this setlist”.</div>'}</div>
    </div></div></div>`;
}

const starsRO = v => [1, 2, 3, 4, 5].map(i => `<button tabindex="-1" class="${v && v >= i - .25 ? 'on' : ''}">★</button>`).join('');

/* ============================================================ songs */
function songsView() {
  const stats = songStats(), q = UI.songSearch.toLowerCase(), f = UI.songFilter;
  const sm = /^([bm])([\d.]+)$/.exec(UI.songStars || ''), starOk = s => !sm || (sm[1] === 'b' ? avgRating(s.id) : myRating(s.id)) >= parseFloat(sm[2]);
  let rows = S.songs.filter(s => (f === 'all' || s.status === f) && (!q || [s.title, s.artist, s.lead_vox, s.starter, s.genre].join(' ').toLowerCase().includes(q)) && (!UI.songNoChart || !chartFor(s.id)) && (!UI.songFlag || s['is_' + UI.songFlag]) && starOk(s));
  const key = UI.songSort, dir = UI.songSortDir === 'desc' ? -1 : 1;
  const val = s => ({ title: s.title, artist: s.artist || '', key: s.song_key || '', length: n0(s.length_min), bpm: n0(s.bpm), lead: s.lead_vox || '', mine: myRating(s.id), avg: avgRating(s.id) || 0, genre: (s.genre || '') + (9 - n0(s.energy)), plays: (stats[s.id] || {}).plays || 0, last: (stats[s.id] || {}).last || '', year: s.year || 0 }[key]);
  rows.sort((a, b) => { const x = val(a), y = val(b); return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * dir; });
  const counts = Object.fromEntries(['active','bench','learning','retired','holiday'].map(k => [k, S.songs.filter(s => s.status === k).length]));
  const th = (k, l, cls = '') => `<th data-act="song-sort" data-v="${k}" class="${cls}">${l}${UI.songSort === k ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
  const ms = activeMembers();
  return `${title('Songs')}
  <div class="row" style="margin-bottom:14px">
    <div class="chips">${[['active','Active'],['learning','Learning'],['bench','Bench'],['holiday','Holiday'],['retired','Retired'],['all','All']].map(([k, l]) => `<button class="chip ${f === k ? 'on' : ''}" data-act="song-filter" data-v="${k}">${l}${k !== 'all' ? ' ' + counts[k] : ''}</button>`).join('')}</div>
    <span class="spacer"></span><input class="in" id="songSearch" placeholder="Search title, artist, singer" value="${esc(UI.songSearch)}" style="width:220px"><label class="btn" style="cursor:pointer">Import charts<input type="file" accept="application/pdf" multiple hidden data-chart-import></label><button class="btn gold" data-act="song-new">+ Song</button>
  </div>
  <div class="row" style="margin:-4px 0 14px;gap:8px;flex-wrap:wrap">
    <button class="chip ${UI.songNoChart ? 'on' : ''}" data-act="song-nochart">No chart for me</button>
    ${[['opener', 'Good openers'], ['closer', 'Good closers'], ['encore', 'Good encores']].map(([k, l]) => `<button class="chip ${UI.songFlag === k ? 'on' : ''}" data-act="song-flag" data-v="${k}">${l}</button>`).join('')}
    <select class="in" data-song-stars style="width:auto;padding:5px 10px;font-size:13px"><option value="">Any rating</option>${[['b3', 'Band avg ★ 3+'], ['b3.5', 'Band avg ★ 3.5+'], ['b4', 'Band avg ★ 4+'], ['b4.5', 'Band avg ★ 4.5+'], ['m3', 'My stars ★ 3+'], ['m4', 'My stars ★ 4+'], ['m5', 'My stars ★ 5']].map(([v, l]) => `<option value="${v}" ${UI.songStars === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <span class="small muted">${rows.length} song${rows.length === 1 ? '' : 's'}</span>
  </div>
  <section class="panel"><div class="tbl-wrap"><table class="tbl">
    <thead><tr>${th('title', 'Song')}${th('key', 'Key')}${th('length', 'Len', 'r')}${th('bpm', 'BPM', 'r hide-sm')}${th('lead', 'Lead vox', 'hide-sm')}${th('genre', 'Genre', 'hide-sm')}${th('mine', 'Your rating')}${th('avg', 'Band', 'hide-sm')}${th('plays', 'Plays', 'r')}${th('last', 'Last played', 'hide-sm')}</tr></thead>
    <tbody>${rows.map(s => { const r = ratingsFor(s.id); return `<tr class="click" data-act="song-edit" data-id="${s.id}">
      <td><b>${esc(s.title)}</b>${s.is_opener ? ' <span class="pill st-confirmed">Opener</span>' : ''}${s.is_closer ? ' <span class="pill st-confirmed">Closer</span>' : ''}${s.is_encore ? ' <span class="pill st-confirmed">Encore</span>' : ''}${chartFor(s.id) ? ' <span class="small" style="color:var(--gold)" title="You have a PDF chart for this song">PDF</span>' : ''}<div class="small muted">${esc(s.artist || '')}${s.year ? ' · ' + s.year : ''}</div></td>
      <td class="num">${esc(s.song_key || '')}${s.capo ? `<div class="small muted">capo ${s.capo}</div>` : ''}</td>
      <td class="r num">${mins(s.length_min)}</td>
      <td class="r num hide-sm">${s.bpm || '<span class="faint">—</span>'}</td>
      <td class="hide-sm">${esc(s.lead_vox || '')}</td>
      <td class="hide-sm small">${esc(s.genre || '')}<div class="faint" title="Energy ${s.energy || '?'} of 5">${'▮'.repeat(s.energy || 0)}</div></td>
      <td><div class="stars" data-stop>${[1, 2, 3, 4, 5].map(i => `<button class="${myRating(s.id) >= i ? 'on' : ''}" data-act="rate" data-id="${s.id}" data-v="${i}" aria-label="${i} stars">★</button>`).join('')}</div></td>
      <td class="hide-sm" title="${r.map(x => (byId('members', x.member_id) || {}).name + ': ' + x.rating).join(', ')}"><span class="num">${avgRating(s.id) ? avgRating(s.id).toFixed(1) : '—'}</span> <span class="small faint">${r.length}/${ms.length}</span></td>
      <td class="r num">${(stats[s.id] || {}).plays || 0}</td>
      <td class="hide-sm small muted">${(stats[s.id] || {}).last ? mdY(stats[s.id].last) : '—'}</td></tr>`; }).join('')}</tbody>
  </table></div></section>`;
}
function songModal(s, edit) { return s && s.id && !edit ? songView(s) : songForm(s); }
function songView(s) {                                              // condensed read-only card: nothing here can be changed by accident
  const ms = activeMembers(), p = s.parts || {}, st = songStats()[s.id] || {};
  const kv = (l, v) => v ? `<div><div class="eyebrow">${l}</div><div class="num" style="font-size:16px;font-weight:600;margin-top:2px">${v}</div></div>` : '';
  const flags = [s.is_opener && 'Good opener', s.is_closer && 'Good closer', s.is_encore && 'Good encore'].filter(Boolean);
  const parts = ms.filter(m => p[m.name]).map(m => `<span><b>${esc(m.name)}</b> ${esc(p[m.name])}</span>`).join('');
  const rates = S.song_ratings.filter(x => x.song_id === s.id), avg = avgRating(s.id);
  return `<div class="scrim" data-act="modal-close"><div class="modal" data-stop data-songview>
    <div class="row" style="align-items:flex-start;gap:10px"><div class="grow"><h2 class="sec" style="margin:0;font-size:24px">${esc(s.title)}</h2><div class="muted">${esc(s.artist || '')}${s.year ? ' · ' + s.year : ''}</div></div><button class="btn gold" data-act="song-edit-mode" data-id="${s.id}">Edit</button><button class="btn ghost" data-act="modal-close">✕</button></div>
    <div class="row" style="margin:10px 0 4px;gap:6px;flex-wrap:wrap"><span class="pill" style="color:var(--muted)">${cap(s.status || 'active')}</span>${flags.map(f => `<span class="pill st-confirmed">${f}</span>`).join('')}</div>
    <div class="kv" style="margin-top:12px">${kv('Key', s.song_key ? esc(s.song_key) + (s.capo ? ` · capo ${s.capo}` : '') : '')}${kv('BPM', s.bpm ? String(s.bpm) : '')}${kv('Length', s.length_min ? mins(s.length_min) : '')}${kv('Tuning', esc(s.tuning || 'Standard'))}${kv('Starts it', esc(s.starter || ''))}${kv('Lead vox', esc(s.lead_vox || ''))}${kv('Genre', esc(s.genre || ''))}${kv('Energy', s.energy ? '▮'.repeat(s.energy) + ` <span class="small muted">${s.energy}/5</span>` : '')}${kv('Plays', String(st.plays || 0))}${kv('Last played', st.last ? mdY(st.last) : '—')}</div>
    ${s.comment ? `<p style="margin:14px 0 0;white-space:pre-wrap">${esc(s.comment)}</p>` : ''}
    ${parts ? `<h2 class="sec" style="margin-top:16px">Who plays what</h2><div class="row small" style="gap:6px 18px;flex-wrap:wrap">${parts}</div>` : ''}
    <h2 class="sec" style="margin-top:16px">Charts (PDF)</h2>${chartBox(s, true)}
    <h2 class="sec" style="margin-top:16px">Band ratings${avg ? ` <span class="small muted" style="font-weight:400">avg ${avg.toFixed(1)}</span>` : ''}</h2><div class="row small" style="gap:6px 18px;flex-wrap:wrap">${ms.map(m => { const r = rates.find(x => x.member_id === m.id); return `<span>${esc(m.name)} <span class="stars ro">${starsRO(r && r.rating)}</span></span>`; }).join('')}</div>
  </div></div>`;
}
function songForm(s) {
  const ms = activeMembers(), p = s.parts || {};
  const f = (k, l, type = 'text', cls = '') => `<label class="f ${cls}">${l}<input class="in" data-s="${k}" type="${type}" value="${esc(s[k] ?? '')}" ${type === 'number' ? 'step="any"' : ''}></label>`;
  return `<div class="scrim" data-act="modal-close"><div class="modal" data-stop>
    <div class="row"><h2 class="sec" style="margin:0">${s.id ? 'Edit song' : 'New song'}</h2><span class="spacer"></span><button class="btn ghost" data-act="modal-close">✕</button></div>
    <div class="fgrid" style="margin-top:14px">
      ${f('title', 'Title', 'text', 'w2')}${f('artist', 'Artist', 'text', 'w2')}
      <label class="f">Status<select class="in" data-s="status">${['active','learning','bench','holiday','retired'].map(x => `<option ${s.status === x ? 'selected' : ''} value="${x}">${cap(x)}</option>`).join('')}</select></label>
      ${f('song_key', 'Key')}${f('capo', 'Capo', 'number')}${f('bpm', 'BPM', 'number')}
      <label class="f">Length (m:ss)<input class="in" data-s="length_fmt" value="${s.length_min ? mins(s.length_min) : ''}" placeholder="3:45"></label>
      ${f('lead_vox', 'Lead vox', 'text', 'w2')}${f('starter', 'Starts it', 'text', 'w2')}
      <label class="f w2">Genre<input class="in" data-s="genre" list="genreList" value="${esc(s.genre || '')}"><datalist id="genreList">${[...new Set(S.songs.map(x => x.genre).filter(Boolean))].sort().map(x => `<option value="${esc(x)}">`).join('')}</datalist></label>
      <label class="f">Energy (1–5)<select class="in" data-s="energy"><option value="">—</option>${[1, 2, 3, 4, 5].map(n => `<option value="${n}" ${s.energy === n ? 'selected' : ''}>${n} ${['', 'mellow', 'easy', 'groove', 'lively', 'barn-burner'][n]}</option>`).join('')}</select></label>
      <label class="f">Tuning<select class="in" data-s="tuning">${['Standard', 'Half step down', 'Drop D', 'Other'].map(x => `<option ${(s.tuning || 'Standard') === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label class="f">Good opener?<span class="check" style="padding:9px 0"><input type="checkbox" data-s="is_opener" ${s.is_opener ? 'checked' : ''}> Works to open a set</span></label>
      <label class="f">Good closer?<span class="check" style="padding:9px 0"><input type="checkbox" data-s="is_closer" ${s.is_closer ? 'checked' : ''}> Works to close a set</span></label>
      <label class="f">Good encore?<span class="check" style="padding:9px 0"><input type="checkbox" data-s="is_encore" ${s.is_encore ? 'checked' : ''}> Works as an encore</span></label>
      ${f('year', 'Year', 'number')}${f('added_on', 'Learned', 'date')}
      <label class="f w4">Notes<input class="in" data-s="comment" value="${esc(s.comment || '')}" placeholder="e.g. tuning half step down"></label>
    </div>
    ${s.id ? `<h2 class="sec" style="margin-top:18px">Charts (PDF)</h2>${chartBox(s)}` : ''}
    <h2 class="sec" style="margin-top:18px">Who plays what</h2>
    <div class="fgrid">${ms.map(m => `<label class="f">${esc(m.name)}<input class="in" data-part="${esc(m.name)}" value="${esc(p[m.name] || '')}"></label>`).join('')}</div>
    ${s.id ? `<h2 class="sec" style="margin-top:18px">Band ratings</h2><div class="row small">${ms.map(m => { const r = S.song_ratings.find(x => x.song_id === s.id && x.member_id === m.id); return `<span>${esc(m.name)} <span class="stars ro">${starsRO(r && r.rating)}</span></span>`; }).join('')}</div>` : ''}
    <div class="row" style="margin-top:18px"><button class="btn gold" data-act="song-save" data-id="${s.id || ''}">Save song</button>${s.id ? `<button class="btn" data-act="song-view" data-id="${s.id}">Cancel</button>` : ''}<span class="spacer"></span>${s.id ? `<span id="songDelWrap"><button class="btn danger sm" data-act="song-del-ask">Delete</button></span>` : ''}</div>
  </div></div>`;
}

/* ============================================================ money */
function cumPanel(ttl, kind, t, yNow) {
  const past = g => kind === 'gig' ? isGig(g) && ['complete', 'confirmed'].includes(g.status) : g.kind === 'practice';
  const fut = g => kind === 'gig' ? isGig(g) && ['inquiry', 'quoted', 'confirmed'].includes(g.status) : g.kind === 'practice';
  const doy = d => { const x = pd(d); return Math.round((x - new Date(x.getFullYear(), 0, 1)) / 864e5) + 1; };
  const byDate = (a, b) => a.gig_date.localeCompare(b.gig_date);
  const dated = S.gigs.filter(g => g.gig_date && yearOf(g.gig_date) <= yNow);
  const years = [...new Set(dated.filter(g => past(g) || fut(g)).map(g => yearOf(g.gig_date)))]; if (!years.includes(yNow)) years.push(yNow);
  years.sort((a, b) => b - a);
  const series = years.map(y => {
    const inY = g => yearOf(g.gig_date) === y;
    return { y, done: dated.filter(g => inY(g) && past(g) && (y < yNow || g.gig_date <= t)).sort(byDate), todo: y === yNow ? dated.filter(g => inY(g) && fut(g) && g.gig_date > t).sort(byDate) : [] };
  });
  if (!series.some(s => s.done.length || s.todo.length)) return `<section class="panel"><h2 class="sec">${ttl}</h2><div class="empty">Nothing yet.</div></section>`;
  const maxV = Math.max(1, ...series.map(s => s.done.length + s.todo.length));
  const step = maxV <= 6 ? 1 : maxV <= 14 ? 2 : maxV <= 30 ? 5 : maxV <= 60 ? 10 : 20, top = Math.ceil(maxV / step) * step;
  const W = 640, H = 250, pl = 34, pr = 12, pt = 14, pb = 26;
  const x = d => pl + (W - pl - pr) * Math.min(d - 1, 365) / 365, yv = v => pt + (H - pt - pb) * (1 - v / top);
  const stair = (ev, d0, v0) => { let c = v0, p = ''; ev.forEach(g => { c++; p += `H${x(doy(g.gig_date)).toFixed(1)}V${yv(c).toFixed(1)}`; }); return { p, c }; };
  const pal = ['#ffbf43', '#8fb8e8', '#c9a7ff', '#f3eee4', '#7fd1b9', '#ff9ecb'], td = doy(t);
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;margin-top:10px" role="img" aria-label="${ttl}">`;
  for (let v = 0; v <= top; v += step) s += `<line x1="${pl}" x2="${W - pr}" y1="${yv(v)}" y2="${yv(v)}" stroke="rgba(243,238,228,.08)"/><text x="${pl - 6}" y="${yv(v) + 4}" text-anchor="end">${v}</text>`;
  for (let m = 0; m < 12; m++) { const a = doy(`${yNow}-${String(m + 1).padStart(2, '0')}-01`), b = m < 11 ? doy(`${yNow}-${String(m + 2).padStart(2, '0')}-01`) : 366; s += `<line x1="${x(a)}" x2="${x(a)}" y1="${H - pb}" y2="${H - pb + 4}" stroke="rgba(243,238,228,.25)"/><text x="${(x(a) + x(b)) / 2}" y="${H - 8}" text-anchor="middle">${MON[m]}</text>`; }
  s += `<line x1="${x(td)}" x2="${x(td)}" y1="${pt}" y2="${H - pb}" stroke="rgba(243,238,228,.3)" stroke-dasharray="2 4"/>`;
  series.slice().reverse().forEach(sr => {
    const c = pal[series.indexOf(sr) % pal.length], cur = sr.y === yNow, a = stair(sr.done, 1, 0);
    s += `<path d="M${x(1)} ${yv(0)}${a.p}H${x(cur ? td : 366)}" fill="none" stroke="${c}" stroke-width="${cur ? 3 : 2}" stroke-linejoin="round"><title>${sr.y}: ${sr.done.length}</title></path>`;
    if (cur && sr.todo.length) { const b = stair(sr.todo, td, a.c); s += `<path d="M${x(td)} ${yv(a.c)}${b.p}H${x(366)}" fill="none" stroke="${c}" stroke-width="3" stroke-dasharray="7 6" stroke-linejoin="round" opacity=".85"><title>${sr.y} with everything on the calendar: ${b.c}</title></path>`; }
  });
  s += '</svg>';
  const legend = series.map((sr, i) => `<span><i style="background:${pal[i % pal.length]}"></i>${sr.y} · ${sr.done.length}${sr.todo.length ? ` <span class="faint">→ ${sr.done.length + sr.todo.length} on calendar</span>` : ''}</span>`).join('');
  return `<section class="panel"><h2 class="sec" style="margin-bottom:6px">${ttl}</h2><div class="legend">${legend}</div>${s}<p class="small faint" style="margin:6px 0 0">Dashed line = everything still on the calendar${kind === 'gig' ? ', including leads' : ''}.</p></section>`;
}
function moneyView() {
  const yrSel = UI.moneyYear, t = todayIso();
  const played = S.gigs.filter(g => isGig(g) && g.status === 'complete');
  const years = [...new Set(played.map(g => yearOf(g.gig_date)))].filter(Boolean).sort();
  const inYr = g => yrSel === 'all' || String(yearOf(g.gig_date)) === yrSel;
  const rows = played.filter(inYr).sort((a, b) => b.gig_date.localeCompare(a.gig_date));
  const sum = f => rows.reduce((a, g) => a + f(g), 0);
  const expY = S.expenses.filter(e => yrSel === 'all' || String(yearOf(e.spent_on)) === yrSel);
  const expT = expY.reduce((a, e) => a + n0(e.amount), 0);
  const unlinkedSales = S.merch_sales.filter(s => !s.gig_id && (yrSel === 'all' || String(yearOf(s.sold_on)) === yrSel)).reduce((a, s) => a + n0(s.amount), 0);
  const G = sum(gross) + unlinkedSales, H = sum(g => n0(g.hours));
  const recv = S.gigs.filter(g => balanceDue(g) > 0).sort((a, b) => a.gig_date.localeCompare(b.gig_date));
  const byYear = years.map(y => { const r = played.filter(g => yearOf(g.gig_date) === y); return { y, pay: r.reduce((a, g) => a + pay(g), 0), tips: r.reduce((a, g) => a + n0(g.tips), 0), merch: r.reduce((a, g) => a + merchOf(g), 0), n: r.length, h: r.reduce((a, g) => a + n0(g.hours), 0) }; });
  const ms = activeMembers(), st = settings();
  return `${title('Metrics')}
  <div class="grid g2">${cumPanel('Cumulative gigs by year', 'gig', t, new Date().getFullYear())}${cumPanel('Cumulative practices by year', 'practice', t, new Date().getFullYear())}</div>
  <h2 class="sec2">Money</h2>
  <div class="row" style="margin-bottom:14px"><div class="chips">${['all', ...years.map(String)].map(y => `<button class="chip ${yrSel === y ? 'on' : ''}" data-act="money-year" data-v="${y}">${y === 'all' ? 'All years' : y}</button>`).join('')}</div></div>
  <div class="grid g4" style="margin-bottom:16px">
    ${kpi(money(G), 'Gross', `${rows.length} gigs played`)}
    ${kpi(H ? money(G / H) : '—', '$ per gig hour', `${+H.toFixed(1)} gig hours`)}
    ${kpi(money(expT, true), 'Expenses', `net ${money(G - expT)}`)}
    ${kpi(money(recv.reduce((a, g) => a + balanceDue(g), 0)), 'Still owed', recv.length + ' open balance' + (recv.length === 1 ? '' : 's'))}
  </div>
  <div class="split">
    <div class="stack">
      <section class="panel"><div class="row"><h2 class="sec" style="margin:0">Income by year</h2><span class="spacer"></span>
        <div class="legend"><span><i style="background:var(--gold)"></i>Income — pay, tips &amp; merch (left)</span><span><i style="background:#8fb8e8"></i>Gigs played (right)</span></div></div>
        ${yearChart(byYear)}</section>
      <section class="panel"><h2 class="sec">Gigs ${yrSel === 'all' ? '' : yrSel}</h2><div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>Date</th><th>Gig</th><th class="r">Pay</th><th class="r">Tips</th><th class="r">Merch</th><th class="r">Total</th><th class="r hide-sm">$/hr</th><th class="r hide-sm">Each</th></tr></thead>
        <tbody>${rows.map(g => { const ex = expensesFor(g.id); const fund = Math.max(0, gross(g) - ex) * n0(st.band_fund_pct) / 100; return `<tr class="click" data-href="#gig/${g.id}">
          <td class="num small">${mdY(g.gig_date)}</td><td>${esc(g.title)}</td>
          <td class="r num">${money(pay(g))}</td><td class="r num">${n0(g.tips) ? money(g.tips) : ''}</td><td class="r num">${merchOf(g) ? money(merchOf(g)) : ''}</td>
          <td class="r num"><b>${money(gross(g))}</b></td><td class="r num hide-sm">${g.hours ? money(gross(g) / g.hours) : ''}</td><td class="r num hide-sm">${ms.length ? money((gross(g) - ex - fund) / ms.length) : ''}</td></tr>`; }).join('')}</tbody>
        <tfoot><tr><td></td><td>Total</td><td class="r num">${money(sum(pay))}</td><td class="r num">${money(sum(g => n0(g.tips)))}</td><td class="r num">${money(sum(merchOf))}</td><td class="r num">${money(sum(gross))}</td><td class="hide-sm"></td><td class="hide-sm"></td></tr></tfoot>
      </table></div></section>
    </div>
    <div class="stack">
      <section class="panel"><h2 class="sec">Still owed</h2><div class="list">${recv.map(g => `<a class="li" href="#gig/${g.id}"><div class="grow"><div class="t">${esc(g.title)}</div><div class="s">${g.invoice_no ? 'Invoice ' + esc(g.invoice_no) + ' · ' + mdY(g.invoiced_on) : 'Not invoiced'} · played ${mdY(g.gig_date)}</div></div><div class="amt" style="color:var(--gold)">${money(balanceDue(g))}</div></a>`).join('') || '<div class="empty">Nobody owes the band money.</div>'}</div></section>
      <section class="panel"><div class="row"><h2 class="sec" style="margin:0">Expenses</h2><span class="spacer"></span><button class="btn sm gold" data-act="exp-new">+ Expense</button></div>
        <div class="list" style="margin-top:8px">${expY.sort((a, b) => b.spent_on.localeCompare(a.spent_on)).map(e => { const m = byId('members', e.paid_by); return `<div class="li" data-act="exp-edit" data-id="${e.id}"><div class="grow"><div class="t">${esc(e.note || e.category)}</div><div class="s">${mdY(e.spent_on)} · ${esc(e.category)}${m ? ' · paid by ' + esc(m.name) : ''}${e.paid_by && !e.reimbursed ? ' · <span style="color:var(--gold)">owed back</span>' : ''}</div></div><div class="amt">${money(e.amount, true)}</div></div>`; }).join('') || '<div class="empty">No expenses logged.</div>'}</div></section>
      <section class="panel"><div class="row"><h2 class="sec" style="margin:0">Merch</h2><span class="spacer"></span><button class="btn sm" data-act="merch-item-new">+ Item</button><button class="btn sm gold" data-act="sale-new">+ Sale</button></div>
        <table class="tbl" style="margin-top:8px"><thead><tr><th>Item</th><th class="r">Price</th><th class="r">Stock</th><th class="r">Sold</th></tr></thead><tbody>
        ${S.merch_items.filter(i => i.active).map(i => { const sold = S.merch_sales.filter(s => s.item_id === i.id).reduce((a, s) => a + n0(s.qty), 0); return `<tr class="click" data-act="merch-item-edit" data-id="${i.id}"><td>${esc(i.name)}</td><td class="r num">${money(i.price)}</td><td class="r num" style="${i.stock <= 3 ? 'color:var(--bad)' : ''}">${i.stock}</td><td class="r num">${sold}</td></tr>`; }).join('') || '<tr><td colspan="4" class="muted">Add shirts, hats, stickers… then log sales at the merch table.</td></tr>'}
        </tbody></table>
        ${S.merch_sales.length ? `<div class="small muted" style="margin-top:10px">Last sales: ${S.merch_sales.slice().sort((a, b) => b.sold_on.localeCompare(a.sold_on)).slice(0, 4).map(s => `${mdY(s.sold_on)} ${s.qty}× ${esc((byId('merch_items', s.item_id) || {}).name || 'item')} ${money(s.amount)}`).join(' · ')}</div>` : ''}
      </section>
    </div>
  </div>`;
}
function yearChart(data) {
  if (!data.length) return '<div class="empty">No played gigs yet.</div>';
  const inc = d => d.pay + d.tips + d.merch, BLUE = '#8fb8e8';
  const nice = m => { const e = Math.pow(10, Math.floor(Math.log10(m || 1))), f = m / e; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 4 ? 4 : f <= 5 ? 5 : 10) * e; };
  const topI = nice(Math.max(...data.map(inc), 1)), topN = Math.max(4, Math.ceil(Math.max(...data.map(d => d.n), 1) / 4) * 4);
  const W = 640, H = 270, pl = 58, pr = 40, pt = 22, pb = 30, n = data.length;
  const x = i => pl + (W - pl - pr) * (i + .5) / n, yI = v => pt + (H - pt - pb) * (1 - v / topI), yN = v => pt + (H - pt - pb) * (1 - v / topN);
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;margin-top:10px" role="img" aria-label="Income and gig count by year">`;
  for (let k = 0; k <= 4; k++) { const y = pt + (H - pt - pb) * (1 - k / 4);
    s += `<line x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}" stroke="rgba(243,238,228,.08)"/><text x="${pl - 7}" y="${y + 4}" text-anchor="end" style="fill:var(--gold)">${money(topI * k / 4, true)}</text><text x="${W - pr + 7}" y="${y + 4}" style="fill:${BLUE}">${+(topN * k / 4).toFixed(1)}</text>`; }
  s += `<text x="${pl - 7}" y="10" text-anchor="end" style="fill:var(--gold);font-weight:700">Income</text><text x="${W - pr + 7}" y="10" style="fill:${BLUE};font-weight:700">Gigs</text>`;
  data.forEach((d, i) => { s += `<text x="${x(i)}" y="${H - 9}" text-anchor="middle">${d.y}</text>`; });
  const line = (f, c, dash) => `<polyline points="${data.map((d, i) => x(i).toFixed(1) + ',' + f(d).toFixed(1)).join(' ')}" fill="none" stroke="${c}" stroke-width="3" stroke-linejoin="round" ${dash ? 'stroke-dasharray="7 5"' : ''}/>`;
  s += line(d => yI(inc(d)), 'var(--gold)') + line(d => yN(d.n), BLUE, true);
  data.forEach((d, i) => {
    const yi = yI(inc(d)), yn = yN(d.n), nAbove = yn < yi, bottom = H - pb - 8;      // labels point away from each other; at an edge they slide to the side
    const lab = (cx, cy, dy, txt, c) => { const yy = cy + dy; return (yy > bottom || yy < pt + 4) ? `<text x="${cx + 11}" y="${cy + 4}" text-anchor="start" style="fill:${c};font-weight:700">${txt}</text>` : `<text x="${cx}" y="${yy}" text-anchor="middle" style="fill:${c};font-weight:700">${txt}</text>`; };
    s += `<circle cx="${x(i)}" cy="${yi}" r="5" fill="var(--gold)"><title>${d.y}: ${money(inc(d))} from ${d.n} gigs</title></circle>${lab(x(i), yi, nAbove ? 21 : -10, money(inc(d), true), 'var(--gold)')}`;
    s += `<rect x="${x(i) - 5}" y="${yn - 5}" width="10" height="10" fill="${BLUE}"><title>${d.y}: ${d.n} gigs</title></rect>${lab(x(i), yn, nAbove ? -10 : 21, d.n, BLUE)}`;
  });
  return s + '</svg>';
}
function expenseModal(e) {
  return `<div class="scrim" data-act="modal-close"><div class="modal" data-stop>
    <div class="row"><h2 class="sec" style="margin:0">${e.id ? 'Edit expense' : 'New expense'}</h2><span class="spacer"></span><button class="btn ghost" data-act="modal-close">✕</button></div>
    <div class="fgrid" style="margin-top:14px">
      <label class="f">Date<input class="in" type="date" data-x="spent_on" value="${esc(e.spent_on || todayIso())}"></label>
      <label class="f">Amount $<input class="in" type="number" step="any" data-x="amount" value="${esc(e.amount ?? '')}"></label>
      <label class="f w2">Category<select class="in" data-x="category">${['Gear','Cables & stands','Merch stock','Travel','Food','Printing','Fees','Other'].map(c => `<option ${e.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label class="f w4">What for<input class="in" data-x="note" value="${esc(e.note || '')}"></label>
      <label class="f w2">For gig<select class="in" data-x="gig_id"><option value="">— General —</option>${S.gigs.filter(isGig).filter(g => g.gig_date).sort((a, b) => b.gig_date.localeCompare(a.gig_date)).slice(0, 40).map(g => `<option value="${g.id}" ${e.gig_id === g.id ? 'selected' : ''}>${esc(g.title)} (${mdY(g.gig_date)})</option>`).join('')}</select></label>
      <label class="f">Paid by<select class="in" data-x="paid_by"><option value="">Band account</option>${activeMembers().map(m => `<option value="${m.id}" ${e.paid_by === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
      <label class="f">Paid back<span class="check" style="padding:9px 0"><input type="checkbox" data-x="reimbursed" ${e.reimbursed ? 'checked' : ''}> Reimbursed</span></label>
    </div>
    <div class="row" style="margin-top:18px"><button class="btn gold" data-act="exp-save" data-id="${e.id || ''}">Save</button><span class="spacer"></span>${e.id ? `<button class="btn danger sm" data-act="exp-del" data-id="${e.id}">Delete</button>` : ''}</div>
  </div></div>`;
}
function saleModal() {
  const recent = S.gigs.filter(g => isGig(g) && g.gig_date && g.gig_date <= todayIso() && days(g.gig_date, todayIso()) <= 1 && live(g)).sort((a, b) => b.gig_date.localeCompare(a.gig_date))[0];
  return `<div class="scrim" data-act="modal-close"><div class="modal" data-stop>
    <div class="row"><h2 class="sec" style="margin:0">Log merch sale</h2><span class="spacer"></span><button class="btn ghost" data-act="modal-close">✕</button></div>
    <div class="fgrid" style="margin-top:14px">
      <label class="f w2">Item<select class="in" data-x="item_id">${S.merch_items.filter(i => i.active).map(i => `<option value="${i.id}" data-price="${n0(i.price)}">${esc(i.name)} — ${money(i.price)}</option>`).join('')}</select></label>
      <label class="f">Qty<input class="in" type="number" data-x="qty" value="1" min="1"></label>
      <label class="f">Amount $<input class="in" type="number" step="any" data-x="amount" placeholder="auto"></label>
      <label class="f">Date<input class="in" type="date" data-x="sold_on" value="${todayIso()}"></label>
      <label class="f">Method<select class="in" data-x="method">${['Cash','Venmo','Card','Other'].map(m => `<option>${m}</option>`).join('')}</select></label>
      <label class="f w2">At gig<select class="in" data-x="gig_id"><option value="">— None —</option>${S.gigs.filter(isGig).filter(g => g.gig_date).sort((a, b) => b.gig_date.localeCompare(a.gig_date)).slice(0, 30).map(g => `<option value="${g.id}" ${recent && recent.id === g.id ? 'selected' : ''}>${esc(g.title)} (${mdY(g.gig_date)})</option>`).join('')}</select></label>
    </div>
    <p class="small faint">Stock goes down automatically. Sales tied to a gig add to that gig's merch total.</p>
    <div class="row" style="margin-top:12px"><button class="btn gold" data-act="sale-save">Save sale</button></div>
  </div></div>`;
}
function merchItemModal(i) {
  return `<div class="scrim" data-act="modal-close"><div class="modal" data-stop>
    <div class="row"><h2 class="sec" style="margin:0">${i.id ? 'Edit item' : 'New merch item'}</h2><span class="spacer"></span><button class="btn ghost" data-act="modal-close">✕</button></div>
    <div class="fgrid" style="margin-top:14px">
      <label class="f w2">Name<input class="in" data-x="name" value="${esc(i.name || '')}" placeholder="Rope logo tee — L"></label>
      <label class="f">Price $<input class="in" type="number" step="any" data-x="price" value="${esc(i.price ?? '')}"></label>
      <label class="f">Our cost $<input class="in" type="number" step="any" data-x="cost" value="${esc(i.cost ?? '')}"></label>
      <label class="f">In stock<input class="in" type="number" data-x="stock" value="${esc(i.stock ?? 0)}"></label>
      <label class="f">Listed<span class="check" style="padding:9px 0"><input type="checkbox" data-x="active" ${i.active !== false ? 'checked' : ''}> Active</span></label>
    </div>
    <div class="row" style="margin-top:18px"><button class="btn gold" data-act="merch-item-save" data-id="${i.id || ''}">Save</button></div>
  </div></div>`;
}

/* ============================================================ settings / band */
function prefsView() {
  const st = settings(), ms = S.members.slice().sort((a, b) => a.sort - b.sort), mgr = isMgr();
  return `${title('Prefs')}
  <section class="panel" style="margin-bottom:18px;max-width:620px"><h2 class="sec">My preferences</h2>
    <label class="check" style="align-items:flex-start"><input type="checkbox" data-act="toggle-cb" ${UI.cb ? 'checked' : ''}><span><b>Colorblind-friendly mode</b><div class="small muted" style="margin-top:2px">Swaps red/green cues for blue/orange and adds shapes and labels so color is never the only signal. Saved on this device.</div></span></label>
    <div class="small faint" style="margin-top:14px">App version ${APP_V} · <a href="#" data-act="app-refresh">Update app files now</a></div>
    <label class="f" style="margin-top:14px;max-width:320px">Header position (iPad)<select class="in" data-hdr>${[[10, 'Snug'], [32, 'Medium'], [56, 'Low'], [80, 'Lowest']].map(([v, l]) => `<option value="${v}" ${(UI.hdr != null ? UI.hdr : 56) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="f" style="margin-top:14px;max-width:320px">Footer position (iPad)<select class="in" data-ftr>${[[0, 'Lowest'], [6, 'Low'], [14, 'Medium'], [24, 'High'], [34, 'Highest']].map(([v, l]) => `<option value="${v}" ${(UI.fpx != null ? UI.fpx : 14) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="f" style="margin-top:14px;max-width:320px">Text size<select class="in" data-text-size><option value="auto" ${UI.tz == null ? 'selected' : ''}>Auto (a bit larger on iPad)</option><option value="1" ${UI.tz === 1 ? 'selected' : ''}>Normal</option><option value="1.12" ${UI.tz === 1.12 ? 'selected' : ''}>Large</option><option value="1.25" ${UI.tz === 1.25 ? 'selected' : ''}>Extra large</option></select></label>
    ${(() => { if (!S.me) return ''; const cur = S.chart_defaults.find(d => d.member_id === S.me.id), ids = new Set(S.song_charts.filter(c => c.member_id !== S.me.id).map(c => c.member_id)); if (cur) ids.add(cur.use_member_id); const mine = S.song_charts.filter(c => c.member_id === S.me.id).length;
      return `<label class="f" style="margin-top:14px">When I don’t have my own chart for a song, use…<select class="in" data-chart-default><option value="">Nobody’s (leave it blank)</option>${[...ids].map(id => `<option value="${id}" ${cur && cur.use_member_id === id ? 'selected' : ''}>${esc((byId('members', id) || {}).name || 'Bandmate')}’s chart</option>`).join('')}</select></label><div class="small muted" style="margin-top:4px">You have ${mine} chart${mine === 1 ? '' : 's'} of your own. You can still pick a different chart song by song from the song’s page.</div>`; })()}
  </section>
  <section class="team" style="margin-bottom:18px">${ms.filter(m => m.active).map(m => `<div class="mate"><img src="${photo(m)}" alt="${esc(m.name)}"><div class="plate"><small>${esc(m.instrument || '')}</small>${esc(m.name)}</div></div>`).join('')}</section>
  <section class="panel" style="margin-top:18px;max-width:620px"><h2 class="sec">Page-turner pedal</h2>
    <div class="f" style="max-width:560px">
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:6px"><button class="btn sm" data-act="ped-learn" data-v="next">Teach “next”</button><button class="btn sm" data-act="ped-learn" data-v="prev">Teach “previous”</button><button class="btn sm ghost" data-act="ped-reset">Reset</button></div>
      <div class="small muted" id="pedStatus" style="margin-top:8px">Press a pedal switch — everything the iPad receives shows below. If nothing appears, the iPad isn’t getting anything from it (check the pedal’s mode and pairing).${UI.ped && (UI.ped.next || []).length ? ` Learned: next = ${esc(UI.ped.next[0].k)}${(UI.ped.prev || []).length ? ', previous = ' + esc(UI.ped.prev[0].k) : ''}.` : ''}</div>
      <input id="pedFocus" class="in" readonly inputmode="none" autocomplete="off" placeholder="① Tap here, then press the pedal" style="margin-top:8px;max-width:340px">
      <pre id="pedLog" class="small" style="margin:6px 0 0;padding:8px 10px;background:rgba(243,238,228,.05);border-radius:8px;min-height:3.4em;white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace">${esc((S._pedLines || []).join('\n'))}</pre>
      <label class="check" style="margin-top:10px;align-items:flex-start"><input type="checkbox" data-media-mode ${UI.media ? 'checked' : ''}><span>My pedal is in <b>music-control mode</b> (next / previous track)<div class="small muted">Gig mode plays a silent sound so the iPad passes those buttons to the app. Turn on only if your pedal sends music controls.</div></span></label>
      <div class="row" style="margin-top:6px"><button class="btn sm" data-act="ped-media-test">Test music-control buttons</button></div></div>
  </section>`;
}
function adminView() {
  const st = settings(), ms = S.members.slice().sort((a, b) => a.sort - b.sort), mgr = isMgr();
  const f = (k, l, cls = '', type = 'text') => `<label class="f ${cls}">${l}<input class="in" data-st="${k}" type="${type}" value="${esc(st[k] ?? '')}"></label>`;
  return `${title('Admin')}
  <div class="grid g2">
    <section class="panel"><div class="row"><h2 class="sec" style="margin:0">Clients</h2><span class="spacer"></span><button class="btn sm gold" data-act="client-new">+ New client</button></div>
      <div class="list" style="margin-top:8px">${S.clients.slice().sort((a, b) => (a.org || a.contact_name || '').localeCompare(b.org || b.contact_name || '')).map(c => { const n = S.gigs.filter(g => g.client_id === c.id).length; return `<div class="li" data-act="client-edit" data-id="${c.id}" style="cursor:pointer"><div class="grow"><div class="t">${esc(c.org || c.contact_name)}</div><div class="s">${esc([c.contact_name, c.email, c.phone].filter(Boolean).join(' · '))}</div></div><span class="small muted">${esc(c.code || '')} · ${n} gig${n === 1 ? '' : 's'}</span></div>`; }).join('') || '<div class="empty">No clients yet — add one here, or from a gig.</div>'}</div>
    </section>
    <section class="panel"><h2 class="sec">Quotes & invoices</h2>
      <div class="fgrid">
        ${f('band_email', 'Band email', 'w2')}${f('default_terms', 'Terms')}${f('quote_valid_days', 'Quote good for (days)', '', 'number')}
        ${f('default_description', 'Description', 'w4')}
        ${f('default_line_item', 'Line item — {hours} fills in', 'w4')}
        ${f('default_line_note', 'Line note', 'w4')}
        ${f('instagram', 'Instagram', 'w2')}${f('youtube', 'YouTube', 'w2')}
      </div>
      <h2 class="sec" style="margin-top:18px">Reminders & sets</h2>
      <div class="fgrid">
        ${f('remind_setlist_days', 'Setlist due (days before)', 'w2', 'number')}${f('remind_quote_days', 'Quote follow-up (days)', 'w2', 'number')}
        ${f('set_target_min', 'Set length target (min)', 'w2', 'number')}${f('song_buffer_sec', 'Between songs (sec)', 'w2', 'number')}
        ${f('band_fund_pct', 'Band fund % of each gig', 'w2', 'number')}
      </div>
      <div class="row" style="margin-top:12px"><button class="btn gold sm" data-act="save-settings">Save settings</button></div>
    </section>
    <section class="panel"><h2 class="sec">Pay-to on invoices</h2>
      ${S.payees.map(p => `<div class="fgrid" style="margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--line-soft)">
        <label class="f w2">Name<input class="in" data-p="${p.id}" data-k="name" value="${esc(p.name || '')}"></label>
        <label class="f w2">Org / memo<input class="in" data-p="${p.id}" data-k="org" value="${esc(p.org || '')}"></label>
        <label class="f w2">Street<input class="in" data-p="${p.id}" data-k="address1" value="${esc(p.address1 || '')}"></label>
        <label class="f w2">City, ST ZIP<input class="in" data-p="${p.id}" data-k="city_state_zip" value="${esc(p.city_state_zip || '')}"></label>
        <label class="f w4">Check note<input class="in" data-p="${p.id}" data-k="check_note" value="${esc(p.check_note || '')}"></label></div>`).join('')}
      <div class="row"><button class="btn gold sm" data-act="save-payees">Save pay-to</button><button class="btn sm" data-act="payee-new">+ Pay-to</button></div>
    </section>
    ${mgr ? `<section class="panel" style="grid-column:1/-1"><h2 class="sec">Roster & logins</h2>
      <p class="small muted" style="margin-top:0">Each person signs in with the email listed here. Create their login in Supabase → Authentication → Users (same email).</p>
      <table class="tbl"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Linked</th></tr></thead><tbody>
      ${ms.map(m => `<tr><td><b>${esc(m.name)}</b><div class="small muted">${esc(m.instrument || '')}</div></td>
        <td><input class="in" data-m="${m.id}" data-k="email" value="${esc(m.email || '')}" placeholder="email"></td>
        <td><select class="in" style="min-width:112px" data-m="${m.id}" data-k="role"><option ${m.role === 'member' ? 'selected' : ''}>member</option><option ${m.role === 'manager' ? 'selected' : ''}>manager</option></select></td>
        <td class="small">${m.user_id ? '<span style="color:var(--ok)">Yes</span>' : '<span class="faint">Not yet</span>'}</td></tr>`).join('')}
      </tbody></table>
      <div class="row" style="margin-top:12px"><button class="btn gold sm" data-act="save-members">Save roster</button></div>
    </section>` : ''}
  </div>`;
}

/* ============================================================ PDFs */
let LOGO_DATA = null;
async function logoData() {
  if (LOGO_DATA) return LOGO_DATA;
  const img = new Image(); img.src = 'assets/logo.png'; await img.decode();
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0); LOGO_DATA = { url: c.toDataURL('image/png'), w: c.width, h: c.height };
  return LOGO_DATA;
}
const slug = s => (s || 'GIG').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 14) || 'GIG';
async function makeDoc(g, kind) {
  const { jsPDF } = window.jspdf; const st = settings(); const c = clientOf(g) || {}; const p = payeeOf(g);
  const doc = new jsPDF({ unit: 'pt', format: 'letter' }); const W = 612, M = 48;
  const gold = [255, 191, 67], ink = [20, 14, 2], grey = [110, 103, 86];
  // header band — press-kit dark with the rope logo
  doc.setFillColor(...ink); doc.rect(0, 0, W, 118, 'F');
  const L = await logoData(); const lh = 84; doc.addImage(L.url, 'PNG', M, 17, lh * L.w / L.h, lh);
  doc.setFont('helvetica', 'bold'); doc.setTextColor(...gold); doc.setFontSize(34);
  doc.text(kind === 'invoice' ? 'INVOICE' : 'QUOTE', W - M, 70, { align: 'right', charSpace: 2 });
  doc.setFontSize(9); doc.setTextColor(243, 238, 228); doc.setFont('helvetica', 'normal');
  doc.text([st.band_email || '', [st.instagram, st.youtube].filter(Boolean).join('  ·  ')].filter(Boolean), W - M, 90, { align: 'right' });
  doc.setFillColor(...gold); doc.rect(0, 118, W, 4, 'F');

  // meta row
  const code = (c.code || slug(c.org || c.contact_name || g.title));
  let number, dated;
  if (kind === 'invoice') { number = g.invoice_no || `${code}_${(g.gig_date || todayIso()).slice(0, 7).replace('-', '')}`; dated = g.invoiced_on || todayIso(); }
  else { number = g.quote_no || `${code}_${todayIso().slice(0, 7).replace('-', '')}`; dated = g.quoted_on || todayIso(); }
  let y = 158; doc.setTextColor(...ink);
  const meta = kind === 'invoice'
    ? [['Invoice Number', number], ['Invoice Date', mdY(dated)], ['Activity Date', mdY(g.gig_date)], ['Terms', st.default_terms || 'NET30']]
    : [['Quote Number', number], ['Date', mdY(dated)], ['Event Date', g.gig_date ? mdY(g.gig_date) : 'TBD'], ['Terms', st.default_terms || 'NET30']];
  const cw = (W - 2 * M) / meta.length;
  meta.forEach(([l, v], i) => { doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...grey); doc.text(l.toUpperCase(), M + i * cw, y, { charSpace: .6 }); doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(...ink); doc.text(String(v), M + i * cw, y + 16); });
  y += 50;
  // parties
  const party = (label, lines, x) => { doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...grey); doc.text(label, x, y, { charSpace: .6 }); doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5); doc.setTextColor(...ink); doc.text(lines.filter(Boolean), x, y + 16, { lineHeightFactor: 1.35 }); };
  party('ISSUED TO', [c.contact_name, c.org, c.address1, c.city_state_zip], M);
  party('PAY TO', [p.name, kind === 'quote' && p.org ? 'Memo: ' + p.org : p.org, p.address1, p.city_state_zip], W / 2 + 10);
  y += 92;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text('Description: ', M, y); doc.setFont('helvetica', 'normal'); doc.text(st.default_description || 'A night full of awesome music!', M + 66, y);
  y += 22;
  // line table
  const amt = n0(g.quote);
  doc.setFillColor(...ink); doc.rect(M, y, W - 2 * M, 22, 'F');
  doc.setTextColor(...gold); doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5);
  const cx = [M + 10, W - M - 210, W - M - 110, W - M - 10];
  doc.text('DESCRIPTION', cx[0], y + 14.5, { charSpace: .6 }); doc.text('UNIT PRICE', cx[1], y + 14.5, { align: 'right' }); doc.text('QTY', cx[2], y + 14.5, { align: 'right' }); doc.text('TOTAL ($)', cx[3], y + 14.5, { align: 'right' });
  y += 40; doc.setTextColor(...ink); doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5);
  const li = doc.splitTextToSize(lineItem(g), cx[1] - cx[0] - 80);
  doc.text(li, cx[0], y); doc.text(money2(amt), cx[1], y, { align: 'right' }); doc.text('1', cx[2], y, { align: 'right' }); doc.text(money2(amt), cx[3], y, { align: 'right' });
  y += 14 * li.length + 4;
  doc.setFontSize(9.5); doc.setTextColor(...grey);
  const notes = [];
  if (st.default_line_note) notes.push(st.default_line_note);
  if (kind === 'quote' && (g.gig_date || g.venue)) notes.push(`Date: ${g.gig_date ? mdY(g.gig_date) : 'TBD'}${g.start_time ? ' at ' + g.start_time : ''}${g.venue ? ' — ' + g.venue : ''}`);
  if (kind === 'quote') notes.push(n0(g.deposit_amount) ? `Deposit: ${money(g.deposit_amount, true)} to hold the date` : 'Deposit waived');
  notes.forEach(n => { doc.text(n, cx[0], y); y += 14; });
  y += 6; doc.setDrawColor(220, 214, 200); doc.line(M, y, W - M, y); y += 20;
  // totals
  const tot = (l, v, bold) => { doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(bold ? 12 : 10.5); doc.setTextColor(...ink); doc.text(l, cx[2], y, { align: 'right' }); doc.text(v, cx[3], y, { align: 'right' }); y += bold ? 22 : 17; };
  tot('Subtotal', money2(amt)); tot('Tax', '0.00%');
  const dep = kind === 'invoice' ? depositIn(g) : 0; const paid = kind === 'invoice' ? n0(g.paid) : 0;
  if (dep) tot('Deposit received', '-' + money2(dep));
  if (paid) tot('Payments received', '-' + money2(paid));
  doc.setFillColor(...gold); doc.rect(cx[2] - 90, y - 15, cx[3] - cx[2] + 100, 26, 'F');
  tot(kind === 'invoice' && (dep || paid) ? 'Balance Due' : 'Total', '$' + money2(amt - dep - paid), true);
  y += 18;
  if (kind === 'quote') {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...grey); doc.text('SIGNATURES', M, y, { charSpace: .6 }); y += 30;
    doc.setDrawColor(...ink); doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...ink);
    [['PARTY:', 'DATE:'], ['BAND:', 'DATE:']].forEach(([a, b]) => { doc.text(a, M, y); doc.line(M + 42, y + 2, M + 300, y + 2); doc.text(b, M + 320, y); doc.line(M + 352, y + 2, W - M, y + 2); y += 30; });
  }
  y = Math.max(y + 6, 640);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...ink);
  const foot = [p.check_note, `For questions, please email us at ${st.band_email || ''}`].filter(Boolean);
  doc.text(foot, M, y, { lineHeightFactor: 1.4 }); y += 14 * foot.length + 14;
  doc.text(['Respectfully,', (S.members.find(m => m.role === 'manager') || {}).name === 'Tyler' ? 'Tyler Eckert' : (S.me && S.me.name) || 'Trailer Folk', st.band_name || 'Trailer Folk'], M, y, { lineHeightFactor: 1.4 });
  if (kind === 'quote') { doc.setTextColor(...grey); doc.setFontSize(9); doc.text(`This quote is good for ${st.quote_valid_days || 30} days`, W - M, y + 30, { align: 'right' }); }
  doc.setFillColor(...ink); doc.rect(0, 772, W, 20, 'F');
  return { doc, number, dated };
}
async function pdfFor(g, kind) {
  if (!n0(g.quote)) { toast('Add a quote amount first.', true); return; }
  const { doc, number, dated } = await makeDoc(g, kind);
  const fname = `Trailer Folk ${kind === 'invoice' ? 'Invoice' : 'Quote'} - ${number}.pdf`;
  download(fname, doc.output('blob'));
  const patch = kind === 'invoice' ? { invoice_no: number, invoiced_on: dated } : { quote_no: number, quoted_on: dated, status: g.status === 'inquiry' ? 'quoted' : g.status };
  if (Object.entries(patch).some(([k, v]) => g[k] !== v)) await guard(() => save('gigs', { ...g, ...patch }));
  render();
}
async function stagePdf(g) {
  const { jsPDF } = window.jspdf; const items = itemsOf(g.id).filter(i => i.played);   // g: slCtx()
  const doc = new jsPDF({ unit: 'pt', format: 'letter' }); const W = 612, M = 40;
  const sets = [...new Set(items.map(i => i.set_no))];
  const plan = planOf(g); const ros = runOfShow(g, plan, Object.fromEntries(sets.map(n => [n, items.filter(i => i.set_no === n).reduce((a, i) => a + songDur(byId('songs', i.song_id), plan.buf), 0)])));
  sets.forEach((n, si) => {
    if (si) doc.addPage();
    doc.setFillColor(20, 14, 2); doc.rect(0, 0, W, 64, 'F');
    doc.setTextColor(255, 191, 67); doc.setFont('helvetica', 'bold'); doc.setFontSize(22); doc.text(`SET ${n}`, M, 42); const rr = ros.find(r => r.kind === 'set' && r.n === n); if (rr && rr.from) { doc.setFontSize(11); doc.text(`${rr.from} - ${rr.to}`, M + 80, 41); }
    doc.setFontSize(10); doc.setTextColor(243, 238, 228); doc.setFont('helvetica', 'normal'); doc.text(`${g.title}${g.gig_date ? ' · ' + fmtDate(g.gig_date) : ''}`, W - M, 40, { align: 'right' });
    const its = items.filter(i => i.set_no === n); const nNotes = its.filter(i => i.note).length; const rowH = Math.min(36, (792 - 100) / Math.max(its.length + nNotes * .6, 1));
    let y = 64 + rowH;
    its.forEach((i, k) => {
      const s = byId('songs', i.song_id) || {};
      doc.setTextColor(150, 140, 120); doc.setFontSize(Math.min(14, rowH * .4)); doc.text(String(k + 1), M + 14, y, { align: 'right' });
      doc.setTextColor(10, 8, 2); doc.setFont('helvetica', 'bold'); doc.setFontSize(Math.min(22, rowH * .62)); doc.text(s.title || '', M + 24, y);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(Math.min(14, rowH * .4)); doc.setTextColor(90, 80, 60);
      doc.text(`${songLabel(s)}${s.lead_vox ? '   ' + s.lead_vox : ''}`, W - M, y, { align: 'right' });
      if (i.note) { doc.setFont('helvetica', 'italic'); doc.setFontSize(Math.min(12, rowH * .34)); doc.setTextColor(120, 96, 30); doc.text('» ' + i.note, M + 24, y + rowH * .5, { maxWidth: W - 2 * M - 24 }); y += rowH * .6; }
      y += rowH;
    });
  });
  download(`Setlist - ${g.title}${g.gig_date ? ' - ' + g.gig_date : ''}.pdf`, doc.output('blob'));
}

/* ============================================================ ICS */
function icsEsc(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n'); }
function parseTime(t) { const m = String(t || '').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i); if (!m) return null; let h = +m[1]; const mi = +(m[2] || 0); const ap = (m[3] || '').toLowerCase(); if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0; if (!ap && h < 9) h += 12; return [h, mi]; }
const addDayStr = d => iso(new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6) + 1)).replace(/-/g, '');
const icsStamp = (d, m) => { let day = d; if (m >= 1440) { m -= 1440; day = addDayStr(d); } return `${day}T${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}00`; };
// Gigs: start at load-in (else start time), end one hour after the show ends. Practices: start → end as entered.
function eventSpan(g) {
  const mm = a => a[0] * 60 + a[1];
  const st = parseTime(g.start_time), en = parseTime(g.end_time), li = g.kind === 'gig' ? parseTime(g.load_in_time) : null;
  const first = li || st; if (!first) return null;
  const start = mm(first); let end;
  if (en) end = mm(en); else if (st) end = mm(st) + (g.hours ? n0(g.hours) * 60 : 120); else end = start + 120;
  if (end <= start) end += 1440;
  if (g.kind === 'gig') end += 60;
  return [start, end];
}
function icsFor(list) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Trailer Folk//Band HQ//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Trailer Folk', 'X-WR-TIMEZONE:America/Chicago'];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  list.filter(g => g.gig_date).forEach(g => {
    const d = g.gig_date.replace(/-/g, ''); const sp = eventSpan(g);
    lines.push('BEGIN:VEVENT', `UID:${g.id}@band.eckerthaus.com`, `DTSTAMP:${stamp}`);
    if (sp) lines.push(`DTSTART;TZID=America/Chicago:${icsStamp(d, sp[0])}`, `DTEND;TZID=America/Chicago:${icsStamp(d, sp[1])}`);
    else { const nx = addDayStr(d); lines.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${nx}`); }
    lines.push(`SUMMARY:${icsEsc(g.kind === 'practice' ? 'Trailer Folk practice' : 'Trailer Folk: ' + g.title + (g.status !== 'confirmed' && g.status !== 'complete' ? ' (' + STATUS_LABEL[g.status] + ')' : ''))}`);
    if (g.venue || g.address) lines.push(`LOCATION:${icsEsc([g.venue, g.address].filter(Boolean).join(', '))}`);
    const times = g.kind === 'gig' ? [g.load_in_time ? 'Load-in: ' + g.load_in_time : '', g.start_time ? 'Start: ' + g.start_time : '', g.end_time ? 'End: ' + g.end_time : ''].filter(Boolean).join('\n') : '';
    lines.push(`DESCRIPTION:${icsEsc([times, g.notes || '', location.origin + location.pathname + '#gig/' + g.id].filter(Boolean).join('\n'))}`);
    lines.push('END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

/* ============================================================ email drafts */
function mailDraft(g, kind) {
  const st = settings(), c = clientOf(g) || {}, first = (c.contact_name || '').split(' ')[0] || 'there';
  const when = g.gig_date ? fmtDate(g.gig_date, true) : 'your date';
  const sign = `\n\nThanks!\n${S.me ? S.me.name : 'Tyler'}\nTrailer Folk\n${st.band_email || ''}`;
  const T = {
    quote: [`Trailer Folk quote — ${g.title}`, `Hi ${first},\n\nThanks for reaching out! We'd love to play ${when}${g.venue ? ' at ' + g.venue : ''}. The attached quote covers ${lineItem(g).toLowerCase()} for ${money(g.quote)}, including our sound and lighting.\n\n${n0(g.deposit_amount) ? `A ${money(g.deposit_amount)} deposit locks in the date.` : 'Just reply to confirm and we\'ll put you on the calendar.'} The quote is good for ${st.quote_valid_days || 30} days.`],
    deposit: [`Trailer Folk — deposit for ${g.gig_date ? mdY(g.gig_date) : 'your event'}`, `Hi ${first},\n\nQuick reminder that we're holding ${when} for you. A ${money(g.deposit_amount || 0)} deposit locks in the date — checks payable to ${payeeOf(g).name || 'Tyler Eckert'}, memo Trailer Folk.`],
    details: [`Trailer Folk — getting ready for ${g.title}`, `Hi ${first},\n\nWe're looking forward to ${when}! A few things to confirm:\n\n• Start time: ${g.start_time || '?'}${g.hours ? ' (' + g.hours + ' hours of music)' : ''}\n• ${g.load_in_time ? 'Load-in: ' + g.load_in_time + ' (we set up and soundcheck before guests arrive)' : "We'll arrive about 2 hours early to load in and soundcheck"}\n• We need a ~20' x 15' area and access to standard power near the stage\n• Venue address: ${g.address || g.venue || '?'}\n• Any must-play songs, first dance, or announcements?\n\nWe bring all sound and lighting.`],
    invoice: [`Trailer Folk invoice ${g.invoice_no || ''}`.trim(), `Hi ${first},\n\nThank you for having us${g.gig_date ? ' on ' + fmtDate(g.gig_date, true) : ''}! Attached is invoice ${g.invoice_no || ''} for ${money(balanceDue(g) || g.quote)}, due ${settings().default_terms || 'NET30'}. Checks payable to ${payeeOf(g).name || 'Tyler Eckert'}, memo Trailer Folk.`],
    thanks: [`Thank you from Trailer Folk`, `Hi ${first},\n\nWe got your payment — thank you! We had a blast at ${g.title}. If you have a minute, a quick review or tagging us (${st.instagram || '@trailer_folk'}) helps a ton. Hope to play for you again.`],
  }[kind];
  return { to: c.email || '', subject: T[0], body: T[1] + sign };
}
function mailModal(g, kind) {
  const m = mailDraft(g, kind);
  return `<div class="scrim" data-act="modal-close"><div class="modal mail" data-stop>
    <div class="row"><h2 class="sec" style="margin:0">Email draft</h2><span class="spacer"></span><button class="btn ghost" data-act="modal-close">✕</button></div>
    <p class="small muted">To: ${esc(m.to || '(add the client email on the gig page)')}<br>Subject: <b>${esc(m.subject)}</b></p>
    <pre id="mailBody">${esc(m.body)}</pre>
    <div class="row"><button class="btn gold" data-act="copy-mail">Copy text</button>
      <a class="btn" href="mailto:${encodeURIComponent(m.to)}?subject=${encodeURIComponent(m.subject)}&body=${encodeURIComponent(m.body)}">Open in mail app</a>
      ${['quote','invoice'].includes(kind) ? `<span class="small faint">Attach the ${kind} PDF from the gig page.</span>` : ''}</div>
  </div></div>`;
}
/* ============================================================ personal PDF charts */
const chartOf = (songId, memberId) => S.song_charts.find(c => c.song_id === songId && c.member_id === memberId) || null;
function chartFor(songId, memberId = S.me && S.me.id) {          // which PDF this member sees for a song
  if (!memberId) return null;
  const pref = S.chart_prefs.find(p => p.member_id === memberId && p.song_id === songId);
  if (pref) { const c = chartOf(songId, pref.use_member_id); if (c) return { chart: c, via: 'pick' }; }
  const mine = chartOf(songId, memberId); if (mine) return { chart: mine, via: 'own' };
  const d = S.chart_defaults.find(x => x.member_id === memberId);
  if (d) { const c = chartOf(songId, d.use_member_id); if (c) return { chart: c, via: 'default' }; }
  return null;
}
/* PDFs are kept on the device after the first open, so a weak venue connection can't take the charts away */
const idb = () => new Promise((res, rej) => { const r = indexedDB.open('tfhq-charts', 3); r.onupgradeneeded = () => { const db = r.result; ['pdf', 'photo', 'snap', 'marks'].forEach(n => { if (!db.objectStoreNames.contains(n)) db.createObjectStore(n); }); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function idbGet(store, key) { try { const db = await idb(); return await new Promise(res => { const q = db.transaction(store).objectStore(store).get(key); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); } catch { return null; } }
async function idbPut(store, key, val) { try { const db = await idb(); await new Promise(res => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(val, key); tx.oncomplete = tx.onerror = tx.onabort = () => res(); }); } catch {} }
async function idbClear() { try { const db = await idb(); await Promise.all(['pdf', 'photo', 'snap', 'marks'].map(s => new Promise(res => { const tx = db.transaction(s, 'readwrite'); tx.objectStore(s).clear(); tx.oncomplete = tx.onerror = tx.onabort = () => res(); }))); } catch {} }
async function idbEntries(store) { try { const db = await idb(); return await new Promise(res => { const out = []; const q = db.transaction(store).objectStore(store).openCursor(); q.onsuccess = () => { const c = q.result; if (c) { out.push([c.key, c.value]); c.continue(); } else res(out); }; q.onerror = () => res(out); }); } catch { return []; } }
const cacheGet = key => idbGet('pdf', key), cachePut = (key, buf) => idbPut('pdf', key, buf);
async function chartData(c) {
  const key = `${c.path}|${c.updated_at || c.created_at || ''}`;
  let buf = await cacheGet(key); if (buf) return buf;
  const blob = await api.downloadChart(c.path); buf = await blob.arrayBuffer(); cachePut(key, buf); return buf;
}
let pdfjsReady = null;
function loadPdfJs() {                                             // local copy first (pdf.min.js + pdf.worker.min.js next to index.html), then the CDN
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (pdfjsReady) return pdfjsReady;
  const add = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('PDF viewer failed to load')); document.head.appendChild(s); });
  const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  pdfjsReady = add('pdf.min.js?v=3.11.174').then(() => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js?v=3.11.174'; })
    .catch(() => add(CDN + 'pdf.min.js').then(() => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = CDN + 'pdf.worker.min.js'; }))
    .then(() => window.pdfjsLib);
  pdfjsReady.catch(() => { pdfjsReady = null; });
  return pdfjsReady;
}
async function uploadChart(songId, file) {
  if (!S.me) throw new Error('Your login isn’t on the band roster yet.');
  if (!/pdf/i.test(file.type) && !/\.pdf$/i.test(file.name)) throw new Error(`${file.name} isn’t a PDF`);
  if (file.size > 48 * 1024 * 1024) throw new Error(`${file.name} is over 48 MB`);
  const path = `${S.me.id}/${songId}.pdf`; await api.uploadChart(path, file);
  const cur = chartOf(songId, S.me.id);
  await save('song_charts', { ...(cur || { id: uuid(), song_id: songId, member_id: S.me.id }), path, filename: file.name, updated_at: new Date().toISOString() });
}
const normT = s => String(s || '').toLowerCase().replace(/\.pdf$/, '').replace(/[_\-.()\[\]]+/g, ' ').replace(/\b(chart|charts|chords?|lead ?sheet|lyrics|tab|capo \d+|key of [a-g][#b]?)\b/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
function matchSong(fileName) {
  const f = normT(fileName); let best = null, bs = 0;
  S.songs.forEach(s => {
    const t = normT(s.title); if (!t || !f) return; let sc = 0;
    if (f === t) sc = 1;
    else if (t.length >= 4 && (` ${f} `).includes(` ${t} `)) sc = .75 + .25 * t.length / f.length;
    else if (f.length >= 4 && (` ${t} `).includes(` ${f} `)) sc = .75 + .25 * f.length / t.length;
    else { const A = new Set(f.split(' ')), B = new Set(t.split(' ')); const inter = [...A].filter(x => B.has(x)).length; sc = inter / (A.size + B.size - inter); }
    if (sc > bs) { bs = sc; best = s; }
  });
  return bs >= .5 ? best : null;
}
function chartBox(s, ro) {
  const me = S.me; if (!me) return '<div id="chartBox"></div>';
  const mine = chartOf(s.id, me.id), res = chartFor(s.id), others = S.song_charts.filter(c => c.song_id === s.id && c.member_id !== me.id);
  const nm = id => (byId('members', id) || {}).name || 'A bandmate', using = res ? res.chart.member_id : null;
  const row = (label, right, on) => `<div class="row" style="padding:8px 0;border-top:1px solid var(--line-soft);gap:8px;flex-wrap:wrap"><div class="grow"><b>${label}</b>${on ? ' <span class="pill st-confirmed">In use</span>' : ''}</div>${right}</div>`;
  return `<div id="chartBox">
    ${row('My chart', ro ? (mine ? `<span class="small muted">${esc(mine.filename || 'chart.pdf')}</span><button class="btn sm" data-act="chart-open" data-id="${mine.id}">Open</button>` : '<span class="small muted">none yet</span>') : mine ? `<span class="small muted">${esc(mine.filename || 'chart.pdf')}</span><button class="btn sm" data-act="chart-open" data-id="${mine.id}">Open</button><label class="btn sm" style="cursor:pointer">Replace<input type="file" accept="application/pdf" hidden data-chart-up="${s.id}"></label><button class="btn sm danger" data-act="chart-del" data-id="${mine.id}">Remove</button>`
      : `<label class="btn sm gold" style="cursor:pointer">Upload my PDF<input type="file" accept="application/pdf" hidden data-chart-up="${s.id}"></label>`, using === me.id)}
    ${others.map(c => row(`${esc(nm(c.member_id))}’s chart`, `<button class="btn sm" data-act="chart-open" data-id="${c.id}">Open</button>${ro || using === c.member_id ? '' : `<button class="btn sm" data-act="chart-use" data-sid="${s.id}" data-m="${c.member_id}">Use theirs</button>`}`, using === c.member_id)).join('')}
    ${!ro && mine && using !== me.id ? `<div class="row" style="padding-top:8px"><button class="btn sm" data-act="chart-use" data-sid="${s.id}" data-m="own">Use my own instead</button></div>` : ''}
    ${!res ? `<p class="small muted" style="margin:8px 0 0">${ro ? 'No chart yet — tap Edit to upload yours or use a bandmate’s.' : 'No chart yet — upload yours, or use a bandmate’s once they add theirs.'}</p>` : ''}
  </div>`;
}
function refreshChartBox(songId) { const b = $('#chartBox'); const s = byId('songs', songId); if (b && s) b.outerHTML = chartBox(s, !!$('#modalRoot [data-songview]')); render(); }
function importModal() {
  const rows = S._imp.rows, n = rows.filter(r => r.songId).length;
  const opts = sel => '<option value="">— skip —</option>' + S.songs.slice().sort((a, b) => a.title.localeCompare(b.title)).map(s => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.title)}${s.artist ? ' — ' + esc(s.artist) : ''}</option>`).join('');
  return `<div class="scrim" data-act="modal-close"><div class="modal" data-stop style="width:min(760px,100%)">
    <div class="row"><h2 class="sec" style="margin:0">Import charts</h2><span class="spacer"></span><button class="btn ghost" data-act="modal-close">✕</button></div>
    <p class="small muted">Matched to songs by file name. These become <b>your</b> charts — bandmates can use them or add their own. Fix any wrong match below.</p>
    <div class="stack" style="max-height:55vh;overflow:auto;margin-top:8px">${rows.map((r, i) => `<div class="row" style="gap:8px;flex-wrap:wrap;border-top:1px solid var(--line-soft);padding-top:8px"><div class="grow small" style="min-width:160px;word-break:break-all">${esc(r.file.name)}<div class="faint">${(r.file.size / 1e6).toFixed(1)} MB${r.songId && chartOf(r.songId, S.me.id) ? ' · replaces your current chart' : ''}</div></div><select class="in" data-imp="${i}" style="max-width:300px">${opts(r.songId)}</select></div>`).join('')}</div>
    <div class="row" style="margin-top:14px"><button class="btn gold" data-act="chart-import-go" ${n ? '' : 'disabled'}>Upload ${n} chart${n === 1 ? '' : 's'}</button><span class="small faint" id="impStatus"></span></div></div></div>`;
}

/* ============================================================ refresh */
const fingerprint = () => JSON.stringify(TABLES.map(t => S[t]));
async function refreshNow(manual) {
  if (S.offline) return tryOnline(!manual);
  if (S.dirty) { if (manual) toast('Save or cancel your changes first, then refresh.', true); return; }
  try { const before = fingerprint(); await timeoutP(loadAll(), 12000); if (manual || fingerprint() !== before) render(); if (manual) toast('Up to date'); }
  catch (e) { if (manual) toast(isNetErr(e) ? 'Couldn’t refresh — no connection.' : (e.message || 'Couldn’t refresh'), true); }
}
(function pullToRefresh() {
  let y0 = null, dy = 0, pill = null;
  const hdr = () => { const h = $('.top'); return (h ? h.getBoundingClientRect().bottom : 60) + 8; };
  const show = (txt) => { if (!pill) { pill = document.createElement('div'); pill.className = 'ptr'; document.body.appendChild(pill); } pill.style.top = hdr() + 'px'; pill.textContent = txt; pill.style.opacity = Math.min(1, dy / 50); };
  const hide = () => { if (pill) { pill.remove(); pill = null; } };
  document.addEventListener('touchstart', e => { const sc = $('.scroll'); y0 = (sc && sc.contains(e.target) && sc.scrollTop <= 0 && e.touches.length === 1 && !GM.open && !$('#modalRoot .modal') && !e.target.closest('.up-scroll,.tbl-wrap,textarea')) ? e.touches[0].clientY : null; dy = 0; }, { passive: true });
  document.addEventListener('touchmove', e => { if (y0 == null) return; dy = e.touches[0].clientY - y0; const sc = $('.scroll'); if (dy > 8 && sc && sc.scrollTop <= 0) show(dy > 80 ? 'Release to refresh' : '↓ Pull to refresh'); else if (dy <= 8) hide(); }, { passive: true });
  document.addEventListener('touchend', async () => { const go = y0 != null && dy > 80; y0 = null; if (!go) return hide(); if (pill) pill.textContent = 'Refreshing…'; await refreshNow(true); hide(); });
  setInterval(() => {                                               // every 90 s while you're just looking, never while typing
    const a = document.activeElement, typing = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
    if (document.visibilityState === 'visible' && S.me && !S.offline && !S.dirty && !typing && !GM.open && !$('#modalRoot .modal')) refreshNow(false);
  }, 90000);
})();

/* ============================================================ pencil markup */
const GMK = { on: false, tool: 'pen', color: '#d11a2a', strokes: [], undo: [], key: null, songId: null, path: null, cur: null, pending: null, timer: null, scroll: null };
const PEN_COLORS = [['#111111', 'Black'], ['#d11a2a', 'Red'], ['#1d4ed8', 'Blue']];
const r3 = n => Math.round(n * 1000) / 1000;
function segDist(px, py, ax, ay, bx, by) {                          // distance from a point to a line segment
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy, t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function drawStroke(ctx, s, w, h) {                                // points are stored as fractions of the page, so marks fit any zoom or screen
  const pts = s.pts; if (!pts.length || !ctx) return;
  ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = s.c; ctx.fillStyle = s.c;
  if (s.t === 'hl') {
    ctx.globalAlpha = .38; ctx.lineWidth = s.w * w; ctx.beginPath(); pts.forEach(([x, y], i) => i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)); ctx.stroke();
  } else if (pts.length === 1) { ctx.beginPath(); ctx.arc(pts[0][0] * w, pts[0][1] * h, s.w * w * (.5 + pts[0][2]) / 2, 0, 7); ctx.fill(); }
  else for (let i = 1; i < pts.length; i++) { ctx.lineWidth = s.w * w * (.5 + pts[i][2]); ctx.beginPath(); ctx.moveTo(pts[i - 1][0] * w, pts[i - 1][1] * h); ctx.lineTo(pts[i][0] * w, pts[i][1] * h); ctx.stroke(); }
  ctx.restore();
}
function gmRedraw(only) {
  (GM.pgs || []).forEach((P, k) => {
    if (only != null && only !== k) return; const ctx = P.ov.getContext && P.ov.getContext('2d'); if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, P.ov.width, P.ov.height); ctx.setTransform(P.dpr, 0, 0, P.dpr, 0, 0);
    GMK.strokes.forEach(s => { if (s.pg === k) drawStroke(ctx, s, P.w, P.h); });
    if (GMK.cur && GMK.cur.stroke && GMK.cur.stroke.pg === k) drawStroke(ctx, GMK.cur.stroke, P.w, P.h);
  });
}
async function gmMarksLoad(tok) {
  const cur = GM.seq[GM.i], ch = cur.forceChart ? { chart: cur.forceChart } : (cur.song ? chartFor(cur.song.id) : null);
  GMK.strokes = []; GMK.undo = []; GMK.cur = null; GMK.songId = cur.song && cur.song.id; GMK.path = ch && ch.chart.path; GMK.key = GMK.songId && GMK.path ? `${GMK.songId}|${GMK.path}` : null;
  if (!GMK.key) return; const rec = await idbGet('marks', GMK.key); if (tok !== GM.tok) return;
  GMK.strokes = (rec && rec.strokes) || []; gmRedraw();
}
function gmMarksFlush() {
  clearTimeout(GMK.timer); const p = GMK.pending; GMK.pending = null; if (!p) return;
  idbPut('marks', p.key, { strokes: p.strokes, updated_at: new Date().toISOString(), dirty: true, songId: p.songId, path: p.path }).then(marksSync);
}
function gmMarksSaveSoon() {
  if (!GMK.key) return; GMK.pending = { key: GMK.key, songId: GMK.songId, path: GMK.path, strokes: GMK.strokes.slice() };
  clearTimeout(GMK.timer); GMK.timer = setTimeout(gmMarksFlush, 500);
}
let marksSyncing = false, marksWarned = false;
async function marksSync() {                                        // push any marks that haven't reached Supabase yet
  if (marksSyncing || !S.me || navigator.onLine === false) return; marksSyncing = true;
  try {
    for (const [key, r] of await idbEntries('marks')) {
      if (!r.dirty) continue;
      try { await api.upsertMarks([{ member_id: S.me.id, song_id: r.songId, chart_path: r.path, strokes: r.strokes, updated_at: r.updated_at }]); const now = await idbGet('marks', key); if (now && now.updated_at === r.updated_at) await idbPut('marks', key, { ...now, dirty: false }); }
      catch (e) { if (/relation|chart_marks|schema cache|does not exist/i.test((e && e.message) || '') && !marksWarned) { marksWarned = true; toast('Pen marks are saved on this iPad only — run the latest SQL in Supabase to sync them.', true); } break; }
    }
  } finally { marksSyncing = false; }
}
async function marksPull(songIds) {                                 // bring this person's marks from other devices (newest wins; never over unsynced local ones)
  if (S.offline || !S.me || !songIds.length) return false; let changed = false;
  try { for (const row of await api.getMarks(songIds)) { const key = `${row.song_id}|${row.chart_path}`, loc = await idbGet('marks', key); if (!loc || (!loc.dirty && new Date(row.updated_at) > new Date(loc.updated_at))) { await idbPut('marks', key, { strokes: row.strokes || [], updated_at: row.updated_at, dirty: false, songId: row.song_id, path: row.chart_path }); if (key === GMK.key) changed = true; } } } catch {}
  return changed;
}
window.addEventListener('online', () => marksSync());
function gmToolsHtml() {
  const tb = (v, label, extra = '') => `<button class="gm-tb ${GMK.tool === v && (v !== 'pen' || GMK.color === extra) ? 'on' : ''}" data-gm="tool" data-v="${v}" ${v === 'pen' ? `data-c="${extra}"` : ''}>${label}</button>`;
  return PEN_COLORS.map(([c, n]) => `<button class="gm-sw ${GMK.tool === 'pen' && GMK.color === c ? 'on' : ''}" data-gm="tool" data-v="pen" data-c="${c}" aria-label="${n} pen" style="--c:${c}"></button>`).join('')
    + `<button class="gm-tb ${GMK.tool === 'hl' ? 'on' : ''}" data-gm="tool" data-v="hl">Highlight</button><button class="gm-tb ${GMK.tool === 'erase' ? 'on' : ''}" data-gm="tool" data-v="erase">Erase</button><span class="spacer"></span><button class="gm-tb" data-gm="undo">Undo</button><button class="gm-tb" data-gm="clear">Clear</button><button class="gm-tb done" data-gm="pen">Done</button>`;
}
function gmPenToggle(on) {
  GMK.on = on == null ? !GMK.on : on; const d = $('#gigMode'); if (!d) return; d.classList.toggle('gm-pen', GMK.on);
  const t = $('#gmTools'); if (t) { t.hidden = !GMK.on; t.innerHTML = GMK.on ? gmToolsHtml() : ''; } const b = $('#gmPenBtn'); if (b) b.classList.toggle('on', GMK.on);
}
function gmPtr(e) {
  if (!GMK.on) return; const view = $('#gmView'); if (!view) return;
  if (e.type === 'pointerdown') {
    if (e.pointerType !== 'touch') GMK.lastPen = Date.now();
    if (e.pointerType === 'touch') { if (GMK.cur || Date.now() - (GMK.lastPen || 0) < 900) return; GMK.scroll = { id: e.pointerId, y: e.clientY, x: e.clientX, top: view.scrollTop, left: view.scrollLeft }; return; }     // fingers scroll, the Pencil draws
    const ov = e.target.closest && e.target.closest('.gm-ov'); if (!ov || !GMK.key) return; e.preventDefault();
    if (ov.setPointerCapture) { try { ov.setPointerCapture(e.pointerId); } catch {} }
    const pg = Number(ov.dataset.pg), P = GM.pgs[pg], r = ov.getBoundingClientRect();
    GMK.cur = { id: e.pointerId, pg, r, P, removed: [], stroke: GMK.tool === 'erase' ? null : { t: GMK.tool === 'hl' ? 'hl' : 'pen', c: GMK.tool === 'hl' ? '#ffd400' : GMK.color, w: GMK.tool === 'hl' ? 0.024 : 0.0034, pg, pts: [] } };
    gmPtr({ type: 'pointermove', pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY, pressure: e.pressure, pointerType: e.pointerType, getCoalescedEvents: null, _first: true });
  } else if (e.type === 'pointermove') {
    if (GMK.scroll && e.pointerId === GMK.scroll.id) { if (GMK.cur || Date.now() - (GMK.lastPen || 0) < 900) { GMK.scroll = null; return; } const dy = e.clientY - GMK.scroll.y, dx = e.clientX - GMK.scroll.x; if (!GMK.scroll.go && Math.hypot(dx, dy) < 8) return; GMK.scroll.go = true; view.scrollTop = GMK.scroll.top - dy; view.scrollLeft = GMK.scroll.left - dx; return; }
    const c = GMK.cur; if (!c || e.pointerId !== c.id) return; if (!e._first) e.preventDefault && e.preventDefault();
    const evs = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
    for (const q of evs) {
      const x = r3((q.clientX - c.r.left) / c.r.width), y = r3((q.clientY - c.r.top) / c.r.height), p = Math.round((q.pressure || .5) * 100) / 100;
      if (c.stroke) c.stroke.pts.push([x, y, p]);
      else { const rad = 0.03; GMK.strokes = GMK.strokes.filter(s => { if (s.pg !== c.pg) return true; const hit = s.pts.some(([sx, sy], i) => { const a = s.pts[i - 1] || [sx, sy]; return segDist(x * c.P.w, y * c.P.h, a[0] * c.P.w, a[1] * c.P.h, sx * c.P.w, sy * c.P.h) < rad * c.P.w; }); if (hit) c.removed.push(s); return !hit; }); }
    }
    gmRedraw(c.pg);
  } else if (e.type === 'pointerup' || e.type === 'pointercancel') {
    if (GMK.scroll && e.pointerId === GMK.scroll.id) { const moved = GMK.scroll.go; GMK.scroll = null; if (moved) gmSnap(); return; }
    const c = GMK.cur; if (!c || e.pointerId !== c.id) return; GMK.cur = null;
    if (c.stroke && c.stroke.pts.length) { GMK.strokes.push(c.stroke); GMK.undo.push({ add: c.stroke }); gmMarksSaveSoon(); }
    else if (c.removed.length) { GMK.undo.push({ del: c.removed }); gmMarksSaveSoon(); }
    gmRedraw(c.pg);
  }
}
function gmUndo() {
  const a = GMK.undo.pop(); if (!a) return;
  if (a.add) GMK.strokes = GMK.strokes.filter(s => s !== a.add); else GMK.strokes.push(...a.del);
  gmRedraw(); gmMarksSaveSoon();
}
function gmClear() {
  if (!GMK.strokes.length) return; if (!confirm('Erase all your pen marks on this song?')) return;
  GMK.undo.push({ del: GMK.strokes }); GMK.strokes = []; gmRedraw(); gmMarksSaveSoon();
}

/* ============================================================ gig mode */
const GM = { open: false, seq: [], i: 0, zoom: 1, tok: 0, lid: null, preview: false, lock: null, awake: false, doc: null, drawer: false };
const GM_ZOOM = [1, 1.25, 1.5, 2, 2.5, 3];
function gmSeq(L) { return itemsOf(L.id).filter(i => i.played).sort((a, b) => a.set_no - b.set_no || a.position - b.position).map(i => ({ item: i, song: byId('songs', i.song_id), set: i.set_no })); }
function openGigMode(seq, lid, opts = {}) {
  if (!seq.length) return toast('Add songs first.', true);
  closeGigMode(true);
  Object.assign(GM, { open: true, seq, lid, preview: !!opts.preview, zoom: 1, tok: 0, drawer: false });
  const saved = lid ? Number(sessionStorage.getItem('tfgm:' + lid)) : 0; GM.i = saved >= 0 && saved < seq.length ? saved : 0;
  const d = document.createElement('div'); d.id = 'gigMode'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Gig mode');
  d.innerHTML = `<div class="gm-top"><button class="gm-btn" data-gm="exit" aria-label="Exit gig mode">✕</button>
    <div class="gm-title"><div class="gm-t1" id="gmT1"></div><div class="gm-t2"><span id="gmT2"></span><span id="gmPg"></span> <span id="gmPre"></span></div></div>
    <button class="gm-awake" data-gm="awake" id="gmAwake"></button>
    <button class="gm-btn" data-gm="pen" id="gmPenBtn" aria-label="Pencil markup">Pen</button><button class="gm-btn" data-gm="zoom-out" aria-label="Smaller">A−</button><button class="gm-btn" data-gm="zoom-in" aria-label="Bigger">A+</button>${GM.preview ? '' : '<button class="gm-btn" data-gm="list" aria-label="Song list">☰</button>'}</div>
    <input id="gmKeys" class="gm-keys" readonly inputmode="none" autocomplete="off" autocapitalize="off" aria-hidden="true" tabindex="-1">
    <div class="gm-tools" id="gmTools" hidden></div><div class="gm-view" id="gmView"></div><div class="gm-bottom" id="gmBottom"></div><div class="gm-drawer" id="gmDrawer" hidden></div>`;
  document.body.appendChild(d);
  d.addEventListener('click', gmClick); document.addEventListener('keydown', gmKey, true); document.addEventListener('visibilitychange', gmVis);
  d.addEventListener('selectstart', e => e.preventDefault()); d.setAttribute('tabindex', '-1');
  const focusKeys = () => { const k = $('#gmKeys'); if (GM.open && k && document.activeElement !== k) { try { k.focus({ preventScroll: true }); } catch {} } };
  d.addEventListener('pointerup', () => setTimeout(focusKeys, 30)); d.addEventListener('click', () => setTimeout(focusKeys, 30)); d.addEventListener('focusout', () => setTimeout(focusKeys, 120));
  focusKeys();
  let pgT = null; d.querySelector('#gmView').addEventListener('scroll', () => { clearTimeout(pgT); pgT = setTimeout(gmPageInd, 120); });
  let rzT = null; GM.onResize = () => { clearTimeout(rzT); rzT = setTimeout(() => { if (GM.open) gmLoadChart(); }, 250); }; window.addEventListener('resize', GM.onResize);
  const gv = d.querySelector('#gmView'); ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'].forEach(t => gv.addEventListener(t, gmPtr)); gv.addEventListener('contextmenu', e => { if (GMK.on) e.preventDefault(); });
  GMK.on = false; GMK.cur = null; marksSync();
  mediaOff(); if (UI.media) mediaOn(d => gmTurn(d === 'next' ? 1 : -1));
  gmWake(); gmShow(GM.i); if (!GM.preview) gmPrefetch();
  marksPull([...new Set(seq.map(x => x.song && x.song.id).filter(Boolean))]).then(ch => { if (ch && GM.open) gmMarksLoad(GM.tok); });
}
function closeGigMode(quiet) {
  if (GM.onResize) { window.removeEventListener('resize', GM.onResize); GM.onResize = null; }
  mediaOff(); gmMarksFlush(); GMK.on = false; GMK.cur = null;
  const d = $('#gigMode'); if (d) d.remove();
  document.removeEventListener('keydown', gmKey, true); document.removeEventListener('visibilitychange', gmVis);
  if (GM.lock) { try { GM.lock.release(); } catch {} GM.lock = null; }
  if (GM.doc) { try { GM.doc.destroy(); } catch {} GM.doc = null; }
  GM.open = false; GM.tok++;
}
async function gmWake() {
  try { if (navigator.wakeLock) { GM.lock = await navigator.wakeLock.request('screen'); GM.awake = true; GM.lock.addEventListener('release', () => { GM.awake = false; gmBadge(); }); } else GM.awake = false; } catch { GM.awake = false; }
  gmBadge();
}
function gmBadge() { const b = $('#gmAwake'); if (b) b.innerHTML = GM.awake ? '<span style="color:var(--ok)">● awake</span>' : '<span style="color:var(--gold)">may sleep</span>'; }
function gmVis() { if (document.visibilityState === 'visible' && GM.open) gmWake(); }
/* Bluetooth page-turner pedals send ordinary keys (arrows / Page Up-Down). A press scrolls the chart a page; at the end of the chart it moves to the next song. */
function gmPageIdx(v, slots) {                                       // which page is on screen (the one whose middle is nearest the middle of the view)
  const vt = v.getBoundingClientRect().top, mid = v.scrollTop + v.clientHeight / 2; let best = 0, bd = Infinity;
  slots.forEach((s, i) => { const d = Math.abs(s.getBoundingClientRect().top - vt + v.scrollTop + s.offsetHeight / 2 - mid); if (d < bd) { bd = d; best = i; } });
  return best;
}
function gmGoTo(v, slot) { const top = slot.getBoundingClientRect().top - v.getBoundingClientRect().top + v.scrollTop; if (v.scrollTo) v.scrollTo({ top, behavior: 'smooth' }); else v.scrollTop = top; }
function gmSnap() { const v = $('#gmView'); if (!v || GM.zoom !== 1) return; const slots = [...v.querySelectorAll('.gm-slot')]; if (slots.length) gmGoTo(v, slots[gmPageIdx(v, slots)]); }
function gmPageInd() { const el = $('#gmPg'), v = $('#gmView'); if (!el || !v) return; const slots = [...v.querySelectorAll('.gm-slot')]; el.textContent = slots.length > 1 && GM.zoom === 1 ? ` · page ${gmPageIdx(v, slots) + 1}/${slots.length}` : ''; }
/* Bluetooth page-turner pedals send ordinary keys. Normal size: one press = one whole page, and after the last page it moves to the next song.
   Zoomed in (A+): one press scrolls most of a screen instead. */
function gmTurn(dir) {
  const v = $('#gmView'); if (!v) return gmShow(GM.i + dir, dir < 0);
  const slots = [...v.querySelectorAll('.gm-slot')];
  if (GM.zoom === 1 && slots.length) {
    const nxt = gmPageIdx(v, slots) + dir;
    if (nxt < 0 || nxt >= slots.length) return gmShow(GM.i + dir, dir < 0);
    gmGoTo(v, slots[nxt]); setTimeout(gmPageInd, 450); return;
  }
  const room = dir > 0 ? v.scrollHeight - v.clientHeight - v.scrollTop : v.scrollTop, step = dir * Math.round(v.clientHeight * 0.88);
  if (room > 6) { if (v.scrollBy) v.scrollBy({ top: step, behavior: 'smooth' }); else v.scrollTop += step; }
  else gmShow(GM.i + dir, dir < 0);
}
const pedSig = e => ({ k: e.key, c: e.code || '', kc: e.keyCode || 0 });
const pedHit = (e, list) => (list || []).some(s => (s.k && s.k !== 'Unidentified' && e.key === s.k) || (s.c && e.code && e.code === s.c) || (s.kc && e.keyCode === s.kc && (!s.k || s.k === 'Unidentified')));
function gmKey(e) {
  if (!GM.open || e.metaKey || e.ctrlKey || e.altKey) return; const k = e.key, ped = UI.ped || {};
  const next = pedHit(e, ped.next) || ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(k) || [34, 39, 40, 32, 13].includes(e.keyCode);
  const prev = pedHit(e, ped.prev) || ['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(k) || [33, 37, 38, 8].includes(e.keyCode);
  if (next && !prev) { e.preventDefault(); e.stopPropagation(); if (!e.repeat) gmTurn(1); }
  else if (prev) { e.preventDefault(); e.stopPropagation(); if (!e.repeat) gmTurn(-1); }
  else if (k === 'Escape') closeGigMode();
}
/* Pedal setup (Band tab → My preferences): shows exactly what the pedal sends and lets you teach "next" / "previous" */
let pedLearn = null;
function pedLog(line) {
  const box = $('#pedLog'); if (!box) return; const t = new Date().toLocaleTimeString('en-US', { hour12: false });
  S._pedLines = [`${t}  ${line}`, ...(S._pedLines || [])].slice(0, 8); box.textContent = S._pedLines.join('\n');
}
document.addEventListener('focusin', e => { if (e.target && e.target.id === 'pedFocus') pedLog('box focused — now press the pedal'); }, true);
document.addEventListener('focusout', e => { if (e.target && e.target.id === 'pedFocus') pedLog('box lost focus'); }, true);
document.addEventListener('scroll', e => { if (!$('#pedLog') || GM.open) return; const t = e.target === document ? 'page' : (e.target.id || e.target.className || e.target.tagName); pedLog(`something scrolled (${String(t).slice(0, 18)})`); }, true);
['keydown', 'keyup', 'keypress', 'wheel', 'mousedown', 'pointerdown', 'touchstart', 'contextmenu'].forEach(type => document.addEventListener(type, e => {
  if (!$('#pedLog') || GM.open) return;
  if (['mousedown', 'pointerdown', 'touchstart', 'contextmenu'].includes(type) && e.target.closest && e.target.closest('button,select,a,input,textarea,label')) return;   // ignore your own taps on the buttons
  if (type === 'keydown') {
    const s = pedSig(e), box = $('#pedStatus');
    if (pedLearn) { e.preventDefault(); UI.ped = UI.ped || { next: [], prev: [] }; UI.ped[pedLearn] = [s]; keepUI(); if (box) box.innerHTML = `Saved: <b>${pedLearn === 'next' ? 'Next' : 'Previous'}</b> = ${esc(s.k)} <span class="faint">(code ${esc(s.c || '—')}, keyCode ${s.kc || '—'})</span>`; pedLog(`learned ${pedLearn}: ${s.k}`); pedLearn = null; $$('[data-act="ped-learn"]').forEach(b => b.classList.remove('on')); return; }
    pedLog(`key down   key=${s.k}  code=${s.c || '—'}  keyCode=${s.kc || '—'}`);
  }
  else if (type === 'keyup') pedLog(`key up     key=${e.key}`);
  else if (type === 'keypress') pedLog(`keypress   ${e.key}`);
  else if (type === 'wheel') pedLog(`scroll     dy=${Math.round(e.deltaY)} dx=${Math.round(e.deltaX)}`);
  else { const p = e.touches && e.touches[0] ? e.touches[0] : e; pedLog(`${type}  ${e.pointerType || (e.touches ? 'touch' : 'mouse')}  at ${Math.round(p.clientX || 0)},${Math.round(p.clientY || 0)}`); }
}, { capture: true, passive: type === 'wheel' || type === 'touchstart' }));

/* Some pedals send "music controls" (next / previous track) instead of keys. A web page only hears those while it is playing audio,
   so in that mode we play a silent loop and listen for the media buttons. */
const MEDIA = { audio: null, on: false };
function silentWavUrl() {
  const n = 8000, b = new Uint8Array(44 + n), dv = new DataView(b.buffer), tag = (o, s) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); dv.setUint32(4, 36 + n, true); tag(8, 'WAVE'); tag(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 8000, true); dv.setUint32(28, 8000, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true); tag(36, 'data'); dv.setUint32(40, n, true); b.fill(128, 44);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
}
function mediaOn(onAction) {                                       // onAction('next' | 'prev', rawActionName)
  if (!navigator.mediaSession) return false;
  if (!MEDIA.audio) { const a = new Audio(); a.loop = true; a.src = silentWavUrl(); a.setAttribute('playsinline', ''); MEDIA.audio = a; }
  const keepPlaying = () => { try { const p = MEDIA.audio.play(); if (p && p.catch) p.catch(() => {}); } catch {} };
  keepPlaying(); try { navigator.mediaSession.metadata = new MediaMetadata({ title: 'Gig mode', artist: 'Trailer Folk' }); } catch {}
  const map = { nexttrack: 'next', seekforward: 'next', play: 'next', pause: 'next', previoustrack: 'prev', seekbackward: 'prev' };
  Object.keys(map).forEach(act => { try { navigator.mediaSession.setActionHandler(act, () => { keepPlaying(); onAction(map[act], act); }); } catch {} });
  MEDIA.on = true; return true;
}
function mediaOff() {
  if (!MEDIA.on) return; MEDIA.on = false;
  ['nexttrack', 'seekforward', 'play', 'pause', 'previoustrack', 'seekbackward'].forEach(act => { try { navigator.mediaSession.setActionHandler(act, null); } catch {} });
  try { MEDIA.audio.pause(); } catch {}
}
function gmClick(e) {
  const el = e.target.closest('[data-gm]'); if (!el) return; const a = el.dataset.gm;
  if (a === 'exit') closeGigMode();
  else if (a === 'next') gmShow(GM.i + 1); else if (a === 'prev') gmShow(GM.i - 1);
  else if (a === 'pen') gmPenToggle();
  else if (a === 'tool') { GMK.tool = el.dataset.v; if (el.dataset.c) GMK.color = el.dataset.c; $('#gmTools').innerHTML = gmToolsHtml(); }
  else if (a === 'undo') gmUndo(); else if (a === 'clear') gmClear();
  else if (a === 'zoom-in' || a === 'zoom-out') { const k = GM_ZOOM.indexOf(GM.zoom); GM.zoom = GM_ZOOM[Math.max(0, Math.min(GM_ZOOM.length - 1, k + (a === 'zoom-in' ? 1 : -1)))]; gmLoadChart(); }
  else if (a === 'list') { GM.drawer = !GM.drawer; gmDrawer(); }
  else if (a === 'go') { GM.drawer = false; gmDrawer(); gmShow(Number(el.dataset.i)); }
  else if (a === 'awake') toast(GM.awake ? 'Screen stays on while gig mode is open.' : 'This phone won’t let a web page keep the screen on (iOS Home Screen apps need iOS 18.4 or newer). Set Settings → Display & Brightness → Auto-Lock → Never for the gig.', !GM.awake);
}
function gmDrawer() {
  const dr = $('#gmDrawer'); if (!dr) return; dr.hidden = !GM.drawer; if (!GM.drawer) return;
  let last = null;
  dr.innerHTML = `<div class="row" style="padding:12px"><b style="font-size:18px">Songs</b><span class="spacer"></span><button class="gm-btn" data-gm="list">✕</button></div>` + GM.seq.map((x, k) => { const h = x.set !== last ? `<div class="gm-dh">Set ${x.set}</div>` : ''; last = x.set; const s = x.song || {}; return `${h}<button class="gm-di ${k === GM.i ? 'on' : ''}" data-gm="go" data-i="${k}"><span class="n">${k + 1}</span><span class="grow">${esc(s.title || '?')}</span><span class="small">${esc(songLabel(s))}${chartFor(s.id) || x.forceChart ? '' : ' · no chart'}</span></button>${x.item && x.item.note ? `<div class="gm-dn">${esc(x.item.note)}</div>` : ''}`; }).join('');
}
function gmShow(i, toEnd) {
  if (i < 0 || i >= GM.seq.length) return;
  gmMarksFlush(); GM.landEnd = !!toEnd;                          // going back lands on the last page of the previous song
  GM.i = i; if (GM.lid) sessionStorage.setItem('tfgm:' + GM.lid, String(i));
  const cur = GM.seq[i], s = cur.song || {}, inSet = GM.seq.filter(x => x.set === cur.set), pos = inSet.indexOf(cur) + 1;
  $('#gmT1').textContent = s.title || '(deleted song)';
  $('#gmT2').textContent = GM.preview ? songLabel(s) : `Set ${cur.set} · ${pos} of ${inSet.length} · song ${i + 1}/${GM.seq.length}`;
  $('#gmBottom').innerHTML = gmBottom(); gmBadge(); gmLoadChart();
}
function gmBottom() {
  const cur = GM.seq[GM.i], nxt = GM.seq[GM.i + 1], s = cur.song || {};
  if (GM.preview) return `<div class="gm-info"><b>${esc(s.title || '')}</b> <span class="gm-bits">Key ${esc(s.song_key || '?')}${s.capo ? ' · capo ' + s.capo : ''}${s.bpm ? ' · ♩ ' + s.bpm + ' BPM' : ''}${s.starter ? ' · Starts: ' + esc(s.starter) : ''}${s.lead_vox ? ' · Lead: ' + esc(s.lead_vox) : ''}</span></div>`;
  const say = cur.item && cur.item.note;
  let next;
  if (!nxt) next = '<div class="gm-next"><span class="gm-lbl">END</span> <b>That’s the last song</b></div>';
  else {
    const ns = nxt.song || {}, c = changes(s, ns), brk = nxt.set !== cur.set;
    const bits = [`Key ${esc(ns.song_key || '?')}${ns.capo ? ' · capo ' + ns.capo : ''}`, ns.bpm ? `♩ <b>${ns.bpm}</b> BPM` : '', ns.starter ? `Starts: <b>${esc(ns.starter)}</b>` : '', ns.lead_vox ? `Lead: ${esc(ns.lead_vox)}` : ''].filter(Boolean);
    const alerts = brk ? [] : [...(c.tuning ? [`retune → ${esc(ns.tuning || 'Standard')}`] : []), ...c.inst.map(x => `${esc(x.who)}: ${esc(x.to)}`)];
    next = `<div class="gm-next"><span class="gm-lbl">${brk ? 'NEXT SET' : 'NEXT'}</span> <b>${esc(ns.title || '')}</b> <span class="gm-bits">${bits.join(' · ')}</span></div>${alerts.length ? `<div class="gm-alert">⇄ ${alerts.join(' · ')}</div>` : ''}`;
  }
  return `<div class="gm-nav"><button class="gm-nb" data-gm="prev" ${GM.i ? '' : 'disabled'} aria-label="Previous song">&lt;&lt;</button>
    <div class="gm-info">${s.bpm || s.song_key ? `<div class="gm-now"><span class="gm-lbl">NOW</span> ${s.bpm ? `♩ <b>${s.bpm}</b> BPM` : ''}${s.bpm && s.song_key ? ' · ' : ''}${s.song_key ? 'Key ' + esc(s.song_key) + (s.capo ? ' · capo ' + s.capo : '') : ''}</div>` : ''}${say ? `<div class="gm-say">${esc(say)}</div>` : ''}${next}
</div>
    <button class="gm-nb" data-gm="next" ${nxt ? '' : 'disabled'} aria-label="Next song">&gt;&gt;</button></div>`;
}
function gmNoChart(cur) {
  const s = cur.song || {};
  return `<div class="gm-card"><div class="gm-big">${esc(s.title || '')}</div><div class="gm-bigsub">Key ${esc(s.song_key || '?')}${s.capo ? ' · capo ' + s.capo : ''}</div>${s.starter ? `<div>Starts: <b>${esc(s.starter)}</b></div>` : ''}${s.lead_vox ? `<div>Lead vocal: ${esc(s.lead_vox)}</div>` : ''}${s.comment ? `<div class="muted" style="margin-top:8px">${esc(s.comment)}</div>` : ''}<div class="muted" style="margin-top:14px">No PDF chart for you on this one yet.</div></div>`;
}
async function gmLoadChart() {
  GM.pageCount = 0; const tok = ++GM.tok, cur = GM.seq[GM.i], v = $('#gmView'); if (!v) return; v.scrollTop = 0; v.scrollLeft = 0;
  const ch = cur.forceChart ? { chart: cur.forceChart } : (cur.song ? chartFor(cur.song.id) : null);
  if (!ch) { v.innerHTML = gmNoChart(cur); return; }
  v.innerHTML = '<div class="gm-msg">Loading chart…</div>';
  try {
    const [lib, buf] = await Promise.all([loadPdfJs(), chartData(ch.chart)]); if (tok !== GM.tok) return;
    const pdf = await lib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise; if (tok !== GM.tok) { pdf.destroy(); return; }
    if (GM.doc) { try { GM.doc.destroy(); } catch {} } GM.doc = pdf;
    const paged = GM.zoom === 1; v.classList.toggle('paged', paged);                   // normal size: one whole page per screen
    v.innerHTML = ''; GM.pgs = []; const W = v.clientWidth - (paged ? 0 : 12), H = v.clientHeight - (paged ? 0 : 12), dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n); if (tok !== GM.tok) return;
      const v0 = page.getViewport({ scale: 1 });
      const fitW = Math.min(W, H * v0.width / v0.height), w = fitW * GM.zoom;                                  // A+ / A− scale up from the whole-page fit
      const vp = page.getViewport({ scale: w / v0.width * dpr });
      const cv = document.createElement('canvas'); cv.className = 'gm-page'; cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height); cv.style.width = vp.width / dpr + 'px'; cv.style.height = vp.height / dpr + 'px';
      const cssW = vp.width / dpr, cssH = vp.height / dpr, wrap = document.createElement('div'), ov = document.createElement('canvas');
      wrap.className = 'gm-pg'; wrap.style.width = cssW + 'px'; wrap.style.height = cssH + 'px';
      ov.className = 'gm-ov'; ov.dataset.pg = String(n - 1); ov.width = cv.width; ov.height = cv.height; ov.style.width = cssW + 'px'; ov.style.height = cssH + 'px';
      const slot = document.createElement('div'); slot.className = 'gm-slot'; if (paged) slot.style.height = v.clientHeight + 'px';
      wrap.append(cv, ov); slot.appendChild(wrap); v.appendChild(slot); GM.pgs.push({ ov, w: cssW, h: cssH, dpr });
      await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    }
    GM.pageCount = pdf.numPages; if (GM.landEnd) { GM.landEnd = false; v.scrollTop = v.scrollHeight; } gmPageInd();
    await gmMarksLoad(tok);
  } catch (e) { if (tok === GM.tok) v.innerHTML = `<div class="gm-msg">Couldn’t show this chart${navigator.onLine ? '' : ' — you’re offline and it hasn’t been saved on this phone yet'}.<br><small>${esc(e.message || '')}</small></div>${gmNoChart(cur)}`; }
}
async function gmPrefetch() {                                       // save every chart in the setlist on this device while there's signal
  const need = GM.seq.map(x => x.song && chartFor(x.song.id)).filter(Boolean); if (!need.length) return;
  for (let k = 0; k < need.length; k++) {
    if (!GM.open) return; try { await chartData(need[k].chart); } catch {}
    const el = $('#gmPre'); if (el) el.textContent = k + 1 < need.length ? `· saving charts ${k + 1}/${need.length}` : '· charts saved offline';
  }
}

function clientModal(c) {
  const k = c || {}, linked = c ? S.gigs.filter(g => g.client_id === c.id).sort((a, b) => (b.gig_date || '').localeCompare(a.gig_date || '')) : [];
  const fld = (key, label, cls = '', type = 'text', ph = '') => `<label class="f ${cls}">${label}<input class="in" data-cl="${key}" type="${type}" value="${esc(k[key] || '')}" placeholder="${ph}"></label>`;
  const pick = S.gigs.filter(g => g.kind === 'gig' && (!c || g.client_id !== c.id)).sort((a, b) => (!!a.client_id - !!b.client_id) || (b.gig_date || '').localeCompare(a.gig_date || ''));
  return `<div class="scrim" data-act="modal-close"><div class="modal" data-stop style="width:min(720px,100%)">
    <div class="row"><h2 class="sec" style="margin:0">${c ? 'Client' : 'New client'}</h2><span class="spacer"></span><button class="btn ghost" data-act="modal-close">✕</button></div>
    <div class="fgrid" style="margin-top:12px">${fld('org', 'Organization', 'w2')}${fld('contact_name', 'Contact', 'w2')}${fld('email', 'Email', 'w2', 'email')}${fld('phone', 'Phone', 'w2')}${fld('address1', 'Street', 'w2')}${fld('city_state_zip', 'City, ST ZIP', 'w2')}${fld('code', 'Invoice code', '', 'text', 'OUHSC')}</div>
    <h2 class="sec" style="margin-top:18px">Gigs</h2>
    ${linked.length ? `<div class="list">${linked.map(g => `<div class="li"><div class="grow"><a href="#gig/${g.id}" data-act="modal-close" class="t" style="text-decoration:none">${esc(g.title)}</a><div class="s">${esc(g.gig_date ? fmtDate(g.gig_date) : 'No date')}</div></div><button class="btn sm" data-act="client-unlink" data-gid="${g.id}" data-cid="${c.id}">Remove</button></div>`).join('')}</div>` : '<p class="small muted" style="margin:0">Not tied to any gig yet.</p>'}
    <label class="f" style="margin-top:12px">Tie to a gig<select class="in" data-cl-gig><option value="">— Pick a gig (optional) —</option>${pick.map(g => `<option value="${g.id}">${esc(g.gig_date ? mdY(g.gig_date) + ' · ' : '')}${esc(g.title)}${g.client_id ? ' — now: ' + esc(((byId('clients', g.client_id) || {}).org) || 'another client') : ' — no client'}</option>`).join('')}</select></label>
    <div class="row" style="margin-top:16px"><button class="btn gold" data-act="client-save" data-id="${c ? c.id : ''}">Save${c ? '' : ' client'}</button><button class="btn" data-act="modal-close">Close</button><span class="spacer"></span>${c ? `<button class="btn danger" data-act="client-delete" data-id="${c.id}">Delete</button>` : ''}</div>
  </div></div>`;
}
function openModal(html) { closeModal(); const d = document.createElement('div'); d.id = 'modalRoot'; d.innerHTML = html; document.body.appendChild(d); const f = d.querySelector('input,select'); if (f) f.focus(); }
function closeModal() { const m = $('#modalRoot'); if (m) m.remove(); }

/* ============================================================ events */
function after(sec, id) {
  const gs = $('#gigSearch'); if (gs) gs.oninput = e => { UI.gigSearch = e.target.value; keepUI(); rerenderKeepFocus('#gigSearch'); };
  const gy = $('#gigYear'); if (gy) gy.onchange = e => { UI.gigYear = e.target.value; keepUI(); render(); };
  const ss = $('#songSearch'); if (ss) ss.oninput = e => { UI.songSearch = e.target.value; keepUI(); rerenderKeepFocus('#songSearch'); };
  const ls = $('#libSearch'); if (ls) ls.oninput = e => { UI.libSearch = e.target.value; rerenderKeepFocus('#libSearch'); };
  const cf = $('#copyFrom'); if (cf) cf.onchange = e => e.target.value && copySetlist(id, e.target.value);
  if (sec === 'setlist') {
    const L = byId('setlists', id);
    const saveMeta = async () => { const r = { ...byId('setlists', id), name: $('#slName').value.trim() || null, notes: $('#slNotes').value.trim() || null }; if (r.name !== L.name || r.notes !== L.notes) { await guard(() => save('setlists', r), 'Saved'); render(); } };
    const nm = $('#slName'), nt = $('#slNotes'); if (nm) nm.onchange = saveMeta; if (nt) nt.onchange = saveMeta;
    const as = $('#slAssign'); if (as) as.onchange = e => e.target.value && assignSetlist(id, e.target.value);
  }
  $$('[data-photo]').forEach(inp => inp.onchange = e => { const f = e.target.files[0]; e.target.value = ''; addGigPhoto(byId('gigs', inp.dataset.photo), f); });
  $$('[data-si-note]').forEach(el => el.onchange = async e => { const i = byId('setlist_items', el.dataset.siNote); if (!i) return; const v = e.target.value.trim() || null; if ((i.note || null) !== v) await guard(() => save('setlist_items', { ...i, note: v })); });
  hydratePhotos();
  $$('[data-act-change="sl-attach"]').forEach(el => el.onchange = e => e.target.value && assignSetlist(e.target.value, el.dataset.gig));
  if (sec === 'gig') $$('[data-f],[data-c]').forEach(el => el.addEventListener('input', () => { S.dirty = true; const n = $('#dirtyNote'); if (n) n.textContent = 'Unsaved changes'; }));
  if (sec === 'gig') $$('[data-f="client_id"]').forEach(sel => sel.addEventListener('change', () => fillClient(sel.value)));
}
function rerenderKeepFocus(sel) { const el = $(sel); const pos = el ? el.selectionStart : 0; render(); const n = $(sel); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch {} } }

document.addEventListener('change', e => {
  if (!(e.target.matches && e.target.matches('#modalRoot [data-optplan]') && S._opt)) return;
  const was = { ...(S._opt.plan || {}) }; readOpt(); const now = S._opt.plan;
  if (e.target.dataset.optplan === 'set_count' && n0(was.break_count) === n0(was.set_count) - 1) now.break_count = Math.max(0, Math.round(n0(now.set_count) || 1) - 1);   // keep "a break between each set"
  S._opt.res = null; refreshOpt();
});

document.addEventListener('change', async e => {
  const t = e.target; if (!t.matches) return;
  if (t.matches('[data-chart-up]')) {
    const f = t.files[0], sid = t.dataset.chartUp; t.value = ''; if (!f) return;
    try { toast('Uploading chart…'); await uploadChart(sid, f); toast('Chart saved'); refreshChartBox(sid); } catch (err) { toast(err.message || 'Upload failed', true); }
  } else if (t.matches('[data-chart-import]')) {
    const files = [...t.files]; t.value = ''; if (!files.length) return;
    if (!S.me) return toast('Your login isn’t on the band roster yet.', true);
    S._imp = { rows: files.map(f => { const s = matchSong(f.name); return { file: f, songId: s ? s.id : '' }; }) }; openModal(importModal());
  } else if (t.matches('[data-imp]')) {
    S._imp.rows[Number(t.dataset.imp)].songId = t.value; const n = S._imp.rows.filter(r => r.songId).length, b = $('[data-act="chart-import-go"]');
    if (b) { b.textContent = `Upload ${n} chart${n === 1 ? '' : 's'}`; b.disabled = !n; }
  } else if (t.matches('[data-media-mode]')) {
    UI.media = t.checked; keepUI(); toast(t.checked ? 'Gig mode will listen for music-control buttons' : 'Music-control mode off');
  } else if (t.matches('[data-ftr]')) {
    UI.fpx = Number(t.value); keepUI(); render();
  } else if (t.matches('[data-hdr]')) {
    UI.hdr = Number(t.value); keepUI(); render();
  } else if (t.matches('[data-song-stars]')) {
    UI.songStars = t.value; keepUI(); render();
  } else if (t.matches('[data-text-size]')) {
    UI.tz = t.value === 'auto' ? null : Number(t.value); keepUI(); render();
  } else if (t.matches('[data-chart-default]')) {
    if (!S.me) return;
    try { if (!t.value) { await api.remove('chart_defaults', { member_id: S.me.id }); S.chart_defaults = S.chart_defaults.filter(d => d.member_id !== S.me.id); } else await saveMany('chart_defaults', [{ member_id: S.me.id, use_member_id: t.value }]); toast('Saved'); render(); }
    catch (err) { toast(err.message || 'Could not save', true); }
  }
});

document.addEventListener('submit', async e => {
  if (e.target.id !== 'loginForm') return; e.preventDefault();
  const msg = $('#lgMsg'); msg.textContent = '';
  try { await api.signIn($('#lgEmail').value.trim(), $('#lgPass').value); } catch (err) { msg.textContent = err.message; }
});

document.addEventListener('click', async e => {
  const hrefRow = e.target.closest('tr[data-href]'); if (hrefRow && !e.target.closest('a,button')) { location.hash = hrefRow.dataset.href; return; }
  { const wm = $('#whoMenu'); if (wm && !wm.hidden && !e.target.closest('#whoMenu,[data-act="who-menu"]')) wm.hidden = true; }      // click anywhere else closes the account menu
  const el = e.target.closest('[data-act]'); if (!el) return;
  const fc = e.target.closest('input,textarea,select'); if (fc && fc !== el) return;                       // typing in a field never fires the card around it
  if (el.closest('[data-stop]') && el.dataset.act === 'modal-close' && el.classList.contains('scrim')) return;
  if (el.classList.contains('scrim') && e.target !== el) return;
  const act = el.dataset.act, v = el.dataset.v, id = el.dataset.id;
  const route = (location.hash || '#home').slice(1).split('/');
  const L = route[0] === 'setlist' ? byId('setlists', route[1]) : null;
  const g = route[0] === 'gig' ? byId('gigs', route[1]) : L ? slCtx(L) : null;        // on a setlist page, g is the setlist with gig details filled in
  if (el.tagName === 'A' && el.getAttribute('href') === '#') e.preventDefault();
  if (act === 'rate' || el.closest('.stars')) e.stopPropagation();
  const H = ACTIONS[act]; if (H) await H({ el, v, id, g, e });
});

const ACTIONS = {
  magic: async () => { const em = $('#lgEmail').value.trim(); const msg = $('#lgMsg'); if (!em) { msg.textContent = 'Enter your email first.'; return; } try { await api.magic(em); msg.style.color = 'var(--ok)'; msg.textContent = 'Check your email for a sign-in link.'; } catch (err) { msg.textContent = err.message; } },
  reload: () => location.reload(),
  signout: async () => { await idbClear(); await api.signOut(); },
  'go-online': () => tryOnline(false),
  'modal-close': () => closeModal(),
  'gig-filter': ({ v }) => { UI.gigFilter = v; keepUI(); render(); },
  'song-sort': ({ v }) => { if (UI.songSort === v) UI.songSortDir = UI.songSortDir === 'desc' ? 'asc' : 'desc'; else { UI.songSort = v; UI.songSortDir = ['length', 'mine', 'avg', 'plays', 'last', 'year'].includes(v) ? 'desc' : 'asc'; } keepUI(); render(); },
  'song-nochart': () => { UI.songNoChart = !UI.songNoChart; keepUI(); render(); },
  'song-flag': ({ v }) => { UI.songFlag = UI.songFlag === v ? '' : v; keepUI(); render(); },
  'song-filter': ({ v }) => { UI.songFilter = v; keepUI(); render(); },
  'lib-filter': ({ v }) => { UI.libFilter = v; render(); },
  'money-year': ({ v }) => { UI.moneyYear = v; keepUI(); render(); },
  'cal-move': ({ v }) => { const b = UI.calMonth ? pd(UI.calMonth + '-01') : new Date(today().getFullYear(), today().getMonth(), 1); const step = UI.calSpan === '3mo' ? 3 : 1; const d = v === '0' ? today() : new Date(b.getFullYear(), b.getMonth() + Number(v) * step, 1); UI.calMonth = iso(d).slice(0, 7); keepUI(); render(); },
  'new-gig': async () => { const r = await guard(() => save('gigs', { id: uuid(), kind: 'gig', status: 'inquiry', title: 'New lead', payee_id: (S.payees.find(p => p.is_default) || {}).id || null })); if (r) { S.editGig = r.id; location.hash = '#gig/' + r.id; } },
  'new-practice': async () => {
    const last = S.gigs.filter(x => x.kind === 'practice').sort((a, b) => (b.gig_date || '').localeCompare(a.gig_date || ''))[0] || {};
    const nextGig = upcoming(['gig']).find(x => x.status === 'confirmed');
    const r = await guard(() => save('gigs', { id: uuid(), kind: 'practice', title: 'Practice', gig_date: todayIso(), start_time: last.start_time || '8pm', venue: last.venue || "Jessie's", notes: nextGig ? `Setlist run for ${nextGig.title}` : '' }));
    if (r) { S.editGig = r.id; location.hash = '#gig/' + r.id; }
  },
  'set-status': async ({ v, g }) => { if (!g) return; const patch = collectGig(g); patch.status = v; if (v === 'complete' && patch.paid == null && !patch.deposit_received && n0(patch.quote)) toast('Marked played — log what was paid below.'); await guard(() => save('gigs', patch), 'Status: ' + STATUS_LABEL[v]); S.dirty = false; render(); },
  'save-gig': async ({ g }) => { if (!g) return; await saveGigForm(g); },
  'del-gig-ask': ({ el }) => { el.parentElement.innerHTML = `<span class="confirm">Delete this ${byId('gigs', (location.hash.split('/')[1]))?.kind === 'practice' ? 'practice' : 'gig'} and its setlist? <button class="btn danger sm" data-act="del-gig">Yes, delete</button><button class="btn sm" data-act="cancel-del">Keep</button></span>`; },
  'cancel-del': () => render(),
  'fold-all': ({ v }) => { $$('details[data-fold]').forEach(d => d.open = v === '1'); },
  'del-gig': async ({ g }) => { if (!g) return; await guard(() => del('gigs', g.id), 'Deleted'); S.setlists.forEach(l => { if (l.gig_id === g.id) l.gig_id = null; }); S.dirty = false; location.hash = '#gigs'; },
  pdf: async ({ v, g }) => { if (!g) return; if (S.dirty) await saveGigForm(g, true); await pdfFor(byId('gigs', g.id), v); },
  mail: async ({ v, g }) => { if (!g) return; if (S.dirty) await saveGigForm(g, true); openModal(mailModal(byId('gigs', g.id), v)); },
  'copy-mail': () => copy($('#mailBody').textContent),
  'ics-one': ({ g }) => g && download(`${g.kind === 'practice' ? 'Practice' : g.title} ${g.gig_date || ''}.ics`, icsFor([g]), 'text/calendar'),
  'ics-all': () => download('Trailer Folk calendar.ics', icsFor(S.gigs.filter(x => x.gig_date && x.gig_date >= iso(new Date(Date.now() - 90 * 864e5)) && (x.kind === 'practice' || live(x)))), 'text/calendar'),
  'copy-feed': () => copy($('#feedUrl').value),
  'rotate-token': async () => { const st = settings(); await guard(() => save('settings', { ...st, ics_token: uuid() }), 'New link made — re-subscribe on each phone'); render(); },
  'photo-open': ({ el }) => { if (!el.src) return; openModal(`<div class="scrim" data-act="modal-close" style="align-items:center"><img class="lightbox" src="${el.src}" alt="Gig photo"></div>`); },
  'photo-del': async ({ el, g }) => {
    if (!g || !confirm('Remove this photo?')) return; const path = el.dataset.path;
    try { await api.removePhoto(path); } catch {}
    const cur = byId('gigs', g.id); const tile = el.closest('.ph');
    if (await guard(() => save('gigs', { ...cur, photos: photosOf(cur).filter(p => p.path !== path) }), 'Photo removed') && tile) tile.remove();
  },
  'si-note': ({ id }) => { S._noteOpen[id] = true; render(); const el = $(`[data-si-note="${id}"]`); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } },
  'pl-export': ({ g }) => { const L = g && byId('setlists', g.id); if (L) openModal(exportModal(L)); },
  'exp-copy': ({ id }) => { const L = byId('setlists', id); if (L) copy(exportText(exportRows(L))); },
  'exp-csv': ({ id }) => { const L = byId('setlists', id); if (L) download(`Playlist - ${slName(L)}.csv`, exportCsv(exportRows(L)), 'text/csv'); },
  'gig-mode': ({ g }) => { const L = g && (byId('setlists', g.id) || listOf(g.id)); if (!L) return toast('No setlist on this gig yet.', true); openGigMode(gmSeq(L), L.id); },   // works from a gig page or a setlist page
  'chart-open': ({ id }) => { const c = byId('song_charts', id); if (!c) return; openGigMode([{ item: {}, song: byId('songs', c.song_id), set: 1, forceChart: c }], null, { preview: true }); },
  'chart-use': async ({ el }) => {
    const sid = el.dataset.sid, m = el.dataset.m; if (!S.me) return;
    if (m === 'own') { await guard(() => api.remove('chart_prefs', { member_id: S.me.id, song_id: sid })); S.chart_prefs = S.chart_prefs.filter(p => !(p.member_id === S.me.id && p.song_id === sid)); }
    else await guard(() => saveMany('chart_prefs', [{ member_id: S.me.id, song_id: sid, use_member_id: m }]));
    refreshChartBox(sid);
  },
  'chart-del': async ({ id }) => {
    const c = byId('song_charts', id); if (!c || !confirm('Remove your chart for this song?')) return;
    try { await api.removeChart(c.path); } catch {}
    if (await guard(() => del('song_charts', id), 'Chart removed')) refreshChartBox(c.song_id);
  },
  'chart-import-go': async () => {
    const rows = S._imp.rows.filter(r => r.songId), st = $('#impStatus'); let ok = 0; const bad = [];
    for (let k = 0; k < rows.length; k++) { if (st) st.textContent = `Uploading ${k + 1} of ${rows.length}…`; try { await uploadChart(rows[k].songId, rows[k].file); ok++; } catch (e) { bad.push(`${rows[k].file.name}: ${e.message}`); } }
    closeModal(); render(); toast(bad.length ? `${ok} saved, ${bad.length} failed — ${bad[0]}` : `${ok} chart${ok === 1 ? '' : 's'} saved`, !!bad.length);
  },
  'ped-learn': ({ v, el }) => { pedLearn = v; $$('[data-act="ped-learn"]').forEach(b => b.classList.toggle('on', b === el)); const box = $('#pedStatus'); if (box) box.textContent = `Now press the pedal switch you want for “${v === 'next' ? 'next' : 'previous'}”…`; },
  'ped-media-test': () => { if (MEDIA.on) { mediaOff(); pedLog('music-control test stopped'); return toast('Music-control test stopped'); } if (!mediaOn((d, raw) => pedLog(`music button  ${raw}  →  ${d}`))) return toast('This browser can’t receive music-control buttons.', true); pedLog('listening for music-control buttons — press the pedal'); toast('Listening — press the pedal (tap Test again to stop)'); },
  'app-refresh': async () => { try { if (navigator.serviceWorker) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); if (window.caches) for (const k of await caches.keys()) await caches.delete(k); } catch {} toast('Updating…'); setTimeout(() => location.reload(), 400); },
  'ped-reset': () => { UI.ped = null; pedLearn = null; keepUI(); const box = $('#pedStatus'); if (box) box.textContent = 'Back to the standard keys (arrows, Page Up/Down, Space).'; },
  'gig-edit': ({ g }) => { if (!g) return; S.editGig = g.id; render(); },
  'gig-view': ({ g }) => { if (!g) return; if (S.dirty && !confirm('Discard your unsaved changes?')) return; S.editGig = null; S.dirty = false; render(); },
  'client-new': () => openModal(clientModal(null)),
  'client-edit': ({ id }) => openModal(clientModal(byId('clients', id))),
  'client-save': async ({ id }) => {
    const vals = {}; $$('[data-cl]').forEach(i => vals[i.dataset.cl] = i.value.trim() || null);
    if (!vals.org && !vals.contact_name) return toast('Add an organization or a contact name.', true);
    const base = id ? byId('clients', id) : null;
    const c = await guard(() => save('clients', { ...(base || { id: uuid() }), ...vals }), 'Client saved'); if (!c) return;
    const gid = ($('[data-cl-gig]') || {}).value, g = gid && byId('gigs', gid);
    if (g) await guard(() => save('gigs', { ...g, client_id: c.id }), `Tied to ${g.title}`);
    openModal(clientModal(c)); render();
  },
  'client-unlink': async ({ el }) => { const g = byId('gigs', el.dataset.gid); if (!g) return; if (await guard(() => save('gigs', { ...g, client_id: null }), 'Removed from the gig')) { openModal(clientModal(byId('clients', el.dataset.cid))); render(); } },
  'client-delete': async ({ id }) => {
    const c = byId('clients', id); if (!c) return;
    if (S.gigs.some(g => g.client_id === id)) return toast('Remove this client from its gigs first.', true);
    if (!confirm(`Delete ${c.org || c.contact_name}?`)) return;
    if (await guard(() => del('clients', id), 'Client deleted')) { closeModal(); render(); }
  },
  'who-menu': () => { const m = $('#whoMenu'); if (m) m.hidden = !m.hidden; },
  'gig-na': async ({ el, g }) => {
    if (!g) return; const k = el.dataset.k, cur = new Set(Array.isArray(g.checklist_na) ? g.checklist_na : []); cur.has(k) ? cur.delete(k) : cur.add(k);
    if (!(await guard(() => save('gigs', { ...g, checklist_na: [...cur] })))) return;
    const row = $(`[data-row="${k}"]`), na = cur.has(k);                    // update the row in place so nothing you're typing in edit mode is lost
    if (row) { row.classList.toggle('na', na); const cb = row.querySelector('input'); if (cb) cb.disabled = na; el.textContent = na ? 'Use' : 'N/A'; }
  },
  'gig-chk': async ({ el, g }) => {
    if (!g) return; const k = el.dataset.k, on = el.checked, r = { ...g, [k]: on };
    if (k === 'deposit_received') r.deposit_received_on = on ? (g.deposit_received_on || todayIso()) : null;
    if (k === 'paid_in_full') r.paid_on = on ? (g.paid_on || todayIso()) : g.paid_on;
    if (k === 'invoice_sent' && on && !g.invoiced_on) r.invoiced_on = todayIso();
    const ok = await guard(() => save('gigs', r), 'Saved');
    if (!ok) el.checked = !on;
    else if (S.editGig !== g.id) render();            // while editing, leave the form alone so nothing typed is lost
  },
  'sl-edit': ({ g }) => { if (!g) return; S.editSl = g.id; render(); },
  'sl-view': ({ g }) => { if (!g) return; S.editSl = null; render(); },
  'cal-span': ({ v }) => { UI.calSpan = v; keepUI(); render(); },
  'toggle-cb': ({ el }) => { UI.cb = el.checked; keepUI(); render(); },
  // setlists
  'sel-set': ({ v, e }) => { if (e.target.closest('button')) return; UI.selSet = Number(v); render(); },
  'lib-add': async ({ id, g }) => { if (!g) return; const its = itemsOf(g.id).filter(i => i.set_no === UI.selSet); await guard(() => save('setlist_items', { id: uuid(), setlist_id: g.id, set_no: UI.selSet, position: (its.length ? Math.max(...its.map(i => i.position)) : 0) + 1, song_id: id, played: true, pinned: false })); render(); },
  'si-del': async ({ id }) => { await guard(() => del('setlist_items', id)); render(); },
  'si-played': async ({ id }) => { const i = byId('setlist_items', id); await guard(() => save('setlist_items', { ...i, played: !i.played })); render(); },
  'si-move': async ({ id, v }) => {
    const i = byId('setlist_items', id); const its = itemsOf(i.setlist_id).filter(x => x.set_no === i.set_no); const k = its.findIndex(x => x.id === id); const j = k + Number(v);
    if (j < 0 || j >= its.length) return; [its[k], its[j]] = [its[j], its[k]];
    await guard(() => saveMany('setlist_items', its.map((x, n) => ({ ...x, position: n + 1 })))); render();
  },
  'si-set': async ({ id }) => { const i = byId('setlist_items', id); const P = slCtx(byId('setlists', i.setlist_id)); const n = planOf(P).sets; const to = i.set_no % n + 1; const its = itemsOf(P.id).filter(x => x.set_no === to); await guard(() => save('setlist_items', { ...i, set_no: to, position: (its.length ? Math.max(...its.map(x => x.position)) : 0) + 1 })); render(); },
  'si-pin': async ({ id }) => { const i = byId('setlist_items', id); await guard(() => save('setlist_items', { ...i, pinned: !i.pinned })); render(); },
  'plan-save': async ({ g }) => {
    const L = byId('setlists', g.id), gig = gigOf(L), r = { ...L };
    $$('[data-plan]').forEach(i => { const k = i.dataset.plan; r[k] = k === 'start_time' ? (i.value.trim() || null) : (i.value === '' ? null : Number(i.value)); });
    if (gig && r.start_time === gig.start_time) r.start_time = null;                 // keep following the gig unless changed here
    if (gig && r.hours != null && Number(r.hours) === n0(gig.hours)) r.hours = null;
    r.set_count = Math.max(1, Math.round(n0(r.set_count) || 1));
    const hi = Math.max(0, ...itemsOf(L.id).map(i => i.set_no));
    if (hi > r.set_count) return toast(`Set ${hi} still has songs — move or clear them before dropping to ${r.set_count} set${r.set_count > 1 ? 's' : ''}.`, true);
    const was = planOf(slCtx(L));
    if (r.break_count == null || (r.set_count !== was.sets && Number(r.break_count) === was.breaks && was.breaks === was.sets - 1)) r.break_count = r.set_count - 1;   // keep "a break between each set" when the set count changes
    r.break_count = Math.min(Math.max(0, Math.round(r.break_count)), r.set_count - 1);
    await guard(() => save('setlists', r), 'Plan updated'); render();
  },
  'opt-open': ({ g }) => { const pl = planOf(g); S._opt = { lid: g.id, prefs: optPrefs(g), res: null, plan: { start_time: g.start_time || '', hours: g.hours ?? '', set_count: pl.sets, break_count: pl.breaks, break_min: pl.breakMin } }; openModal(optModal(optCtx(g.id), S._opt.prefs, null)); },
  'opt-w': ({ el, v }) => { S._opt.prefs.w[el.dataset.k] = Number(v); readOpt(); refreshOpt(); },
  'opt-shape': ({ v }) => { S._opt.prefs.shape = v; readOpt(); refreshOpt(); },
  'opt-run': () => {
    readOpt(); const g = optCtx(S._opt.lid); const pr = S._opt.prefs;
    if (!Object.values(pr.pools).some(Boolean)) return toast('Pick at least one song pool.', true);
    if (!g.hours) toast('No slot length set — using the default set length.');
    S._opt.res = optimizeSetlist(g, pr, Date.now()); refreshOpt();
  },
  'opt-apply': async () => {
    const L = byId('setlists', S._opt.lid), res = S._opt.res; if (!res) return;
    const items = itemsOf(L.id), keepPinned = S._opt.prefs.keepPinned;
    const pinnedBySong = new Map(items.filter(i => keepPinned && i.pinned).map(i => [i.song_id, i]));
    const drop = items.filter(i => !(keepPinned && i.pinned)).map(i => i.id);
    const rows = []; res.result.forEach((l, k) => l.forEach((s, n) => { const p = pinnedBySong.get(s.id); rows.push(p ? { ...p, set_no: k + 1, position: n + 1 } : { id: uuid(), setlist_id: L.id, set_no: k + 1, position: n + 1, song_id: s.id, played: true, pinned: false }); }));
    const ok = await guard(async () => {
      if (drop.length) { await api.remove('setlist_items', { id: drop }); S.setlist_items = S.setlist_items.filter(i => !drop.includes(i.id)); }
      await saveMany('setlist_items', rows);
      const p = S._opt.plan || {}, gig = gigOf(L), sv = { ...byId('setlists', L.id), set_count: res.plan.sets, break_count: res.plan.breaks, break_min: res.plan.breakMin, plan: { ...(L.plan || {}), opt: S._opt.prefs } };
      sv.start_time = p.start_time && !(gig && p.start_time === gig.start_time) ? p.start_time : null;
      sv.hours = p.hours != null && p.hours !== '' && !(gig && Number(p.hours) === n0(gig.hours)) ? Number(p.hours) : null;
      await save('setlists', sv);
      return true;
    }, `Setlist built — ${rows.length} songs`);
    if (ok) { closeModal(); render(); }
  },
  'set-clear-ask': ({ el }) => { el.parentElement.innerHTML = `<span class="confirm">Remove every song? <button class="btn danger sm" data-act="set-clear">Clear</button><button class="btn sm" data-act="cancel-del">Keep</button></span>`; },
  'set-clear': async ({ g }) => { await guard(() => api.remove('setlist_items', { setlist_id: g.id })); S.setlist_items = S.setlist_items.filter(i => i.setlist_id !== g.id); render(); },
  'set-default': async ({ g }) => {
    if (itemsOf(g.id).length) { toast('Clear the setlist first, or add songs one at a time.', true); return; }
    const rows = S.songs.filter(s => s.status === 'active' && s.default_set).sort((a, b) => a.default_set - b.default_set || (a.default_order || 0) - (b.default_order || 0));
    const pos = {}; const ins = rows.map(s => { pos[s.default_set] = (pos[s.default_set] || 0) + 1; return { id: uuid(), setlist_id: g.id, set_no: s.default_set, position: pos[s.default_set], song_id: s.id, played: true, pinned: false }; });
    await guard(() => saveMany('setlist_items', ins), `${ins.length} songs added`); const L = byId('setlists', g.id); await guard(() => save('setlists', { ...L, set_count: Math.max(n0(L.set_count), ...ins.map(i => i.set_no), 1) })); render();
  },
  'set-pdf': ({ g }) => { if (!itemsOf(g.id).length) return toast('Add songs first.', true); stagePdf(g); },
  'set-text': ({ g }) => { const its = itemsOf(g.id).filter(i => i.played); const txt = [...new Set(its.map(i => i.set_no))].map(n => `SET ${n}\n` + its.filter(i => i.set_no === n).map((i, k) => { const s = byId('songs', i.song_id) || {}; return `${k + 1}. ${s.title} (${songLabel(s)})${i.note ? '\n   » ' + i.note : ''}`; }).join('\n')).join('\n\n'); copy(`${g.title}${g.gig_date ? ' — ' + fmtDate(g.gig_date) : ''}\n\n${txt}`); },
  // setlist records
  'sl-new': async ({ el }) => { const gid = el.dataset.gig || null; const r = await guard(() => save('setlists', { id: uuid(), gig_id: gid, name: null })); if (r) { S.editSl = r.id; location.hash = '#setlist/' + r.id; } },
  'sl-unassign': async ({ g }) => { const L = byId('setlists', g.id); await guard(() => save('setlists', { ...L, name: L.name || slName(L), gig_id: null }), 'Unassigned — kept as a draft'); render(); },
  'sl-dup': async ({ g }) => {
    const L = byId('setlists', g.id); const copyId = uuid();
    const r = await guard(async () => { const c = await save('setlists', { ...L, id: copyId, gig_id: null, name: `${slName(L)} (copy)`, created_at: undefined, updated_at: undefined }); await saveMany('setlist_items', itemsOf(L.id).map(i => ({ ...i, id: uuid(), setlist_id: copyId, created_at: undefined, updated_at: undefined }))); return c; }, 'Copied as a draft');
    if (r) { S.editSl = copyId; location.hash = '#setlist/' + copyId; }
  },
  'sl-del-ask': ({ el }) => { el.parentElement.innerHTML = `<span class="confirm">Delete this setlist and its songs? <button class="btn danger sm" data-act="sl-del">Delete</button><button class="btn sm" data-act="cancel-del">Keep</button></span>`; },
  'sl-del': async ({ g }) => { const id = g.id; if (await guard(() => del('setlists', id), 'Setlist deleted')) {} S.setlist_items = S.setlist_items.filter(i => i.setlist_id !== id); location.hash = '#setlists'; },
  // songs
  rate: async ({ id, v }) => { if (!S.me) return; const cur = myRating(id); const val = Number(v); if (cur === val) { await guard(() => api.remove('song_ratings', { song_id: id, member_id: S.me.id })); S.song_ratings = S.song_ratings.filter(r => !(r.song_id === id && r.member_id === S.me.id)); } else await guard(() => save('song_ratings', { song_id: id, member_id: S.me.id, rating: val })); render(); },
  'song-edit': ({ id, e }) => { if (e.target.closest('.stars')) return; openModal(songModal(byId('songs', id))); },
  'song-edit-mode': ({ id }) => openModal(songModal(byId('songs', id), true)),
  'song-view': ({ id }) => openModal(songModal(byId('songs', id))),
  'song-new': () => openModal(songModal({ status: 'learning', added_on: todayIso() })),
  'song-save': async ({ id }) => {
    const s = id ? { ...byId('songs', id) } : { id: uuid() };
    $$('[data-s]').forEach(i => { const k = i.dataset.s; if (k === 'length_fmt') { const m = i.value.trim().match(/^(\d+)(?::(\d{1,2}))?$/); s.length_min = m ? +m[1] + (+(m[2] || 0)) / 60 : null; } else if (k === 'energy') s[k] = i.value ? Number(i.value) : null; else if (i.type === 'checkbox') s[k] = i.checked; else s[k] = i.type === 'number' ? (i.value === '' ? null : Number(i.value)) : (i.value.trim() || null); });
    const parts = {}; $$('[data-part]').forEach(i => { if (i.value.trim()) parts[i.dataset.part] = i.value.trim(); }); s.parts = Object.keys(parts).length ? parts : null;
    if (!s.title) return toast('Give the song a title.', true);
    if (await guard(() => save('songs', s), 'Song saved')) { if (id) openModal(songModal(byId('songs', id))); else closeModal(); render(); }
  },
  'song-del-ask': ({ el }) => { el.parentElement.innerHTML = `<span class="confirm">Delete from the book and every setlist? <button class="btn danger sm" data-act="song-del">Delete</button></span>`; },
  'song-del': async () => { const id = $('[data-act="song-save"]').dataset.id; await guard(() => del('songs', id), 'Deleted'); S.setlist_items = S.setlist_items.filter(i => i.song_id !== id); closeModal(); render(); },
  // money
  'exp-new': () => openModal(expenseModal({ paid_by: S.me && S.me.id })),
  'exp-edit': ({ id }) => openModal(expenseModal(byId('expenses', id))),
  'exp-save': async ({ id }) => { const x = id ? { ...byId('expenses', id) } : { id: uuid() }; readX(x); if (!n0(x.amount)) return toast('Enter an amount.', true); if (await guard(() => save('expenses', x), 'Expense saved')) { closeModal(); render(); } },
  'exp-del': async ({ id }) => { await guard(() => del('expenses', id), 'Deleted'); closeModal(); render(); },
  'merch-item-new': () => openModal(merchItemModal({})),
  'merch-item-edit': ({ id }) => openModal(merchItemModal(byId('merch_items', id))),
  'merch-item-save': async ({ id }) => { const x = id ? { ...byId('merch_items', id) } : { id: uuid() }; readX(x); if (!x.name) return toast('Name the item.', true); if (await guard(() => save('merch_items', x), 'Saved')) { closeModal(); render(); } },
  'sale-new': () => { if (!S.merch_items.some(i => i.active)) return toast('Add a merch item first.', true); openModal(saleModal()); },
  'sale-save': async () => {
    const x = { id: uuid() }; readX(x); const item = byId('merch_items', x.item_id); x.qty = Math.max(1, n0(x.qty));
    if (x.amount == null) x.amount = n0(item && item.price) * x.qty;
    if (await guard(() => save('merch_sales', x))) { if (item) await guard(() => save('merch_items', { ...item, stock: n0(item.stock) - x.qty })); toast(`Sold ${x.qty} — ${money(x.amount)}`); closeModal(); render(); }
  },
  // settings
  'save-settings': async () => { const st = { ...settings() }; $$('[data-st]').forEach(i => st[i.dataset.st] = i.type === 'number' ? (i.value === '' ? null : Number(i.value)) : i.value); await guard(() => save('settings', st), 'Settings saved'); render(); },
  'save-members': async () => { const rows = S.members.map(m => ({ ...m })); $$('[data-m]').forEach(i => { const r = rows.find(x => x.id === i.dataset.m); r[i.dataset.k] = i.value.trim() || null; }); await guard(() => saveMany('members', rows), 'Roster saved'); render(); },
  'save-payees': async () => { const rows = S.payees.map(p => ({ ...p })); $$('[data-p]').forEach(i => { const r = rows.find(x => x.id === i.dataset.p); r[i.dataset.k] = i.value.trim() || null; }); await guard(() => saveMany('payees', rows), 'Pay-to saved'); render(); },
  'payee-new': async () => { await guard(() => save('payees', { id: uuid(), name: 'New pay-to', is_default: false })); render(); },
};
function optCtx(lid) {                                  // the setlist with the optimizer window's plan values laid over it
  const g = slCtx(byId('setlists', lid)), p = S._opt && S._opt.plan; if (!p) return g;
  const r = { ...g, start_time: p.start_time || null, hours: p.hours === '' || p.hours == null ? null : Number(p.hours), break_min: p.break_min == null ? g.break_min : n0(p.break_min) };
  r.set_count = Math.max(1, Math.round(n0(p.set_count) || 1));
  r.break_count = p.break_count == null || p.break_count === '' ? null : Math.min(Math.max(0, Math.round(n0(p.break_count))), r.set_count - 1);
  return r;
}
function readOpt() {
  $$('#modalRoot [data-optnum]').forEach(i => { S._opt.prefs[i.dataset.optnum] = Math.max(0, Math.round(n0(i.value))); });
  const pl = {}; $$('#modalRoot [data-optplan]').forEach(i => { const k = i.dataset.optplan; pl[k] = k === 'start_time' ? i.value.trim() : (i.value === '' ? '' : Number(i.value)); }); if (Object.keys(pl).length) S._opt.plan = pl; $$('#modalRoot [data-opt]').forEach(i => { const [a, b] = i.dataset.opt.split('.'); if (b) S._opt.prefs[a][b] = i.checked; else S._opt.prefs[a] = i.checked; }); }
function refreshOpt() { const m = $('#modalRoot .modal'); const sc = m ? m.parentElement.scrollTop : 0; openModal(optModal(optCtx(S._opt.lid), S._opt.prefs, S._opt.res)); const n = $('#modalRoot .scrim'); if (n) n.scrollTop = sc; }
function readX(x) { $$('#modalRoot [data-x]').forEach(i => { const k = i.dataset.x; x[k] = i.type === 'checkbox' ? i.checked : i.type === 'number' ? (i.value === '' ? null : Number(i.value)) : (i.value.trim() || null); }); }
function collectGig(g) {
  const r = { ...g };
  $$('[data-f]').forEach(i => { const k = i.dataset.f; r[k] = i.type === 'checkbox' ? i.checked : i.type === 'number' ? (i.value === '' ? null : Number(i.value)) : (i.value.trim() || null); });
  if (r.kind === 'practice') r.title = 'Practice';
  if (r.deposit_received && !g.deposit_received && !r.deposit_received_on) r.deposit_received_on = todayIso();
  if (r.paid != null && g.paid == null && !r.paid_on) r.paid_on = todayIso();
  return r;
}
function fillClient(id) {                                          // choosing a saved client copies its details into the form (None / New clears them)
  const c = id ? byId('clients', id) : null;
  $$('[data-c]').forEach(i => { i.value = c ? (c[i.dataset.c] || '') : ''; });
  const sum = $('[data-fold="client"] .sum'); if (sum) sum.textContent = c ? ([c.contact_name, c.org].filter(Boolean).join(' — ') || 'Saved client') : 'No client yet';
  S.dirty = true; const n = $('#dirtyNote'); if (n) n.textContent = 'Unsaved changes';
  if (c) toast('Client details filled in');
}
async function saveGigForm(g, quiet) {
  const r = collectGig(g);
  const cEls = $$('[data-c]');
  if (cEls.length) {
    const vals = {}; cEls.forEach(i => vals[i.dataset.c] = i.value.trim() || null);
    const has = Object.values(vals).some(Boolean);
    if (has) {
      const base = r.client_id ? byId('clients', r.client_id) : null;
      const changed = !base || Object.entries(vals).some(([k, v]) => (base[k] || null) !== v);
      if (changed) { const c = await guard(() => save('clients', { ...(base || { id: uuid() }), ...vals })); if (c) r.client_id = c.id; }
    }
  }
  if (await guard(() => save('gigs', r), quiet ? null : 'Saved')) { S.dirty = false; if (!quiet) { S.editGig = null; render(); } }
}
async function copySetlist(toId, fromId) {                // setlist ids
  if (itemsOf(toId).length) { toast('Clear this setlist before copying another one in.', true); render(); return; }
  const rows = itemsOf(fromId).map(i => ({ id: uuid(), setlist_id: toId, set_no: i.set_no, position: i.position, song_id: i.song_id, played: true, pinned: !!i.pinned, note: i.note || null }));
  await guard(() => saveMany('setlist_items', rows), `Copied ${rows.length} songs`);
  const L = byId('setlists', toId), F = byId('setlists', fromId), n = Math.max(...rows.map(x => x.set_no), 1);
  await guard(() => save('setlists', { ...L, set_count: Math.max(n0(L.set_count), n), break_count: L.break_count ?? F.break_count, break_min: L.break_min ?? F.break_min, plan: L.plan || F.plan }));
  render();
}
async function assignSetlist(lid, gid) {
  const L = byId('setlists', lid), g = byId('gigs', gid);
  if (listOf(gid)) { toast(`${g.title} already has a setlist — unassign it first.`, true); render(); return; }
  await guard(() => save('setlists', { ...L, gig_id: gid, name: L.name && L.name !== g.title ? L.name : null }), `Assigned to ${g.title}`);
  render();
}
// sale amount auto-fill
document.addEventListener('input', e => { if (e.target.matches('#modalRoot [data-x="qty"],#modalRoot [data-x="item_id"]')) { const it = $('#modalRoot [data-x="item_id"]'); const q = $('#modalRoot [data-x="qty"]'); const a = $('#modalRoot [data-x="amount"]'); if (it && a) a.placeholder = money(n0(it.selectedOptions[0] && it.selectedOptions[0].dataset.price) * n0(q.value)); } });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
window.addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

/* ============================================================ boot */
async function boot(session) {
  S.session = session; S.loaded = false;
  if (!session) return render();
  render();
  const snap = await snapLoad();
  try {
    await api.rpc('claim_membership');
    await (snap ? timeoutP(loadAll(), 10000) : loadAll());
  } catch (e) {
    console.error(e);
    if (snap && snap.user.id === session.user.id && isNetErr(e)) return bootOffline(snap, 'Couldn’t reach the server — showing the data saved on this device (view only).');
    $('#app').innerHTML = shell('home', `${title('Can’t reach the band book')}<div class="panel"><p>${esc(e.message || e)}</p><p class="small muted">If this says the schema must be one of the exposed schemas, add <b>band</b> under Supabase → Project Settings → Data API → Exposed schemas.</p><button class="btn gold" data-act="reload">Try again</button> <button class="btn" data-act="signout">Sign out</button></div>`);
    return;
  }
  render();
}
(async function init() {
  if (!window.__BAND_MOCK__ && !supa) { $('#app').innerHTML = '<main><p>Could not load the Supabase library — check your connection and reload.</p></main>'; return; }
  // a fresh open always lands on Home — but keep deep links (calendar invites) and sign-in links
  { const h = (location.hash || '').slice(1); if (h && !/^(gig|setlist)\//.test(h) && !/access_token|refresh_token|error|type=/.test(h)) history.replaceState(null, '', location.pathname + location.search + '#home'); }
  let first = true;
  if ('serviceWorker' in navigator && !window.__BAND_MOCK__) navigator.serviceWorker.register('sw.js').catch(() => {});
  api.onAuth(s => { if (first) return; if (S.offline && !s) return; if ((s && s.user.id) !== (S.session && S.session.user.id)) boot(s); });
  let s = null, netErr = false;
  try { s = await timeoutP(api.session(), 6000); } catch { netErr = true; }
  first = false;
  if (!s) {                                                          // no usable login: genuinely signed out, or just no signal?
    const snap = await snapLoad();
    if (snap && (netErr || navigator.onLine === false || !(await reachable()))) return bootOffline(snap);
  }
  boot(s);
  window.addEventListener('online', () => tryOnline(false));
  window.addEventListener('offline', () => { if (!S.loaded || !S.me) return; S.offline = true; if (S.dirty) toast('You’re offline — your changes can’t be saved until you reconnect.', true); else render(); });
  // refresh when someone comes back to the tab, so bandmates' edits show up
  document.addEventListener('visibilitychange', async () => { if (document.visibilityState !== 'visible' || !S.me) return; if (S.offline) return tryOnline(true); if (!$('#modalRoot') && !GM.open) refreshNow(false); });
})();
