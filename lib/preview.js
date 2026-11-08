/* 分享預覽卡片（Cloudflare Pages Functions 共用）
   WhatsApp、LINE、Messenger、Facebook、Telegram、Threads、iMessage、Signal、Slack 都讀 Open Graph 標籤，
   所以 /t/<行程ID>（閱讀）與 /i/<行程ID>#t=<邀請碼>（邀請）先回一頁只有預覽標籤的 HTML，再由 /assets/go.js 轉到真正的頁面。
   邀請碼在 # 後面，不會送到伺服器；這裡只用行程 ID 向資料庫 share_preview 取「名稱、目的地、天數、日期、建立者暱稱」。
   WeChat 不讀一般網站的預覽標籤，只會顯示網址（需要微信 JS-SDK 與公眾號，不在範圍內）。
   需要的環境變數（Cloudflare Pages → Settings → Environment variables）：SUPABASE_URL、SUPABASE_ANON_KEY */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const md = d => { const [, m, day] = String(d).split('-').map(Number); return `${m}/${day}`; };

export async function fetchPreview(env, id, kind) {
  if (!UUID.test(id || '') || !env || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 2500);
  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/share_preview`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ p_trip: id, p_kind: kind })
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j && typeof j === 'object' && j.title ? j : null;
  } catch (e) { return null; } finally { clearTimeout(timer); }
}

export function previewText(p, kind) {
  const generic = kind === 'invite'
    ? { title: '朋友邀你一起編輯旅遊行程', desc: '點開輸入暱稱就能加入，不用註冊。Travel Studio 旅遊手帳。' }
    : { title: 'Travel Studio 旅遊手帳', desc: '和朋友一起排行程：時間、交通、預算與訂位整理在同一本手帳。' };
  if (!p) return generic;
  const parts = [p.destination, `${p.days} 天`, `${md(p.start_date)}–${md(p.end_date)}`];
  if (p.stops) parts.push(`已排 ${p.stops} 站`);
  if (kind === 'invite') return { title: `${p.owner || '朋友'} 邀你一起編輯「${p.title}」`, desc: `${parts.join(' · ')}。點開輸入暱稱就能加入，不用註冊。` };
  return { title: p.title, desc: `${parts.join(' · ')} · ${p.owner || '旅人'} 的旅遊手帳` };
}

export async function renderPreview(ctx, kind) {
  const { request, env, params } = ctx;
  const url = new URL(request.url), id = String(params.id || '');
  const p = await fetchPreview(env, id, kind);
  const tx = previewText(p, kind);
  const valid = UUID.test(id);
  const target = kind === 'invite' ? '/join.html' : (valid ? `/editor.html?trip=${encodeURIComponent(id)}&mode=read` : '/');
  const photo = p && /^https:\/\//.test(p.photo_url || '') ? p.photo_url : null;
  const image = photo || `${url.origin}/assets/og-default.jpg`;
  const html = `<!DOCTYPE html>
<html lang="zh-Hant"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(tx.title)} · Travel Studio</title>
<meta name="description" content="${esc(tx.desc)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Travel Studio"><meta property="og:locale" content="zh_TW">
<meta property="og:title" content="${esc(tx.title)}"><meta property="og:description" content="${esc(tx.desc)}">
<meta property="og:url" content="${esc(url.origin + url.pathname)}">
<meta property="og:image" content="${esc(image)}">${photo ? '' : '\n<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:type" content="image/jpeg">'}
<meta property="og:image:alt" content="${esc(tx.title)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(tx.title)}"><meta name="twitter:description" content="${esc(tx.desc)}"><meta name="twitter:image" content="${esc(image)}">
${kind === 'invite' || !p || p.visibility !== 'public' ? '<meta name="robots" content="noindex">' : ''}
<meta name="ts-go" content="${esc(target)}"${kind === 'invite' ? ' data-keep-hash="1"' : ''}>
<link rel="stylesheet" href="/assets/site.css">
</head><body data-theme="paper"><main class="legal-page"><h1>${esc(tx.title)}</h1><p>${esc(tx.desc)}</p>
<p><a id="go" href="${esc(target)}">打開行程 Open trip →</a></p></main>
<script src="/assets/go.js"></script></body></html>`;
  return new Response(request.method === 'HEAD' ? null : html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      ...(kind === 'invite' || !p || p.visibility !== 'public' ? { 'X-Robots-Tag': 'noindex' } : {})
    }
  });
}
