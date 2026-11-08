/* Travel Studio 行程編輯器（正式版）
   讀取：get_trip（非成員看到遮蔽後的公開版本）
   寫入：只呼叫 RPC；修改帶欄位版本，伺服器偵測同欄位衝突（FR-15）
   同步：Supabase Realtime 有變動就重新讀取；連不上時改為每 20 秒輪詢；離線時修改排隊（FR-04）
   在線狀態：Realtime presence 顯示誰在線、正在編輯哪張卡 */
(function () {
'use strict';
const CFG = window.TS_CONFIG, I18N = window.TS_I18N_EDITOR, SH = window.TS_SHARE, AUTH = window.TS_AUTH;
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
  auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

/* ---------- 小工具 ---------- */
const $ = id => document.getElementById(id);
const store = { get(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, st) => `<svg class="ic" aria-hidden="true"${st ? ` style="${st}"` : ''}><use href="#${n}"/></svg>`;
const parse = v => { const [y, m, d] = String(v).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const toMin = s => { if (!s) return null; const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
const hhmm = s => s ? String(s).slice(0, 5) : '';
const fromMin = n => { n = ((n % 1440) + 1440) % 1440; return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`; };
const durTxt = n => n >= 60 ? `${Math.floor(n / 60)}h${n % 60 ? ` ${n % 60}m` : ''}` : `${n}m`;
const safeUrl = u => /^https:\/\/[^\s<>"]+$/i.test(u || '');
let lang = store.get('ts-lang', (navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en');
let theme = store.get('ts-theme', 'paper');
const t = k => I18N[lang][k];
const THEMES = ['paper', 'kraft', 'peach', 'sage', 'ocean'];
const KIND_ICON = { place: 'ti-map-pin', food: 'ti-tools-kitchen-2', activity: 'ti-flag', lodging: 'ti-bed', transport: 'ti-car', note: 'ti-note' };
const MODE_ICON = { walk: 'ti-walk', train: 'ti-train', bus: 'ti-bus', taxi: 'ti-car', flight: 'ti-plane', boat: 'ti-ship' };
const TAPES = ['#8EA98F', '#DF8B7E', '#C9733B', '#7DAFCE', '#E6C56B'];
const CURRENCIES = ['TWD', 'JPY', 'KRW', 'THB', 'HKD', 'MOP', 'SGD', 'MYR', 'IDR', 'VND', 'CNY', 'USD', 'EUR', 'GBP', 'AUD'];

/* ---------- 狀態 ---------- */
const params = new URLSearchParams(location.search);
const tripId = params.get('trip');
const wantRead = params.get('mode') === 'read';
let data = null, session = null, dayIdx = 0, reading = false, budgetUnit = 'pp';
let channel = null, pollTimer = null, reloadTimer = null, online = {}, myEditing = null;
const queue = [];   // 離線或連線失敗時排隊的寫入
let syncState = 'saved';

const role = () => data && data.role;
const canEdit = () => role() === 'owner' || role() === 'editor';
const isOwner = () => role() === 'owner';
const days = () => (data ? data.days : []);
const day = () => days()[dayIdx];
const items = () => (data ? data.items : []);
const itemsOf = dayId => items().filter(i => i.day_id === dayId).sort((a, b) => a.sort - b.sort);
const memberName = uid => { const m = (data.members || []).find(m => m.user_id === uid); return m ? m.nickname : ''; };
const tripStarted = () => data && (new Date() >= new Date(parse(data.trip.start_date).getTime() - 864e5));

/* ---------- 錯誤與提示 ---------- */
function errMsg(e) {
  const m = String((e && e.message) || ''), k = t('errors');
  for (const key of Object.keys(k)) if (m.includes(key)) return k[key];
  if (/fetch|network|Failed to/i.test(m)) return t('errNetwork');
  return t('errGeneric');
}
const isNetErr = e => /fetch|network|Failed to|Load failed/i.test(String((e && e.message) || '')) || !navigator.onLine;
let toastTimer;
function toast(msg) { const el = $('toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3200); }
async function rpc(name, args) {
  const { data: d, error } = await sb.rpc(name, args || {});
  if (error) { const e = new Error(error.message); e.raw = error; throw e; }
  return d;
}
function setSync(s) {
  syncState = s;
  const el = $('sync'); if (!el) return;
  el.className = 'sync ' + s;
  el.innerHTML = `<i></i>${t('sync')[s]}${queue.length && s === 'offline' ? ` · ${queue.length}` : ''}`;
}

/* ---------- 寫入（排隊、重試） ---------- */
async function write(name, args, opts) {
  opts = opts || {};
  if (!navigator.onLine) { queue.push({ name, args }); setSync('offline'); return null; }
  setSync('saving');
  try {
    const r = await rpc(name, args);
    setSync('saved');
    if (!opts.noReload) scheduleReload(0);
    return r;
  } catch (e) {
    if (isNetErr(e)) { queue.push({ name, args }); setSync('offline'); toast(t('queued')); return null; }
    setSync('saved'); toast(errMsg(e)); scheduleReload(0); throw e;
  }
}
async function flushQueue() {
  if (!queue.length || !navigator.onLine) return;
  setSync('saving');
  while (queue.length) {
    const op = queue[0];
    try { await rpc(op.name, op.args); queue.shift(); }
    catch (e) { if (isNetErr(e)) { setSync('offline'); return; } queue.shift(); toast(errMsg(e)); }
  }
  setSync('saved'); scheduleReload(0);
}
window.addEventListener('online', flushQueue);
window.addEventListener('offline', () => setSync('offline'));
window.addEventListener('beforeunload', e => { if (queue.length) { e.preventDefault(); e.returnValue = ''; } });

/* ---------- 讀取與即時同步 ---------- */
async function load() {
  data = await rpc('get_trip', { p_trip: tripId });
  if (dayIdx >= data.days.length) dayIdx = data.days.length - 1;
  render();
}
function scheduleReload(ms) { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => load().catch(e => toast(errMsg(e))), ms == null ? 400 : ms); }
function startRealtime() {
  if (!data || !data.role) { pollTimer = setInterval(() => scheduleReload(0), 60000); return; }   // 公開閱讀：低頻更新
  try {
    channel = sb.channel('trip:' + tripId, { config: { presence: { key: session ? session.user.id : 'anon' } } });
    const f = 'trip_id=eq.' + tripId;
    ['trip_items', 'trip_days', 'collaborators', 'stamp_types'].forEach(tb => channel.on('postgres_changes', { event: '*', schema: 'public', table: tb, filter: f }, () => scheduleReload()));
    channel.on('postgres_changes', { event: '*', schema: 'public', table: 'trips', filter: 'id=eq.' + tripId }, () => scheduleReload());
    ['item_memos', 'item_stamps'].forEach(tb => channel.on('postgres_changes', { event: '*', schema: 'public', table: tb }, () => scheduleReload()));
    channel.on('presence', { event: 'sync' }, () => { online = channel.presenceState(); renderPresence(); });
    channel.subscribe(status => {
      if (status === 'SUBSCRIBED') { clearInterval(pollTimer); pollTimer = null; trackPresence(); }
      if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') && !pollTimer) pollTimer = setInterval(() => scheduleReload(0), 20000);
    });
  } catch (e) { pollTimer = setInterval(() => scheduleReload(0), 20000); }
}
function trackPresence() {
  if (!channel || !data || !data.role) return;
  const me = (data.members || []).find(m => m.is_me);
  channel.track({ nickname: me ? me.nickname : '', editing: myEditing }).catch(() => {});
}
function onlineList() {
  const out = [];
  Object.values(online || {}).forEach(arr => (arr || []).forEach(p => out.push(p)));
  return out;
}

/* ---------- 計算：衝突、營業時間、預算 ---------- */
function partySize() {
  const p = data.trip.party_size;
  if (p && /^\d+$/.test(p)) return +p;
  if (p === '7-9') return 8; if (p === '10+') return 10;
  return Math.max(1, (data.members || []).length);
}
function digits(cur) { try { return new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits; } catch (e) { return 2; } }
const toMajor = (minor, cur) => minor == null ? '' : minor / Math.pow(10, digits(cur));
const toMinor = (major, cur) => (major === '' || major == null || isNaN(+major)) ? null : Math.round(+major * Math.pow(10, digits(cur)));
function money(minor, cur) { if (minor == null || !cur) return ''; return `${cur} ${(minor / Math.pow(10, digits(cur))).toLocaleString('en-US', { maximumFractionDigits: digits(cur) })}`; }
function estOf(i) { return i.est_max_minor != null ? i.est_max_minor : i.est_min_minor; }
function perPerson(i) { const v = estOf(i); if (v == null) return null; return i.cost_basis === 'group' ? Math.round(v / partySize()) : v; }

function conflictsOf(list) {
  // 依卡片順序檢查相鄰兩個有時間的行程；中間的交通卡提供所需時間
  const out = {}; let prev = null, transport = 0;
  list.forEach(i => {
    if (i.kind === 'transport') { transport += +(i.extra && i.extra.duration) || 0; return; }
    if (i.kind === 'lodging' || i.kind === 'note' || !i.start_time) return;
    if (prev && prev.end_time) {
      const gap = toMin(i.start_time) - toMin(prev.end_time), need = transport;
      const key = `${hhmm(prev.end_time)}-${hhmm(i.start_time)}-${need}`;
      if ((gap < need || (gap === 0 && need === 0)) && !(i.extra && i.extra.ignore_conflict === key)) {
        out[i.id] = { prev, gap, need, key, overlap: gap < 0, suggest: fromMin(toMin(prev.end_time) + (need || 30)) };
      }
    }
    prev = i; transport = 0;
  });
  return out;
}
function hoursWarn(i, dateStr) {
  const h = i.extra && i.extra.hours; if (!h) return null;
  const wd = parse(dateStr).getDay();
  if (Array.isArray(h.closed) && h.closed.includes(wd)) return t('closedDay')(t('wd')[wd]);
  if (h.open && h.close && i.start_time) {
    const s = toMin(i.start_time), e = toMin(i.end_time || i.start_time), o = toMin(h.open), c = toMin(h.close);
    if (s < o || (c > o && e > c)) return t('outsideHours')(h.open, h.close);
  }
  return null;
}
function budget(list) {
  const base = data.trip.base_currency || (list.find(i => i.currency) || {}).currency || null;
  let est = 0, paid = 0, actual = 0; const other = {};
  list.forEach(i => {
    const pp = perPerson(i);
    if (pp != null) { if (!base || i.currency === base) est += pp; else other[i.currency] = (other[i.currency] || 0) + pp; }
    if (i.paid_minor && (!base || i.currency === base)) paid += Math.round(i.paid_minor / partySize());
    if (i.actual_minor && (!base || i.currency === base)) actual += i.actual_minor;
  });
  return { base, est, paid, actual, other };
}

/* ---------- 版面 ---------- */
function render() {
  if (!data) return;
  document.documentElement.lang = lang === 'zh' ? 'zh-Hant' : 'en';
  document.body.dataset.theme = theme;
  document.title = `${data.trip.title} · Travel Studio`;
  reading = reading || !canEdit();
  document.body.classList.toggle('readonly', !canEdit());
  document.body.classList.toggle('reading', reading);
  renderRail(); renderTop(); renderBanner(); renderDays(); renderMain(); renderAside(); renderNav();
  document.querySelectorAll('[data-i]').forEach(el => { const v = t(el.dataset.i); if (typeof v === 'string') el.textContent = v; });
  document.querySelectorAll('[data-i-label]').forEach(el => el.setAttribute('aria-label', t(el.dataset.iLabel)));
  setSync(queue.length ? 'offline' : syncState);
}
function renderRail() {
  const u = session && session.user, email = u && !u.is_anonymous ? (u.email || (u.phone ? '••• ' + String(u.phone).slice(-4) : '')) : '';
  const me = (data.members || []).find(m => m.is_me), ini = (email || (me && me.nickname) || '?').slice(0, 1).toUpperCase();
  $('rail').innerHTML = `<a class="lg" href="index.html" aria-label="Travel Studio">TS</a>
    <button aria-current="page" aria-label="${t('editorNav')}" title="${t('editorNav')}">${ic('ti-notebook')}</button>
    <a href="index.html#mine" aria-label="${t('myTrips')}" title="${t('myTrips')}">${ic('ti-folder')}</a>
    ${isOwner() ? `<button data-act="share" aria-label="${t('shareSettings')}" title="${t('shareSettings')}">${ic('ti-users')}</button>` : ''}
    ${isOwner() ? `<button data-act="settings" aria-label="${t('tripSettings')}" title="${t('tripSettings')}">${ic('ti-settings')}</button>` : ''}
    <span class="spacer"></span>
    <button data-act="lang" aria-label="Language" title="Language" style="font:500 12px var(--sans)">${lang === 'zh' ? 'EN' : '中'}</button>
    <button data-act="theme" aria-label="${t('theme')}" title="${t('theme')}">${ic('ti-palette')}</button>
    ${u ? `<a class="me" href="index.html" aria-label="${esc(email ? t('acctG')(email) : t('acctAnon'))}" title="${esc(email || (me ? me.nickname : ''))}">${esc(ini)}</a>` : `<a class="me" href="index.html" aria-label="${t('login')}">${ic('ti-user')}</a>`}`;
}
function renderTop() {
  const tr = data.trip, a = parse(tr.start_date), b = parse(tr.end_date);
  const vis = { private: 'ti-lock', link: 'ti-link', public: 'ti-world' }[tr.visibility];
  $('top').innerHTML = `
    <h1>${esc(tr.title)}</h1>
    <span class="mono">${a.getFullYear()}/${t('md')(a)} – ${t('md')(b)}</span>
    ${data.role ? `<span class="sync" id="sync" role="status"><i></i></span>` : ''}
    <div class="av" id="avatars" aria-label="${t('members')}"></div>
    <span class="grow"></span>
    ${data.role ? `<button class="chip vis-chip hide-m" data-act="share">${ic(vis)}${t('vis')[tr.visibility]}</button>` : ''}
    ${isOwner() ? `<button class="chip" data-act="invite">${ic('ti-user-plus')}${t('copyInvite')}</button>` : ''}
    ${!data.role ? `<button class="chip" data-act="shareRead">${ic('ti-share-2')}${t('share')}</button><button class="chip hide-m" data-act="report">${ic('ti-flag-3')}${t('report')}</button>` : ''}
    ${isOwner() ? `<button class="chip hide-m" data-act="share">${ic('ti-share')}${t('shareSettings')}</button>` : ''}
    <button class="chip hide-m" data-act="print">${ic('ti-printer')}${t('pdf')}</button>
    ${canEdit() ? `<button class="chip" data-act="read" aria-pressed="${reading}">${ic('ti-eye')}${t('readMode')}</button>` : ''}`;
  renderPresence();
}
function renderPresence() {
  const el = $('avatars'); if (!el || !data) return;
  const on = new Set(onlineList().map(p => p.nickname));
  const ms = (data.members || []).slice(0, 4);
  el.innerHTML = ms.map((m, i) => `<span class="${on.has(m.nickname) ? 'on' : ''}" title="${esc(m.nickname)}" style="background:${['#302A25', '#B86B45', '#5E7A62', '#8A7A6A'][i]}">${esc((m.nickname || '?').slice(0, 1))}</span>`).join('')
    + ((data.members || []).length > 4 ? `<span style="background:#8A7A6A">+${data.members.length - 4}</span>` : '');
  const box = $('presenceBox'); if (box) box.innerHTML = presenceHtml();
  document.querySelectorAll('[data-editing-for]').forEach(b => {
    const who = onlineList().filter(p => p.editing === b.dataset.editingFor && !(data.members || []).some(m => m.is_me && m.nickname === p.nickname)).map(p => p.nickname);
    b.hidden = !who.length; b.textContent = who.length ? t('isEditing')(who.join('、')) : '';
  });
}
function renderBanner() {
  const el = $('banner');
  if (!data.role) {
    el.hidden = false;
    const pub = data.trip.visibility === 'public';
    el.innerHTML = `${ic(pub ? 'ti-world' : 'ti-link')}<span>${(pub ? t('publicBanner') : t('linkBanner'))(esc((data.members[0] || {}).nickname || '—'))}</span>${pub ? `<button class="bd" data-act="copyPublic">${ic('ti-copy')}${t('copyToMine')}</button>` : ''}<button class="bl" data-act="report">${ic('ti-flag-3')}${t('report')}</button>`;
  } else if (data.trip.held_at) {
    el.hidden = false; el.innerHTML = `${ic('ti-alert-octagon')}<span>${t('heldBanner')}</span>`;
  } else if (role() === 'viewer') {
    el.hidden = false; el.innerHTML = `${ic('ti-eye')}<span>${t('viewerBanner')}</span>`;
  } else if (data.is_anonymous) {
    el.hidden = false;
    el.innerHTML = `${ic('ti-user-check')}<span>${t('anonBanner')}</span><button class="bd" data-act="linkAccount">${t('linkGoogle')}</button>`;
  } else el.hidden = true;
}
function renderDays() {
  $('days').innerHTML = days().map((d, i) => {
    const n = itemsOf(d.id).filter(x => x.kind !== 'transport').length, dt = parse(d.date);
    return `<button class="day" role="tab" aria-selected="${i === dayIdx}" data-act="day" data-dix="${i}"><b>DAY ${String(d.day_index).padStart(2, '0')}</b><span>${t('mdw')(dt)} · ${n ? t('stops')(n) : t('unplanned')}</span></button>`;
  }).join('') + (canEdit() && days().length < 30 ? `<button class="day add edit-only" data-act="addDay">${ic('ti-plus')} ${t('addDay')}</button>` : '');
}
function lodgingFor(d) {
  // 住宿卡：從入住那天到退房前一晚，每天的標題下方都顯示（FR-06、AT-37）
  return items().filter(i => i.kind === 'lodging').filter(i => {
    const s = days().find(x => x.id === i.day_id), e = days().find(x => x.id === (i.end_day_id || i.day_id));
    return s && e && d.day_index >= s.day_index && d.day_index <= e.day_index;
  });
}
function renderMain() {
  const d = day(); if (!d) return;
  const list = itemsOf(d.id), conf = conflictsOf(list), dt = parse(d.date);
  const timed = list.filter(i => i.start_time && i.kind !== 'transport');
  const span = timed.length ? `${hhmm(timed[0].start_time)} – ${hhmm(timed.reduce((m, i) => (toMin(i.end_time || i.start_time) > toMin(m) ? (i.end_time || i.start_time) : m), timed[0].end_time || timed[0].start_time))}` : '';
  const b = budget(list);
  const sub = d.subtitle
    ? `<button class="sub-edit" data-act="subtitle" ${canEdit() ? '' : 'disabled'}>${esc(d.subtitle)}</button>`
    : (canEdit() ? `<button class="sub-edit edit-only" data-act="subtitle" style="font-size:16px;color:var(--soft)">${t('addSubtitle')}</button>` : '');
  const lodges = lodgingFor(d);
  let html = `<div class="dh"><div><span class="k">DAY ${String(d.day_index).padStart(2, '0')}</span><h2>${t('mdw')(dt)} <span id="subWrap">${sub}</span></h2>
      <p class="meta">${[t('stops')(list.filter(i => i.kind !== 'transport').length), span, b.est ? t('estPP')(money(b.est, b.base)) : ''].filter(Boolean).join(' · ')}</p></div>
      <div class="acts edit-only"><button class="bd" data-act="add">${ic('ti-plus')}${t('addStop')}</button></div></div>`;
  html += lodges.map(l => `<div class="lodge">${ic('ti-bed')}<span>${t('tonight')}<b>${esc(l.title)}</b></span>${l.booking_status === 'booked' ? `<span class="st ok">${ic('ti-check')}${t('booked')}</span>` : ''}</div>`).join('');
  if (!list.length) html += `<div class="empty-day">${canEdit() ? t('emptyDayEdit') : t('emptyDay')}</div>`;
  list.forEach((i, k) => { html += i.kind === 'transport' ? ticket(i, list, k, conf) : card(i, list, k, conf, d); });
  if (canEdit()) html += `<button class="addcard edit-only" data-act="add">${ic('ti-plus')} ${t('addCardBig')}<br><span class="meta">${t('addCardHint')}</span></button>`;
  $('main').innerHTML = html;
  renderPresence();
}
function stampHtml(i) {
  const out = [];
  if (i.booking_status === 'booked') out.push(`<span class="rs" style="color:#2E7A45"><span>${t('stampBooked')}</span></span>`);
  if (i.booking_status === 'none_needed') out.push(`<span class="rs" style="color:#5E7A62"><span>${t('stampNoNeed')}</span></span>`);
  if (i.paid_minor) out.push(`<span class="rs" style="color:#A33A2A"><span>${t('stampPaid')}</span></span>`);
  (data.item_stamps || []).filter(x => x.item_id === i.id).forEach(x => {
    const s = (data.stamp_types || []).find(s => s.id === x.stamp_type_id);
    if (s) out.push(`<button class="rs custom" data-ink="${esc(s.ink)}" data-act="toggleStamp" data-id="${i.id}" data-stamp="${s.id}" ${canEdit() ? '' : 'disabled'} aria-label="${esc(t('removeStamp')(s.label))}"><span>${esc(s.label)}</span></button>`);
  });
  const shown = out.slice(0, 3).join('') + (out.length > 3 ? `<span class="meta">+${out.length - 3}</span>` : '');
  return `<div class="stamps">${shown}${canEdit() ? `<button class="addstamp edit-only" data-act="stampPick" data-id="${i.id}" aria-label="${t('addStamp')}">${ic('ti-plus')}</button>` : ''}</div>`;
}
function card(i, list, k, conf, d) {
  const c = conf[i.id], ex = i.extra || {}, hw = hoursWarn(i, d.date);
  const dur = i.start_time && i.end_time ? toMin(i.end_time) - toMin(i.start_time) : null;
  const bk = i.booking_status === 'booked' ? `<span class="st ok">${ic('ti-check')}${t('booked')}</span>`
    : i.booking_status === 'todo' ? `<span class="st todo">${ic('ti-ticket')}${t('todo')}</span>`
    : i.booking_status === 'none_needed' ? `<span class="st ok">${ic('ti-check')}${t('noNeed')}</span>` : '';
  const pp = perPerson(i), est = estOf(i);
  const memos = (data.memos || []).filter(m => m.item_id === i.id);
  const links = [
    safeUrl(ex.map_url) ? `<a class="lk" data-out="map" href="${esc(ex.map_url)}" target="_blank" rel="noopener noreferrer">${ic('ti-map-pin')}${t('map')}</a>` : '',
    safeUrl(ex.site_url) ? `<a class="lk" data-out="site" href="${esc(ex.site_url)}" target="_blank" rel="noopener noreferrer">${ic('ti-world')}${t('site')}</a>` : '',
    safeUrl(i.booking_url) ? `<a class="lk dk" data-out="booking" href="${esc(i.booking_url)}" target="_blank" rel="noopener noreferrer">${ic('ti-ticket')}${t('bookingLink')}${i.booking_code ? ' · ' + esc(i.booking_code) : ''}</a>` : '',
    !safeUrl(i.booking_url) && i.booking_code ? `<span class="lk">${ic('ti-ticket')}${t('codeLabel')}${esc(i.booking_code)}</span>` : '',
    i.remind_on && i.booking_status !== 'booked' ? `<span class="lk">${ic('ti-bell')}${t('remind')(t('md')(parse(i.remind_on)))}</span>` : ''
  ].join('');
  const hours = ex.hours && (ex.hours.open || (ex.hours.closed || []).length) ? `<span class="meta">${ex.hours.open ? t('hoursShort')(ex.hours.open, ex.hours.close) : ''}${(ex.hours.closed || []).length ? ` · ${t('closedOn')((ex.hours.closed).map(w => t('wd')[w]).join('、'))}` : ''}</span>` : '';
  const visit = tripStarted() && i.kind !== 'note' ? `<div class="visit">${ic('ti-checkbox')}<span>${t('visitQ')}</span>
      <button data-act="visit" data-id="${i.id}" data-v="went" aria-pressed="${i.visit_status === 'went'}" ${canEdit() ? '' : 'disabled'}>${ic('ti-check')}${t('went')}</button>
      <button data-act="visit" data-id="${i.id}" data-v="skipped" aria-pressed="${i.visit_status === 'skipped'}" ${canEdit() ? '' : 'disabled'}>${ic('ti-x')}${t('skipped')}</button>
      ${i.actual_minor != null ? `<span>${t('actual')(money(i.actual_minor, i.currency || data.trip.base_currency))}</span>` : ''}
      ${canEdit() ? `<button class="act" data-act="actual" data-id="${i.id}">${ic('ti-coin')}${t('recordActual')}</button>` : ''}</div>` : '';
  const who = memberName(i.created_by);
  return `<article class="pc${c ? ' conf' : ''}" id="item-${i.id}"><i class="tape" style="background:${c ? '#C9733B' : TAPES[k % TAPES.length]}" aria-hidden="true"></i><i class="pin" aria-hidden="true"></i>
    <div class="head"><span class="lbl">${ic(KIND_ICON[i.kind])} ${t('kinds')[i.kind]}</span>${c ? `<span class="st warn">${ic('ti-alert-triangle')}${t('conflict')}</span>` : ''}${bk}
      <span class="editing-badge" data-editing-for="${i.id}" hidden></span>
      ${i.start_time ? `<span class="time">${ic('ti-clock')}<b>${hhmm(i.start_time)}${i.end_time ? ' – ' + hhmm(i.end_time) : ''}</b>${i.is_fixed ? `<span class="lock">${ic('ti-lock')} ${t('fixed')}</span>` : ''}${dur > 0 ? `<span class="meta">${t('stay')(durTxt(dur))}</span>` : ''}</span>` : ''}</div>
    ${c ? `<div class="conf-box" role="alert"><b>${c.overlap ? t('confOverlap')(esc(c.prev.title), hhmm(c.prev.end_time)) : t('confTight')(esc(c.prev.title), hhmm(c.prev.end_time), c.need)}</b>
      <div class="acts edit-only">${i.is_fixed ? '' : `<button data-act="confShift" data-id="${i.id}" data-to="${c.suggest}">${t('shiftTo')(c.suggest)}</button>`}<button data-act="confTransport" data-id="${c.prev.id}">${t('addTransport')}</button><button data-act="confIgnore" data-id="${i.id}" data-key="${esc(c.key)}">${t('ignore')}</button></div></div>` : ''}
    ${hw ? `<div class="hours-warn">${ic('ti-clock-exclamation')} ${hw}</div>` : ''}
    <div class="body">
      <div class="pola">${safeUrl(ex.photo_url) ? `<img src="${esc(ex.photo_url)}" alt="${esc(ex.photo_note || i.title)}" loading="lazy" referrerpolicy="no-referrer">` : `<div class="ph">${ic(KIND_ICON[i.kind])}</div>`}
        <span class="hand">${esc(ex.photo_note || i.title)}</span></div>
      <div class="info"><h3>${esc(i.title)}${hours}</h3>
        ${ex.desc ? `<p class="desc">${esc(ex.desc)}</p>` : ''}
        ${est != null ? `<div class="cost"><div class="r"><span>${ic('ti-coins')} ${t('costEst')}</span><b>${t('approxPP')(money(pp, i.currency))}</b></div><div class="r"><span>${t('groupTotal')(partySize())}</span><span class="acc">${money(i.cost_basis === 'group' ? est : est * partySize(), i.currency)}${i.paid_minor ? ` (${t('paidShort')})` : ''}</span></div></div>` : ''}
        ${links ? `<div class="btns">${links}</div>` : ''}
        ${stampHtml(i)}
      </div>
    </div>
    ${visit}
    ${(memos.length || canEdit()) ? `<div class="memo"><b>${ic('ti-pin')} ${t('memoTitle')}</b>
      ${memos.map(m => `<div class="row"><span>${esc(m.body)}</span><span class="who">— ${esc(m.author || '')}</span>${(m.mine || isOwner()) && canEdit() ? `<button class="x edit-only" data-act="delMemo" data-id="${m.id}" aria-label="${t('delete')}">${ic('ti-x')}</button>` : ''}</div>`).join('')}
      ${canEdit() ? `<form class="memo-add edit-only" data-memo="${i.id}"><input maxlength="1000" placeholder="${t('memoPh')}" aria-label="${t('memoPh')}"><button>${t('post')}</button></form>` : ''}</div>` : ''}
    <div class="foot"><span class="who"><i></i>${who ? t('pastedBy')(esc(who)) : ''}</span>
      <div class="ops edit-only"><button data-act="edit" data-id="${i.id}">${ic('ti-pencil')}${t('edit')}</button>
        <button data-act="up" data-id="${i.id}" aria-label="${t('up')}" ${k === 0 ? 'disabled' : ''}>${ic('ti-arrow-up')}</button>
        <button data-act="down" data-id="${i.id}" aria-label="${t('down')}" ${k === list.length - 1 ? 'disabled' : ''}>${ic('ti-arrow-down')}</button>
        <button data-act="moveDay" data-id="${i.id}">${ic('ti-calendar-event')}${t('moveDay')}</button>
        <button data-act="dup" data-id="${i.id}">${ic('ti-copy')}${t('copy')}</button>
        <button class="del" data-act="del" data-id="${i.id}">${ic('ti-trash')}${t('remove')}</button></div></div>
  </article>`;
}
function ticket(i, list, k) {
  const ex = i.extra || {}, mode = ex.mode || 'taxi', est = estOf(i);
  const prev = list.slice(0, k).reverse().find(x => x.kind !== 'transport'), next = list.slice(k + 1).find(x => x.kind !== 'transport');
  const note = [ex.duration ? t('aboutMin')(ex.duration) : '', est != null ? money(est, i.currency) + (i.cost_basis === 'group' ? t('perGroup') : t('perP')) : '', i.start_time ? t('departAt')(hhmm(i.start_time)) : ''].filter(Boolean).join(' · ');
  return `<div class="tk" id="item-${i.id}">${ic(MODE_ICON[mode] || 'ti-car', 'font-size:22px')}<div class="tx"><b>${esc(i.title)}</b><br><span class="hand">${esc(note || (prev && next ? `${prev.title} → ${next.title}` : ''))}</span></div>
    ${ex.duration ? `<span class="dur">${t('minutes')(ex.duration)}</span>` : ''}
    <span class="ops edit-only" style="display:inline-flex;gap:6px">
      <button class="edit" data-act="up" data-id="${i.id}" aria-label="${t('up')}" ${k === 0 ? 'disabled' : ''}>${ic('ti-arrow-up')}</button>
      <button class="edit" data-act="down" data-id="${i.id}" aria-label="${t('down')}" ${k === list.length - 1 ? 'disabled' : ''}>${ic('ti-arrow-down')}</button>
      <button class="edit" data-act="edit" data-id="${i.id}" aria-label="${t('edit')}">${ic('ti-pencil')}</button>
      <button class="edit" data-act="del" data-id="${i.id}" aria-label="${t('remove')}">${ic('ti-trash')}</button></span></div>`;
}
function renderAside() {
  const d = day(); if (!d) return;
  const list = itemsOf(d.id), conf = conflictsOf(list);
  const tl = list.filter(i => i.kind !== 'note').map(i => {
    if (i.kind === 'transport') return `<div class="tr"><div class="r"><b>${ic(MODE_ICON[(i.extra || {}).mode] || 'ti-car')} ${esc(i.title)}</b><span class="m">${(i.extra || {}).duration ? t('minutes')(i.extra.duration) : ''}</span></div></div>`;
    const c = conf[i.id];
    return `<div class="tli${i.is_fixed ? ' fixed' : ''}${c ? ' cf' : ''}">${c ? '<div class="box">' : ''}<div class="r"><span class="t">${i.start_time ? hhmm(i.start_time) + (i.end_time ? ' – ' + hhmm(i.end_time) : '') : t('noTime')}${i.is_fixed ? ` <span class="lock">${ic('ti-lock')} ${t('fixed')}</span>` : ''}</span><span class="d">${i.booking_status === 'todo' ? t('todo') : ''}</span></div><p class="n"><a href="#item-${i.id}" style="text-decoration:none">${esc(i.title)}</a></p><p class="s">${t('kinds')[i.kind]}</p>${c ? `<p class="tip">${ic('ti-bolt')} ${t('conflict')}</p></div>` : ''}</div>`;
  }).join('');
  const all = items(), b = budget(all), bd = budget(list), k = budgetUnit === 'grp' ? partySize() : 1;
  const cap = data.trip.budget_cap_minor, pct = cap ? Math.min(100, Math.round(b.est / cap * 100)) : null;
  const other = Object.entries(b.other).map(([c, v]) => money(v * k, c)).join('、');
  const notes = [];
  all.filter(i => i.booking_status === 'todo').sort((a, c) => String(a.remind_on || '9').localeCompare(String(c.remind_on || '9'))).forEach(i => notes.push(`<div class="rm"><i class="dot" style="background:#C9733B"></i>${esc(i.title)} <span class="tag o">${i.remind_on ? t('remindTag')(t('md')(parse(i.remind_on))) : t('todo')}</span></div>`));
  days().forEach(dd => { const cf = conflictsOf(itemsOf(dd.id)); Object.keys(cf).forEach(id => { const it = all.find(x => x.id === id); notes.push(`<div class="rm"><i class="dot" style="background:var(--danger)"></i>DAY ${dd.day_index} · ${esc(it.title)} <span class="tag o">${t('conflict')}</span></div>`); }); });
  $('aside').innerHTML = `
    <section class="note"><div class="nh"><h3>${ic('ti-map-2')}${t('tlTitle')(d.day_index)}</h3><span class="cnt">${t('stops')(list.filter(i => i.kind !== 'transport').length)}</span></div>
      <div class="nb">${tl ? `<div class="tl">${tl}</div>` : `<p class="empty">${t('emptyDay')}</p>`}</div></section>
    <section class="note"><div class="nh"><h3>${ic('ti-pig-money')}${t('budgetTitle')}</h3>${b.base ? `<span class="cnt ok">${b.base}</span>` : ''}</div>
      <div class="nb">${b.base ? `<p class="meta" style="margin-bottom:10px">${t('partyNote')(partySize())}</p>
        <div class="seg" role="group" aria-label="${t('unit')}"><button aria-pressed="${budgetUnit === 'pp'}" data-act="unit" data-u="pp">${t('perPersonL')}</button><button aria-pressed="${budgetUnit === 'grp'}" data-act="unit" data-u="grp">${t('groupL')(partySize())}</button></div>
        <div class="big"><div class="r"><span>${t('tripEst')}</span><span class="v">${money(b.est * k, b.base)}</span></div><div class="r"><span class="meta">${t('dayEst')(d.day_index)}</span><span class="acc">${money(bd.est * k, b.base)}</span></div></div>
        <div class="two"><div><i style="background:#2E4B61"></i>${t('paid')}<b>${money(b.paid * k, b.base)}</b></div><div><i style="background:#B86B45"></i>${t('unpaid')}<b>${money(Math.max(0, b.est - b.paid) * k, b.base)}</b></div></div>
        ${cap ? `<div class="bar-r"><span>${t('vsCap')}</span><span>${money(b.est * k, b.base)} / ${money(cap * k, b.base)}</span></div><div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${t('vsCap')}"><div style="width:${pct}%"></div></div><div class="bar-f"><span class="g">${t('capPct')(pct)}</span><span>${b.est <= cap ? t('capLeft')(money((cap - b.est) * k, b.base)) : t('capOver')(money((b.est - cap) * k, b.base))}</span></div>` : (isOwner() ? `<p class="meta" style="margin-top:10px"><button class="lk edit-only" data-act="settings">${ic('ti-target')}${t('setCap')}</button></p>` : '')}
        ${b.actual ? `<p class="meta" style="margin-top:8px">${t('actualTotal')(money(b.actual, b.base))}</p>` : ''}
        ${other ? `<p class="meta" style="margin-top:6px">${t('otherCur')(other)}</p>` : ''}
        <p class="meta bud-note">${ic('ti-info-circle')}${t('budgetNote')}</p>`
        : `<p class="empty">${t('noBudget')}</p>${isOwner() ? `<p style="margin-top:8px"><button class="lk edit-only" data-act="settings">${ic('ti-settings')}${t('setCurrency')}</button></p>` : ''}`}</div></section>
    ${data.role ? `<section class="note"><div class="nh"><h3>${ic('ti-pin')}${t('notesTitle')}</h3><span class="cnt">${t('nItems')(notes.length)}</span></div><div class="nb">${notes.join('') || `<p class="empty">${t('noNotes')}</p>`}</div></section>` : ''}
    ${data.role ? `<div class="line"><span class="lg">SHARE</span><div class="tx" id="presenceBox">${presenceHtml()}</div>${isOwner() ? `<button class="btn" data-act="invite">${ic('ti-user-plus')} ${t('copyInviteShort')}</button>` : ''}</div>` : ''}`;
}
function presenceHtml() {
  const on = onlineList(), names = [...new Set(on.map(p => p.nickname).filter(Boolean))];
  const ed = on.filter(p => p.editing).map(p => { const it = items().find(i => i.id === p.editing); return it ? t('isEditingItem')(esc(p.nickname), esc(it.title)) : ''; }).filter(Boolean);
  return `<b>${t('coEdit')} <span class="on">${t('onlineN')(Math.max(1, names.length))}</span></b><p class="s">${ed[0] || t('membersN')((data.members || []).length)}</p>`;
}
function renderNav() {
  $('mnav').innerHTML = `<a href="index.html#mine" style="text-decoration:none" class="mbtn">${ic('ti-folder')}<span>${t('myTrips')}</span></a>
    ${canEdit() ? `<button class="add edit-only" data-act="add">${ic('ti-plus')}<span>${t('addStop')}</span></button>` : '<span></span>'}
    ${isOwner() ? `<button data-act="share">${ic('ti-share')}<span>${t('share')}</span></button>` : `<button data-act="print">${ic('ti-printer')}<span>${t('pdf')}</span></button>`}
    ${canEdit() ? `<button data-act="read" aria-pressed="${reading}">${ic('ti-eye')}<span>${t('readMode')}</span></button>` : '<span></span>'}
    <button data-act="theme">${ic('ti-palette')}<span>${t('theme')}</span></button>`;
}

/* ---------- 編輯面板（FR-05～FR-12） ---------- */
let editing = null;
function openEditor(id) {
  const i = items().find(x => x.id === id); if (!i) return;
  editing = { id, base: Object.assign({}, i.field_versions || {}), orig: JSON.parse(JSON.stringify(i)) };
  myEditing = id; trackPresence();
  const ex = i.extra || {}, h = ex.hours || {}, cur = i.currency || data.trip.base_currency || '';
  const dayOpts = days().filter(d => d.day_index >= (days().find(x => x.id === i.day_id) || {}).day_index).map(d => `<option value="${d.id}" ${d.id === (i.end_day_id || i.day_id) ? 'selected' : ''}>DAY ${d.day_index} · ${t('mdw')(parse(d.date))}</option>`).join('');
  $('itemBody').innerHTML = `
    <div class="kinds" role="group" aria-label="${t('kind')}">${Object.keys(KIND_ICON).map(k => `<button type="button" data-kind="${k}" aria-pressed="${k === i.kind}">${ic(KIND_ICON[k])}${t('kinds')[k]}</button>`).join('')}</div>
    <label class="fl" for="f_title">${t('fTitle')} *</label><input class="inp" id="f_title" maxlength="120" value="${esc(i.title)}" required>
    <div class="row3c"><div><label class="fl" for="f_start">${t('fStart')}</label><input class="inp" type="time" id="f_start" value="${hhmm(i.start_time)}"></div>
      <div><label class="fl" for="f_end">${t('fEnd')}</label><input class="inp" type="time" id="f_end" value="${hhmm(i.end_time)}"></div>
      <div><label class="chk" style="margin-top:34px"><input type="checkbox" id="f_fixed" ${i.is_fixed ? 'checked' : ''}>${ic('ti-lock')}${t('fixed')}</label></div></div>
    <p class="hint">${t('fixedHint')}</p>
    <div data-show="transport"><div class="row2"><div><label class="fl" for="f_mode">${t('fMode')}</label><select class="sel" id="f_mode">${Object.keys(MODE_ICON).map(m => `<option value="${m}" ${m === (ex.mode || 'taxi') ? 'selected' : ''}>${t('modes')[m]}</option>`).join('')}</select></div>
      <div><label class="fl" for="f_dur">${t('fDuration')}</label><input class="inp" type="number" min="0" max="1440" id="f_dur" value="${ex.duration || ''}"></div></div></div>
    <div data-show="lodging"><label class="fl" for="f_endday">${t('fLastNight')}</label><select class="sel" id="f_endday">${dayOpts}</select></div>
    <div data-hide="transport note">
      <label class="fl" for="f_desc">${t('fDesc')}</label><textarea class="ta" id="f_desc" maxlength="1000">${esc(ex.desc || '')}</textarea>
      <div class="fsec"><h3>${ic('ti-photo')}${t('fPhoto')}</h3>
        <div class="row2"><div><label class="fl" for="f_photo">${t('fPhotoUrl')}</label><input class="inp" id="f_photo" inputmode="url" placeholder="https://" value="${esc(ex.photo_url || '')}"></div>
        <div><label class="fl" for="f_upload">${t('fUpload')}</label><input class="inp" type="file" id="f_upload" accept="image/jpeg,image/png,image/webp" style="padding:8px"></div></div>
        <p class="hint">${t('photoHint')}</p>
        <div class="photo-prev" id="photoPrev">${safeUrl(ex.photo_url) ? `<img src="${esc(ex.photo_url)}" alt="">` : ''}</div>
        <label class="fl" for="f_note">${t('fPhotoNote')}</label><input class="inp" id="f_note" maxlength="40" value="${esc(ex.photo_note || '')}" placeholder="${esc(i.title)}"></div>
      <div class="fsec"><h3>${ic('ti-clock')}${t('fHours')}</h3>
        <div class="row2"><div><label class="fl" for="f_open">${t('fOpen')}</label><input class="inp" type="time" id="f_open" value="${esc(h.open || '')}"></div><div><label class="fl" for="f_close">${t('fClose')}</label><input class="inp" type="time" id="f_close" value="${esc(h.close || '')}"></div></div>
        <p class="fl">${t('fClosedDays')}</p><div class="days7">${[0, 1, 2, 3, 4, 5, 6].map(w => `<label><input type="checkbox" name="f_closed" value="${w}" ${(h.closed || []).includes(w) ? 'checked' : ''}>${t('wd')[w]}</label>`).join('')}</div></div>
    </div>
    <div class="fsec" data-hide="note"><h3>${ic('ti-coins')}${t('fCost')}</h3>
      <div class="row3c"><div><label class="fl" for="f_cur">${t('fCurrency')}</label><select class="sel" id="f_cur"><option value="">—</option>${[...new Set([cur, ...CURRENCIES].filter(Boolean))].map(c => `<option ${c === cur ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
        <div><label class="fl" for="f_min">${t('fMin')}</label><input class="inp" type="number" min="0" step="any" id="f_min" value="${toMajor(i.est_min_minor, cur)}"></div>
        <div><label class="fl" for="f_max">${t('fMax')}</label><input class="inp" type="number" min="0" step="any" id="f_max" value="${toMajor(i.est_max_minor, cur)}"></div></div>
      <div class="row2"><div><label class="fl" for="f_basis">${t('fBasis')}</label><select class="sel" id="f_basis"><option value="per_person" ${i.cost_basis !== 'group' ? 'selected' : ''}>${t('perPersonL')}</option><option value="group" ${i.cost_basis === 'group' ? 'selected' : ''}>${t('wholeGroup')}</option></select></div>
        <div><label class="fl" for="f_paid">${t('fPaid')}</label><input class="inp" type="number" min="0" step="any" id="f_paid" value="${toMajor(i.paid_minor, cur)}"></div></div></div>
    <div class="fsec" data-hide="note transport"><h3>${ic('ti-ticket')}${t('fBooking')}</h3>
      <div class="row2"><div><label class="fl" for="f_bstat">${t('fBookStatus')}</label><select class="sel" id="f_bstat"><option value="">—</option>${['todo', 'booked', 'none_needed'].map(s => `<option value="${s}" ${s === i.booking_status ? 'selected' : ''}>${t('bstat')[s]}</option>`).join('')}</select></div>
        <div><label class="fl" for="f_remind">${t('fRemind')}</label><input class="inp" type="date" id="f_remind" value="${esc(i.remind_on || '')}"></div></div>
      <div class="row2"><div><label class="fl" for="f_burl">${t('fBookUrl')}</label><input class="inp" id="f_burl" inputmode="url" placeholder="https://" value="${esc(i.booking_url || '')}"></div>
        <div><label class="fl" for="f_code">${t('fCode')}</label><input class="inp" id="f_code" maxlength="60" value="${esc(i.booking_code || '')}"></div></div>
      <p class="hint">${t('codeHint')}</p></div>
    <div class="fsec" data-hide="note"><h3>${ic('ti-link')}${t('fLinks')}</h3>
      <div class="row2"><div><label class="fl" for="f_map">${t('fMap')}</label><input class="inp" id="f_map" inputmode="url" placeholder="https://" value="${esc(ex.map_url || '')}"></div>
        <div><label class="fl" for="f_site">${t('fSite')}</label><input class="inp" id="f_site" inputmode="url" placeholder="https://" value="${esc(ex.site_url || '')}"></div></div>
      <p class="hint">${t('urlHint')}</p></div>
    <p class="err" id="itemErr" role="alert" hidden></p><div id="conflictNote"></div>`;
  applyKindVisibility(i.kind);
  $('itemDlg').showModal();
  $('f_title').focus();
}
function applyKindVisibility(kind) {
  $('itemBody').querySelectorAll('[data-show]').forEach(el => { el.hidden = !el.dataset.show.split(' ').includes(kind); });
  $('itemBody').querySelectorAll('[data-hide]').forEach(el => { el.hidden = el.dataset.hide.split(' ').includes(kind); });
}
function readEditor() {
  const kind = ($('itemBody').querySelector('[data-kind][aria-pressed=true]') || {}).dataset.kind;
  const cur = $('f_cur').value || null;
  const closed = [...$('itemBody').querySelectorAll('input[name=f_closed]:checked')].map(x => +x.value);
  const o = editing.orig, ex = Object.assign({}, o.extra || {});
  const set = (k, v) => { if (v === '' || v == null || (Array.isArray(v) && !v.length)) delete ex[k]; else ex[k] = v; };
  set('desc', $('f_desc').value.trim()); set('photo_url', $('f_photo').value.trim()); set('photo_note', $('f_note').value.trim());
  set('map_url', $('f_map').value.trim()); set('site_url', $('f_site').value.trim());
  const hours = {}; if ($('f_open').value) hours.open = $('f_open').value; if ($('f_close').value) hours.close = $('f_close').value; if (closed.length) hours.closed = closed;
  set('hours', Object.keys(hours).length ? hours : null);
  if (kind === 'transport') { set('mode', $('f_mode').value); set('duration', $('f_dur').value ? Math.max(0, Math.min(1440, +$('f_dur').value)) : null); }
  const next = {
    title: $('f_title').value.trim(), kind,
    start_time: $('f_start').value || null, end_time: $('f_end').value || null, is_fixed: $('f_fixed').checked,
    currency: cur, cost_basis: $('f_basis').value,
    est_min_minor: toMinor($('f_min').value, cur), est_max_minor: toMinor($('f_max').value, cur), paid_minor: toMinor($('f_paid').value, cur),
    booking_status: $('f_bstat').value || null, remind_on: $('f_remind').value || null,
    booking_url: $('f_burl').value.trim() || null, booking_code: $('f_code').value.trim() || null,
    end_day_id: kind === 'lodging' ? ($('f_endday').value || null) : o.end_day_id, extra: ex
  };
  const patch = {}, base = {};
  Object.keys(next).forEach(k => {
    const a = JSON.stringify(next[k] == null ? null : next[k]), b = JSON.stringify(o[k] == null ? null : (k.endsWith('_time') ? hhmm(o[k]) || null : o[k]));
    if (a === b) return;
    if (k === 'end_day_id' && next[k] === o.day_id && !o.end_day_id) return;          // 只住一晚：不必寫入
    if (k === 'currency' && o.currency == null && next.est_min_minor == null && next.est_max_minor == null && next.paid_minor == null) return;
    patch[k] = next[k]; base[k] = editing.base[k] || 0;
  });
  return { patch, base };
}
function validateEditor(patch) {
  const e = [];
  if (!$('f_title').value.trim()) e.push(t('vTitle'));
  ['f_photo', 'f_map', 'f_site', 'f_burl'].forEach(id => { const v = $(id).value.trim(); $(id).setAttribute('aria-invalid', v && !safeUrl(v) ? 'true' : 'false'); if (v && !safeUrl(v)) e.push(t('vUrl')); });
  const mn = +$('f_min').value, mx = +$('f_max').value; if ($('f_min').value && $('f_max').value && mn > mx) e.push(t('vRange'));
  if ($('f_start').value && $('f_end').value && $('f_end').value < $('f_start').value) e.push(t('vTime'));
  const el = $('itemErr'); el.hidden = !e.length; el.textContent = [...new Set(e)].join(' ');
  return !e.length;
}
async function saveEditor(force) {
  const { patch, base } = readEditor();
  if (!validateEditor(patch)) return;
  if (!Object.keys(patch).length) return closeEditor();
  if (force) Object.keys(force).forEach(k => { base[k] = force[k]; });
  $('itemSave').classList.add('busy');
  try {
    const r = await write('update_item', { p_item: editing.id, p_patch: patch, p_base: base }, { noReload: true });
    if (r && r.conflicts && r.conflicts.length) {
      // 別人剛改過同一欄位：不覆蓋，讓使用者決定
      setSync('conflict');
      const fresh = r.item;
      $('conflictNote').innerHTML = `<div class="conflict-note">${t('conflictSaved')(r.conflicts.map(k => t('fieldNames')[k] || k).join('、'))}
        <div class="linkrow"><button type="button" class="bl" data-act="useTheirs">${t('useTheirs')}</button><button type="button" class="btn-danger" data-act="useMine">${t('useMine')}</button></div></div>`;
      editing.pendingForce = {}; r.conflicts.forEach(k => { editing.pendingForce[k] = (fresh.field_versions || {})[k]; });
      editing.orig = fresh; editing.base = Object.assign({}, fresh.field_versions || {});
      scheduleReload(0);
      return;
    }
    closeEditor(); scheduleReload(0);
  } catch (e) { /* write() 已提示 */ } finally { $('itemSave').classList.remove('busy'); }
}
function closeEditor() { if ($('itemDlg').open) $('itemDlg').close(); editing = null; myEditing = null; trackPresence(); if (syncState === 'conflict') setSync('saved'); }
$('itemDlg').addEventListener('close', () => { editing = null; myEditing = null; trackPresence(); });
$('itemSave').addEventListener('click', () => saveEditor());
$('itemBody').addEventListener('click', e => {
  const k = e.target.closest('[data-kind]');
  if (k) { $('itemBody').querySelectorAll('[data-kind]').forEach(b => b.setAttribute('aria-pressed', b === k)); applyKindVisibility(k.dataset.kind); }
});
$('itemBody').addEventListener('change', async e => {
  if (e.target.id !== 'f_upload' || !e.target.files[0]) return;
  const f = e.target.files[0];
  if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { toast(t('photoType')); e.target.value = ''; return; }
  if (f.size > 5 * 1024 * 1024) { toast(t('photoSize')); e.target.value = ''; return; }
  const path = `${tripId}/${(crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2))}.${f.type.split('/')[1].replace('jpeg', 'jpg')}`;
  toast(t('uploading'));
  const { error } = await sb.storage.from('trip-photos').upload(path, f, { contentType: f.type, upsert: false });
  if (error) { toast(errMsg(error)); return; }
  const url = sb.storage.from('trip-photos').getPublicUrl(path).data.publicUrl;
  $('f_photo').value = url; $('photoPrev').innerHTML = `<img src="${esc(url)}" alt="">`; toast(t('uploaded'));
});

/* ---------- 新增卡片 ---------- */
let addAfter = null;
function openAdd(kind, after) {
  addAfter = after || null;
  $('addKinds').innerHTML = Object.keys(KIND_ICON).map(k => `<button type="button" data-kind="${k}" aria-pressed="${k === (kind || 'place')}">${ic(KIND_ICON[k])}${t('kinds')[k]}</button>`).join('');
  $('addTitle').value = ''; $('addErr').hidden = true;
  $('addDlg').showModal(); $('addTitle').focus();
}
$('addKinds').addEventListener('click', e => { const k = e.target.closest('[data-kind]'); if (k) $('addKinds').querySelectorAll('[data-kind]').forEach(b => b.setAttribute('aria-pressed', b === k)); });
$('addForm').addEventListener('submit', async e => {
  e.preventDefault();
  const title = $('addTitle').value.trim();
  if (!title) { $('addErr').hidden = false; $('addTitle').focus(); return; }
  const kind = $('addKinds').querySelector('[aria-pressed=true]').dataset.kind;
  $('addOk').classList.add('busy');
  try {
    const it = await write('add_item', { p_trip: tripId, p_day: day().id, p_kind: kind, p_title: title, p_after: addAfter }, { noReload: true });
    $('addDlg').close();
    await load();
    if (it && it.id) openEditor(it.id);
  } catch (err) { /* 已提示 */ } finally { $('addOk').classList.remove('busy'); }
});

/* ---------- 分享設定（FR-13、FR-16、FR-18） ---------- */
async function inviteLink(kind) {
  const k = `ts-inv-${kind}-${tripId}`; let tok = null; try { tok = sessionStorage.getItem(k); } catch (e) {}
  if (!tok) { tok = await rpc('create_invite', { p_trip: tripId, p_kind: kind }); try { sessionStorage.setItem(k, tok); } catch (e) {} }
  return SH.inviteUrl(tripId, tok);
}
const copyText = s => SH.copy(s);
const sheetKind = {};   // 連結 → edit／view／read，記錄是從哪個分享方式送出
function sheetHtml(url, kind, text) { sheetKind[url] = kind; return SH.sheet({ url, text, title: data.trip.title, lang, ic, esc }); }
async function fillInvite(box, kind) {
  box.innerHTML = `<p class="hint">${t('preparing')}</p>`;
  try { const link = await inviteLink(kind); box.innerHTML = sheetHtml(link, kind, (kind === 'edit' ? t('lineText') : t('viewText'))(data.trip.title)); }
  catch (e) { box.innerHTML = `<p class="err">${esc(errMsg(e))}</p>`; }
}
function openSheetDlg(title, hint, html) {
  $('sheetTitle').textContent = title; $('sheetHint').textContent = hint; $('sheetBody').innerHTML = html;
  $('sheetDlg').showModal();
}
function openInvite() {
  if (!isOwner()) { toast(t('ownerOnly')); return; }
  openSheetDlg(t('inviteTitle'), t('editLinkHint'), '');
  fillInvite($('sheetBody'), 'edit');
}
function openReadShare() {
  openSheetDlg(t('shareTitle'), t('shareReadHint'), sheetHtml(SH.readUrl(tripId), 'read', t('readText')(data.trip.title)));
}
SH.bind(document, (ch, url) => {
  if (ch === 'copy') toast(sheetKind[url] === 'edit' ? t('inviteCopied') : sheetKind[url] === 'view' ? t('viewCopied') : t('readUrlCopied'));
  if (session) sb.rpc('log_event', { p_name: 'share_opened', p_trip: tripId, p_props: { channel: ch, kind: sheetKind[url] || 'read' } }).then(() => {}, () => {});
});
function openShare() {
  if (!isOwner()) { toast(t('ownerOnly')); return; }
  const v = data.trip.visibility;
  $('shareBody').innerHTML = `
    <p class="fl">${t('visibility')}</p>
    ${['private', 'link', 'public'].map(k => `<label class="opt"><input type="radio" name="vis" value="${k}" ${k === v ? 'checked' : ''}><span><b>${ic({ private: 'ti-lock', link: 'ti-link', public: 'ti-world' }[k])} ${t('vis')[k]}</b><span class="hint">${t('visDesc')[k]}</span></span></label>`).join('')}
    <div id="pubBox" ${v === 'public' ? '' : 'hidden'}><div class="warnbox">${t('pubPreview')}</div>
      <label class="chk"><input type="checkbox" id="pubAgree" ${v === 'public' ? 'checked' : ''}>${t('pubAgree')}</label></div>
    <div class="fsec"><h3>${ic('ti-user-plus')}${t('editLink')}</h3><p class="hint">${t('editLinkHint')}</p>
      <div id="shEdit"></div></div>
    <div class="fsec"><h3>${ic('ti-eye')}${t('viewLink')}</h3><p class="hint">${t('viewLinkHint')}</p>
      <div id="shView"><button class="bl" data-act="showView">${ic('ti-link')}${t('makeViewLink')}</button></div></div>
    <div class="fsec" id="readBox" ${v === 'private' ? 'hidden' : ''}><h3>${ic('ti-world')}${t('readUrl')}</h3><p class="hint">${t('readUrlHint')}</p>
      ${sheetHtml(SH.readUrl(tripId), 'read', t('readText')(data.trip.title))}</div>
    <div class="fsec"><h3>${ic('ti-users')}${t('membersTitle')}</h3>
      ${(data.members || []).map(m => `<div class="mem"><span class="dot${onlineList().some(p => p.nickname === m.nickname) ? ' on' : ''}"></span>${esc(m.nickname || '—')}${m.is_me ? ` (${t('you')})` : ''}<span class="role">${t('roles')[m.role]}</span>${m.role !== 'owner' ? `<button class="bl" style="height:28px" data-act="removeMember" data-id="${m.user_id}">${t('removeMember')}</button>` : ''}</div>`).join('')}
      <div class="linkrow"><button class="btn-danger" data-act="revokeAll">${ic('ti-link-off')}${t('revokeAll')}</button></div><p class="hint">${t('revokeHint')}</p></div>`;
  $('shareDlg').showModal();
  fillInvite($('shEdit'), 'edit');
}
$('shareBody').addEventListener('change', e => { if (e.target.name === 'vis') { $('pubBox').hidden = e.target.value !== 'public'; $('readBox').hidden = e.target.value === 'private'; } });
$('shareSave').addEventListener('click', async () => {
  const v = ($('shareBody').querySelector('input[name=vis]:checked') || {}).value;
  if (v === data.trip.visibility) return $('shareDlg').close();
  if (v === 'public' && !$('pubAgree').checked) { toast(t('pubNeedAgree')); return; }
  try { await write('set_visibility', { p_trip: tripId, p_visibility: v, p_agree_public_license: v === 'public' }); $('shareDlg').close(); toast(t('visSaved')); } catch (e) {}
});

/* ---------- 行程設定（FR-02） ---------- */
function openSettings() {
  if (!isOwner()) { toast(t('ownerOnly')); return; }
  const tr = data.trip, cur = tr.base_currency || '';
  $('setBody').innerHTML = `
    <label class="fl" for="s_title">${t('fTripTitle')}</label><input class="inp" id="s_title" maxlength="80" value="${esc(tr.title)}">
    <div class="row2"><div><label class="fl" for="s_start">${t('fStartDate')}</label><input class="inp" type="date" id="s_start" value="${esc(tr.start_date)}"></div>
      <div><label class="fl" for="s_party">${t('fParty')}</label><select class="sel" id="s_party">${t('partyOpts').map(([k, l]) => `<option value="${k}" ${k === (tr.party_size || '') ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
    <p class="hint">${t('startHint')(days().length)}</p>
    <div class="row2"><div><label class="fl" for="s_cur">${t('fBaseCur')}</label><select class="sel" id="s_cur"><option value="">—</option>${CURRENCIES.map(c => `<option ${c === cur ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div><label class="fl" for="s_cap">${t('fCap')}</label><input class="inp" type="number" min="0" step="any" id="s_cap" value="${cur ? toMajor(tr.budget_cap_minor, cur) : ''}"></div></div>
    <div class="fsec"><h3>${ic('ti-calendar-minus')}${t('removeDay')}</h3><p class="hint">${t('removeDayHint')}</p>
      <div class="linkrow"><select class="sel" id="s_day" style="max-width:260px">${days().map(d => `<option value="${d.id}">DAY ${d.day_index} · ${t('mdw')(parse(d.date))} · ${t('stops')(itemsOf(d.id).length)}</option>`).join('')}</select><button class="btn-danger" data-act="removeDay" ${days().length <= 1 ? 'disabled' : ''}>${t('remove')}</button></div></div>
    <div class="fsec"><h3>${ic('ti-download')}${t('exportTitle')}</h3><div class="linkrow"><button class="bl" data-act="exportJson">${ic('ti-file-code')}JSON</button><button class="bl" data-act="print">${ic('ti-printer')}${t('pdf')}</button></div></div>`;
  $('setDlg').showModal();
}
$('setSave').addEventListener('click', async () => {
  const tr = data.trip, patch = {}, cur = $('s_cur').value || null;
  if ($('s_title').value.trim() && $('s_title').value.trim() !== tr.title) patch.title = $('s_title').value.trim();
  if ($('s_start').value && $('s_start').value !== tr.start_date) patch.start_date = $('s_start').value;
  if (($('s_party').value || null) !== (tr.party_size || null)) patch.party_size = $('s_party').value || null;
  if (cur !== (tr.base_currency || null)) patch.base_currency = cur;
  const cap = cur ? toMinor($('s_cap').value, cur) : null;
  if (cap !== (tr.budget_cap_minor == null ? null : tr.budget_cap_minor)) patch.budget_cap_minor = cap;
  if (!Object.keys(patch).length) return $('setDlg').close();
  try { await write('update_trip', { p_trip: tripId, p_patch: patch }); $('setDlg').close(); toast(t('saved')); } catch (e) {}
});

/* ---------- 郵戳選擇（FR-40） ---------- */
let stampItem = null;
function openStamps(itemId) {
  stampItem = itemId;
  const on = new Set((data.item_stamps || []).filter(x => x.item_id === itemId).map(x => x.stamp_type_id));
  $('stampBody').innerHTML = `<p class="hint">${t('stampLinkedHint')}</p>
    <div class="picklist">${(data.stamp_types || []).map(s => `<button type="button" data-act="toggleStamp" data-id="${itemId}" data-stamp="${s.id}" aria-current="${on.has(s.id)}"><span class="rs" data-ink="${esc(s.ink)}" style="width:40px;height:40px"><span>${esc(s.label)}</span></span>${esc(s.label)}${on.has(s.id) ? ` · ${t('stamped')}` : ''}<span style="margin-left:auto" data-act="delStampType" data-stamp="${s.id}" role="button" aria-label="${t('deleteStampType')}">${ic('ti-trash')}</span></button>`).join('') || `<p class="hint">${t('noStamps')}</p>`}</div>
    <form id="newStamp" class="fsec"><h3>${ic('ti-plus')}${t('newStamp')}</h3><div class="row2"><div><label class="fl" for="ns_label">${t('stampLabel')}</label><input class="inp" id="ns_label" maxlength="12"></div>
      <div><label class="fl" for="ns_ink">${t('stampInk')}</label><select class="sel" id="ns_ink">${['red', 'brown', 'green', 'blue', 'purple'].map(k => `<option value="${k}">${t('inks')[k]}</option>`).join('')}</select></div></div>
      <div class="linkrow"><button class="bd">${t('create')}</button></div></form>`;
  $('stampDlg').showModal();
}
$('stampBody').addEventListener('submit', async e => {
  e.preventDefault(); const label = $('ns_label').value.trim(); if (!label) return;
  try { await write('create_stamp_type', { p_trip: tripId, p_label: label, p_ink: $('ns_ink').value }, { noReload: true }); await load(); openStamps(stampItem); } catch (err) {}
});

/* ---------- 移到其他天 ---------- */
let moveItemId = null;
function openMove(id) {
  moveItemId = id; const it = items().find(i => i.id === id);
  $('moveBody').innerHTML = `<div class="picklist">${days().map(d => `<button type="button" data-act="moveTo" data-day="${d.id}" aria-current="${d.id === it.day_id}">DAY ${d.day_index} · ${t('mdw')(parse(d.date))}${d.subtitle ? ' · ' + esc(d.subtitle) : ''}</button>`).join('')}</div>`;
  $('moveDlg').showModal();
}

/* ---------- 實際花費（FR-41） ---------- */
let actualItem = null;
$('actualForm').addEventListener('submit', async e => {
  e.preventDefault();
  const it = actualItem, cur = it.currency || data.trip.base_currency, v = $('acInput').value.trim(), m = toMinor(v, cur);
  if (!v || m == null || m < 0) { $('acErr').hidden = false; return; }
  $('actualDlg').close();
  await write('set_visit', { p_item: it.id, p_status: it.visit_status === 'unknown' ? 'went' : it.visit_status, p_actual_minor: m }).catch(() => {});
});

/* ---------- 確認框 ---------- */
let confirmFn = null;
function confirmBox(title, body, ok, fn) { $('cfTitle').textContent = title; $('cfBody').textContent = body; $('cfOk').textContent = ok; confirmFn = fn; $('confirmDlg').showModal(); }
$('cfOk').addEventListener('click', () => { $('confirmDlg').close(); const f = confirmFn; confirmFn = null; if (f) f(); });

/* ---------- 列印（全部天數） ---------- */
function buildPrint() {
  const tr = data.trip;
  $('printArea').innerHTML = `<h1>${esc(tr.title)}</h1><p class="pm">${esc(tr.start_date)} – ${esc(tr.end_date)}</p>` + days().map(d => {
    const l = itemsOf(d.id);
    return `<h2>DAY ${d.day_index} · ${t('mdw')(parse(d.date))}${d.subtitle ? ' · ' + esc(d.subtitle) : ''}</h2>` + (l.map(i => `<div class="pi"><span>${i.start_time ? hhmm(i.start_time) + (i.end_time ? '–' + hhmm(i.end_time) : '') : ''}</span><span><b>${esc(i.title)}</b> <span class="pm">${t('kinds')[i.kind]}${estOf(i) != null ? ' · ' + t('approxPP')(money(perPerson(i), i.currency)) : ''}${i.booking_status ? ' · ' + t('bstat')[i.booking_status] : ''}</span>${(i.extra || {}).desc ? `<br><span class="pm">${esc(i.extra.desc)}</span>` : ''}</span></div>`).join('') || `<p class="pm">${t('unplanned')}</p>`);
  }).join('') + `<p class="pm" style="margin-top:18px">Travel Studio</p>`;
}
window.addEventListener('beforeprint', () => { if (data) buildPrint(); });

/* ---------- 事件委派 ---------- */
document.addEventListener('submit', async e => {
  const f = e.target.closest('.memo-add'); if (!f) return;
  e.preventDefault(); const inp = f.querySelector('input'), body = inp.value.trim(); if (!body) return;
  inp.disabled = true;
  try { await write('add_memo', { p_item: f.dataset.memo, p_body: body }); inp.value = ''; } catch (err) {} finally { inp.disabled = false; }
});
document.addEventListener('click', async e => {
  const out = e.target.closest('a[data-out]');
  if (out && session) sb.rpc('log_event', { p_name: 'outbound_clicked', p_trip: tripId, p_props: { kind: out.dataset.out } }).then(() => {}, () => {});
  const a = e.target.closest('[data-act]'); if (!a || a.disabled) return;
  const act = a.dataset.act, id = a.dataset.id;
  const it = id ? items().find(i => i.id === id) : null;
  switch (act) {
    case 'day': dayIdx = +a.dataset.dix; history.replaceState(null, '', `#day=${dayIdx + 1}`); renderDays(); renderMain(); renderAside(); window.scrollTo({ top: 0 }); break;
    case 'addDay': try { await write('add_day', { p_trip: tripId }, { noReload: true }); await load(); dayIdx = days().length - 1; render(); } catch (err) {} break;
    case 'add': openAdd(); break;
    case 'edit': openEditor(id); break;
    case 'up': case 'down': {
      const list = itemsOf(it.day_id), k = list.findIndex(x => x.id === id);
      await write('move_item', { p_item: id, p_day: it.day_id, p_index: k + (act === 'up' ? -1 : 1) }).catch(() => {});
      break;
    }
    case 'moveDay': openMove(id); break;
    case 'moveTo': $('moveDlg').close(); await write('move_item', { p_item: moveItemId, p_day: a.dataset.day, p_index: 9999 }).catch(() => {}); toast(t('moved')); break;
    case 'dup': await write('duplicate_item', { p_item: id }).catch(() => {}); break;
    case 'del': confirmBox(t('delItemTitle'), t('delItemBody')(it.title), t('remove'), () => write('delete_item', { p_item: id }).catch(() => {})); break;
    case 'visit': await write('set_visit', { p_item: id, p_status: it.visit_status === a.dataset.v ? 'unknown' : a.dataset.v }).catch(() => {}); break;
    case 'actual': {
      const cur = it.currency || data.trip.base_currency;
      if (!cur) { toast(t('needCurrency')); break; }
      actualItem = it;
      $('acLabel').textContent = t('actualPrompt')(cur);
      $('acInput').value = it.actual_minor != null ? toMajor(it.actual_minor, cur) : '';
      $('acErr').hidden = true; $('actualDlg').showModal(); $('acInput').focus();
      break;
    }
    case 'confShift': {
      const dur = it.start_time && it.end_time ? toMin(it.end_time) - toMin(it.start_time) : 60;
      await write('update_item', { p_item: id, p_patch: { start_time: a.dataset.to, end_time: fromMin(toMin(a.dataset.to) + dur) }, p_base: {} }).catch(() => {});
      break;
    }
    case 'confTransport': openAdd('transport', id); break;
    case 'confIgnore': await write('update_item', { p_item: id, p_patch: { extra: Object.assign({}, it.extra || {}, { ignore_conflict: a.dataset.key }) }, p_base: {} }).catch(() => {}); break;
    case 'subtitle': {
      if (!canEdit()) break;
      const d = day();
      $('subWrap').innerHTML = `<input class="sub-input" id="subInput" maxlength="60" value="${esc(d.subtitle || '')}" aria-label="${t('subtitleLabel')}">`;
      const inp = $('subInput'); inp.focus();
      const done = async save => { inp.onblur = null; if (save && inp.value.trim() !== (d.subtitle || '')) await write('set_day_subtitle', { p_day: d.id, p_text: inp.value }).catch(() => {}); else renderMain(); };
      inp.onblur = () => done(true);
      inp.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); inp.blur(); } if (ev.key === 'Escape') { inp.onblur = null; renderMain(); } };
      break;
    }
    case 'stampPick': openStamps(id); break;
    case 'toggleStamp': if (e.target.closest('[data-act=delStampType]')) break;
      await write('toggle_stamp', { p_item: id, p_stamp: a.dataset.stamp }, { noReload: $('stampDlg').open }).catch(() => {});
      if ($('stampDlg').open) { await load(); openStamps(stampItem); }
      break;
    case 'delStampType': {
      e.stopPropagation(); const s = (data.stamp_types || []).find(x => x.id === a.dataset.stamp);
      const n = (data.item_stamps || []).filter(x => x.stamp_type_id === s.id).length;
      $('stampDlg').close();
      confirmBox(t('delStampTitle'), t('delStampBody')(s.label, n), t('remove'), async () => { await write('delete_stamp_type', { p_stamp: s.id }).catch(() => {}); });
      break;
    }
    case 'delMemo': await write('delete_memo', { p_memo: id }).catch(() => {}); break;
    case 'unit': budgetUnit = a.dataset.u; renderAside(); break;
    case 'read': reading = !reading; render(); break;
    case 'print': buildPrint(); window.print(); sb.rpc('log_event', { p_name: 'export_pdf', p_trip: tripId, p_props: {} }).then(() => {}, () => {}); break;
    case 'lang': lang = lang === 'zh' ? 'en' : 'zh'; store.set('ts-lang', lang); render(); break;
    case 'theme': { const i = (THEMES.indexOf(theme) + 1) % THEMES.length; theme = THEMES[i]; store.set('ts-theme', theme); document.body.dataset.theme = theme; break; }
    case 'share': openShare(); break;
    case 'invite': openInvite(); break;
    case 'showView': fillInvite($('shView'), 'view'); break;
    case 'shareRead': openReadShare(); break;
    case 'report': openReport(); break;
    case 'removeMember': {
      const m = data.members.find(x => x.user_id === id);
      confirmBox(t('removeMemberTitle'), t('removeMemberBody')(m.nickname), t('removeMember'), async () => { await write('remove_collaborator', { p_trip: tripId, p_user: id }).catch(() => {}); if ($('shareDlg').open) $('shareDlg').close(); });
      break;
    }
    case 'revokeAll': $('shareDlg').close(); confirmBox(t('revokeTitle'), t('revokeBody'), t('revokeAll'), async () => {
      try { const n = await write('revoke_invites', { p_trip: tripId, p_remove_members: true }); ['edit', 'view'].forEach(k => { try { sessionStorage.removeItem(`ts-inv-${k}-${tripId}`); } catch (er) {} }); toast(t('revoked')(n || 0)); } catch (er) {}
    }); break;
    case 'settings': openSettings(); break;
    case 'removeDay': {
      const dId = $('s_day').value, d = days().find(x => x.id === dId), n = itemsOf(dId).length;
      $('setDlg').close();
      confirmBox(t('removeDayTitle')(d.day_index), t('removeDayBody')(n), t('remove'), async () => { await write('remove_day', { p_trip: tripId, p_day: dId }).catch(() => {}); dayIdx = 0; });
      break;
    }
    case 'exportJson': {
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const l = document.createElement('a'); l.href = url; l.download = `travel-studio-${tripId}.json`; document.body.appendChild(l); l.click(); l.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      break;
    }
    case 'useTheirs': closeEditor(); scheduleReload(0); break;
    case 'useMine': saveEditor(editing.pendingForce); break;
    case 'closeDlg': a.closest('dialog').close(); break;
    case 'linkAccount': signIn(null); break;
    case 'copyPublic': copyPublic(); break;
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && syncState === 'conflict') setSync('saved'); });

/* ---------- 登入（綁定帳號、複製公開行程、檢舉） ---------- */
const PENDING = 'ts-ed-pending';
function signIn(pending) {
  try { if (pending) sessionStorage.setItem(PENDING, JSON.stringify({ trip: tripId, act: pending })); } catch (e) {}
  AUTH.open({ sb, cfg: CFG, lang, ic, esc, link: !!(session && session.user.is_anonymous), redirectTo: location.href,
    onSignedIn: async s => { session = s; await load().catch(() => {}); resumePending(); } });
}
function resumePending() {
  let p = null; try { p = JSON.parse(sessionStorage.getItem(PENDING) || 'null'); sessionStorage.removeItem(PENDING); } catch (e) {}
  if (!p || p.trip !== tripId || !session) return;
  if (p.act === 'copy') copyPublic();
  if (p.act === 'report') openReport();
}
async function copyPublic() {
  if (!session || session.user.is_anonymous) return signIn('copy');
  try { const nid = await rpc('copy_trip', { p_trip: tripId }); location.href = `editor.html?trip=${encodeURIComponent(nid)}`; }
  catch (er) {
    if (/consent_required/.test(er.message)) { toast(t('needConsent')); setTimeout(() => { location.href = 'index.html'; }, 1500); return; }
    toast(errMsg(er));
  }
}
function openReport() {
  if (!session) return signIn('report');
  $('reportBody').innerHTML = `<p class="hint">${t('reportHint')}</p>
    ${['inappropriate', 'copyright', 'privacy', 'spam', 'other'].map((k, i) => `<label class="opt"><input type="radio" name="rcat" value="${k}" ${i ? '' : 'checked'}><span><b>${t('rcat')[k][0]}</b><span class="hint">${t('rcat')[k][1]}</span></span></label>`).join('')}
    <label class="fl" for="rNote">${t('reportNote')}</label><textarea class="ta" id="rNote" maxlength="500"></textarea>
    <p class="hint">${t('reportContact')(esc(CFG.CONTACT_EMAIL))}</p>`;
  $('reportDlg').showModal();
}
$('reportSend').addEventListener('click', async () => {
  const cat = ($('reportBody').querySelector('input[name=rcat]:checked') || {}).value;
  $('reportSend').classList.add('busy');
  try { await rpc('report_trip', { p_trip: tripId, p_category: cat, p_note: $('rNote').value.trim() || null }); $('reportDlg').close(); toast(t('reportThanks')); }
  catch (e) { toast(errMsg(e)); } finally { $('reportSend').classList.remove('busy'); }
});

/* ---------- 啟動 ---------- */
function fatal(title, body) {
  document.querySelector('.app').hidden = true; $('mnav').hidden = true;
  $('fatal').hidden = false;
  $('fatal').innerHTML = `<h1>${esc(title)}</h1><p>${esc(body)}</p><p style="margin-top:14px"><a href="index.html">${t('backHome')}</a></p>`;
}
async function init() {
  document.body.dataset.theme = theme;
  if (!tripId) return fatal(t('notFound'), t('notFoundBody'));
  try {
    const { data: s } = await sb.auth.getSession(); session = s.session;
    await load();
  } catch (e) {
    if (/forbidden/.test(e.message)) return fatal(t('noAccess'), session ? t('noAccessBody') : t('noAccessLogin'));
    return fatal(t('loadFailed'), errMsg(e));
  }
  const m = /day=(\d+)/.exec(location.hash); if (m) { dayIdx = Math.min(days().length - 1, Math.max(0, +m[1] - 1)); render(); }
  if (wantRead) { reading = true; render(); }
  if (location.hash === '#share' && isOwner()) openShare();
  $('skel').hidden = true;
  resumePending();
  startRealtime();
  sb.auth.onAuthStateChange((ev, s) => { const was = session && session.user.id; session = s; if (s && s.user.id !== was) scheduleReload(0); });
}
init();
})();
