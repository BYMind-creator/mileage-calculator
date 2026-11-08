/* 登入／綁定帳號對話框（首頁、加入頁、編輯器共用）
   方式：Google、Apple、LINE（Supabase 自訂 OAuth／OIDC）、Email 驗證碼。開哪些由 config.js 的 AUTH_PROVIDERS 決定。
   - App 內建瀏覽器（LINE、FB、IG、Messenger、Threads、WeChat…）會擋 Google，自動隱藏 Google，其他方式照常。
   - 匿名旅伴「綁定帳號」：OAuth 用 linkIdentity、Email 用 updateUser＋驗證碼，保留同一個帳號與編輯紀錄。
   - Email 驗證碼需要在 Supabase 的 Email 範本放 {{ .Token }}（見 README）。
   - 手機驗證碼（'sms'）：輸入手機號碼，簡訊收 6 位數驗證碼。需在 Supabase 設定 Phone provider（例如 Twilio Verify）。
     手機號碼只用來登入，畫面只顯示末四碼。 */
(function () {
'use strict';
const SH = window.TS_SHARE;
const L = {
  zh: {
    titleIn: '登入 Travel Studio', titleLink: '綁定帳號', subIn: '行程存在你的帳號裡，換手機也找得回來。', subLink: '綁定後，換手機或清除瀏覽器也找得回這份行程，編輯紀錄會保留。',
    google: '使用 Google 繼續', apple: '使用 Apple 繼續', line: '使用 LINE 繼續', email: '使用 Email 驗證碼', sms: '使用手機驗證碼',
    phoneLabel: '手機號碼', phonePh: '例如 9123 4567', cc: '國碼', errBadPhone: '手機號碼格式不正確。',
    phoneSent: n => `驗證碼已用簡訊傳到 ${n}，10 分鐘內有效。`, changePhone: '改用其他號碼',
    errPhoneTaken: '這個手機號碼已經有帳號。請先登出匿名身分再用它登入（匿名期間的編輯會留在原行程）。',
    inApp: app => `${app} 的內建瀏覽器不支援 Google 登入，請用下面其他方式。`,
    emailLabel: 'Email', emailPh: 'you@example.com', send: '寄驗證碼', back: '選其他方式',
    codeSent: e => `驗證碼已寄到 ${e}，10 分鐘內有效。找不到的話看一下垃圾郵件。`, codeLabel: '驗證碼', verify: '登入', verifyLink: '綁定',
    resend: '重新寄送', resendIn: s => `${s} 秒後可重寄`, changeEmail: '改用其他 Email',
    foot: '繼續即表示你同意', terms: '服務條款', privacy: '隱私權政策', and: '與',
    errBadEmail: 'Email 格式不正確。', errBadCode: '驗證碼不正確或已過期，請重新輸入或重寄。', errTooMany: '太多次了，請稍等一分鐘再試。',
    errEmailTaken: '這個 Email 已經有帳號。請先登出匿名身分再用這個 Email 登入（匿名期間的編輯會留在原行程）。',
    errIdentityTaken: '這個帳號已經綁定在另一個使用者身上，請直接用它登入。', errCaptcha: '請先完成下方的驗證。',
    errProviderOff: '這個登入方式還沒開放，請改用其他方式。', errNetwork: '連不上網路，請稍後再試。', errGeneric: '登入失敗，請再試一次。', close: '關閉'
  },
  en: {
    titleIn: 'Sign in to Travel Studio', titleLink: 'Link an account', subIn: 'Your trips are saved to your account, so you can switch phones.', subLink: "Link an account to keep this trip if you switch phones or clear your browser. Your edits stay.",
    google: 'Continue with Google', apple: 'Continue with Apple', line: 'Continue with LINE', email: 'Use an email code', sms: 'Use a phone code',
    phoneLabel: 'Mobile number', phonePh: 'e.g. 9123 4567', cc: 'Country code', errBadPhone: "That number doesn't look right.",
    phoneSent: n => `We texted a code to ${n}. It expires in 10 minutes.`, changePhone: 'Use a different number',
    errPhoneTaken: 'That number already has an account. Sign out of guest mode, then sign in with it (your guest edits stay on the trip).',
    inApp: app => `${app}'s built-in browser doesn't support Google sign-in. Use another option below.`,
    emailLabel: 'Email', emailPh: 'you@example.com', send: 'Send code', back: 'Other options',
    codeSent: e => `We sent a code to ${e}. It expires in 10 minutes. Check your spam folder if you don't see it.`, codeLabel: 'Code', verify: 'Sign in', verifyLink: 'Link',
    resend: 'Resend', resendIn: s => `Resend in ${s}s`, changeEmail: 'Use a different email',
    foot: 'By continuing you agree to the', terms: 'Terms', privacy: 'Privacy Policy', and: 'and',
    errBadEmail: "That email doesn't look right.", errBadCode: "That code is wrong or expired. Try again or resend.", errTooMany: 'Too many tries. Wait a minute and try again.',
    errEmailTaken: 'That email already has an account. Sign out of guest mode, then sign in with it (your guest edits stay on the trip).',
    errIdentityTaken: "That account is already linked to someone else. Sign in with it directly.", errCaptcha: 'Please complete the verification below.',
    errProviderOff: "This sign-in option isn't available yet. Try another.", errNetwork: "You're offline. Try again later.", errGeneric: "Couldn't sign in. Please try again.", close: 'Close'
  }
};
const META = {
  google: { icon: 'ti-brand-google', color: '#4285F4' },
  apple: { icon: 'ti-brand-apple', color: 'currentColor' },
  line: { icon: 'ti-brand-line', color: '#06C755' },
  email: { icon: 'ti-mail', color: 'currentColor' },
  sms: { icon: 'ti-device-mobile-message', color: 'currentColor' }
};
// 國碼：香港、台灣、澳門優先；trunk＝當地撥號前面的 0，國際格式要拿掉
const CC = [['+852', '香港 HK', 8, 8, false], ['+886', '台灣 TW', 9, 9, true], ['+853', '澳門 MO', 8, 8, false], ['+86', '中國 CN', 11, 11, false],
  ['+65', '新加坡 SG', 8, 8, false], ['+60', '馬來西亞 MY', 9, 10, true], ['+81', '日本 JP', 10, 10, true], ['+82', '韓國 KR', 9, 10, true],
  ['+66', '泰國 TH', 9, 9, true], ['+1', 'US / CA', 10, 10, false], ['+44', 'UK', 10, 10, true], ['+61', 'AU', 9, 9, true]];
function defaultCc() {
  let tz = ''; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
  const lg = (navigator.language || '').toLowerCase();
  if (tz === 'Asia/Hong_Kong' || lg === 'zh-hk') return '+852';
  if (tz === 'Asia/Macau' || lg === 'zh-mo') return '+853';
  if (tz === 'Asia/Taipei' || lg === 'zh-tw') return '+886';
  return '+852';
}
function normPhone(cc, raw) {
  const c = CC.find(x => x[0] === cc); let d = String(raw || '').replace(/\D/g, '');
  if (!c) return null;
  if (c[4] && d.startsWith('0')) d = d.slice(1);
  if (d.length < c[2] || d.length > c[3]) return null;
  return cc + d;
}
// 顯示用：+852 9123 4567、+886 912 345 678
function maskPhone(p) {
  const c = CC.map(x => x[0]).sort((a, b) => b.length - a.length).find(x => p.startsWith(x)) || '';
  const n = p.slice(c.length);
  const g = n.length === 9 ? [n.slice(0, 3), n.slice(3, 6), n.slice(6)] : [n.slice(0, n.length - 4), n.slice(-4)];
  return `${c} ${g.filter(Boolean).join(' ')}`.trim();
}
let o = null, dlg = null, step = 'choose', email = '', phone = '', cc = null, captchaToken = null, captchaId = null, cooldown = 0, timer = null;
const l = () => L[o.lang] || L.zh;

function providers() {
  const cfg = (o && o.cfg) || window.TS_CONFIG;
  const list = (cfg.AUTH_PROVIDERS || ['google', 'apple', 'line', 'email']).filter(p => META[p]);
  return SH && SH.inApp() ? list.filter(p => p !== 'google') : list;
}
function errText(e) {
  const m = String((e && (e.message || e.error_description || e.code)) || '');
  if (/rate limit|after \d+ seconds|too many/i.test(m)) return l().errTooMany;
  if (/captcha/i.test(m)) return l().errCaptcha;
  if (/phone_exists|phone.*already|already.*phone/i.test(m)) return l().errPhoneTaken;
  if (/invalid phone|phone.*invalid|validation_failed.*phone/i.test(m)) return l().errBadPhone;
  if (/unsupported phone provider|sms provider|phone provider|phone_provider_disabled/i.test(m)) return l().errProviderOff;
  if (/already (been )?registered|email_exists|already exists.*email|email.*already/i.test(m)) return l().errEmailTaken;
  if (/identity.*(already|exists)|identity_already_exists/i.test(m)) return l().errIdentityTaken;
  if (/provider is not enabled|unsupported provider|validation_failed.*provider/i.test(m)) return l().errProviderOff;
  if (/expired|invalid.*(otp|token)|token.*(expired|invalid)|otp/i.test(m)) return l().errBadCode;
  if (/fetch|network|Failed to|Load failed/i.test(m)) return l().errNetwork;
  return l().errGeneric;
}
function showErr(msg) { const el = dlg.querySelector('.auth-err'); el.textContent = msg || ''; el.hidden = !msg; }

function mountCaptcha() {
  const key = o.cfg.TURNSTILE_SITE_KEY, box = dlg.querySelector('#authCaptcha'); if (!key || !box) return;
  captchaToken = null;
  const render = () => { captchaId = window.turnstile.render(box, { sitekey: key, language: o.lang === 'zh' ? 'zh-tw' : 'en', callback: tok => { captchaToken = tok; }, 'expired-callback': () => { captchaToken = null; } }); };
  if (window.turnstile) return render();
  if (!document.getElementById('ts-turnstile')) { const sc = document.createElement('script'); sc.id = 'ts-turnstile'; sc.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; sc.async = true; sc.onload = render; document.head.appendChild(sc); }
  else document.getElementById('ts-turnstile').addEventListener('load', render);
}
function resetCaptcha() { captchaToken = null; try { if (window.turnstile && captchaId != null) window.turnstile.reset(captchaId); } catch (e) {} }

function view() {
  const x = l(), ic = o.ic, esc = o.esc, app = SH && SH.inApp();
  let body = '';
  if (step === 'choose') {
    body = `${app && (o.cfg.AUTH_PROVIDERS || ['google']).includes('google') ? `<p class="auth-note">${ic('ti-info-circle')} ${esc(x.inApp(SH.appLabel(app)))}</p>` : ''}
      <div class="auth-list">${providers().map(p => `<button type="button" class="auth-btn" data-auth="${p}">${ic(META[p].icon, 'color:' + META[p].color)}<span>${x[p]}</span></button>`).join('')}</div>`;
  } else if (step === 'email') {
    body = `<form class="auth-form" data-form="email" novalidate>
        <label class="auth-label" for="authEmail">${x.emailLabel}</label>
        <input class="auth-inp" id="authEmail" type="email" inputmode="email" autocomplete="email" maxlength="254" placeholder="${x.emailPh}" value="${esc(email)}" required>
        ${o.cfg.TURNSTILE_SITE_KEY ? '<div id="authCaptcha" class="auth-captcha"></div>' : ''}
        <button class="auth-primary" type="submit">${x.send}</button>
        <button type="button" class="auth-link" data-auth="back">${x.back}</button></form>`;
  } else if (step === 'phone') {
    const cur = cc || defaultCc();
    body = `<form class="auth-form" data-form="phone" novalidate>
        <label class="auth-label" for="authPhone">${x.phoneLabel}</label>
        <div class="auth-phone"><select class="auth-inp auth-cc" id="authCc" aria-label="${x.cc}">${CC.map(c => `<option value="${c[0]}" ${c[0] === cur ? 'selected' : ''}>${c[0]} ${c[1]}</option>`).join('')}</select>
          <input class="auth-inp" id="authPhone" type="tel" inputmode="tel" autocomplete="tel-national" maxlength="20" placeholder="${x.phonePh}" value="${esc(phone ? phone.replace(cur, '') : '')}" required></div>
        ${o.cfg.TURNSTILE_SITE_KEY ? '<div id="authCaptcha" class="auth-captcha"></div>' : ''}
        <button class="auth-primary" type="submit">${x.send}</button>
        <button type="button" class="auth-link" data-auth="back">${x.back}</button></form>`;
  } else if (step === 'pcode') {
    body = `<form class="auth-form" data-form="pcode" novalidate>
        <p class="auth-note">${esc(x.phoneSent(maskPhone(phone)))}</p>
        <label class="auth-label" for="authCode">${x.codeLabel}</label>
        <input class="auth-inp auth-code" id="authCode" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="10" required>
        <button class="auth-primary" type="submit">${o.link ? x.verifyLink : x.verify}</button>
        <div class="auth-row"><button type="button" class="auth-link" data-auth="resend" ${cooldown ? 'disabled' : ''}>${cooldown ? x.resendIn(cooldown) : x.resend}</button>
        <button type="button" class="auth-link" data-auth="changePhone">${x.changePhone}</button></div></form>`;
  } else if (step === 'code') {
    body = `<form class="auth-form" data-form="code" novalidate>
        <p class="auth-note">${esc(x.codeSent(email))}</p>
        <label class="auth-label" for="authCode">${x.codeLabel}</label>
        <input class="auth-inp auth-code" id="authCode" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="10" required>
        <button class="auth-primary" type="submit">${o.link ? x.verifyLink : x.verify}</button>
        <div class="auth-row"><button type="button" class="auth-link" data-auth="resend" ${cooldown ? 'disabled' : ''}>${cooldown ? x.resendIn(cooldown) : x.resend}</button>
        <button type="button" class="auth-link" data-auth="change">${x.changeEmail}</button></div></form>`;
  }
  dlg.innerHTML = `<div class="auth-h"><span class="mono">${o.link ? 'LINK' : 'SIGN IN'}</span><h2>${o.link ? x.titleLink : x.titleIn}</h2>
      <button type="button" class="auth-x" data-auth="close" aria-label="${x.close}">${ic('ti-x')}</button></div>
    <p class="auth-sub">${o.link ? x.subLink : x.subIn}</p>
    ${body}<p class="auth-err" role="alert" hidden></p>
    <p class="auth-foot">${x.foot} <a href="terms.html" target="_blank" rel="noopener">${x.terms}</a> ${x.and} <a href="privacy.html" target="_blank" rel="noopener">${x.privacy}</a></p>`;
  if (step === 'email') { mountCaptcha(); dlg.querySelector('#authEmail').focus(); }
  if (step === 'phone') { mountCaptcha(); dlg.querySelector('#authPhone').focus(); }
  if (step === 'code' || step === 'pcode') dlg.querySelector('#authCode').focus();
}
function startCooldown() {
  cooldown = 60; clearInterval(timer);
  timer = setInterval(() => {
    cooldown = Math.max(0, cooldown - 1);
    const b = dlg && dlg.querySelector('[data-auth=resend]');
    if (b) { b.disabled = cooldown > 0; b.textContent = cooldown ? l().resendIn(cooldown) : l().resend; }
    if (!cooldown) clearInterval(timer);
  }, 1000);
}
async function sendCode() {
  const sb = o.sb;
  if (o.cfg.TURNSTILE_SITE_KEY && !captchaToken && !o.link) throw new Error('captcha');
  const r = o.link
    ? await sb.auth.updateUser({ email }, { emailRedirectTo: o.redirectTo })
    : await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: o.redirectTo, captchaToken: captchaToken || undefined } });
  resetCaptcha();
  if (r.error) throw r.error;
  startCooldown();
}
async function sendPhoneCode() {
  const sb = o.sb;
  if (o.cfg.TURNSTILE_SITE_KEY && !captchaToken && !o.link) throw new Error('captcha');
  const r = o.link
    ? await sb.auth.updateUser({ phone })
    : await sb.auth.signInWithOtp({ phone, options: { channel: 'sms', shouldCreateUser: true, captchaToken: captchaToken || undefined } });
  resetCaptcha();
  if (r.error) throw r.error;
  startCooldown();
}
async function oauth(p) {
  const sb = o.sb, provider = p === 'line' ? (o.cfg.LINE_PROVIDER_ID || 'custom:line') : p;
  const options = { redirectTo: o.redirectTo };
  if (p === 'google') options.queryParams = { prompt: 'select_account' };
  if (p === 'line') options.scopes = 'openid profile email';
  if (o.beforeRedirect) o.beforeRedirect(p);
  const { error } = o.link ? await sb.auth.linkIdentity({ provider, options }) : await sb.auth.signInWithOAuth({ provider, options });
  if (error) throw error;
}

