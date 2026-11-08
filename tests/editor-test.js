// 編輯器端對端測試：真的 supabase-js ＋ 本機 PostgREST 模擬 ＋ 真的 PostgreSQL（含全部 RPC 與權限）
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const BASE = 'http://127.0.0.1:8770';
const SHOTS = process.argv[2] || '.';
const U = {
  owner:    { id: '11111111-1111-4111-8111-111111111111', email: 'owner@gmail.com', anon: false },
  mate:     { id: '22222222-2222-4222-8222-222222222222', email: null, anon: true },
  viewer:   { id: '33333333-3333-4333-8333-333333333333', email: null, anon: true },
  stranger: { id: '44444444-4444-4444-8444-444444444444', email: 'stranger@gmail.com', anon: false },
  r2:       { id: '55555555-5555-4555-8555-555555555555', email: 'r2@gmail.com', anon: false },
  r3:       { id: '66666666-6666-4666-8666-666666666666', email: 'r3@gmail.com', anon: false }
};
const psql = sql => execSync(`su postgres -c "psql -h /tmp -p 55432 -d tse2e -At -q"`, { input: sql }).toString().trim();
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const tok = u => `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: u.id, role: 'authenticated', email: u.email, is_anonymous: u.anon, exp: 4102444800 })}.x`;
async function rpc(u, fn, args) {
  const r = await fetch(`${BASE}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok(u), apikey: 'test-anon-key' }, body: JSON.stringify(args || {}) });
  const j = await r.json().catch(() => null); if (r.status >= 400) throw new Error(fn + ': ' + JSON.stringify(j)); return j;
}
const results = []; let failed = 0;
function ok(cond, name) { results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; }

async function getText(path) { const r = await fetch(BASE + path); return { status: r.status, text: await r.text() }; }
const og = (html, prop) => { const m = new RegExp(`<meta property="${prop}" content="([^"]*)"`).exec(html); return m ? m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&') : null; };
async function pageAs(browser, u, url, opts) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 1360, height: 900 } }, opts || {}));
  if (u) {
    const session = { access_token: tok(u), refresh_token: 'r', token_type: 'bearer', expires_in: 3600 * 24 * 365, expires_at: 4102444800,
      user: { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email || '', is_anonymous: u.anon, app_metadata: {}, user_metadata: {}, identities: [] } };
    await ctx.addInitScript(s => { localStorage.setItem('sb-127-auth-token', s); localStorage.setItem('ts-lang', 'zh'); }, JSON.stringify(session));
  }
  await ctx.addInitScript(() => localStorage.setItem('ts-lang', 'zh'));
  const page = await ctx.newPage();
  page.errors = [];
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|realtime|websocket|ERR_NAME|ERR_TUNNEL|404/i.test(m.text())) page.errors.push(m.text()); });
  page.on('pageerror', e => page.errors.push('pageerror: ' + e.message));
  await page.goto(BASE + url);
  await page.waitForSelector('#skel[hidden], #fatal:not([hidden])', { state: 'attached', timeout: 10000 });
  return page;
}
const today = new Date(); const iso = d => d.toISOString().slice(0, 10);

