/* 多平台分享與 App 內建瀏覽器處理（台灣、香港）
   - 分享：手機用系統分享面板（WhatsApp、LINE、Messenger、IG、WeChat、Telegram、Signal 都在裡面），
     另外提供常用 App 的直接按鈕、複製連結、QR code（WeChat 不支援網頁直接分享，掃碼或貼上連結最可靠）。
   - 內建瀏覽器：Google 不允許在 App 內建瀏覽器登入（LINE、Facebook、Messenger、Instagram、Threads、WeChat 等），
     偵測到時引導改用瀏覽器開啟。受邀者匿名加入不受影響。 */
(function () {
'use strict';
const ua = navigator.userAgent || '';
const isIOS = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/i.test(ua);
const isMobile = isIOS || isAndroid;
const enc = encodeURIComponent;
const L = {
  zh: { more: '其他 App…', copy: '複製連結', qr: 'QR code', qrHint: 'WeChat 或當面掃描即可打開', copied: '已複製連結',
        menuFb: '點右上角「⋯」，選「在外部瀏覽器開啟」。', menuWeChat: '點右上角「⋯」，選「在瀏覽器打開」。',
        menuLine: '點下方按鈕用瀏覽器開啟。', menuApp: '請把網址貼到 Safari 或 Chrome 開啟。',
        banner: app => `${app} 的內建瀏覽器無法使用 Google 登入。` },
  en: { more: 'More apps…', copy: 'Copy link', qr: 'QR code', qrHint: 'Scan with WeChat or a phone camera', copied: 'Link copied',
        menuFb: 'Tap "⋯" at the top right and choose "Open in external browser".', menuWeChat: 'Tap "⋯" at the top right and choose "Open in browser".',
        menuLine: 'Tap the button to open in your browser.', menuApp: 'Paste the link into Safari or Chrome.',
        banner: app => `Google sign-in doesn't work in ${app}'s built-in browser.` }
};

function inApp() {
  if (/\bLine\//i.test(ua)) return 'LINE';
  if (/FBAN\/Messenger|FB_IAB\/MESSENGER|MessengerForiOS|MessengerLite/i.test(ua)) return 'Messenger';
  if (/Instagram/i.test(ua)) return 'Instagram';
  if (/Barcelona/i.test(ua)) return 'Threads';
  if (/FBAN|FBAV|FB_IAB|FBIOS/i.test(ua)) return 'Facebook';
  if (/MicroMessenger/i.test(ua)) return 'WeChat';
  if (/KAKAOTALK/i.test(ua)) return 'KakaoTalk';
  if (isAndroid && /; wv\)/.test(ua)) return 'App';
  return null;
}
// 能直接跳到外部瀏覽器的連結；做不到（iOS 的 FB／IG／WeChat）回 null，改顯示操作說明
function escapeHref(url) {
  const app = inApp(); if (!app) return null;
  let u; try { u = new URL(url || location.href); } catch (e) { return null; }
  if (app === 'LINE') { u.searchParams.set('openExternalBrowser', '1'); return u.toString(); }
  if (isAndroid) {
    u.hash = '';   // intent 網址不能帶 #
    return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${enc(u.toString())};end`;
  }
  return null;
}
function escapeHint(lang) {
  const l = L[lang] || L.zh, app = inApp();
  if (!app) return '';
  if (app === 'LINE' || isAndroid) return l.menuLine;
  if (app === 'WeChat') return l.menuWeChat;
  if (['Facebook', 'Messenger', 'Instagram', 'Threads'].includes(app)) return l.menuFb;
  return l.menuApp;
}
const appLabel = app => app === 'App' ? 'App' : app;

function inviteUrl(tripId, token) { return new URL(`i/${enc(tripId)}#t=${enc(token)}`, location.href).href; }
function readUrl(tripId) { return new URL(`t/${enc(tripId)}`, location.href).href; }

function copy(s) {
  // 剪貼簿 API 在權限被擋時可能一直不回應；800ms 內沒完成就改用備用方式
  if (navigator.clipboard && window.isSecureContext) {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 800));
    return Promise.race([navigator.clipboard.writeText(s), timeout]).catch(() => fallbackCopy(s));
  }
  fallbackCopy(s); return Promise.resolve();
}
function fallbackCopy(s) { try { const ta = document.createElement('textarea'); ta.value = s; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); } catch (e) {} }

function qrSvg(url) {
  if (!window.qrcode) return '';
  const q = window.qrcode(0, 'M'); q.addData(url); q.make();
  return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

/* 分享按鈕列。ic、esc 由呼叫端提供（同一套圖示與跳脫）。點擊用 data-share，不會和頁面的 data-act 衝突。 */
function sheet(o) {
  const l = L[o.lang] || L.zh, url = o.url, msg = o.text ? `${o.text} ${url}` : url;
  const apps = [
    ['line', 'LINE', 'ti-brand-line', '#06C755', `https://line.me/R/share?text=${enc(msg)}`],
    ['whatsapp', 'WhatsApp', 'ti-brand-whatsapp', '#25D366', `https://wa.me/?text=${enc(msg)}`],
    isMobile ? ['messenger', 'Messenger', 'ti-brand-messenger', '#0866FF', `fb-messenger://share/?link=${enc(url)}`] : null,
    ['telegram', 'Telegram', 'ti-brand-telegram', '#229ED9', `https://t.me/share/url?url=${enc(url)}&text=${enc(o.text || '')}`]
  ].filter(Boolean);
  const native = typeof navigator.share === 'function'
    ? `<button type="button" class="sh-btn sh-more" data-share="native">${o.ic('ti-share-2')}<span>${l.more}</span></button>` : '';
  return `<div class="share-sheet" data-url="${o.esc(url)}" data-text="${o.esc(o.text || '')}" data-title="${o.esc(o.title || '')}">
    <div class="sh-row">${native}${apps.map(a => `<a class="sh-btn" data-share="${a[0]}" href="${o.esc(a[4])}" target="_blank" rel="noopener noreferrer">${o.ic(a[2], 'color:' + a[3])}<span>${a[1]}</span></a>`).join('')}
      <button type="button" class="sh-btn" data-share="copy">${o.ic('ti-copy')}<span>${l.copy}</span></button>
      <button type="button" class="sh-btn" data-share="qr" aria-expanded="false">${o.ic('ti-qrcode')}<span>${l.qr}</span></button></div>
    <div class="sh-qr" hidden><div class="sh-qr-img" role="img" aria-label="QR code"></div><p>${o.ic('ti-brand-wechat', 'color:#07C160')} ${l.qrHint}</p></div>
  </div>`;
}
/* 綁定一次即可（事件委派）。onPick(channel, url) 用來記錄事件、顯示提示。 */
function bind(root, onPick) {
  root.addEventListener('click', async e => {
    const b = e.target.closest('[data-share]'); if (!b) return;
    const sh = b.closest('.share-sheet'); if (!sh) return;
    const url = sh.dataset.url, ch = b.dataset.share;
    if (ch === 'native') {
      e.preventDefault();
      try { await navigator.share({ title: sh.dataset.title || undefined, text: sh.dataset.text || undefined, url }); onPick && onPick('native', url); } catch (err) { /* 使用者取消 */ }
    } else if (ch === 'copy') {
      e.preventDefault(); await copy(url); onPick && onPick('copy', url);
    } else if (ch === 'qr') {
      e.preventDefault();
      const box = sh.querySelector('.sh-qr'), open = box.hidden;
      if (open && !box.dataset.done) { box.querySelector('.sh-qr-img').innerHTML = qrSvg(url); box.dataset.done = '1'; }
      box.hidden = !open; b.setAttribute('aria-expanded', String(open));
      if (open) onPick && onPick('qr', url);
    } else onPick && onPick(ch, url);
  });
}

window.TS_SHARE = { inApp, appLabel, isIOS, isAndroid, isMobile, escapeHref, escapeHint, inviteUrl, readUrl, copy, sheet, bind, qrSvg, L };
})();