function ensureDialog() {
  if (dlg) return;
  dlg = document.createElement('dialog'); dlg.className = 'auth-dlg'; dlg.id = 'authDlg'; dlg.setAttribute('aria-label', 'Sign in');
  document.body.appendChild(dlg);
  dlg.addEventListener('click', async e => {
    if (e.target === dlg) { dlg.close(); return; }          // 點背景關閉
    const b = e.target.closest('[data-auth]'); if (!b || b.disabled) return;
    const a = b.dataset.auth; showErr('');
    if (a === 'close') return dlg.close();
    if (a === 'back') { step = 'choose'; return view(); }
    if (a === 'change') { step = 'email'; return view(); }
    if (a === 'email') { step = 'email'; return view(); }
    if (a === 'sms' || a === 'changePhone') { step = 'phone'; return view(); }
    if (a === 'resend') { b.disabled = true; try { await (step === 'pcode' ? sendPhoneCode() : sendCode()); } catch (err) { showErr(errText(err)); b.disabled = false; } return; }
    b.classList.add('busy');
    try { await oauth(a); } catch (err) { b.classList.remove('busy'); showErr(errText(err)); }
  });
  dlg.addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('.auth-primary'); showErr('');
    if (f.dataset.form === 'email') {
      const v = f.querySelector('#authEmail').value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) { showErr(l().errBadEmail); return; }
      email = v; btn.classList.add('busy');
      try { await sendCode(); step = 'code'; view(); } catch (err) { btn.classList.remove('busy'); showErr(errText(err)); }
    } else if (f.dataset.form === 'phone') {
      cc = f.querySelector('#authCc').value;
      const n = normPhone(cc, f.querySelector('#authPhone').value);
      if (!n) { showErr(l().errBadPhone); return; }
      phone = n; btn.classList.add('busy');
      try { await sendPhoneCode(); step = 'pcode'; view(); } catch (err) { btn.classList.remove('busy'); showErr(errText(err)); }
    } else if (f.dataset.form === 'pcode') {
      const code = f.querySelector('#authCode').value.replace(/\D/g, '');
      if (code.length < 6) { showErr(l().errBadCode); return; }
      btn.classList.add('busy');
      const { data, error } = await o.sb.auth.verifyOtp({ phone, token: code, type: o.link ? 'phone_change' : 'sms' });
      if (error || !data.session) { btn.classList.remove('busy'); showErr(errText(error || { message: 'otp' })); return; }
      dlg.close();
      if (o.onSignedIn) o.onSignedIn(data.session, 'sms');
    } else if (f.dataset.form === 'code') {
      const code = f.querySelector('#authCode').value.replace(/\D/g, '');
      if (code.length < 6) { showErr(l().errBadCode); return; }
      btn.classList.add('busy');
      const { data, error } = await o.sb.auth.verifyOtp({ email, token: code, type: o.link ? 'email_change' : 'email' });
      if (error || !data.session) { btn.classList.remove('busy'); showErr(errText(error || { message: 'otp' })); return; }
      dlg.close();
      if (o.onSignedIn) o.onSignedIn(data.session, 'email');
    }
  });
  dlg.addEventListener('close', () => { clearInterval(timer); });
}

/* opts: { sb, cfg, lang, ic, esc, link, redirectTo, beforeRedirect(provider), onSignedIn(session, method) } */
function open(opts) {
  o = opts; ensureDialog(); step = 'choose'; captchaToken = null;
  view(); dlg.showModal();
  const first = dlg.querySelector('.auth-btn'); if (first) first.focus();
}
window.TS_AUTH = { open, providers: () => providers(), L };
})();