(async () => {
  // ---------- 準備資料 ----------
  psql(Object.values(U).map(u => `insert into auth.users (id, email, is_anonymous) values ('${u.id}', ${u.email ? `'${u.email}'` : 'null'}, ${u.anon});`).join('\n'));
  for (const u of Object.values(U)) await rpc(u, 'record_consent', { p_stats: true, p_marketing: false });
  const end = new Date(today.getTime() + 3 * 864e5);
  const tripId = await rpc(U.owner, 'create_trip', { p_title: '曼谷 4 日吃喝團', p_place_id: null, p_dest_text: '曼谷', p_start: iso(today), p_end: iso(end), p_party: null });
  const editTok = await rpc(U.owner, 'create_invite', { p_trip: tripId, p_kind: 'edit' });
  const viewTok = await rpc(U.owner, 'create_invite', { p_trip: tripId, p_kind: 'view' });
  await rpc(U.mate, 'join_invite', { p_token: editTok, p_nickname: 'Ken' });
  await rpc(U.viewer, 'join_invite', { p_token: viewTok, p_nickname: 'Amy' });

  const browser = await chromium.launch();
  // ---------- 1. 擁有者打開編輯器 ----------
  const p = await pageAs(browser, U.owner, `/editor.html?trip=${tripId}`);
  ok(await p.locator('.top h1').innerText() === '曼谷 4 日吃喝團', '1 標題正確');
  ok(await p.locator('.day[role=tab]').count() === 4, '1 四天分頁');
  ok(await p.locator('.empty-day').isVisible(), '1 空白天提示');
  ok(await p.locator('#sync').innerText().then(s => s.includes('已儲存')), '1 同步狀態：已儲存');
  ok(await p.locator('svg.ic use').count() > 10 && await p.evaluate(() => [...document.querySelectorAll('svg.ic use')].every(u => document.getElementById(u.getAttribute('href').slice(1)))), '1 所有圖示都有對應 SVG（不會空白）');

  // ---------- 2. 新增卡片＋編輯欄位 ----------
  await p.click('.dh [data-act=add]');
  await p.click('#addKinds [data-kind=food]');
  await p.fill('#addTitle', 'Jay Fai 蟹肉歐姆蛋');
  await p.click('#addOk');
  await p.waitForSelector('#itemDlg[open]');
  await p.fill('#f_start', '14:00'); await p.fill('#f_end', '15:30'); await p.check('#f_fixed');
  await p.selectOption('#f_cur', 'THB'); await p.fill('#f_min', '1000'); await p.fill('#f_max', '1500');
  await p.selectOption('#f_bstat', 'booked'); await p.fill('#f_code', 'JF-8890');
  await p.fill('#f_map', 'http://maps.example.com/x');
  await p.click('#itemSave');
  ok(await p.locator('#itemErr').isVisible() && (await p.locator('#itemErr').innerText()).includes('https://'), '2 非 https 網址被擋下');
  await p.fill('#f_map', 'https://maps.example.com/jayfai');
  await p.fill('#f_desc', '米其林一星路邊攤，排隊要早。');
  await p.click('#itemSave');
  await p.waitForSelector('#itemDlg:not([open])', { state: 'attached' });
  await p.waitForSelector('.pc h3:has-text("Jay Fai")');
  const c1 = p.locator('.pc').first();
  ok((await c1.locator('.time').innerText()).includes('14:00 – 15:30'), '2 卡片顯示時間');
  ok(await c1.locator('.lock').count() === 1, '2 固定時間鎖頭');
  ok((await c1.locator('.cost').innerText()).includes('THB 1,500'), '2 預估費用（取上限）');
  ok((await c1.innerText()).includes('JF-8890'), '2 成員看得到訂位代碼');
  ok(await c1.locator('.rs:has-text("已訂")').count() === 1, '2 已預約自動蓋「已訂」郵戳');
  ok(await c1.locator('a[data-out=map]').getAttribute('rel').then(r => r.includes('noopener')), '2 外部連結 noopener');

  // ---------- 3. 時間衝突 → 補交通 → 改建議時間 ----------
  await p.click('.addcard');
  await p.click('#addKinds [data-kind=activity]'); await p.fill('#addTitle', 'TOPKART 卡丁車'); await p.click('#addOk');
  await p.waitForSelector('#itemDlg[open]');
  await p.fill('#f_start', '15:30'); await p.fill('#f_end', '17:00'); await p.click('#itemSave');
  await p.waitForSelector('.pc.conf');
  ok((await p.locator('.pc.conf .conf-box').innerText()).includes('沒有交通時間'), '3 相鄰無交通 → 衝突');
  await p.click('.pc.conf [data-act=confTransport]');
  await p.waitForSelector('#addDlg[open]');
  ok(await p.locator('#addKinds [data-kind=transport]').getAttribute('aria-pressed') === 'true', '3 補交通預選交通類型');
  await p.fill('#addTitle', 'Grab 叫車'); await p.click('#addOk');
  await p.waitForSelector('#itemDlg[open]');
  await p.selectOption('#f_mode', 'taxi'); await p.fill('#f_dur', '20'); await p.click('#itemSave');
  await p.waitForSelector('#itemDlg:not([open])', { state: 'attached' });
  await p.waitForSelector('.tk:has-text("Grab")');
  const order = await p.locator('#main .pc h3, #main .tk b').allInnerTexts();
  ok(order[0].startsWith('Jay Fai') && order[1] === 'Grab 叫車' && order[2].startsWith('TOPKART'), '3 交通卡插在兩站之間');
  ok((await p.locator('.pc.conf .conf-box').innerText()).includes('20 分鐘'), '3 交通 20 分鐘仍不夠 → 衝突');
  await p.click('.pc.conf [data-act=confShift]');
  await p.waitForFunction(() => !document.querySelector('.pc.conf'));
  ok((await p.locator('.pc:has-text("TOPKART") .time').innerText()).includes('15:50 – 17:20'), '3 改為建議時間 15:50，保留停留時長');
  ok((await p.locator('aside').innerText()).includes('TOPKART'), '3 側欄時間軸更新');

  // ---------- 4. 行程設定 → 預算 ----------
  await p.click('#rail [data-act=settings]');
  await p.selectOption('#s_party', '4'); await p.selectOption('#s_cur', 'THB'); await p.fill('#s_cap', '3000');
  await p.click('#setSave'); await p.waitForSelector('#setDlg:not([open])', { state: 'attached' });
  await p.waitForSelector('aside .bar');
  const bud = await p.locator('aside').innerText();
  ok(bud.includes('以 4 人試算') && bud.includes('THB 1,500'), '4 預算以 4 人試算、每人 THB 1,500');
  ok(bud.includes('預估占預算 50%'), '4 預算上限占比 50%');
  await p.click('aside [data-act=unit][data-u=grp]');
  ok((await p.locator('aside .big').innerText()).includes('THB 6,000'), '4 切換整團 THB 6,000');

  // ---------- 5. 備忘、郵戳、去了沒、實際花費 ----------
  await p.fill('.pc:has-text("Jay Fai") .memo-add input', '記得帶現金');
  await p.press('.pc:has-text("Jay Fai") .memo-add input', 'Enter');
  await p.waitForSelector('.pc:has-text("Jay Fai") .memo .row:has-text("記得帶現金")');
  ok(true, '5 新增備忘');
  await p.click('.pc:has-text("TOPKART") [data-act=stampPick]');
  await p.fill('#ns_label', '要排隊'); await p.selectOption('#ns_ink', 'blue');
  await p.click('#newStamp button');
  await p.waitForSelector('#stampBody .picklist button:has-text("要排隊")');
  await p.click('#stampBody .picklist button:has-text("要排隊")');
  await p.waitForSelector('#stampBody .picklist button[aria-current=true]');
  await p.click('#stampDlg [data-act=closeDlg]');
  ok(await p.locator('.pc:has-text("TOPKART") .rs.custom[data-ink=blue]').count() === 1, '5 自訂郵戳蓋上');
  await p.click('.pc:has-text("Jay Fai") [data-act=visit][data-v=went]');
  await p.waitForSelector('.pc:has-text("Jay Fai") [data-v=went][aria-pressed=true]');
  await p.click('.pc:has-text("Jay Fai") [data-act=actual]');
  await p.fill('#acInput', '5200'); await p.click('#actualForm button.bd');
  await p.waitForSelector('.pc:has-text("Jay Fai") .visit:has-text("THB 5,200")');
  ok((await p.locator('.pc:has-text("Jay Fai") .cost').innerText()).includes('THB 1,500'), '5 實際花費不覆蓋預估');
  ok((await p.locator('aside').innerText()).includes('已記錄實際花費 THB 5,200'), '5 側欄顯示實際花費');

  // ---------- 6. 排序、複製、移到其他天、刪除 ----------
  await p.click('.pc:has-text("TOPKART") [data-act=up]');
  await p.waitForFunction(() => document.querySelectorAll('#main .pc h3, #main .tk b')[1].textContent.startsWith('TOPKART'));
  ok(true, '6 往上移');
  await p.click('.pc:has-text("Jay Fai") [data-act=dup]');
  await p.waitForFunction(() => document.querySelectorAll('#main .pc').length === 3);
  const dup = p.locator('.pc').nth(1);
  ok(!(await dup.innerText()).includes('JF-8890') && (await dup.locator('.st.todo').count()) === 1, '6 複製卡片：已預約→待預約、不帶訂位代碼');
  await dup.locator('[data-act=moveDay]').click();
  await p.click('#moveBody [data-act=moveTo] >> nth=1');
  await p.waitForFunction(() => document.querySelectorAll('#main .pc').length === 2);
  await p.click('.day[data-dix="1"]');
  ok(await p.locator('#main .pc').count() === 1, '6 移到 DAY 02');
  await p.click('.pc [data-act=del]'); await p.click('#cfOk');
  await p.waitForSelector('.empty-day');
  ok(true, '6 刪除卡片（確認框）');
  await p.click('.day[data-dix="0"]');

  // ---------- 7. 同欄位衝突（FR-15） ----------
  const items = await rpc(U.owner, 'get_trip', { p_trip: tripId }).then(d => d.items);
  const jf = items.find(i => i.title.startsWith('Jay Fai'));
  await p.click('.pc:has-text("Jay Fai") [data-act=edit]');
  await p.waitForSelector('#itemDlg[open]');
  await rpc(U.mate, 'update_item', { p_item: jf.id, p_patch: { title: 'Jay Fai（Ken 改）' }, p_base: jf.field_versions });
  await p.fill('#f_title', 'Jay Fai（我改）'); await p.fill('#f_desc', '改了說明');
  await p.click('#itemSave');
  await p.waitForSelector('#conflictNote .conflict-note');
  ok((await p.locator('#conflictNote').innerText()).includes('名稱'), '7 偵測到同欄位衝突並列出欄位');
  ok((await p.locator('#sync').innerText()).includes('衝突'), '7 同步狀態顯示衝突');
  let fresh = await rpc(U.owner, 'get_trip', { p_trip: tripId }).then(d => d.items.find(i => i.id === jf.id));
  ok(fresh.title === 'Jay Fai（Ken 改）' && fresh.extra.desc === '改了說明', '7 沒衝突的欄位已存，衝突欄位沒被覆蓋');
  await p.click('[data-act=useMine]');
  await p.waitForSelector('#itemDlg:not([open])', { state: 'attached' });
  fresh = await rpc(U.owner, 'get_trip', { p_trip: tripId }).then(d => d.items.find(i => i.id === jf.id));
  ok(fresh.title === 'Jay Fai（我改）', '7 選「用我的版本」後覆蓋');

  // ---------- 8. 天副標、新增一天、刪除一天 ----------
  await p.click('.dh [data-act=subtitle]');
  await p.fill('#subInput', '老城與河畔'); await p.press('#subInput', 'Enter');
  await p.waitForSelector('.dh .sub-edit:has-text("老城與河畔")');
  ok(true, '8 天副標');
  await p.click('.day.add');
  await p.waitForFunction(() => document.querySelectorAll('.day[role=tab]').length === 5);
  ok(await p.locator('.day[aria-selected=true]').innerText().then(s => s.includes('DAY 05')), '8 新增一天並切換過去');
  await p.click('#rail [data-act=settings]');
  await p.selectOption('#s_day', { index: 4 }); await p.click('[data-act=removeDay]'); await p.click('#cfOk');
  await p.waitForFunction(() => document.querySelectorAll('.day[role=tab]').length === 4);
  ok(true, '8 刪除一天');

  // ---------- 9. 離線排隊 ----------
  await p.context().setOffline(true);
  await p.fill('.pc:has-text("TOPKART") .memo-add input', '離線時寫的');
  await p.press('.pc:has-text("TOPKART") .memo-add input', 'Enter');
  await p.waitForSelector('#sync.offline');
  ok(true, '9 離線時顯示離線、修改排隊');
  await p.context().setOffline(false);
  await p.waitForSelector('.pc:has-text("TOPKART") .memo .row:has-text("離線時寫的")', { timeout: 8000 });
  ok(await p.locator('#sync.saved').count() === 1, '9 恢復連線自動送出');

  // ---------- 10. 分享設定：公開需同意 ----------
  await p.click('#rail [data-act=share]');
  await p.waitForSelector('#shareDlg[open]');
  ok(await p.locator('#shareBody .mem').count() === 3, '10 成員清單 3 人');
  await p.check('#shareBody input[value=public]');
  await p.uncheck('#pubAgree');
  await p.click('#shareSave');
  ok(await p.locator('#shareDlg[open]').count() === 1, '10 沒勾同意不能公開');
  await p.check('#pubAgree'); await p.click('#shareSave');
  await p.waitForSelector('#shareDlg:not([open])', { state: 'attached' });
  ok((await p.locator('.vis-chip').innerText()).includes('公開'), '10 公開範圍更新');
  await p.click('.top [data-act=invite]');
  await p.waitForSelector('#sheetDlg[open] .share-sheet');
  const invUrl = await p.locator('#sheetDlg .share-sheet').getAttribute('data-url');
  ok(new RegExp(`/i/${tripId}#t=[A-Za-z0-9_-]+$`).test(invUrl), '10 邀請網址格式 /i/<行程>#t=<邀請碼>');
  const wa = await p.locator('#sheetDlg [data-share=whatsapp]').getAttribute('href');
  ok(wa.startsWith('https://wa.me/?text=') && decodeURIComponent(wa).includes(invUrl), '10 WhatsApp 分享連結帶邀請網址');
  ok(await p.locator('#sheetDlg [data-share=line]').count() === 1 && await p.locator('#sheetDlg [data-share=telegram]').count() === 1, '10 LINE、Telegram 按鈕');
  await p.click('#sheetDlg [data-share=qr]');
  ok(await p.locator('#sheetDlg .sh-qr-img svg').count() === 1, '10 QR code（WeChat／當面掃）');
  await p.click('#sheetDlg [data-share=copy]');
  await p.waitForSelector('#toast.show:has-text("已複製編輯邀請")', { timeout: 5000 }).then(() => ok(true, '10 複製編輯邀請'), () => ok(false, '10 複製編輯邀請'));
  await p.click('#sheetDlg [data-act=closeDlg]');
  // 邀請預覽卡片（真的 Pages Function 程式）：私人行程也顯示建立者與行程名稱
  const invPrev = await getText(new URL(invUrl).pathname);
  ok(og(invPrev.text, 'og:title') === 'me 邀你一起編輯「曼谷 4 日吃喝團」' || /邀你一起編輯「曼谷 4 日吃喝團」/.test(og(invPrev.text, 'og:title')), '10 邀請預覽卡片標題含行程名稱 ' + og(invPrev.text, 'og:title'));
  ok(/曼谷 · 4 天/.test(og(invPrev.text, 'og:description')), '10 邀請預覽描述：目的地與天數 ' + og(invPrev.text, 'og:description'));
  ok(og(invPrev.text, 'og:image').endsWith('/assets/og-default.jpg'), '10 私人行程邀請不帶照片，用預設分享圖');

  // ---------- 11. 列印區包含全部天數 ----------
  await p.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  const pr = await p.locator('#printArea').innerText();
  ok(['DAY 1', 'DAY 2', 'DAY 3', 'DAY 4'].every(d => pr.includes(d)) && pr.includes('TOPKART') && !pr.includes('JF-8890'), '11 列印區含全部天數、不含訂位代碼');
  await p.screenshot({ path: `${SHOTS}/editor_owner_desktop.png`, fullPage: false });
  ok(p.errors.length === 0, '1-11 擁有者頁面沒有程式錯誤 ' + p.errors.join(' | '));

  // ---------- 12. 匿名旅伴（可編輯）----------
  const m = await pageAs(browser, U.mate, `/editor.html?trip=${tripId}`);
  ok((await m.locator('#banner').innerText()).includes('匿名加入'), '12 匿名旅伴看到綁定 Google 提示');
  ok(await m.locator('#rail [data-act=settings]').count() === 0 && await m.locator('.top [data-act=invite]').count() === 0, '12 匿名旅伴沒有設定與邀請');
  ok(await m.locator('.dh [data-act=add]').isVisible(), '12 匿名旅伴可以新增');
  ok((await m.locator('.pc:has-text("Jay Fai")').innerText()).includes('JF-8890'), '12 成員看得到訂位代碼');
  ok(m.errors.length === 0, '12 無程式錯誤 ' + m.errors.join(' | '));

  // ---------- 13. 僅檢視成員 ----------
  const v = await pageAs(browser, U.viewer, `/editor.html?trip=${tripId}`);
  ok((await v.locator('#banner').innerText()).includes('僅檢視'), '13 僅檢視提示');
  ok(await v.locator('.edit-only:visible').count() === 0, '13 看不到任何編輯按鈕');
  ok(await v.locator('.memo .row:has-text("記得帶現金")').count() === 1, '13 成員看得到備忘');

  // ---------- 14. 陌生人看公開行程 → 複製一份 ----------
  const s = await pageAs(browser, U.stranger, `/editor.html?trip=${tripId}&mode=read`);
  const sTxt = await s.locator('body').innerText();
  ok((await s.locator('#banner').innerText()).includes('公開的行程'), '14 公開行程唯讀提示');
  ok(!sTxt.includes('JF-8890') && !sTxt.includes('記得帶現金') && !sTxt.includes('5,200'), '14 訂位代碼、備忘、實際花費都被遮蔽');
  ok(await s.locator('.edit-only:visible').count() === 0, '14 沒有編輯按鈕');
  await s.click('[data-act=copyPublic]');
  await s.waitForURL(/editor\.html\?trip=(?!.*mode)/);
  await s.waitForSelector('#skel[hidden]', { state: 'attached' });
  ok(await s.locator('.dh [data-act=add]').isVisible() && await s.locator('#rail [data-act=settings]').count() === 1, '14 複製後成為新行程擁有者');
  ok(s.errors.length === 0, '14 無程式錯誤 ' + s.errors.join(' | '));

  // ---------- 14b. 資料表直接讀取不能繞過遮蔽 ----------
  const raw = await fetch(`${BASE}/rest/v1/trip_items?trip_id=eq.${tripId}`, { headers: { Authorization: 'Bearer ' + tok(U.stranger), apikey: 'test-anon-key' } }).then(r => r.json());
  const rawAnon = await fetch(`${BASE}/rest/v1/trip_items?trip_id=eq.${tripId}`, { headers: { Authorization: 'Bearer test-anon-key', apikey: 'test-anon-key' } }).then(r => r.json());
  ok(Array.isArray(raw) && raw.length === 0 && Array.isArray(rawAnon) && rawAnon.length === 0, '14b 非成員直接查資料表拿不到卡片（訂位代碼不會外洩）');

  // ---------- 14c. 公開行程預覽卡片＋照片 ----------
  const jfId = (await rpc(U.owner, 'get_trip', { p_trip: tripId })).items.find(i => i.title.startsWith('Jay Fai')).id;
  await rpc(U.owner, 'update_item', { p_item: jfId, p_patch: { extra: { photo_url: 'https://images.example.com/jayfai.jpg' } }, p_base: {} });
  const rd = await getText(`/t/${tripId}`);
  ok(og(rd.text, 'og:title') === '曼谷 4 日吃喝團' && og(rd.text, 'og:image') === 'https://images.example.com/jayfai.jpg', '14c 公開行程預覽：標題＋第一張照片');
  ok(!rd.text.includes('JF-8890') && !rd.text.includes('記得帶現金'), '14c 預覽頁不含敏感內容');

  // ---------- 14d. 檢舉：3 人檢舉 → 自動暫停公開 ----------
  const r1 = await pageAs(browser, U.stranger, `/editor.html?trip=${tripId}&mode=read`);
  await r1.click('#banner [data-act=report]');
  await r1.waitForSelector('#reportDlg[open]');
  await r1.check('#reportBody input[value=privacy]'); await r1.fill('#rNote', '有別人的電話');
  await r1.click('#reportSend');
  await r1.waitForSelector('#toast.show:has-text("已收到檢舉")').then(() => ok(true, '14d 檢舉送出'), () => ok(false, '14d 檢舉送出'));
  ok(await p.evaluate(() => 1) && (await rpc(U.owner, 'report_trip', { p_trip: tripId, p_category: 'spam' }).then(() => false, e => /is_member/.test(e.message))), '14d 成員不能檢舉自己的行程');
  await rpc(U.r2, 'report_trip', { p_trip: tripId, p_category: 'spam' });
  ok((await rpc(U.r2, 'public_trips', { p_sort: 'new' })).some(x => x.id === tripId), '14d 兩人檢舉時仍公開');
  await rpc(U.r3, 'report_trip', { p_trip: tripId, p_category: 'inappropriate', p_note: '測試' });
  ok(!(await rpc(U.r2, 'public_trips', { p_sort: 'new' })).some(x => x.id === tripId), '14d 第 3 人檢舉 → 從探索區下架');
  const held = await pageAs(browser, U.r2, `/editor.html?trip=${tripId}&mode=read`);
  ok((await held.locator('#fatal').innerText()).includes('沒有權限'), '14d 暫停期間非成員看不到');
  const heldPrev = await getText(`/t/${tripId}`);
  ok(og(heldPrev.text, 'og:title') === 'Travel Studio 旅遊手帳', '14d 暫停期間預覽卡片只顯示通用文字');
  await p.reload(); await p.waitForSelector('#skel[hidden]', { state: 'attached' });
  ok((await p.locator('#banner').innerText()).includes('暫停對外公開'), '14d 擁有者看到暫停提示，仍可編輯');
  const leakR = psql(`select count(*) from public.domain_events where props::text ~ '(有別人的電話|測試)';`);
  ok(leakR === '0', '14d 檢舉說明不寫進事件');
  psql(`update public.trips set held_at = null where id = '${tripId}'; update public.reports set status = 'rejected' where trip_id = '${tripId}';`);

  // ---------- 15. 改為私人 → 陌生人被擋 ----------
  await rpc(U.owner, 'set_visibility', { p_trip: tripId, p_visibility: 'private' });
  const s2 = await pageAs(browser, U.stranger, `/editor.html?trip=${tripId}&mode=read`);
  ok((await s2.locator('#fatal').innerText()).includes('沒有權限'), '15 私人行程擋下非成員');
  await rpc(U.owner, 'set_visibility', { p_trip: tripId, p_visibility: 'link' });
  const s3 = await pageAs(browser, null, `/editor.html?trip=${tripId}&mode=read`);
  ok((await s3.locator('#banner').innerText()).includes('分享給你') && await s3.locator('[data-act=copyPublic]').count() === 0, '15 「知道連結可看」：未登入可唯讀、不能複製');

  // ---------- 16. 撤銷邀請 → 透過連結加入的成員被移除 ----------
  await p.reload(); await p.waitForSelector('#skel[hidden]', { state: 'attached' });
  await p.click('#rail [data-act=share]'); await p.click('[data-act=revokeAll]'); await p.click('#cfOk');
  await p.waitForSelector('#toast:has-text("已撤銷")');
  ok((await p.locator('#toast').innerText()).includes('移除 2 位'), '16 撤銷後移除 2 位連結成員');
  const m2 = await pageAs(browser, U.mate, `/editor.html?trip=${tripId}`);
  ok(await m2.locator('#banner').innerText().then(t => t.includes('分享給你')) && await m2.locator('.edit-only:visible').count() === 0, '16 被移除的旅伴變成唯讀（行程為知道連結可看）');

  // ---------- 17. 英文介面、手機版 ----------
  await p.click('#rail [data-act=lang]');
  ok((await p.locator('.dh [data-act=add]').innerText()).includes('Add stop'), '17 切換英文');
  await p.click('#rail [data-act=lang]');
  const mob = await pageAs(browser, U.owner, `/editor.html?trip=${tripId}`, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const overflow = await mob.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok(overflow <= 0, '17 手機版沒有水平捲動（' + overflow + 'px）');
  ok(await mob.locator('#mnav').isVisible(), '17 手機底部導覽');
  await mob.screenshot({ path: `${SHOTS}/editor_owner_mobile.png`, fullPage: true });
  await mob.click('.pc:has-text("Jay Fai") [data-act=edit]');
  await mob.waitForSelector('#itemDlg[open]');
  const dlgW = await mob.evaluate(() => document.getElementById('itemDlg').getBoundingClientRect().width);
  ok(dlgW <= 390, '17 手機版編輯面板不超出螢幕');
  await mob.screenshot({ path: `${SHOTS}/editor_dialog_mobile.png` });

  // ---------- 18. 無效網址參數 ----------
  const bad = await pageAs(browser, U.owner, `/editor.html`);
  ok((await bad.locator('#fatal').innerText()).includes('找不到行程'), '18 沒有行程代碼顯示錯誤頁');

  // ---------- 18b. 404 頁 ----------
  const nf = await pageAs(browser, null, `/no-such-page`).catch(() => null);
  const nfr = await getText('/no-such-page');
  ok(nfr.status === 404 && nfr.text.includes('這一頁迷路了'), '18b 404 頁');

  // ---------- 18c. 邀請網址在瀏覽器裡轉到加入頁（邀請碼跟著帶過去） ----------
  const tok2 = await rpc(U.owner, 'create_invite', { p_trip: tripId, p_kind: 'edit' });
  const jctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await jctx.addInitScript(() => localStorage.setItem('ts-lang', 'zh'));
  const jp = await jctx.newPage();
  await jp.goto(`${BASE}/i/${tripId}#t=${tok2}`);
  await jp.waitForURL(/join\.html/);
  await jp.waitForSelector('#sheet h1');
  ok((await jp.locator('#sheet h1').innerText()).includes('曼谷 4 日吃喝團') && !jp.url().includes(tok2), '18c /i/ 轉到加入頁並讀到邀請（網址列不留邀請碼）');
  ok(await jp.locator('#acctJoin').count() === 1, '18c 加入頁有「已有帳號？登入後加入」');
  await jp.click('#acctJoin');
  await jp.waitForSelector('#authDlg[open]');
  const provs = await jp.locator('#authDlg .auth-btn').evaluateAll(b => b.map(x => x.dataset.auth));
  ok(JSON.stringify(provs) === '["google","apple","line","sms","email"]', '18c 一般瀏覽器：Google、Apple、LINE、手機、Email ' + provs);

  // ---------- 18d. Instagram 內建瀏覽器：不顯示 Google，Email 驗證碼登入 ----------
  const ig = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 345.0.0.31.89 (iPhone15,3; iOS 17_5; zh_TW; zh-Hant-TW)' });
  await ig.addInitScript(() => localStorage.setItem('ts-lang', 'zh'));
  const hp = await ig.newPage(); hp.errors = []; hp.on('pageerror', e => hp.errors.push(e.message));
  await hp.goto(BASE + '/');
  await hp.waitForSelector('#inappBar:not([hidden])');
  ok((await hp.locator('#inappBar').innerText()).includes('Instagram'), '18d 首頁偵測到 Instagram 內建瀏覽器');
  await hp.click('#loginBtn');
  await hp.waitForSelector('#authDlg[open]');
  const igProvs = await hp.locator('#authDlg .auth-btn').evaluateAll(b => b.map(x => x.dataset.auth));
  ok(!igProvs.includes('google') && ['apple', 'line', 'sms', 'email'].every(x => igProvs.includes(x)), '18d 內建瀏覽器隱藏 Google，保留 Apple／LINE／手機／Email ' + igProvs);
  await hp.click('#authDlg [data-auth=email]');
  await hp.fill('#authEmail', 'not-an-email'); await hp.click('#authDlg .auth-primary');
  ok((await hp.locator('#authDlg .auth-err').innerText()).includes('格式'), '18d Email 格式檢查');
  await hp.fill('#authEmail', 'Amy.HK@example.com'); await hp.click('#authDlg .auth-primary');
  await hp.waitForSelector('#authCode');
  ok((await hp.locator('#authDlg').innerText()).includes('amy.hk@example.com'), '18d 寄出驗證碼（Email 轉小寫）');
  await hp.fill('#authCode', '000000'); await hp.click('#authDlg .auth-primary');
  await hp.waitForSelector('#authDlg .auth-err:not([hidden])');
  ok((await hp.locator('#authDlg .auth-err').innerText()).includes('不正確'), '18d 錯誤驗證碼提示');
  await hp.fill('#authCode', '123456'); await hp.click('#authDlg .auth-primary');
  await hp.waitForSelector('#acctWrap:not([hidden])');
  ok((await hp.locator('#acctEmail').innerText()).includes('amy.hk@example.com'), '18d Email 驗證碼登入成功，不必離開 App');
  const prof = psql(`select display_name from public.profiles p join auth.users u on u.id = p.id where u.email = 'amy.hk@example.com';`);
  ok(prof === 'amy.hk', '18d 沒有名稱時用 Email 前綴當暱稱（' + prof + '）');
  ok(hp.errors.length === 0, '18d 無程式錯誤 ' + hp.errors.join(' | '));

  // ---------- 19. 事件紀錄不含自由文字 ----------
  const ev = psql(`select string_agg(distinct name, ',') from public.domain_events;`);
  const leak = psql(`select count(*) from public.domain_events where props::text ~ '(Jay Fai|TOPKART|記得帶現金|JF-8890)';`);
  ok(leak === '0', '19 事件不含使用者文字（' + ev + '）');

  await browser.close();
  console.log(results.join('\n'));
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log(results.join('\n')); console.error('CRASH', e); process.exit(2); });
