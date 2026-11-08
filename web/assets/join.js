/* Travel Studio 受邀者加入頁（FR-14）
   流程：讀取邀請 → 輸入暱稱並同意服務條款 → 匿名登入（或已登入者直接用原帳號）→ join_invite → 進入編輯器
   邀請碼放在網址的 # 後面，不會送到伺服器記錄，也不會出現在 Referer。 */
(function () {
'use strict';
const CFG = window.TS_CONFIG, I18N = window.TS_I18N;
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
  auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});
const $ = id => document.getElementById(id);
const store = { get(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, st) => `<svg class="ic" aria-hidden="true"${st ? ` style="${st}"` : ''}><use href="#${n}"/></svg>`;
const parse = v => { const [y, m, d] = String(v).split('-').map(Number); return new Date(y, m - 1, d); };
let lang = store.get('ts-lang', (navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en');
document.body.dataset.theme = store.get('ts-theme', 'paper');
const t = k => I18N[lang][k];
const TOKEN_KEY = 'ts-join-token';
const editorUrl = id => `${CFG.EDITOR_PATH}?trip=${encodeURIComponent(id)}`;

function readToken() {
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  let tok = h.get('t');
  if (tok) { try { sessionStorage.setItem(TOKEN_KEY, tok); } catch (e) {} }
  else { try { tok = sessionStorage.getItem(TOKEN_KEY); } catch (e) {} }
  return tok;
}
function errMsg(error) {
  const m = String((error && error.message) || ''), known = t('errors');
  for (const k of Object.keys(known)) if (m.includes(k)) return known[k];
  if (/fetch|network|Failed to/i.test(m)) return t('errNetwork');
  return t('errGeneric');
}
let toastTimer;
function toast(msg) { const el = $('toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3000); }

let token = null, invite = null, session = null, already = null, state = 'loading', captchaToken = null;

/* 人機驗證（Cloudflare Turnstile）：config 填了 TURNSTILE_SITE_KEY 才啟用，需與 Supabase 的 CAPTCHA 設定一致 */
function mountCaptcha() {
  const key = CFG.TURNSTILE_SITE_KEY, box = $('captcha'); if (!key || !box) return;
  const render = () => window.turnstile.render(box, { sitekey: key, language: lang === 'zh' ? 'zh-tw' : 'en', callback: tok => { captchaToken = tok; }, 'expired-callback': () => { captchaToken = null; } });
  if (window.turnstile) return render();
  if (!document.getElementById('ts-turnstile')) { const sc = document.createElement('script'); sc.id = 'ts-turnstile'; sc.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; sc.async = true; sc.onload = render; document.head.appendChild(sc); }
}

function view() {
  document.documentElement.lang = lang === 'zh' ? 'zh-Hant' : 'en';
  document.title = (lang === 'zh' ? '加入行程' : 'Join trip') + ' · Travel Studio';
  $('langZh').setAttribute('aria-pressed', lang === 'zh'); $('langEn').setAttribute('aria-pressed', lang === 'en');
  const sheet = $('sheet');
  if (state === 'loading') { sheet.innerHTML = '<div class="skel" aria-hidden="true"></div>'; return; }
  if (state === 'invalid') {
    sheet.innerHTML = `<h1>${ic('ti-link-off')} ${t('jInvalid')}</h1><p class="meta" style="font-size:14px;margin-top:8px">${t('jInvalidHint')}</p>
      <a class="cta" href="index.html" style="text-decoration:none"><span class="seal">${ic('ti-arrow-right')}</span><span class="txt">${t('jHome')}</span></a>`;
    return;
  }
  const a = parse(invite.start_date), b = parse(invite.end_date);
  const head = `<div class="sheet-top"><span class="mono">${t('jChip')}</span></div>
    <h1>${esc(t('jTitle')(invite.title))}</h1>
    <p class="meta" style="font-size:14px">${esc(t('jMeta')(invite.owner_name || '—', t('fmt')(a), t('fmt')(b)))}</p>
    ${invite.kind === 'view' ? `<p class="meta preview">${t('jViewOnly')}</p>` : ''}<div class="rule"></div>`;
  if (state === 'already') {
    sheet.innerHTML = head + `<p class="meta" style="font-size:14px;margin-top:16px">${t('jAlready')}</p>
      <a class="cta" href="${editorUrl(already)}" style="text-decoration:none"><span class="seal">${esc(t('seal'))}</span><span class="txt">${t('jGo')}</span>${ic('ti-arrow-right')}</a>`;
    return;
  }
  const nick = (session && !session.user.is_anonymous && session.user.user_metadata && (session.user.user_metadata.full_name || session.user.user_metadata.name)) || '';
  sheet.innerHTML = head + `<form id="joinForm" novalidate>
      <label class="flabel" for="nick">${t('jNick')}</label>
      <div class="frame"><div class="field">${ic('ti-user-plus')}<input id="nick" maxlength="20" autocomplete="nickname" placeholder="${esc(t('jNickPh'))}" value="${esc(nick.slice(0, 20))}" aria-describedby="nickHint nickErr"></div></div>
      <p class="meta" id="nickHint" style="margin-top:6px">${t('jNickHint')}</p>
      <p class="err" id="nickErr" role="alert">${esc(t('errors').invalid_nickname)}</p>
      <div class="opt" style="margin-top:14px"><input type="checkbox" id="agree"><label for="agree" class="meta">${t('jAgree')} <a href="${t('privacyUrl')}" target="_blank" rel="noopener">${t('privacyLink')}</a>${t('legalSep')}<a href="${t('termsUrl')}" target="_blank" rel="noopener">${t('terms')}</a> ${t('jAgree2')} <span class="req">${t('required')}</span></label></div>
      <div class="opt"><input type="checkbox" id="stats" ${CFG.STATS_DEFAULT_CHECKED ? 'checked' : ''}><label for="stats" class="meta">${t('jStats')}</label></div>
      ${CFG.TURNSTILE_SITE_KEY ? '<div id="captcha" style="margin-top:14px"></div>' : ''}
      <button class="cta" type="submit" id="joinBtn" disabled><span class="seal">${esc(t('seal'))}</span><span class="txt" id="joinTxt">${invite.kind === 'view' ? t('jJoinView') : t('jJoin')}</span>${ic('ti-arrow-right')}</button>
      ${!(session && !session.user.is_anonymous) ? `<p class="meta" style="margin-top:12px"><button type="button" class="inline-link" id="acctJoin">${ic('ti-login-2')} ${t('jHaveGoogle')}</button></p>` : ''}
    </form>`;
  mountCaptcha();
  const agree = $('agree'), btn = $('joinBtn');
  agree.addEventListener('change', () => { btn.disabled = !agree.checked; });
  $('joinForm').addEventListener('submit', e => { e.preventDefault(); join(); });
  const g = $('acctJoin');
  // 已有帳號：登入後用原帳號加入。OAuth 會離開頁面，邀請碼已存在 sessionStorage，回來後接著加入。
  if (g) g.addEventListener('click', () => window.TS_AUTH.open({ sb, cfg: CFG, lang, ic, esc, link: !!(session && session.user.is_anonymous),
    redirectTo: location.origin + location.pathname,
    onSignedIn: async s => { session = s; await checkAlready(); view(); } }));
}

async function join() {
  const nickEl = $('nick'), nick = nickEl.value.trim();
  if (nick.length < 1 || nick.length > 20) { $('nickErr').classList.add('show'); nickEl.setAttribute('aria-invalid', 'true'); nickEl.focus(); return; }
  const btn = $('joinBtn'); btn.classList.add('busy'); $('joinTxt').textContent = t('jJoining');
  try {
    if (!session) {
      if (CFG.TURNSTILE_SITE_KEY && !captchaToken) throw new Error('captcha_required');
      const { data, error } = await sb.auth.signInAnonymously(captchaToken ? { options: { captchaToken } } : undefined);
      if (error) throw error;
      session = data.session;
    }
    const { data: rows, error: ce } = await sb.rpc('my_consent');
    if (ce) throw ce;
    const ok = (rows || []).some(r => r.purpose === 'service' && r.granted && r.terms_version === r.current_version);
    if (!ok) { const { error } = await sb.rpc('record_consent', { p_stats: $('stats').checked, p_marketing: false }); if (error) throw error; }
    const { data: tripId, error: je } = await sb.rpc('join_invite', { p_token: token, p_nickname: nick });
    if (je) throw je;
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) {}
    location.replace(editorUrl(tripId));
  } catch (e) {
    toast(errMsg(e));
    btn.classList.remove('busy'); $('joinTxt').textContent = invite.kind === 'view' ? t('jJoinView') : t('jJoin');
  }
}

async function checkAlready() {
  if (!session || !invite) return;
  const { data: me } = await sb.from('collaborators').select('trip_id').eq('trip_id', invite.trip_id).eq('user_id', session.user.id).maybeSingle();
  if (me) { already = invite.trip_id; state = 'already'; }
}
async function init() {
  view();
  token = readToken();
  if (location.hash) history.replaceState(null, '', location.pathname);   // 不讓邀請碼留在網址列
  if (!token) { state = 'invalid'; return view(); }
  try {
    const { data: s } = await sb.auth.getSession(); session = s.session;
    const { data, error } = await sb.rpc('invite_preview', { p_token: token });
    if (error) throw error;
    invite = (data || [])[0];
    if (!invite) { state = 'invalid'; return view(); }
    state = 'form'; await checkAlready(); view();
  } catch (e) { toast(errMsg(e)); state = 'invalid'; view(); }
}
function setLang(l) { lang = l; store.set('ts-lang', l); view(); }
$('langZh').addEventListener('click', () => setLang('zh'));
$('langEn').addEventListener('click', () => setLang('en'));
init();
})();
