/* Trailer Folk HQ — band admin app.
   Data lives in the `band` schema of the lawn-master Supabase project.
   Plain JS, no build step: edit and push to GitHub Pages. */
'use strict';

const SUPABASE_URL = 'https://uomhdexfwovuovtarycz.supabase.co';
const SUPABASE_KEY = 'sb_publishable_GP4wq5bwrQ3M0qCTwQei4A_Lsk_zBcK';   // publishable key only — never the secret key
const CAL_FUNCTION = 'band-calendar';                                        // Edge Function name for the live calendar feed

/* ============================================================ data layer */
const TABLES = ['members','settings','payees','clients','gigs','songs','setlist_items','song_ratings','merch_items','merch_sales','expenses'];
const PK = { song_ratings: ['song_id','member_id'], settings: ['id'] };

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
  async remove(table, match) {
    let q = supa.from(table).delete();
    for (const [k, v] of Object.entries(match)) q = Array.isArray(v) ? q.in(k, v) : q.eq(k, v);
    const { error } = await q; if (error) throw error;
  },
};

const S = { session: null, me: null, loaded: false };
TABLES.forEach(t => S[t] = []);

async function loadAll() {
  const res = await Promise.all(TABLES.map(t => api.all(t)));
  TABLES.forEach((t, i) => S[t] = res[i]);
  S.loaded = true;
  S.me = S.members.find(m => S.session && m.user_id === S.session.user.id) || null;
}
async function save(table, row) {
  const [saved] = await api.upsert(table, [row]);
  const keys = PK[table] || ['id'];
  const i = S[table].findIndex(r => keys.every(k => r[k] === saved[k]));
  if (i >= 0) S[table][i] = saved; else S[table].push(saved);
  return saved;
}
async function saveMany(table, rows) {
  if (!rows.length) return [];
  const saved = await api.upsert(table, rows);
  const keys = PK[table] || ['id'];
  saved.forEach(r => { const i = S[table].findIndex(x => keys.every(k => x[k] === r[k])); if (i >= 0) S[table][i] = r; else S[table].push(r); });
  return saved;
}
async function del(table, id) {
  await api.remove(table, { id });
  S[table] = S[table].filter(r => r.id !== id);
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
const STATUS_LABEL = { inquiry: 'Inquiry', quoted: 'Quoted', confirmed: 'Booked', complete: 'Played', passed: 'Passed', cancelled: 'Cancelled' };
const isGig = g => g.kind === 'gig';
const live = g => isGig(g) && !['passed','cancelled'].includes(g.status);
const salesFor = id => S.merch_sales.filter(s => s.gig_id === id).reduce((a, s) => a + n0(s.amount), 0);
const expensesFor = id => S.expenses.filter(e => e.gig_id === id).reduce((a, e) => a + n0(e.amount), 0);
const depositIn = g => g.deposit_received ? n0(g.deposit_amount) : 0;
const pay = g => depositIn(g) + n0(g.paid);                                  // performance fee received
const merchOf = g => n0(g.merch) + salesFor(g.id);
const gross = g => pay(g) + n0(g.tips) + merchOf(g);
const balanceDue = g => g.status === 'complete' && n0(g.quote) > 0 ? Math.max(0, n0(g.quote) - pay(g)) : 0;
const setItems = id => S.setlist_items.filter(i => i.gig_id === id).sort((a, b) => a.set_no - b.set_no || a.position - b.position);
const songsPlayed = g => { const it = setItems(g.id).filter(i => i.played); return it.length || n0(g.songs_played_legacy); };
const upcoming = (kinds = ['gig','practice']) => S.gigs.filter(g => g.gig_date && g.gig_date >= todayIso() && kinds.includes(g.kind) && (g.kind === 'practice' || ['confirmed','quoted','inquiry'].includes(g.status))).sort((a, b) => a.gig_date.localeCompare(b.gig_date));
const statusPill = g => g.kind === 'practice' ? '<span class="pill st-practice">Practice</span>' : `<span class="pill st-${g.status}">${STATUS_LABEL[g.status] || g.status}</span>`;
const yearOf = s => s ? Number(s.slice(0, 4)) : null;
const clientOf = g => g.client_id ? byId('clients', g.client_id) : null;
const payeeOf = g => (g.payee_id && byId('payees', g.payee_id)) || S.payees.find(p => p.is_default) || S.payees[0] || {};
const songStats = () => {
  const m = {};
  S.setlist_items.forEach(i => {
    if (!i.played) return; const g = byId('gigs', i.gig_id); if (!g || g.status !== 'complete') return;
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
      if (n0(g.quote) > 0 && !g.invoice_no && balanceDue(g) > 0) add('hi', g, `No invoice sent — ${money(balanceDue(g))} still due.`, 'Invoice');
      else if (g.invoiced_on && balanceDue(g) > 0 && days(g.invoiced_on, t) > terms) add('hi', g, `Invoice ${g.invoice_no} is ${days(g.invoiced_on, t) - terms} days past ${st.default_terms || 'NET30'} — ${money(balanceDue(g))} due.`, 'Follow up');
      else if (g.invoiced_on && balanceDue(g) > 0) add('lo', g, `Waiting on payment for ${g.invoice_no} (${money(balanceDue(g))}, due ${mdY(iso(new Date(pd(g.invoiced_on).getTime() + terms * 864e5)))}).`, 'Open');
    }
    if (g.status === 'confirmed' && n0(g.deposit_amount) > 0 && !g.deposit_received) add('md', g, `Deposit of ${money(g.deposit_amount)} not received yet.`, 'Deposit');
    if (['confirmed'].includes(g.status) && d && d >= t && days(t, d) <= (st.remind_setlist_days || 14) && !setItems(g.id).length) add(days(t, d) <= 5 ? 'hi' : 'md', g, `Gig in ${days(t, d)} days and no setlist yet.`, 'Build set');
    if (g.status === 'confirmed' && d && d >= t && days(t, d) <= 21 && (!g.start_time || !g.venue || /tbd/i.test(g.venue || ''))) add('md', g, 'Missing start time or venue — lock in details with the client.', 'Details');
    if (g.status === 'confirmed' && !d) add('md', g, 'Booked but no date set.', 'Details');
    if (g.status === 'inquiry' && !g.quote) add('md', g, 'New inquiry — send a quote.', 'Quote');
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
  gigs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  set: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  songs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z"/></svg>',
  money: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2v20M17 6.5c0-1.9-2.2-3-5-3s-5 1.3-5 3.3 2 2.8 5 3.4 5 1.4 5 3.5-2.2 3.3-5 3.3-5-1.1-5-3"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
};
const NAV = [['home','Home','home'],['gigs','Gigs','gigs'],['calendar','Calendar','cal'],['setlists','Setlists','set'],['songs','Songs','songs'],['money','Money','money'],['settings','Band','gear']];

function shell(route, inner) {
  const sec = route.split('/')[0];
  const on = k => (k === sec || (k === 'gigs' && sec === 'gig') || (k === 'setlists' && sec === 'setlist')) ? 'on' : '';
  const me = S.me;
  return `
  <header class="top">
    <a class="brand" href="#home"><img src="assets/logo.png" alt="Trailer Folk"><span class="hide-sm">HQ</span></a>
    <div class="row" style="gap:0;align-items:stretch">
      <nav class="nav">${NAV.map(([k, l]) => `<a href="#${k}" class="${on(k)}">${l}</a>`).join('')}</nav>
      <a class="who" href="#settings" style="text-decoration:none" title="Band & settings">${me ? `<img src="${photo(me)}" alt=""><span class="nm small muted">${esc(me.name)}</span>` : ''}</a>
    </div>
  </header>
  <main class="view">${inner}</main>
  <nav class="tabbar">${NAV.filter(n => n[0] !== 'settings').map(([k, l, i]) => `<a href="#${k}" class="${on(k)}">${ICON[i]}${l}</a>`).join('')}</nav>`;
}
const title = (t, sub) => `<h1 class="echo disp"><span class="solid">${esc(t)}</span><span class="ghost" aria-hidden="true">${esc(t)}</span></h1>${sub ? `<p class="muted" style="margin:-10px 0 22px">${sub}</p>` : ''}`;

/* ============================================================ router */
let UI = { gigFilter: 'upcoming', gigSearch: '', gigYear: 'all', calMonth: null, songFilter: 'active', songSearch: '', songSort: 'title', moneyYear: String(new Date().getFullYear()), selSet: 1, libFilter: 'active', libSearch: '' };
try { Object.assign(UI, JSON.parse(localStorage.getItem('tfhq-ui') || '{}')); } catch {}
const keepUI = () => { try { localStorage.setItem('tfhq-ui', JSON.stringify(UI)); } catch {} };

function render() {
  const app = $('#app');
  if (!S.session) return app.innerHTML = loginView();
  if (!S.loaded) return app.innerHTML = shell('home', '<p class="muted">Loading the band book…</p>');
  if (!S.me) return app.innerHTML = notMemberView();
  const route = (location.hash || '#home').slice(1);
  const [sec, id] = route.split('/');
  const views = { home: homeView, gigs: gigsView, gig: () => gigView(id), calendar: calendarView, setlists: setlistsView, setlist: () => setlistView(id), songs: songsView, money: moneyView, settings: settingsView };
  const y = window.scrollY, same = S._route === route;
  app.innerHTML = shell(route, (views[sec] || homeView)());
  if (same) window.scrollTo(0, y); else window.scrollTo(0, 0);
  S._route = route;
  after(sec, id);
}
window.addEventListener('hashchange', () => { if (S.dirty && !confirmLeave()) return; render(); });
function confirmLeave() { S.dirty = false; return true; }

/* ============================================================ login */
function loginView() {
  return `<div class="login">
    <div class="ph" role="img" aria-label="Trailer Folk on stage"></div>
    <form class="fm" id="loginForm">
      <img src="assets/logo.png" alt="Trailer Folk">
      ${title('Band HQ')}
      <p class="muted" style="margin-top:-8px">Gigs, setlists, invoices and the money — all in one place. Band members only.</p>
      <div class="stack">
        <label class="f">Email<input class="in" id="lgEmail" type="email" autocomplete="username" required></label>
        <label class="f">Password<input class="in" id="lgPass" type="password" autocomplete="current-password"></label>
        <div class="row"><button class="btn gold" type="submit">Sign in</button><button class="btn" type="button" data-act="magic">Email me a sign-in link</button></div>
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
  const t = todayIso(), st = settings();
  const up = upcoming();
  const next = up[0];
  const nextGig = up.find(g => g.kind === 'gig' && g.status === 'confirmed');
  const lastGig = S.gigs.filter(g => isGig(g) && g.status === 'complete' && g.gig_date && g.gig_date <= t).sort((a, b) => b.gig_date.localeCompare(a.gig_date))[0];
  const lastPrac = S.gigs.filter(g => g.kind === 'practice' && g.gig_date && g.gig_date <= t).sort((a, b) => b.gig_date.localeCompare(a.gig_date))[0];
  const yr = new Date().getFullYear();
  const played = S.gigs.filter(g => isGig(g) && g.status === 'complete' && yearOf(g.gig_date) === yr);
  const grossY = played.reduce((a, g) => a + gross(g), 0);
  const hrs = played.reduce((a, g) => a + n0(g.hours), 0);
  const booked = S.gigs.filter(g => isGig(g) && g.status === 'confirmed' && g.gig_date >= t);
  const pipeline = booked.reduce((a, g) => a + n0(g.quote), 0);
  const att = attention();
  const n = next ? days(t, next.gig_date) : null;
  return `
  ${next ? `<a class="next" href="#gig/${next.id}" style="text-decoration:none;color:inherit;margin-bottom:18px">
     <div><div class="eyebrow">${next.kind === 'practice' ? 'Next practice' : 'Next gig'}</div>
       <div class="when">${n === 0 ? 'Tonight' : n === 1 ? 'Tomorrow' : 'In ' + n + ' days'}</div>
       <div class="what">${esc(next.kind === 'practice' ? 'Practice' + (next.notes ? ' — ' + next.notes : '') : next.title)}</div>
       <div class="muted">${fmtDate(next.gig_date, true)}${next.start_time ? ' · ' + esc(next.start_time) : ''}${next.venue ? ' · ' + esc(next.venue) : ''}</div>
       ${next.kind === 'gig' ? `<div class="row" style="margin-top:12px">${statusPill(next)}<span class="small muted">${setItems(next.id).length ? setItems(next.id).length + ' songs on the setlist' : 'No setlist yet'}</span></div>` : ''}
     </div></a>` : `<div class="next" style="margin-bottom:18px"><div><div class="eyebrow">Next up</div><div class="when">Nothing booked</div><div class="muted">Add a lead or a practice to get the calendar moving.</div></div></div>`}
  <div class="grid g4" style="margin-bottom:18px">
    ${kpi(played.length, `Gigs played in ${yr}`, booked.length + ' more booked')}
    ${kpi(money(grossY), `Gross ${yr}`, 'pay + tips + merch')}
    ${kpi(hrs ? money(grossY / hrs) : '—', '$ per gig hour', `${yr}, all-in`)}
    ${kpi(money(pipeline), 'Booked, not yet played', booked.length + ' gig' + (booked.length === 1 ? '' : 's'))}
  </div>
  <div class="split">
    <section class="panel">
      <div class="row"><h2 class="sec" style="margin:0">Needs attention</h2><span class="spacer"></span><span class="small muted">${att.length} item${att.length === 1 ? '' : 's'}</span></div>
      <div class="list" style="margin-top:8px">${att.length ? att.slice(0, 14).map(a => `
        <a class="li" href="${a.href || (a.act === 'Build set' ? '#setlist/' + a.g.id : a.act === 'Add practice' ? '#calendar' : '#gig/' + a.g.id)}" style="align-items:flex-start">
          <span class="sev ${a.sev}"></span>
          <div class="grow"><div class="t">${a.g ? esc(a.g.title) : 'Band'}</div><div class="small muted" style="white-space:normal">${esc(a.text)}</div></div>
          <span class="btn sm">${a.act}</span></a>`).join('') : '<div class="empty">All caught up. Nothing needs you right now.</div>'}
      </div>
    </section>
    <div class="stack">
      <section class="panel">
        <h2 class="sec">Coming up</h2>
        <div class="list">${up.slice(0, 6).map(gigLi).join('') || '<div class="empty">Nothing on the calendar.</div>'}</div>
        <div class="row" style="margin-top:12px"><button class="btn sm gold" data-act="new-gig">+ Lead / gig</button><button class="btn sm" data-act="new-practice">+ Practice</button></div>
      </section>
      <section class="panel grid g2">
        ${kpi(lastGig ? days(lastGig.gig_date, t) : '—', 'Days since last gig', lastGig ? esc(lastGig.title) : '')}
        ${kpi(lastPrac ? days(lastPrac.gig_date, t) : '—', 'Days since practice', lastPrac ? fmtDate(lastPrac.gig_date) : '')}
      </section>
    </div>
  </div>`;
}
const kpi = (v, l, d) => `<div class="panel kpi"><div class="l">${l}</div><div class="v num">${v}</div>${d ? `<div class="d">${d}</div>` : ''}</div>`;
function gigLi(g) {
  const d = pd(g.gig_date);
  const amt = g.kind === 'practice' ? '' : g.status === 'complete' ? money(gross(g)) : g.quote ? money(g.quote) : '';
  return `<a class="li" href="#gig/${g.id}">
    <div class="date">${d ? `<small>${MON[d.getMonth()]}</small><b>${d.getDate()}</b><small>${String(d.getFullYear()).slice(2)}</small>` : '<small>TBD</small>'}</div>
    <div class="grow"><div class="t">${esc(g.kind === 'practice' ? 'Practice' : g.title)}</div>
      <div class="s">${[g.start_time, g.venue, g.kind === 'practice' ? g.notes : ''].filter(Boolean).map(esc).join(' · ') || '&nbsp;'}</div></div>
    ${statusPill(g)}<div class="amt hide-sm" style="min-width:64px">${amt}</div></a>`;
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
  return `${title('Gigs', 'Every lead, booking, practice and pass — the old Gig List and Passed tabs in one place.')}
   <div class="row" style="margin-bottom:14px">
     <div class="chips">${[['upcoming','Upcoming'],['leads',`Leads (${counts('leads')})`],['booked',`Booked (${counts('booked')})`],['played','Played'],['practices','Practices'],['passed','Passed'],['all','All']].map(([k, l]) => `<button class="chip ${f === k ? 'on' : ''}" data-act="gig-filter" data-v="${k}">${l}</button>`).join('')}</div>
     <span class="spacer"></span>
     <select class="in" id="gigYear" style="width:auto"><option value="all">All years</option>${years.map(y => `<option ${UI.gigYear == y ? 'selected' : ''}>${y}</option>`).join('')}</select>
     <input class="in" id="gigSearch" placeholder="Search" value="${esc(UI.gigSearch)}" style="width:180px">
     <button class="btn gold" data-act="new-gig">+ Lead / gig</button><button class="btn" data-act="new-practice">+ Practice</button>
   </div>
   <section class="panel"><div class="list">${rows.map(gigLi).join('') || '<div class="empty">Nothing here.</div>'}</div></section>`;
}

/* ============================================================ gig detail */
function gigView(id) {
  const g = byId('gigs', id);
  if (!g) return `${title('Not found')}<p class="muted">That gig may have been deleted. <a href="#gigs">Back to gigs</a></p>`;
  const st = settings(), c = clientOf(g) || {}, practice = g.kind === 'practice';
  const items = setItems(g.id);
  const f = (key, label, type = 'text', cls = '', extra = '') => `<label class="f ${cls}">${label}<input class="in" data-f="${key}" type="${type}" value="${esc(g[key] ?? '')}" ${type === 'number' ? 'step="any" inputmode="decimal"' : ''} ${extra}></label>`;
  const stepper = practice ? '' : `<div class="chips" style="margin-bottom:6px">${STATUSES.map(s => `<button class="chip ${g.status === s ? 'on' : ''}" data-act="set-status" data-v="${s}">${STATUS_LABEL[s]}</button>`).join('')}</div>`;
  const totalDur = items.reduce((a, i) => a + n0((byId('songs', i.song_id) || {}).length_min), 0);
  return `
  <div class="row" style="margin-bottom:6px"><a href="#gigs" class="small">← Gigs</a></div>
  ${title(practice ? 'Practice' : g.title, `${fmtDate(g.gig_date, true)}${g.start_time ? ' · ' + esc(g.start_time) : ''}${g.venue ? ' · ' + esc(g.venue) : ''}`)}
  ${stepper}
  <div class="split" style="margin-top:14px">
   <div class="stack">
    <section class="panel"><h2 class="sec">Details</h2>
      <div class="fgrid">
        ${practice ? '' : f('title', 'Name', 'text', 'w2')}
        ${f('gig_date', 'Date', 'date')}
        ${f('start_time', 'Start', 'text', '', 'placeholder="7pm"')}
        ${practice ? f('end_time', 'End') : f('end_time', 'End', 'text', '', 'placeholder="9pm"')}
        ${f('venue', practice ? 'Where' : 'Venue', 'text', practice ? 'w2' : 'w2')}
        ${practice ? '' : f('address', 'Address', 'text', 'w2')}
        <label class="f w4">${practice ? 'Plan' : 'Notes'}<textarea class="in" data-f="notes">${esc(g.notes || '')}</textarea></label>
      </div>
    </section>
    ${practice ? '' : `
    <section class="panel"><h2 class="sec">Client</h2>
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
    </section>
    <section class="panel"><h2 class="sec">Money</h2>
      <div class="fgrid">
        ${f('quote', 'Quote $', 'number')}${f('hours', 'Hours', 'number')}
        ${f('deposit_amount', 'Deposit $', 'number')}
        <label class="f">Deposit in<span class="check" style="padding:9px 0"><input type="checkbox" data-f="deposit_received" ${g.deposit_received ? 'checked' : ''}> Received</span></label>
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
    </section>`}
    <div class="row"><button class="btn gold" data-act="save-gig">Save changes</button><span id="dirtyNote" class="small muted"></span><span class="spacer"></span>
      <span id="delWrap"><button class="btn danger sm" data-act="del-gig-ask">Delete</button></span></div>
   </div>
   <div class="stack">
    ${practice ? '' : `
    <section class="panel"><h2 class="sec">Paperwork</h2>
      <div class="stack">
        <div class="row"><div class="grow"><b>Quote</b><div class="small muted">${g.quote_no ? esc(g.quote_no) + ' · sent ' + mdY(g.quoted_on) : 'Not sent yet'}</div></div><button class="btn sm gold" data-act="pdf" data-v="quote">Quote PDF</button></div>
        <div class="row"><div class="grow"><b>Invoice</b><div class="small muted">${g.invoice_no ? esc(g.invoice_no) + ' · ' + mdY(g.invoiced_on) : 'Not invoiced yet'}</div></div><button class="btn sm gold" data-act="pdf" data-v="invoice">Invoice PDF</button></div>
        <div class="row" style="flex-wrap:wrap"><button class="btn sm" data-act="mail" data-v="quote">Quote email</button><button class="btn sm" data-act="mail" data-v="deposit">Deposit reminder</button><button class="btn sm" data-act="mail" data-v="details">Gig-week details</button><button class="btn sm" data-act="mail" data-v="invoice">Invoice email</button><button class="btn sm" data-act="mail" data-v="thanks">Thank-you</button></div>
        <p class="small faint" style="margin:0">Generating a PDF stamps the quote/invoice number and date on this gig.</p>
      </div>
    </section>`}
    <section class="panel"><h2 class="sec">Setlist</h2>
      ${items.length ? `<p class="muted" style="margin-top:0">${items.length} songs across ${new Set(items.map(i => i.set_no)).size} set(s) · about ${hm(totalDur + items.length * (st.song_buffer_sec || 10) / 60)} with transitions</p>` : `<p class="muted" style="margin-top:0">${g.songs_played_legacy ? g.songs_played_legacy + ' songs played (count from the old sheet).' : 'No setlist yet.'}</p>`}
      <div class="row"><a class="btn sm gold" href="#setlist/${g.id}">${items.length ? 'Open setlist' : 'Build setlist'}</a></div>
    </section>
    <section class="panel"><h2 class="sec">Calendar</h2>
      <div class="row"><button class="btn sm" data-act="ics-one">Add to my calendar (.ics)</button></div>
    </section>
    ${practice || g.status !== 'complete' ? '' : payoutPanel(g)}
   </div>
  </div>`;
}
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
  return `<section class="panel"><h2 class="sec">Payout split</h2>
    <table class="tbl"><tbody>
      <tr><td>Gross</td><td class="r num">${money(gross(g), true)}</td></tr>
      ${exp ? `<tr><td>Gig expenses</td><td class="r num">−${money(exp, true)}</td></tr>` : ''}
      ${fund ? `<tr><td>Band fund (${n0(st.band_fund_pct)}%)</td><td class="r num">−${money(fund, true)}</td></tr>` : ''}
      ${ms.map(m => `<tr><td>${esc(m.name)}</td><td class="r num">${money(each, true)}</td></tr>`).join('')}
    </tbody></table></section>`;
}

/* ============================================================ calendar */
function calendarView() {
  const base = UI.calMonth ? pd(UI.calMonth + '-01') : new Date(today().getFullYear(), today().getMonth(), 1);
  const y = base.getFullYear(), m = base.getMonth();
  const start = new Date(y, m, 1 - new Date(y, m, 1).getDay());
  const t = todayIso(), st = settings();
  const byDay = {};
  S.gigs.forEach(g => { if (g.gig_date) (byDay[g.gig_date] = byDay[g.gig_date] || []).push(g); });
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i); const k = iso(d);
    if (i >= 35 && d.getMonth() !== m) break;
    const evs = (byDay[k] || []).map(g => {
      const cls = g.kind === 'practice' ? 'practice' : ['passed','cancelled'].includes(g.status) ? 'dead' : ['inquiry','quoted'].includes(g.status) ? 'lead' : 'gig';
      return `<a class="ev ${cls}" href="#gig/${g.id}" title="${esc(g.title)}"><span>${esc(g.start_time ? g.start_time + ' ' : '')}${esc(g.kind === 'practice' ? 'Practice' : g.title)}</span></a>`;
    }).join('');
    cells.push(`<div class="day ${d.getMonth() !== m ? 'out' : ''} ${k === t ? 'today' : ''}"><span class="dn">${d.getDate()}</span>${evs}</div>`);
  }
  const feed = `${SUPABASE_URL.replace('.supabase.co', '.functions.supabase.co')}/${CAL_FUNCTION}?token=${st.ics_token || ''}`;
  const monthList = S.gigs.filter(g => g.gig_date && yearOf(g.gig_date) === y && pd(g.gig_date).getMonth() === m).sort((a, b) => a.gig_date.localeCompare(b.gig_date));
  return `${title('Calendar')}
   <div class="row" style="margin-bottom:12px">
     <button class="btn sm" data-act="cal-move" data-v="-1">←</button>
     <b class="disp" style="font-size:20px;color:var(--gold);min-width:210px;text-align:center">${base.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</b>
     <button class="btn sm" data-act="cal-move" data-v="1">→</button>
     <button class="btn sm ghost" data-act="cal-move" data-v="0">Today</button>
     <span class="spacer"></span>
     <div class="legend"><span><i style="background:var(--gold)"></i>Booked / played</span><span><i style="background:var(--info)"></i>Lead</span><span><i style="background:var(--muted)"></i>Practice</span></div>
   </div>
   <section class="panel" style="padding:10px"><div class="cal">${DOW.map(d => `<div class="dow">${d}</div>`).join('')}${cells.join('')}</div></section>
   <div class="split" style="margin-top:16px">
     <section class="panel"><h2 class="sec">This month</h2><div class="list">${monthList.map(gigLi).join('') || '<div class="empty">Nothing this month.</div>'}</div>
       <div class="row" style="margin-top:12px"><button class="btn sm gold" data-act="new-gig">+ Lead / gig</button><button class="btn sm" data-act="new-practice">+ Practice</button></div></section>
     <section class="panel"><h2 class="sec">Sync to your phone</h2>
       <p class="small muted" style="margin-top:0">Subscribe once and every gig and practice shows up in your own calendar, with reminders the day before and two hours before. Updates flow in automatically (Apple refreshes about hourly; Google can take up to a day).</p>
       <label class="f">Calendar feed URL<input class="in" readonly value="${esc(feed)}" id="feedUrl"></label>
       <div class="row" style="margin-top:10px"><button class="btn sm gold" data-act="copy-feed">Copy URL</button><a class="btn sm" href="${esc(feed.replace(/^https:/, 'webcal:'))}">Open in Apple Calendar</a><button class="btn sm" data-act="ics-all">Download .ics instead</button></div>
       <p class="small faint">Google Calendar: Other calendars → + → From URL → paste. Anyone with this link can read the schedule${isMgr() ? '; <a href="#" data-act="rotate-token">reset the link</a> if it gets shared too widely' : ''}.</p>
     </section>
   </div>`;
}

/* ============================================================ setlists */
function setlistsView() {
  const t = todayIso();
  const up = S.gigs.filter(g => isGig(g) && ['confirmed','quoted'].includes(g.status) && (!g.gig_date || g.gig_date >= t)).sort((a, b) => (a.gig_date || '9').localeCompare(b.gig_date || '9'));
  const past = S.gigs.filter(g => isGig(g) && g.status === 'complete' && setItems(g.id).length).sort((a, b) => b.gig_date.localeCompare(a.gig_date));
  const li = g => { const n = setItems(g.id).length; return gigLi(g).replace('</a>', '').replace(/<div class="amt[^]*?<\/div>/, '') + `<span class="small ${n ? 'muted' : ''}" style="${n ? '' : 'color:var(--gold)'}">${n ? n + ' songs' : 'Needs a set'}</span></a>`; };
  return `${title('Setlists', 'Build sets from the song book, check timing against the slot, and print a stage copy.')}
   <div class="grid g2">
     <section class="panel"><h2 class="sec">Upcoming gigs</h2><div class="list">${up.map(g => li(g).replace(`href="#gig/${g.id}"`, `href="#setlist/${g.id}"`)).join('') || '<div class="empty">No booked gigs.</div>'}</div></section>
     <section class="panel"><h2 class="sec">Past setlists</h2><div class="list">${past.map(g => li(g).replace(`href="#gig/${g.id}"`, `href="#setlist/${g.id}"`)).join('')}</div></section>
   </div>`;
}
function setlistView(id) {
  const g = byId('gigs', id);
  if (!g) return `${title('Not found')}<a href="#setlists">Back</a>`;
  const st = settings(), items = setItems(id), buf = (st.song_buffer_sec ?? 10) / 60;
  const setNos = [...new Set(items.map(i => i.set_no))]; const maxSet = Math.max(n0(g.set_count), ...setNos, 1);
  const sets = Array.from({ length: maxSet }, (_, i) => i + 1);
  if (UI.selSet > maxSet) UI.selSet = 1;
  const used = new Set(items.map(i => i.song_id));
  const target = g.hours ? Math.round(n0(g.hours) * 60 / sets.length) : (n0(st.set_target_min) || 40);
  const setCards = sets.map(n => {
    const its = items.filter(i => i.set_no === n);
    const dur = its.reduce((a, i) => a + (i.played ? n0((byId('songs', i.song_id) || {}).length_min) + buf : 0), 0);
    return `<section class="panel set ${UI.selSet === n ? 'sel' : ''}" data-act="sel-set" data-v="${n}">
      <div class="row"><h3>Set ${n}</h3><span class="spacer"></span><span class="small num ${dur > target ? '' : 'muted'}" style="${dur > target ? 'color:var(--bad)' : ''}">${hm(dur)} / ${target}m</span></div>
      <div class="bar"><i class="${dur > target ? 'over' : ''}" style="width:${Math.min(100, dur / target * 100)}%"></i></div>
      ${its.map((i, k) => { const s = byId('songs', i.song_id) || { title: '(deleted song)' }; return `
        <div class="song ${i.played ? '' : 'unplayed'}">
          <span class="n">${k + 1}</span>
          <div style="min-width:0"><div class="nm">${esc(s.title)}</div><div class="meta">${esc(songLabel(s))} · ${mins(s.length_min)} · ${esc(s.lead_vox || '')}${s.starter ? ' · starts: ' + esc(s.starter) : ''}</div></div>
          <div class="acts">
            <button class="ib" title="Move up" data-act="si-move" data-id="${i.id}" data-v="-1">▲</button>
            <button class="ib" title="Move down" data-act="si-move" data-id="${i.id}" data-v="1">▼</button>
            ${sets.length > 1 ? `<button class="ib" title="Move to next set" data-act="si-set" data-id="${i.id}">⇄</button>` : ''}
            <button class="ib" title="${i.played ? 'Mark skipped' : 'Mark played'}" data-act="si-played" data-id="${i.id}">${i.played ? '✓' : '○'}</button>
            <button class="ib" title="Remove" data-act="si-del" data-id="${i.id}">✕</button>
          </div></div>`; }).join('') || '<p class="small muted">Click songs in the book to add them here.</p>'}
    </section>`;
  }).join('');
  const others = S.gigs.filter(x => x.id !== id && setItems(x.id).length).sort((a, b) => (b.gig_date || '').localeCompare(a.gig_date || ''));
  const q = UI.libSearch.toLowerCase();
  const stats = songStats();
  const lib = S.songs.filter(s => (UI.libFilter === 'all' || s.status === UI.libFilter) && (!q || (s.title + ' ' + (s.artist || '')).toLowerCase().includes(q)))
    .sort((a, b) => (a.default_set || 99) - (b.default_set || 99) || (a.default_order || 999) - (b.default_order || 999) || a.title.localeCompare(b.title));
  const total = items.filter(i => i.played).reduce((a, i) => a + n0((byId('songs', i.song_id) || {}).length_min) + buf, 0);
  return `<div class="row" style="margin-bottom:6px"><a href="#gig/${g.id}" class="small">← ${esc(g.title)}</a></div>
  ${title('Setlist', `${esc(g.title)} · ${fmtDate(g.gig_date)} · ${items.length} songs · ${hm(total)} of music${g.hours ? ' for a ' + g.hours + '-hour slot' : ''}`)}
  <div class="row" style="margin-bottom:14px">
    <button class="btn sm" data-act="set-add">+ Add set</button>
    ${sets.length > 1 ? `<button class="btn sm" data-act="set-drop">− Remove last set</button>` : ''}
    <select class="in" id="copyFrom" style="width:auto;max-width:260px"><option value="">Copy from another gig…</option>${others.map(o => `<option value="${o.id}">${esc(o.title)} (${mdY(o.gig_date)})</option>`).join('')}</select>
    <button class="btn sm" data-act="set-default">Fill from default order</button>
    <span class="spacer"></span>
    <button class="btn sm gold" data-act="set-pdf">Stage PDF</button><button class="btn sm" data-act="set-text">Copy as text</button>
    <span id="clearWrap"><button class="btn sm danger" data-act="set-clear-ask">Clear</button></span>
  </div>
  <div class="split">
    <div class="sets">${setCards}</div>
    <section class="panel" style="position:sticky;top:90px">
      <div class="row"><h2 class="sec" style="margin:0">Song book</h2><span class="spacer"></span><span class="small muted">adds to Set ${UI.selSet}</span></div>
      <div class="row" style="margin:10px 0"><input class="in" id="libSearch" placeholder="Search songs" value="${esc(UI.libSearch)}">
        <div class="chips">${[['active','Active'],['bench','Bench'],['holiday','Holiday'],['all','All']].map(([k, l]) => `<button class="chip ${UI.libFilter === k ? 'on' : ''}" data-act="lib-filter" data-v="${k}">${l}</button>`).join('')}</div></div>
      <div class="lib">${lib.map(s => `<div class="libi ${used.has(s.id) ? 'used' : ''}" data-act="lib-add" data-id="${s.id}">
         <div class="grow"><div style="font-weight:600">${esc(s.title)}</div><div class="small muted">${esc(s.artist || '')} · ${esc(songLabel(s))} · ${mins(s.length_min)}</div></div>
         <div style="text-align:right"><div class="stars ro">${starsRO(avgRating(s.id))}</div><div class="small faint">${(stats[s.id] || {}).plays || 0} plays</div></div></div>`).join('')}</div>
    </section>
  </div>`;
}
const starsRO = v => [1, 2, 3, 4, 5].map(i => `<button tabindex="-1" class="${v && v >= i - .25 ? 'on' : ''}">★</button>`).join('');

/* ============================================================ songs */
function songsView() {
  const stats = songStats(), q = UI.songSearch.toLowerCase(), f = UI.songFilter;
  let rows = S.songs.filter(s => (f === 'all' || s.status === f) && (!q || [s.title, s.artist, s.lead_vox, s.starter].join(' ').toLowerCase().includes(q)));
  const key = UI.songSort, dir = UI.songSortDir === 'desc' ? -1 : 1;
  const val = s => ({ title: s.title, artist: s.artist || '', key: s.song_key || '', length: n0(s.length_min), lead: s.lead_vox || '', mine: myRating(s.id), avg: avgRating(s.id) || 0, plays: (stats[s.id] || {}).plays || 0, last: (stats[s.id] || {}).last || '', year: s.year || 0 }[key]);
  rows.sort((a, b) => { const x = val(a), y = val(b); return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * dir; });
  const counts = Object.fromEntries(['active','bench','learning','retired','holiday'].map(k => [k, S.songs.filter(s => s.status === k).length]));
  const th = (k, l, cls = '') => `<th data-sort="${k}" class="${cls}">${l}${UI.songSort === k ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
  const ms = activeMembers();
  return `${title('Songs', 'The song book with keys, capos, who sings, and how the band rates each one. Rate songs with the stars — your stars are yours alone.')}
  <div class="row" style="margin-bottom:14px">
    <div class="chips">${[['active','Active'],['learning','Learning'],['bench','Bench'],['holiday','Holiday'],['retired','Retired'],['all','All']].map(([k, l]) => `<button class="chip ${f === k ? 'on' : ''}" data-act="song-filter" data-v="${k}">${l}${k !== 'all' ? ' ' + counts[k] : ''}</button>`).join('')}</div>
    <span class="spacer"></span><input class="in" id="songSearch" placeholder="Search title, artist, singer" value="${esc(UI.songSearch)}" style="width:220px"><button class="btn gold" data-act="song-new">+ Song</button>
  </div>
  <section class="panel"><div class="tbl-wrap"><table class="tbl">
    <thead><tr>${th('title', 'Song')}${th('key', 'Key')}${th('length', 'Len', 'r')}${th('lead', 'Lead vox', 'hide-sm')}${th('mine', 'Your rating')}${th('avg', 'Band', 'hide-sm')}${th('plays', 'Plays', 'r')}${th('last', 'Last played', 'hide-sm')}</tr></thead>
    <tbody>${rows.map(s => { const r = ratingsFor(s.id); return `<tr class="click" data-act="song-edit" data-id="${s.id}">
      <td><b>${esc(s.title)}</b><div class="small muted">${esc(s.artist || '')}${s.year ? ' · ' + s.year : ''}</div></td>
      <td class="num">${esc(s.song_key || '')}${s.capo ? `<div class="small muted">capo ${s.capo}</div>` : ''}</td>
      <td class="r num">${mins(s.length_min)}</td>
      <td class="hide-sm">${esc(s.lead_vox || '')}</td>
      <td><div class="stars" data-stop>${[1, 2, 3, 4, 5].map(i => `<button class="${myRating(s.id) >= i ? 'on' : ''}" data-act="rate" data-id="${s.id}" data-v="${i}" aria-label="${i} stars">★</button>`).join('')}</div></td>
      <td class="hide-sm" title="${r.map(x => (byId('members', x.member_id) || {}).name + ': ' + x.rating).join(', ')}"><span class="num">${avgRating(s.id) ? avgRating(s.id).toFixed(1) : '—'}</span> <span class="small faint">${r.length}/${ms.length}</span></td>
      <td class="r num">${(stats[s.id] || {}).plays || 0}</td>
      <td class="hide-sm small muted">${(stats[s.id] || {}).last ? mdY(stats[s.id].last) : '—'}</td></tr>`; }).join('')}</tbody>
  </table></div></section>`;
}
function songModal(s) {
  const ms = activeMembers(), p = s.parts || {};
  const f = (k, l, type = 'text', cls = '') => `<label class="f ${cls}">${l}<input class="in" data-s="${k}" type="${type}" value="${esc(s[k] ?? '')}" ${type === 'number' ? 'step="any"' : ''}></label>`;
  return `<div class="scrim" data-act="modal-close"><div class="modal" data-stop>
    <div class="row"><h2 class="sec" style="margin:0">${s.id ? 'Edit song' : 'New song'}</h2><span class="spacer"></span><button class="btn ghost" data-act="modal-close">✕</button></div>
    <div class="fgrid" style="margin-top:14px">
      ${f('title', 'Title', 'text', 'w2')}${f('artist', 'Artist', 'text', 'w2')}
      <label class="f">Status<select class="in" data-s="status">${['active','learning','bench','holiday','retired'].map(x => `<option ${s.status === x ? 'selected' : ''} value="${x}">${cap(x)}</option>`).join('')}</select></label>
      ${f('song_key', 'Key')}${f('capo', 'Capo', 'number')}
      <label class="f">Length (m:ss)<input class="in" data-s="length_fmt" value="${s.length_min ? mins(s.length_min) : ''}" placeholder="3:45"></label>
      ${f('lead_vox', 'Lead vox', 'text', 'w2')}${f('starter', 'Starts it', 'text', 'w2')}
      ${f('year', 'Year', 'number')}${f('added_on', 'Learned', 'date')}${f('default_set', 'Default set', 'number')}${f('default_order', 'Default order', 'number')}
      ${f('chart_url', 'Chart link (PDF / Drive)', 'url', 'w4')}
      <label class="f w4">Notes<input class="in" data-s="comment" value="${esc(s.comment || '')}" placeholder="e.g. tuning half step down"></label>
    </div>
    <h2 class="sec" style="margin-top:18px">Who plays what</h2>
    <div class="fgrid">${ms.map(m => `<label class="f">${esc(m.name)}<input class="in" data-part="${esc(m.name)}" value="${esc(p[m.name] || '')}"></label>`).join('')}</div>
    ${s.id ? `<h2 class="sec" style="margin-top:18px">Band ratings</h2><div class="row small">${ms.map(m => { const r = S.song_ratings.find(x => x.song_id === s.id && x.member_id === m.id); return `<span>${esc(m.name)} <span class="stars ro">${starsRO(r && r.rating)}</span></span>`; }).join('')}</div>` : ''}
    ${s.chart_url ? `<p><a href="${esc(s.chart_url)}" target="_blank" rel="noopener">Open chart ↗</a></p>` : ''}
    <div class="row" style="margin-top:18px"><button class="btn gold" data-act="song-save" data-id="${s.id || ''}">Save song</button><span class="spacer"></span>${s.id ? `<span id="songDelWrap"><button class="btn danger sm" data-act="song-del-ask">Delete</button></span>` : ''}</div>
  </div></div>`;
}

/* ============================================================ money */
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
  return `${title('Money', 'Pay, tips and merch by gig and year; what is still owed; expenses and payouts.')}
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
        <div class="legend"><span><i style="background:var(--gold)"></i>Gig pay</span><span><i style="background:#c27b1a"></i>Tips</span><span><i style="background:#f3eee4"></i>Merch</span></div></div>
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
  const W = 640, H = 230, pl = 52, pb = 26, pt = 18, pr = 8;
  const max = Math.max(...data.map(d => d.pay + d.tips + d.merch)) || 1;
  const step = Math.pow(10, Math.floor(Math.log10(max))) * (max / Math.pow(10, Math.floor(Math.log10(max))) > 5 ? 2 : max / Math.pow(10, Math.floor(Math.log10(max))) > 2 ? 1 : .5);
  const top = Math.ceil(max / step) * step;
  const y = v => pt + (H - pt - pb) * (1 - v / top);
  const bw = Math.min(70, (W - pl - pr) / data.length * .55);
  const x = i => pl + (W - pl - pr) * (i + .5) / data.length;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;margin-top:10px" role="img" aria-label="Income by year">`;
  for (let v = 0; v <= top + 1e-6; v += step) s += `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" stroke="rgba(243,238,228,.08)"/><text x="${pl - 8}" y="${y(v) + 4}" text-anchor="end">$${v >= 1000 ? (v / 1000) + 'k' : v}</text>`;
  data.forEach((d, i) => {
    let base = 0; const cx = x(i);
    [['pay', '#ffbf43'], ['tips', '#c27b1a'], ['merch', '#f3eee4']].forEach(([k, c]) => { if (d[k] > 0) { s += `<rect x="${cx - bw / 2}" width="${bw}" y="${y(base + d[k])}" height="${y(base) - y(base + d[k])}" fill="${c}"><title>${d.y} ${k}: ${money(d[k])}</title></rect>`; base += d[k]; } });
    s += `<text x="${cx}" y="${y(base) - 6}" text-anchor="middle" style="fill:var(--cream);font-weight:700">${money(base)}</text><text x="${cx}" y="${H - 8}" text-anchor="middle">${d.y} · ${d.n} gigs</text>`;
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
function settingsView() {
  const st = settings(), ms = S.members.slice().sort((a, b) => a.sort - b.sort), mgr = isMgr();
  const f = (k, l, cls = '', type = 'text') => `<label class="f ${cls}">${l}<input class="in" data-st="${k}" type="${type}" value="${esc(st[k] ?? '')}" ${mgr ? '' : 'disabled'}></label>`;
  return `${title('The Band')}
  <section class="team" style="margin-bottom:18px">${ms.filter(m => m.active).map(m => `<div class="mate"><img src="${photo(m)}" alt="${esc(m.name)}"><div class="plate"><small>${esc(m.instrument || '')}</small>${esc(m.name)}</div></div>`).join('')}</section>
  <div class="grid g2">
    <section class="panel"><h2 class="sec">Roster & logins</h2>
      <p class="small muted" style="margin-top:0">Each person signs in with the email listed here. ${mgr ? 'Create their login in Supabase → Authentication → Users (same email), or have them use “Email me a sign-in link”.' : 'Only managers can change the roster.'}</p>
      <table class="tbl"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Linked</th></tr></thead><tbody>
      ${ms.map(m => `<tr><td><b>${esc(m.name)}</b><div class="small muted">${esc(m.instrument || '')}</div></td>
        <td><input class="in" data-m="${m.id}" data-k="email" value="${esc(m.email || '')}" ${mgr ? '' : 'disabled'} placeholder="email"></td>
        <td><select class="in" style="min-width:112px" data-m="${m.id}" data-k="role" ${mgr ? '' : 'disabled'}><option ${m.role === 'member' ? 'selected' : ''}>member</option><option ${m.role === 'manager' ? 'selected' : ''}>manager</option></select></td>
        <td class="small">${m.user_id ? '<span style="color:var(--ok)">Yes</span>' : '<span class="faint">Not yet</span>'}</td></tr>`).join('')}
      </tbody></table>
      ${mgr ? '<div class="row" style="margin-top:12px"><button class="btn gold sm" data-act="save-members">Save roster</button></div>' : ''}
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
      ${mgr ? '<div class="row" style="margin-top:12px"><button class="btn gold sm" data-act="save-settings">Save settings</button></div>' : ''}
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
    <section class="panel"><h2 class="sec">Clients</h2>
      <div class="list">${S.clients.slice().sort((a, b) => (a.org || a.contact_name || '').localeCompare(b.org || b.contact_name || '')).map(c => { const n = S.gigs.filter(g => g.client_id === c.id).length; return `<div class="li"><div class="grow"><div class="t">${esc(c.org || c.contact_name)}</div><div class="s">${esc([c.contact_name, c.email, c.phone].filter(Boolean).join(' · '))}</div></div><span class="small muted">${esc(c.code || '')} · ${n} gig${n === 1 ? '' : 's'}</span></div>`; }).join('') || '<div class="empty">Clients get saved from the gig page.</div>'}</div>
    </section>
  </div>
  <div class="row" style="margin-top:18px"><span class="small muted">Signed in as ${esc(S.session.user.email)}</span><span class="spacer"></span><button class="btn" data-act="signout">Sign out</button></div>`;
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
  const { jsPDF } = window.jspdf; const items = setItems(g.id).filter(i => i.played);
  const doc = new jsPDF({ unit: 'pt', format: 'letter' }); const W = 612, M = 40;
  const sets = [...new Set(items.map(i => i.set_no))];
  sets.forEach((n, si) => {
    if (si) doc.addPage();
    doc.setFillColor(20, 14, 2); doc.rect(0, 0, W, 64, 'F');
    doc.setTextColor(255, 191, 67); doc.setFont('helvetica', 'bold'); doc.setFontSize(22); doc.text(`SET ${n}`, M, 42);
    doc.setFontSize(10); doc.setTextColor(243, 238, 228); doc.setFont('helvetica', 'normal'); doc.text(`${g.title} · ${fmtDate(g.gig_date)}`, W - M, 40, { align: 'right' });
    const its = items.filter(i => i.set_no === n); const rowH = Math.min(36, (792 - 100) / Math.max(its.length, 1));
    let y = 64 + rowH;
    its.forEach((i, k) => {
      const s = byId('songs', i.song_id) || {};
      doc.setTextColor(150, 140, 120); doc.setFontSize(Math.min(14, rowH * .4)); doc.text(String(k + 1), M + 14, y, { align: 'right' });
      doc.setTextColor(10, 8, 2); doc.setFont('helvetica', 'bold'); doc.setFontSize(Math.min(22, rowH * .62)); doc.text(s.title || '', M + 24, y);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(Math.min(14, rowH * .4)); doc.setTextColor(90, 80, 60);
      doc.text(`${songLabel(s)}${s.lead_vox ? '   ' + s.lead_vox : ''}`, W - M, y, { align: 'right' });
      y += rowH;
    });
  });
  download(`Setlist - ${g.title} - ${g.gig_date || ''}.pdf`, doc.output('blob'));
}

/* ============================================================ ICS */
function icsEsc(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n'); }
function parseTime(t) { const m = String(t || '').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i); if (!m) return null; let h = +m[1]; const mi = +(m[2] || 0); const ap = (m[3] || '').toLowerCase(); if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0; if (!ap && h < 9) h += 12; return [h, mi]; }
function icsFor(list) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Trailer Folk//Band HQ//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Trailer Folk', 'X-WR-TIMEZONE:America/Chicago'];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  list.filter(g => g.gig_date).forEach(g => {
    const d = g.gig_date.replace(/-/g, ''); const t = parseTime(g.start_time); const e = parseTime(g.end_time);
    lines.push('BEGIN:VEVENT', `UID:${g.id}@band.eckerthaus.com`, `DTSTAMP:${stamp}`);
    if (t) {
      const dur = g.hours ? n0(g.hours) * 60 : 120; const eh = e || [t[0] + Math.floor((t[1] + dur) / 60), (t[1] + dur) % 60];
      const f = ([h, m]) => String(Math.min(h, 23)).padStart(2, '0') + String(m).padStart(2, '0') + '00';
      lines.push(`DTSTART;TZID=America/Chicago:${d}T${f(t)}`, `DTEND;TZID=America/Chicago:${d}T${f(eh)}`);
    } else { const nx = iso(new Date(pd(g.gig_date).getTime() + 864e5)).replace(/-/g, ''); lines.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${nx}`); }
    lines.push(`SUMMARY:${icsEsc(g.kind === 'practice' ? 'Trailer Folk practice' : 'Trailer Folk: ' + g.title + (g.status !== 'confirmed' && g.status !== 'complete' ? ' (' + STATUS_LABEL[g.status] + ')' : ''))}`);
    if (g.venue || g.address) lines.push(`LOCATION:${icsEsc([g.venue, g.address].filter(Boolean).join(', '))}`);
    lines.push(`DESCRIPTION:${icsEsc((g.notes || '') + '\n' + location.origin + location.pathname + '#gig/' + g.id)}`);
    if (g.kind === 'gig' && g.status === 'confirmed') lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Gig tomorrow', 'TRIGGER:-P1D', 'END:VALARM');
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Trailer Folk', 'TRIGGER:-PT2H', 'END:VALARM', 'END:VEVENT');
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
    details: [`Trailer Folk — getting ready for ${g.title}`, `Hi ${first},\n\nWe're looking forward to ${when}! A few things to confirm:\n\n• Start time: ${g.start_time || '?'}${g.hours ? ' (' + g.hours + ' hours of music)' : ''}\n• We'll arrive about 2 hours early to load in and soundcheck\n• We need a ~20' x 15' area and access to standard power near the stage\n• Venue address: ${g.address || g.venue || '?'}\n• Any must-play songs, first dance, or announcements?\n\nWe bring all sound and lighting.`],
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
function openModal(html) { closeModal(); const d = document.createElement('div'); d.id = 'modalRoot'; d.innerHTML = html; document.body.appendChild(d); const f = d.querySelector('input,select'); if (f) f.focus(); }
function closeModal() { const m = $('#modalRoot'); if (m) m.remove(); }

/* ============================================================ events */
function after(sec, id) {
  const gs = $('#gigSearch'); if (gs) gs.oninput = e => { UI.gigSearch = e.target.value; keepUI(); rerenderKeepFocus('#gigSearch'); };
  const gy = $('#gigYear'); if (gy) gy.onchange = e => { UI.gigYear = e.target.value; keepUI(); render(); };
  const ss = $('#songSearch'); if (ss) ss.oninput = e => { UI.songSearch = e.target.value; keepUI(); rerenderKeepFocus('#songSearch'); };
  const ls = $('#libSearch'); if (ls) ls.oninput = e => { UI.libSearch = e.target.value; rerenderKeepFocus('#libSearch'); };
  const cf = $('#copyFrom'); if (cf) cf.onchange = e => e.target.value && copySetlist(id, e.target.value);
  if (sec === 'gig') $$('[data-f],[data-c]').forEach(el => el.addEventListener('input', () => { S.dirty = true; const n = $('#dirtyNote'); if (n) n.textContent = 'Unsaved changes'; }));
}
function rerenderKeepFocus(sel) { const el = $(sel); const pos = el ? el.selectionStart : 0; render(); const n = $(sel); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch {} } }

document.addEventListener('submit', async e => {
  if (e.target.id !== 'loginForm') return; e.preventDefault();
  const msg = $('#lgMsg'); msg.textContent = '';
  try { await api.signIn($('#lgEmail').value.trim(), $('#lgPass').value); } catch (err) { msg.textContent = err.message; }
});

document.addEventListener('click', async e => {
  const hrefRow = e.target.closest('tr[data-href]'); if (hrefRow && !e.target.closest('a,button')) { location.hash = hrefRow.dataset.href; return; }
  const el = e.target.closest('[data-act]'); if (!el) return;
  if (el.closest('[data-stop]') && el.dataset.act === 'modal-close' && el.classList.contains('scrim')) return;
  if (el.classList.contains('scrim') && e.target !== el) return;
  const act = el.dataset.act, v = el.dataset.v, id = el.dataset.id;
  const route = (location.hash || '#home').slice(1).split('/'); const g = route[0] === 'gig' || route[0] === 'setlist' ? byId('gigs', route[1]) : null;
  if (el.tagName === 'A' && el.getAttribute('href') === '#') e.preventDefault();
  if (act === 'rate' || el.closest('.stars')) e.stopPropagation();
  const H = ACTIONS[act]; if (H) await H({ el, v, id, g, e });
});

const ACTIONS = {
  magic: async () => { const em = $('#lgEmail').value.trim(); const msg = $('#lgMsg'); if (!em) { msg.textContent = 'Enter your email first.'; return; } try { await api.magic(em); msg.style.color = 'var(--ok)'; msg.textContent = 'Check your email for a sign-in link.'; } catch (err) { msg.textContent = err.message; } },
  reload: () => location.reload(),
  signout: async () => { await api.signOut(); },
  'modal-close': () => closeModal(),
  'gig-filter': ({ v }) => { UI.gigFilter = v; keepUI(); render(); },
  'song-filter': ({ v }) => { UI.songFilter = v; keepUI(); render(); },
  'lib-filter': ({ v }) => { UI.libFilter = v; render(); },
  'money-year': ({ v }) => { UI.moneyYear = v; keepUI(); render(); },
  'cal-move': ({ v }) => { const b = UI.calMonth ? pd(UI.calMonth + '-01') : new Date(today().getFullYear(), today().getMonth(), 1); const d = v === '0' ? today() : new Date(b.getFullYear(), b.getMonth() + Number(v), 1); UI.calMonth = iso(d).slice(0, 7); keepUI(); render(); },
  'new-gig': async () => { const r = await guard(() => save('gigs', { id: uuid(), kind: 'gig', status: 'inquiry', title: 'New lead', payee_id: (S.payees.find(p => p.is_default) || {}).id || null })); if (r) location.hash = '#gig/' + r.id; },
  'new-practice': async () => {
    const last = S.gigs.filter(x => x.kind === 'practice').sort((a, b) => (b.gig_date || '').localeCompare(a.gig_date || ''))[0] || {};
    const nextGig = upcoming(['gig']).find(x => x.status === 'confirmed');
    const r = await guard(() => save('gigs', { id: uuid(), kind: 'practice', title: 'Practice', gig_date: todayIso(), start_time: last.start_time || '8pm', venue: last.venue || "Jessie's", notes: nextGig ? `Setlist run for ${nextGig.title}` : '' }));
    if (r) location.hash = '#gig/' + r.id;
  },
  'set-status': async ({ v, g }) => { if (!g) return; const patch = collectGig(g); patch.status = v; if (v === 'complete' && patch.paid == null && !patch.deposit_received && n0(patch.quote)) toast('Marked played — log what was paid below.'); await guard(() => save('gigs', patch), 'Status: ' + STATUS_LABEL[v]); S.dirty = false; render(); },
  'save-gig': async ({ g }) => { if (!g) return; await saveGigForm(g); },
  'del-gig-ask': ({ el }) => { el.parentElement.innerHTML = `<span class="confirm">Delete this ${byId('gigs', (location.hash.split('/')[1]))?.kind === 'practice' ? 'practice' : 'gig'} and its setlist? <button class="btn danger sm" data-act="del-gig">Yes, delete</button><button class="btn sm" data-act="cancel-del">Keep</button></span>`; },
  'cancel-del': () => render(),
  'del-gig': async ({ g }) => { if (!g) return; await guard(() => del('gigs', g.id), 'Deleted'); S.setlist_items = S.setlist_items.filter(i => i.gig_id !== g.id); S.dirty = false; location.hash = '#gigs'; },
  pdf: async ({ v, g }) => { if (!g) return; if (S.dirty) await saveGigForm(g, true); await pdfFor(byId('gigs', g.id), v); },
  mail: async ({ v, g }) => { if (!g) return; if (S.dirty) await saveGigForm(g, true); openModal(mailModal(byId('gigs', g.id), v)); },
  'copy-mail': () => copy($('#mailBody').textContent),
  'ics-one': ({ g }) => g && download(`${g.kind === 'practice' ? 'Practice' : g.title} ${g.gig_date || ''}.ics`, icsFor([g]), 'text/calendar'),
  'ics-all': () => download('Trailer Folk calendar.ics', icsFor(S.gigs.filter(x => x.gig_date && x.gig_date >= iso(new Date(Date.now() - 90 * 864e5)) && (x.kind === 'practice' || live(x)))), 'text/calendar'),
  'copy-feed': () => copy($('#feedUrl').value),
  'rotate-token': async () => { const st = settings(); await guard(() => save('settings', { ...st, ics_token: uuid() }), 'New link made — re-subscribe on each phone'); render(); },
  // setlists
  'sel-set': ({ v, e }) => { if (e.target.closest('button')) return; UI.selSet = Number(v); render(); },
  'lib-add': async ({ id, g }) => { if (!g) return; const its = setItems(g.id).filter(i => i.set_no === UI.selSet); await guard(() => save('setlist_items', { id: uuid(), gig_id: g.id, set_no: UI.selSet, position: (its.length ? Math.max(...its.map(i => i.position)) : 0) + 1, song_id: id, played: true })); render(); },
  'si-del': async ({ id }) => { await guard(() => del('setlist_items', id)); render(); },
  'si-played': async ({ id }) => { const i = byId('setlist_items', id); await guard(() => save('setlist_items', { ...i, played: !i.played })); render(); },
  'si-move': async ({ id, v }) => {
    const i = byId('setlist_items', id); const its = setItems(i.gig_id).filter(x => x.set_no === i.set_no); const k = its.findIndex(x => x.id === id); const j = k + Number(v);
    if (j < 0 || j >= its.length) return; [its[k], its[j]] = [its[j], its[k]];
    await guard(() => saveMany('setlist_items', its.map((x, n) => ({ ...x, position: n + 1 })))); render();
  },
  'si-set': async ({ id }) => { const i = byId('setlist_items', id); const g = byId('gigs', i.gig_id); const n = Math.max(n0(g.set_count), ...setItems(g.id).map(x => x.set_no), 1); const to = i.set_no % n + 1; const its = setItems(g.id).filter(x => x.set_no === to); await guard(() => save('setlist_items', { ...i, set_no: to, position: (its.length ? Math.max(...its.map(x => x.position)) : 0) + 1 })); render(); },
  'set-add': async ({ g }) => { const n = Math.max(n0(g.set_count), ...setItems(g.id).map(x => x.set_no), 1) + 1; await guard(() => save('gigs', { ...g, set_count: n })); UI.selSet = n; render(); },
  'set-drop': async ({ g }) => { const n = Math.max(n0(g.set_count), ...setItems(g.id).map(x => x.set_no), 1); const its = setItems(g.id).filter(x => x.set_no === n); if (its.length) { toast(`Set ${n} still has songs — remove or move them first.`, true); return; } await guard(() => save('gigs', { ...g, set_count: n - 1 })); render(); },
  'set-clear-ask': ({ el }) => { el.parentElement.innerHTML = `<span class="confirm">Remove every song? <button class="btn danger sm" data-act="set-clear">Clear</button><button class="btn sm" data-act="cancel-del">Keep</button></span>`; },
  'set-clear': async ({ g }) => { await guard(() => api.remove('setlist_items', { gig_id: g.id })); S.setlist_items = S.setlist_items.filter(i => i.gig_id !== g.id); render(); },
  'set-default': async ({ g }) => {
    if (setItems(g.id).length) { toast('Clear the setlist first, or add songs one at a time.', true); return; }
    const rows = S.songs.filter(s => s.status === 'active' && s.default_set).sort((a, b) => a.default_set - b.default_set || (a.default_order || 0) - (b.default_order || 0));
    const pos = {}; const ins = rows.map(s => { pos[s.default_set] = (pos[s.default_set] || 0) + 1; return { id: uuid(), gig_id: g.id, set_no: s.default_set, position: pos[s.default_set], song_id: s.id, played: true }; });
    await guard(() => saveMany('setlist_items', ins), `${ins.length} songs added`); await guard(() => save('gigs', { ...g, set_count: Math.max(...ins.map(i => i.set_no), 1) })); render();
  },
  'set-pdf': ({ g }) => { if (!setItems(g.id).length) return toast('Add songs first.', true); stagePdf(g); },
  'set-text': ({ g }) => { const its = setItems(g.id).filter(i => i.played); const txt = [...new Set(its.map(i => i.set_no))].map(n => `SET ${n}\n` + its.filter(i => i.set_no === n).map((i, k) => { const s = byId('songs', i.song_id) || {}; return `${k + 1}. ${s.title} (${songLabel(s)})`; }).join('\n')).join('\n\n'); copy(`${g.title} — ${fmtDate(g.gig_date)}\n\n${txt}`); },
  // songs
  rate: async ({ id, v }) => { if (!S.me) return; const cur = myRating(id); const val = Number(v); if (cur === val) { await guard(() => api.remove('song_ratings', { song_id: id, member_id: S.me.id })); S.song_ratings = S.song_ratings.filter(r => !(r.song_id === id && r.member_id === S.me.id)); } else await guard(() => save('song_ratings', { song_id: id, member_id: S.me.id, rating: val })); render(); },
  'song-edit': ({ id, e }) => { if (e.target.closest('.stars')) return; openModal(songModal(byId('songs', id))); },
  'song-new': () => openModal(songModal({ status: 'learning', added_on: todayIso() })),
  'song-save': async ({ id }) => {
    const s = id ? { ...byId('songs', id) } : { id: uuid() };
    $$('[data-s]').forEach(i => { const k = i.dataset.s; if (k === 'length_fmt') { const m = i.value.trim().match(/^(\d+)(?::(\d{1,2}))?$/); s.length_min = m ? +m[1] + (+(m[2] || 0)) / 60 : null; } else s[k] = i.type === 'number' ? (i.value === '' ? null : Number(i.value)) : (i.value.trim() || null); });
    const parts = {}; $$('[data-part]').forEach(i => { if (i.value.trim()) parts[i.dataset.part] = i.value.trim(); }); s.parts = Object.keys(parts).length ? parts : null;
    if (!s.title) return toast('Give the song a title.', true);
    if (await guard(() => save('songs', s), 'Song saved')) { closeModal(); render(); }
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
function readX(x) { $$('#modalRoot [data-x]').forEach(i => { const k = i.dataset.x; x[k] = i.type === 'checkbox' ? i.checked : i.type === 'number' ? (i.value === '' ? null : Number(i.value)) : (i.value.trim() || null); }); }
function collectGig(g) {
  const r = { ...g };
  $$('[data-f]').forEach(i => { const k = i.dataset.f; r[k] = i.type === 'checkbox' ? i.checked : i.type === 'number' ? (i.value === '' ? null : Number(i.value)) : (i.value.trim() || null); });
  if (r.kind === 'practice') r.title = 'Practice';
  if (r.deposit_received && !g.deposit_received && !r.deposit_received_on) r.deposit_received_on = todayIso();
  if (r.paid != null && g.paid == null && !r.paid_on) r.paid_on = todayIso();
  return r;
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
  if (await guard(() => save('gigs', r), quiet ? null : 'Saved')) { S.dirty = false; if (!quiet) render(); }
}
async function copySetlist(toId, fromId) {
  if (setItems(toId).length) { toast('Clear this setlist before copying another one in.', true); render(); return; }
  const src = setItems(fromId);
  const rows = src.map(i => ({ id: uuid(), gig_id: toId, set_no: i.set_no, position: i.position, song_id: i.song_id, played: true }));
  await guard(() => saveMany('setlist_items', rows), `Copied ${rows.length} songs`);
  const g = byId('gigs', toId); const n = Math.max(...rows.map(x => x.set_no), 1); if (n0(g.set_count) < n) await guard(() => save('gigs', { ...g, set_count: n }));
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
  try {
    await api.rpc('claim_membership');
    await loadAll();
  } catch (e) {
    console.error(e);
    $('#app').innerHTML = shell('home', `${title('Can’t reach the band book')}<div class="panel"><p>${esc(e.message || e)}</p><p class="small muted">If this says the schema must be one of the exposed schemas, add <b>band</b> under Supabase → Project Settings → Data API → Exposed schemas.</p><button class="btn gold" data-act="reload">Try again</button> <button class="btn" data-act="signout">Sign out</button></div>`);
    return;
  }
  render();
}
(async function init() {
  if (!window.__BAND_MOCK__ && !supa) { $('#app').innerHTML = '<main><p>Could not load the Supabase library — check your connection and reload.</p></main>'; return; }
  let first = true;
  api.onAuth(s => { if (first) return; if ((s && s.user.id) !== (S.session && S.session.user.id)) boot(s); });
  const s = await api.session(); first = false; boot(s);
  // refresh when someone comes back to the tab, so bandmates' edits show up
  document.addEventListener('visibilitychange', async () => { if (document.visibilityState === 'visible' && S.me && !S.dirty && !$('#modalRoot')) { try { await loadAll(); render(); } catch {} } });
})();
