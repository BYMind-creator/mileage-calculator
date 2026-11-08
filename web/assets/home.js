/* Travel Studio 首頁（正式版）
   - 登入：Google／Apple／LINE（OAuth PKCE）或 Email 驗證碼（assets/auth.js）；匿名受邀者登入時改為綁定，保留同一個 uid
   - 所有寫入都呼叫資料庫 RPC，前端不直接寫資料表
   - 登入前的動作（建立、按心心、複製）先存在 sessionStorage，登入回來後接續執行 */
(function () {
'use strict';

const CFG = window.TS_CONFIG, I18N = window.TS_I18N;
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
  auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

/* ---------- 小工具 ---------- */
const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
};
const sess = {
  get(k) { try { return JSON.parse(sessionStorage.getItem(k) || 'null'); } catch (e) { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { sessionStorage.removeItem(k); } catch (e) {} }
};
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (name, style) => `<svg class="ic" aria-hidden="true"${style ? ` style="${style}"` : ''}><use href="#${name}"/></svg>`;
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = v => { if (!v) return null; const [y, m, d] = v.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; };
const today = new Date();

let lang = store.get('ts-lang', (navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en');
let theme = store.get('ts-theme', 'paper');
const t = k => I18N[lang][k];

const THEMES = [["paper", "#F8F4E9", "#B86B45"], ["kraft", "#E8DDC5", "#A5794C"], ["peach", "#FFF0E8", "#DF8B7E"], ["sage", "#EAF0E7", "#8EA98F"], ["ocean", "#E6F1F7", "#7DAFCE"]];
const TACKS = ['#A33A2A', '#C9A86A', '#2E4B61', '#5E7A62'], WASHI = ['#8EA98F', '#DF8B7E', '#E6C56B', '#7DAFCE'];
const PENDING = 'ts-pending';

/* ---------- 狀態 ---------- */
let session = null, consented = false, termsVersion = '', trips = [], members = [], cities = [];
let exploreOn = false, publicList = [], sortBy = 'likes', loaded = false, destSel = null;
const isFull = () => !!(session && !session.user.is_anonymous);
const isAnon = () => !!(session && session.user.is_anonymous);
const SH = window.TS_SHARE;
const inApp = () => SH.inApp();
const editorUrl = (id, extra) => `${CFG.EDITOR_PATH}?trip=${encodeURIComponent(id)}${extra || ''}`;

/* ---------- 錯誤處理 ---------- */
function errMsg(error) {
  if (!error) return t('errGeneric');
  const m = String(error.message || '');
  const known = t('errors');
  for (const k of Object.keys(known)) if (m.includes(k)) return known[k];
  if (/fetch|network|Failed to/i.test(m)) return t('errNetwork');
  return t('errGeneric');
}
async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args || {});
  if (error) { const e = new Error(error.message); e.code = error.code; e.raw = error; throw e; }
  return data;
}
let toastTimer;
function toast(msg) { const el = $('toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3000); }
function logEvent(name, trip, props) { if (!session) return; sb.rpc('log_event', { p_name: name, p_trip: trip || null, p_props: props || {} }).then(() => {}, () => {}); }

/* ---------- 資料載入 ---------- */
async function loadFlags() {
  const { data } = await sb.from('feature_flags').select('key,enabled,value');
  (data || []).forEach(f => {
    if (f.key === 'explore') exploreOn = !!f.enabled;
    if (f.key === 'terms_version') termsVersion = typeof f.value === 'string' ? f.value : String(f.value || '');
  });
}
async function loadCities() {
  const { data } = await sb.from('places').select('id,slug,name_zh,name_en,country_zh,country_en,aliases').eq('level', 'city');
  cities = data || [];
}
async function loadConsent() {
  const rows = await rpc('my_consent');
  consented = (rows || []).some(r => r.purpose === 'service' && r.granted && r.terms_version === r.current_version);
  return rows || [];
}
async function loadTrips() {
  trips = await rpc('my_trips', { p_limit: 20 }) || [];
  members = [];
  if (trips[0]) {
    const { data } = await sb.from('collaborators').select('nickname,role').eq('trip_id', trips[0].id);
    members = data || [];
  }
}
async function loadPublic() {
  if (!exploreOn) return;
  try { publicList = await rpc('public_trips', { p_sort: sortBy, p_limit: 12 }) || []; } catch (e) { publicList = []; }
  renderExplore();
}

/* ---------- 登入 ---------- */
function redirectTo() { return location.origin + location.pathname; }
async function signIn(pending) {
  $('loginErr').classList.remove('show');
  if (pending) sess.set(PENDING, pending);
  // 匿名受邀者：綁定到同一個帳號（link），保留編輯紀錄；Email 驗證碼不會離開頁面，直接接續剛才的動作
  window.TS_AUTH.open({ sb, cfg: CFG, lang, ic, esc, link: isAnon(), redirectTo: redirectTo(),
    onSignedIn: async s => {
      session = s;
      try { await Promise.all([loadConsent(), loadTrips()]); } catch (e) {}
      render(); await resumePending();
    } });
}
function readOAuthError() {
  const q = new URLSearchParams(location.search), h = new URLSearchParams(location.hash.replace(/^#/, ''));
  const err = q.get('error') || h.get('error');
  if (!err) return false;
  history.replaceState(null, '', location.pathname);
  return true;
}
async function signOut() {
  await sb.auth.signOut();
  session = null; trips = []; members = []; consented = false;
  render(); toast(t('signedOut'));
}

/* ---------- 同意（FR-43） ---------- */
let consentNext = null;
function askConsent(next) {
  consentNext = next || null;
  $('cStat').checked = !!CFG.STATS_DEFAULT_CHECKED; $('cMkt').checked = false;
  $('consentDlg').showModal();
}
$('cAgree').addEventListener('click', async () => {
  const btn = $('cAgree'); btn.classList.add('busy');
  try {
    await rpc('record_consent', { p_stats: $('cStat').checked, p_marketing: $('cMkt').checked });
    consented = true; $('consentDlg').close();
    const n = consentNext; consentNext = null; if (n) await n();
  } catch (e) { toast(errMsg(e)); } finally { btn.classList.remove('busy'); }
});
function consentCancel() { consentNext = null; $('consentDlg').close(); sess.del(PENDING); toast(t('consentRequired')); }
$('cCancel').addEventListener('click', consentCancel);
$('consentDlg').addEventListener('cancel', e => { e.preventDefault(); consentCancel(); });

/* 需要完整帳號的動作：未登入 → 登入；未同意 → 同意；然後執行 */
function withAccount(pending, fn) {
  if (!isFull()) { toast(t('needLogin')); signIn(pending); return; }
  if (!consented) { askConsent(fn); return; }
  fn();
}

/* ---------- 下拉面板 ---------- */
function closePanels() {
  document.querySelectorAll('.panel.open').forEach(p => p.classList.remove('open'));
  document.querySelectorAll('[aria-expanded=true]:not(#dest)').forEach(b => b.setAttribute('aria-expanded', 'false'));
  document.querySelectorAll('.pc.menu-open').forEach(c => c.classList.remove('menu-open'));
}
function openPanel(btn, panel) {
  const open = !panel.classList.contains('open');
  closePanels(); panel.classList.toggle('open', open); btn.setAttribute('aria-expanded', open);
  const card = btn.closest('.pc'); if (card && open) card.classList.add('menu-open');
  return open;
}
['theme', 'menu', 'acct'].forEach(k => $(k + 'Btn').addEventListener('click', e => { e.stopPropagation(); openPanel($(k + 'Btn'), $(k + 'Panel')); }));
document.addEventListener('keydown', e => { if (e.key === 'Escape') closePanels(); });

function renderThemes() {
  $('themePanel').innerHTML = THEMES.map((th, i) => `<button role="menuitemradio" aria-checked="${th[0] === theme}" data-theme-k="${th[0]}"><span class="swatch" style="background:${th[1]};border-color:${th[2]}"></span>${t('themes')[i]}</button>`).join('');
}
$('themePanel').addEventListener('click', e => {
  const b = e.target.closest('[data-theme-k]'); if (!b) return;
  theme = b.dataset.themeK; store.set('ts-theme', theme); document.body.dataset.theme = theme; renderThemes(); closePanels();
});

/* ---------- 目的地：清單優先，找不到可自由輸入 ---------- */
const destEl = $('dest'), listEl = $('destList');
let acItems = [], acIndex = -1;
const norm = s => String(s || '').trim().toLowerCase();
const cityName = c => lang === 'zh' ? c.name_zh : c.name_en;
const cityCountry = c => lang === 'zh' ? c.country_zh : c.country_en;
const cityLabel = c => `${cityName(c)} · ${cityCountry(c)}`;
const cityKeys = c => [c.name_zh, c.name_en, c.country_zh, c.country_en, ...(c.aliases || [])];
function findCities(q) { q = norm(q); if (!q) return []; return cities.filter(c => cityKeys(c).some(v => norm(v).includes(q))).slice(0, 6); }
function exactCity(q) { q = norm(q); return cities.find(c => [c.name_zh, c.name_en, ...(c.aliases || [])].some(v => norm(v) === q)); }
function currentCity() { return destSel && destSel.id ? cities.find(c => c.id === destSel.id) : null; }
function openList() {
  const q = destEl.value.trim();
  acItems = findCities(q).map(c => ({ city: c })); if (q && !exactCity(q)) acItems.push({ free: q }); acIndex = -1;
  listEl.innerHTML = acItems.map((it, i) => it.city
    ? `<li role="option" id="ac-${i}" data-i="${i}" aria-selected="false"><span>${esc(cityName(it.city))}</span><span class="c">${esc(cityCountry(it.city))}</span></li>`
    : `<li role="option" id="ac-${i}" data-i="${i}" aria-selected="false" class="free">${esc(t('acFree')(it.free))}</li>`).join('');
  const show = acItems.length > 0; listEl.hidden = !show; destEl.setAttribute('aria-expanded', show); destEl.removeAttribute('aria-activedescendant');
}
function closeList() { listEl.hidden = true; destEl.setAttribute('aria-expanded', 'false'); destEl.removeAttribute('aria-activedescendant'); acIndex = -1; }
function setActive(i) {
  acIndex = i; listEl.querySelectorAll('li').forEach((li, k) => li.setAttribute('aria-selected', k === i));
  if (i >= 0) { destEl.setAttribute('aria-activedescendant', 'ac-' + i); const li = $('ac-' + i); if (li) li.scrollIntoView({ block: 'nearest' }); }
}
function choose(i) {
  const it = acItems[i]; if (!it) return;
  if (it.city) { destSel = { id: it.city.id }; destEl.value = cityName(it.city); } else destSel = { free: true };
  closeList(); renderDestState(); updatePreview();
}
function renderDestState() {
  const el = $('destState'), q = destEl.value.trim(), c = currentCity(); el.className = 'dest-state';
  if (c) { el.classList.add('ok'); el.innerHTML = `${ic('ti-circle-check')}<span>${esc(t('destOk')(cityLabel(c)))}</span>`; return; }
  if (!q) { el.innerHTML = ''; return; }
  if ((destSel && destSel.free) || !findCities(q).length) { el.classList.add('free'); el.innerHTML = `${ic('ti-pencil')}<span>${esc(t('destFree')(q))}</span>`; return; }
  el.classList.add('hint'); el.innerHTML = `${ic('ti-list-search')}<span>${esc(t('destHint'))}</span>`;
}
destEl.addEventListener('input', () => { destSel = null; $('errDest').classList.remove('show'); destEl.removeAttribute('aria-invalid'); openList(); renderDestState(); updatePreview(); });
destEl.addEventListener('focus', () => { if (destEl.value.trim() && !currentCity()) openList(); });
destEl.addEventListener('keydown', e => {
  if (listEl.hidden) { if (e.key === 'ArrowDown') { openList(); if (acItems.length) setActive(0); e.preventDefault(); } return; }
  if (e.key === 'ArrowDown') { setActive(Math.min(acIndex + 1, acItems.length - 1)); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { setActive(Math.max(acIndex - 1, 0)); e.preventDefault(); }
  else if (e.key === 'Enter' && acIndex >= 0) { choose(acIndex); e.preventDefault(); }
  else if (e.key === 'Escape') { closeList(); e.stopPropagation(); }
});
destEl.addEventListener('blur', () => setTimeout(closeList, 120));
listEl.addEventListener('mousedown', e => e.preventDefault());
listEl.addEventListener('click', e => { const li = e.target.closest('li'); if (li) choose(+li.dataset.i); });

/* ---------- 建立行程表單 ---------- */
const startEl = $('startDate'), endEl = $('endDate'), nameEl = $('tripName'), partyEl = $('party');
startEl.value = iso(addDays(today, 14)); endEl.value = iso(addDays(today, 18));
startEl.min = iso(today); endEl.min = startEl.value;
function range() { const s = parse(startEl.value), e = parse(endEl.value); if (!s || !e) return null; return { s, e, n: Math.round((e - s) / 864e5) + 1 }; }
function updatePreview() {
  const r = range(), d = destEl.value.trim();
  $('preview').textContent = (r && r.n >= 1 && r.n <= 30) ? t('preview')(r.n, t('fmt')(r.s), `${pad(r.n)} ${t('fmt')(r.e)}`) : t('checkDates');
  nameEl.placeholder = (d && r && r.n >= 1) ? t('autoName')(d, r.n) : t('phName');
}
function renderParty() { const v = partyEl.value; partyEl.innerHTML = t('partyOpts').map(([k, l]) => `<option value="${k}">${l}</option>`).join(''); partyEl.value = v || ''; }
function clearDateErr() { $('errDate').classList.remove('show'); endEl.removeAttribute('aria-invalid'); }
startEl.addEventListener('input', () => { clearDateErr(); const s = parse(startEl.value), e = parse(endEl.value); if (s && e && e < s) endEl.value = iso(addDays(s, 4)); endEl.min = startEl.value || iso(today); updatePreview(); });
endEl.addEventListener('input', () => { clearDateErr(); updatePreview(); });

function readForm() {
  const q = destEl.value.trim(); let c = currentCity();
  if (!c) { c = exactCity(q); if (c) { destSel = { id: c.id }; destEl.value = cityName(c); } }
  return { dest: destEl.value.trim(), placeId: c ? c.id : null, start: startEl.value, end: endEl.value, party: partyEl.value || null, name: nameEl.value.trim() || nameEl.placeholder };
}
function writeForm(f) {
  destEl.value = f.dest || ''; destSel = f.placeId ? { id: f.placeId } : (f.dest ? { free: true } : null);
  if (f.start) startEl.value = f.start; if (f.end) endEl.value = f.end; partyEl.value = f.party || ''; nameEl.value = f.nameTyped || '';
  renderDestState(); updatePreview();
}
function validate() {
  let bad = false; const r = range(); closeList();
  if (!destEl.value.trim()) { $('errDest').classList.add('show'); destEl.setAttribute('aria-invalid', 'true'); bad = true; }
  const msg = !r ? t('errNone') : r.n < 1 ? t('errOrder') : r.n > 30 ? t('errMax') : '';
  if (msg) { $('errDate').textContent = msg; $('errDate').classList.add('show'); endEl.setAttribute('aria-invalid', 'true'); bad = true; }
  if (bad) (destEl.getAttribute('aria-invalid') ? destEl : endEl).focus();
  return !bad;
}
async function createTrip(f) {
  const btn = $('ctaBtn'); btn.classList.add('busy'); $('ctaTxt').textContent = t('creating');
  try {
    const id = await rpc('create_trip', { p_title: f.name, p_place_id: f.placeId, p_dest_text: f.dest, p_start: f.start, p_end: f.end, p_party: f.party });
    sess.del(PENDING);
    location.href = editorUrl(id);
  } catch (e) {
    if (/consent_required/.test(e.message)) { consented = false; askConsent(() => createTrip(f)); }
    else toast(errMsg(e));
  } finally { btn.classList.remove('busy'); renderCta(); }
}
$('tripForm').addEventListener('submit', e => {
  e.preventDefault();
  if (!validate()) return;
  const f = readForm(); f.nameTyped = nameEl.value.trim(); updatePreview();
  withAccount({ type: 'create', form: f }, () => createTrip(f));
});

/* ---------- 邀請連結 ---------- */
async function inviteLink(tripId) {
  const k = 'ts-inv-edit-' + tripId; let tok = sess.get(k);
  if (!tok) { tok = await rpc('create_invite', { p_trip: tripId, p_kind: 'edit' }); sess.set(k, tok); }
  return SH.inviteUrl(tripId, tok);
}
async function prepareInvite(tripId, title) {
  const box = $('invShare'); box.innerHTML = ''; box.dataset.trip = tripId;
  $('invHint').textContent = t('invPreparing');
  try {
    const link = await inviteLink(tripId);
    box.innerHTML = SH.sheet({ url: link, text: t('invText')(title).trim(), title, lang, ic, esc });
    $('invHint').textContent = t('invHint');
  } catch (e) { $('invHint').textContent = errMsg(e); }
}
function showInApp(focus) {
  const app = inApp(); $('inappBar').hidden = !app; if (!app) return;
  const href = SH.escapeHref(location.href);
  $('inappName').textContent = SH.appLabel(app);
  $('inappText').textContent = SH.L[lang].banner(SH.appLabel(app)) + ' ' + SH.escapeHint(lang);
  $('inappOpen').hidden = !href; if (href) $('inappOpen').href = href;
  if (focus) (href ? $('inappOpen') : $('inappCopy')).focus();
}
function copyText(s) {
  // 剪貼簿 API 在權限被擋時可能一直不回應；800ms 內沒完成就改用備用方式
  if (navigator.clipboard && window.isSecureContext) {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 800));
    return Promise.race([navigator.clipboard.writeText(s), timeout]).catch(() => fallbackCopy(s));
  }
  fallbackCopy(s); return Promise.resolve();
}
function fallbackCopy(s) { try { const ta = document.createElement('textarea'); ta.value = s; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); } catch (e) {} }

/* ---------- 金額、時間格式 ---------- */
function fmtMoney(minor, cur) {
  if (minor == null || !cur) return '';
  let digits = 2; try { digits = new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits; } catch (e) {}
  return `${cur} ${(minor / Math.pow(10, digits)).toLocaleString('en-US', { maximumFractionDigits: digits })}`;
}
function relTime(ts) {
  const rtf = new Intl.RelativeTimeFormat(lang === 'zh' ? 'zh-Hant' : 'en', { numeric: 'auto' });
  const s = (new Date(ts) - Date.now()) / 1000, a = Math.abs(s);
  if (a < 60) return rtf.format(Math.round(s), 'second');
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}
const hash = s => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) | 0; return Math.abs(h); };
function decor(id, i) { const h = hash(id); return { tack: TACKS[h % 4], washi: WASHI[(h >> 3) % 4], wl: (18 + (h % 45)) + '%', r: (i % 2 ? '.9deg' : '-1.2deg') }; }
function destLabel(x) { const c = x.place_slug && cities.find(c => c.slug === x.place_slug); return c ? cityName(c) : x.destination_text; }

/* ---------- 軟木板 ---------- */
const STEP_ICONS = ["ti-login-2", "ti-photo", "ti-user-plus", "ti-refresh"];
function boardFirstVisit() {
  return `<article class="note">
    <div class="note-tab" aria-hidden="true"></div><span class="note-label">${t('gLabel')}</span>
    <span class="chip">${t('gChip')}</span>
    <h2 id="boardTitle">${t('gTitle')}</h2>
    <p class="meta" style="font-size:14px">${t('gLead')}</p>
    <div class="steps">${t('steps').map((s, i) => `<div class="step"><p class="mono">0${i + 1}</p><h3>${ic(STEP_ICONS[i])}${s[0]}</h3><p class="meta">${s[1]}</p>${i === 2 ? `<button type="button" class="step-link" data-act="collab">${t('howJoin')} ${ic('ti-arrow-right')}</button>` : ''}</div>`).join('')}</div>
    ${isFull() ? `<p class="meta empty">${ic('ti-notebook')}${t('noTrips')}</p>` : ''}
  </article>`;
}
function cover(x) {
  return `<div class="cover"><div class="main-part"><p class="dest">${esc(destLabel(x))}</p></div><div class="stub">${ic('ti-ticket', 'font-size:20px')}${t('durStub')(x.days)}</div></div>`;
}
function myCard(x, i) {
  const d = decor(x.id, i), end = parse(x.end_date), start = parse(x.start_date);
  const icon = { private: 'ti-lock', link: 'ti-link', public: 'ti-world' }[x.visibility];
  const owner = x.role === 'owner';
  return `<article class="pc" style="--r:${d.r}">
    <i class="tack" style="background:${d.tack}"></i><i class="washi" style="left:${d.wl};background:${d.washi}"></i>
    ${cover(x)}
    <div class="pc-row"><h3>${esc(x.title)}</h3>
      <div class="right"><span class="vis">${ic(icon)}${t('vis')[x.visibility]}</span>
        <div class="pop"><button class="icob mini" data-act="toggle" data-target="m-${x.id}" aria-haspopup="true" aria-expanded="false" aria-label="${t('more')}">${ic('ti-dots')}</button>
          <div class="panel" id="m-${x.id}" role="menu">
            ${owner ? `<a role="menuitem" href="${editorUrl(x.id, '#share')}">${ic('ti-share')}${t('mShare')}</a>` : ''}
            <button role="menuitem" data-act="copyTrip" data-id="${x.id}">${ic('ti-copy')}${t('mCopy')}</button>
            ${owner ? `<div class="sepline"></div><button role="menuitem" class="danger" data-act="delTrip" data-id="${x.id}">${ic('ti-trash')}${t('mDelete')}</button>` : ''}
          </div></div></div></div>
    <p class="meta">${t('fmtShort')(start)} – ${t('fmtShort')(end)} · ${t('members')(x.members)}</p>
    <div class="pc-foot"><span class="meta">${t('planned')(x.planned_days, x.days)}</span><a href="${editorUrl(x.id)}" class="btn-dark">${t('resume')}</a></div>
  </article>`;
}
function boardReturning() {
  const r = trips[0], start = parse(r.start_date), end = parse(r.end_date), pct = Math.round(r.planned_days / r.days * 100);
  const money = fmtMoney(r.est_per_person_minor, r.currency);
  const av = members.slice(0, 3).map((m, i) => `<span style="background:${['#302A25', '#B86B45', '#5E7A62'][i]}">${esc((m.nickname || '?').slice(0, 1))}</span>`).join('') + (members.length > 3 ? `<span style="background:#8A7A6A">+${members.length - 3}</span>` : '');
  const others = trips.slice(1);
  return `<article class="note">
    <div class="note-tab" aria-hidden="true"></div><span class="note-label">${t('rLabel')}</span>
    <div class="note-head"><div class="left"><span class="chip">${t('rChip')}</span><span class="meta">${t('edited')(relTime(r.updated_at))}</span></div><span class="live"><i></i>${t('members')(r.members)}</span></div>
    <div class="resume">
      <div>
        <h2 id="boardTitle">${esc(r.title)}</h2>
        <p class="meta" style="font-size:14px">${t('fmt')(start)} – ${t('fmt')(end)}${money ? ' · ' + esc(t('budgetLine')(money)) : ''}</p>
        <div class="progress">
          <div class="progress-row meta"><span style="color:var(--ink)">${t('progLabel')}</span><b>${t('prog')(r.planned_days, r.days, pct)}</b></div>
          <div class="track" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${t('progLabel')}"><div class="fill" style="width:${pct}%"></div></div>
        </div>
        <div class="avatars">${av}</div>
      </div>
      <div class="actions">
        <a href="${editorUrl(r.id)}" class="btn-dark">${ic('ti-player-play')}${t('resume')}</a>
        ${r.role === 'owner' ? `<div class="pop"><button class="btn-light" type="button" data-act="toggle" data-target="invPanel" data-trip="${r.id}" aria-haspopup="true" aria-expanded="false">${ic('ti-user-plus')}${t('copyInvite')}</button>
          <div class="panel inv-panel" id="invPanel">
            <p class="hint" id="invHint">${t('invHint')}</p>
            <div id="invShare"></div>
          </div></div>` : ''}
      </div>
    </div>
  </article>
  ${others.length ? `<div class="sec"><b aria-hidden="true"></b><h2>${t('others')}</h2><div class="side"><span class="meta">${t('othersSide')}</span></div></div>
  <div class="cards">${others.map(myCard).join('')}</div>` : ''}`;
}
function publicCard(x, i) {
  const d = decor(x.id, i + 1);
  const n = Number(x.likes) || 0;
  return `<article class="pc" style="--r:${d.r}">
    <i class="tack" style="background:${d.tack}"></i><i class="washi" style="left:${d.wl};background:${d.washi}"></i>
    ${cover(x)}
    <div class="pc-row"><h3>${esc(x.title)}</h3></div>
    <p class="meta">${t('by')(esc(x.author || '—'), x.published_at ? t('fmtShort')(new Date(x.published_at)) : '')}</p>
    <div class="pc-foot"><div class="acts">
      <button class="like" data-act="like" data-id="${x.id}" aria-pressed="${!!x.liked_by_me}" aria-label="${t('likeLabel')(n)}">${ic(x.liked_by_me ? 'ti-heart-filled' : 'ti-heart')}${n}</button>
      <button class="btn-light btn-sm" data-act="exCopy" data-id="${x.id}">${ic('ti-copy')}${t('exCopy')}</button>
      <a class="btn-dark" style="min-height:36px;padding:0 12px;font-size:13px" href="${editorUrl(x.id, '&mode=read')}">${t('exView')}</a></div></div>
  </article>`;
}
function renderExplore() {
  $('explore').hidden = !exploreOn;
  document.querySelectorAll('.js-explore').forEach(a => a.hidden = !exploreOn);
  if (!exploreOn) return;
  $('sortSeg').setAttribute('aria-label', t('sortLabel'));
  $('sortSeg').innerHTML = t('sorts').map(([k, l]) => `<button aria-pressed="${k === sortBy}" data-act="sort" data-k="${k}">${l}</button>`).join('');
  $('exCards').innerHTML = publicList.length ? publicList.map(publicCard).join('') : `<p class="meta">${t('exEmpty')}</p>`;
}
function renderCollab() {
  $('collabGrid').innerHTML = t('collab').map((c, i) => `<div><p class="mono">0${i + 1}</p><h3>${ic(c[0])}${c[1]}</h3><p class="meta">${c[2]}</p></div>`).join('');
}
function renderBoard() {
  if (!loaded) return;
  $('boardContent').innerHTML = (isFull() && trips.length) ? boardReturning() : boardFirstVisit();
  document.body.classList.toggle('returning', isFull() && trips.length > 0);
}
function renderCta() {
  $('ctaSeal').innerHTML = isFull() ? esc(t('seal')) : ic('ti-login-2');
  $('ctaTxt').textContent = isFull() ? t('cta') : t('ctaGuest');
  $('gateNote').hidden = isFull();
}

/* ---------- 對話框與帳號 ---------- */
let confirmFn = null;
function confirmBox(title, body, okText, fn) { $('cfTitle').textContent = title; $('cfBody').textContent = body; $('cfOk').textContent = okText; confirmFn = fn; $('confirmDlg').showModal(); }
$('cfOk').addEventListener('click', () => { $('confirmDlg').close(); const f = confirmFn; confirmFn = null; if (f) f(); });
async function openSettings() {
  try {
    const rows = await loadConsent();
    const get = p => (rows.find(r => r.purpose === p) || {}).granted;
    $('sStat').checked = !!get('stats'); $('sMkt').checked = !!get('marketing');
    $('setVer').textContent = t('setVer')(termsVersion);
    $('setDlg').showModal();
  } catch (e) { toast(errMsg(e)); }
}
async function exportData() {
  try {
    const data = await rpc('export_my_data');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'travel-studio-my-data.json'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000); toast(t('exported'));
  } catch (e) { toast(errMsg(e)); }
}
function scrollToId(id) { const el = $(id); if (el) el.scrollIntoView({ block: 'start' }); }
function setNav(k) { document.querySelectorAll('.tabs a').forEach(a => { if (a.dataset.nav === k) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }); }
function goMine() {
  if (!isFull()) { signIn({ type: 'mine' }); return; }
  setNav('mine'); scrollToId('mine'); if (!trips.length) toast(t('noTrips'));
}
async function refreshTrips() { try { await loadTrips(); } catch (e) { toast(errMsg(e)); } renderBoard(); }

/* ---------- 事件委派 ---------- */
document.addEventListener('click', async e => {
  const nav = e.target.closest('[data-nav]');
  if (nav) {
    e.preventDefault(); closePanels(); const k = nav.dataset.nav;
    if (k === 'mine') return goMine();
    if (k === 'collab') return $('collabDlg').showModal();
    setNav(k);
    if (k === 'plan') { scrollToId('plan'); destEl.focus({ preventScroll: true }); } else scrollToId(k);
    return;
  }
  const a = e.target.closest('[data-act]');
  if (!e.target.closest('.panel') && !(a && a.dataset.act === 'toggle')) closePanels();
  if (!a) return;
  const act = a.dataset.act, id = a.dataset.id;
  switch (act) {
    case 'toggle': {
      e.stopPropagation();
      const open = openPanel(a, $(a.dataset.target));
      if (open && a.dataset.target === 'invPanel') prepareInvite(a.dataset.trip, (trips[0] || {}).title || '');
      break;
    }
    case 'collab': $('collabDlg').showModal(); break;
    case 'copyTrip': {
      closePanels(); const x = trips.find(o => o.id === id);
      withAccount({ type: 'copy', id }, async () => {
        try { await rpc('copy_trip', { p_trip: id }); toast(t('copiedTrip')(x ? x.title : '')); await refreshTrips(); } catch (err) { toast(errMsg(err)); }
      });
      break;
    }
    case 'delTrip': {
      closePanels(); const x = trips.find(o => o.id === id);
      confirmBox(t('delTitle'), t('delBody')(x.title), t('delOk'), async () => {
        try { await rpc('delete_trip', { p_trip: id }); toast(t('deletedTrip')(x.title)); await refreshTrips(); } catch (err) { toast(errMsg(err)); }
      });
      break;
    }
    case 'mine': closePanels(); goMine(); break;
    case 'settings': closePanels(); openSettings(); break;
    case 'saveSettings':
      try { await rpc('record_consent', { p_stats: $('sStat').checked, p_marketing: $('sMkt').checked }); consented = true; $('setDlg').close(); toast(t('saved')); }
      catch (err) { toast(errMsg(err)); }
      break;
    case 'export': exportData(); break;
    case 'delAccount':
      $('setDlg').close();
      confirmBox(t('delAccTitle'), t('delAccBody'), t('delAccOk'), async () => {
        try { await rpc('delete_my_account'); await sb.auth.signOut(); session = null; trips = []; consented = false; render(); toast(t('accDeleted')); }
        catch (err) { toast(errMsg(err)); }
      });
      break;
    case 'logout': closePanels(); signOut(); break;
    case 'closeDlg': a.closest('dialog').close(); break;
    case 'retry': $('tripForm').requestSubmit(); break;
    case 'sort': sortBy = a.dataset.k; loadPublic(); break;
    case 'like':
      withAccount({ type: 'like', id }, async () => {
        try {
          const liked = await rpc('toggle_like', { p_trip: id });
          const x = publicList.find(p => p.id === id);
          if (x) { x.likes = Number(x.likes) + (liked ? 1 : -1); x.liked_by_me = liked; }
          renderExplore(); const b = document.querySelector(`[data-act="like"][data-id="${id}"]`); if (b) b.focus();
        } catch (err) { toast(errMsg(err)); }
      });
      break;
    case 'exCopy': {
      const x = publicList.find(p => p.id === id);
      withAccount({ type: 'exCopy', id }, async () => {
        try { await rpc('copy_trip', { p_trip: id }); toast(t('copiedTrip')(x ? x.title : '')); await refreshTrips(); } catch (err) { toast(errMsg(err)); }
      });
      break;
    }
  }
});
$('loginBtn').addEventListener('click', () => signIn(null));

/* 登入回來後，接續登入前的動作 */
async function resumePending() {
  const p = sess.get(PENDING); if (!p) return;
  const run = async () => {
    sess.del(PENDING);
    if (p.type === 'create') { writeForm(p.form); await createTrip(p.form); }
    else if (p.type === 'like') document.querySelector(`[data-act="like"][data-id="${p.id}"]`)?.click();
    else if (p.type === 'exCopy' || p.type === 'copy') { try { await rpc('copy_trip', { p_trip: p.id }); await refreshTrips(); } catch (e) { toast(errMsg(e)); } }
    else if (p.type === 'mine') goMine();
  };
  if (p.type === 'create') writeForm(p.form);
  if (!consented) askConsent(run); else await run();
}

/* ---------- 全頁渲染 ---------- */
function render() {
  document.documentElement.lang = lang === 'zh' ? 'zh-Hant' : 'en';
  document.body.dataset.theme = theme;
  document.querySelectorAll('[data-i]').forEach(el => { const v = t(el.dataset.i); if (typeof v === 'string') el.textContent = v; });
  document.querySelectorAll('[data-i-label]').forEach(el => el.setAttribute('aria-label', t(el.dataset.iLabel)));
  $('dispatch').textContent = `${t('dispatch')} ${today.getFullYear()}-001`;
  $('stampBottom').textContent = t('stampBottom')(today.getFullYear());
  destEl.placeholder = t('phDest');
  const c = currentCity(); if (c) destEl.value = cityName(c);
  $('themeBtn').setAttribute('aria-label', t('themeLabel'));
  $('menuBtn').setAttribute('aria-label', t('menuLabel'));
  $('acctBtn').setAttribute('aria-label', t('acctLabel'));
  $('langZh').setAttribute('aria-pressed', lang === 'zh'); $('langEn').setAttribute('aria-pressed', lang === 'en');
  const full = isFull();
  $('loginBtn').hidden = full; $('acctWrap').hidden = !full;
  if (full) {
    const u = session.user, email = u.email || '', nm = (u.user_metadata && (u.user_metadata.full_name || u.user_metadata.name)) || email || (u.phone ? '••• ' + String(u.phone).slice(-4) : '');
    $('acctIni').textContent = (nm || '?').slice(0, 1).toUpperCase(); $('acctEmail').textContent = email || nm; $('acctWho').textContent = t('signedAs')(email || nm);
  }
  $('savedState').classList.toggle('off', !full); $('savedTxt').textContent = full ? t('saveOn') : t('saveOff');
  renderCta();
  showInApp(false);
  $('guideGrid').innerHTML = t('guide').map(g => `<div><h3>${g[0]}</h3><p class="meta">${g[1]}</p></div>`).join('');
  $('contactLink').href = 'mailto:' + CFG.CONTACT_EMAIL;
  $('year').textContent = today.getFullYear();
  renderBoard(); renderExplore(); renderCollab(); renderDestState(); renderParty(); renderThemes(); updatePreview();
}
function setLang(l) { lang = l; store.set('ts-lang', l); closeList(); render(); }
$('langZh').addEventListener('click', () => setLang('zh'));
$('langEn').addEventListener('click', () => setLang('en'));
$('inappCopy').addEventListener('click', async () => { await SH.copy(location.href); toast(t('urlCopied')); });
SH.bind(document, (ch) => {
  const tripId = ($('invShare') || {}).dataset ? $('invShare').dataset.trip : null;
  if (ch === 'copy') toast(t('invCopied'));
  if (tripId) logEvent('invite_copied', tripId, { channel: ch });
});

/* ---------- 啟動 ---------- */
async function init() {
  render();
  const oauthErr = readOAuthError();
  try {
    const { data } = await sb.auth.getSession(); session = data.session;
    await Promise.all([loadFlags().catch(() => {}), loadCities().catch(() => {})]);
    if (isFull()) await Promise.all([loadConsent(), loadTrips()]);
  } catch (e) { toast(errMsg(e)); }
  loaded = true; render();
  if (oauthErr) {
    const p = sess.get(PENDING);
    if (p && p.type === 'create') { writeForm(p.form); $('loginErr').classList.add('show'); }
    sess.del(PENDING);
  } else if (isFull()) await resumePending();
  if (exploreOn) loadPublic();
  sb.auth.onAuthStateChange((ev, s) => {
    const was = isFull(); session = s;
    if (was !== isFull()) { (isFull() ? Promise.all([loadConsent(), loadTrips()]) : Promise.resolve()).catch(() => {}).then(render); }
  });
}
init();
})();
