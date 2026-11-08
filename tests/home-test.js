// 首頁與加入頁回歸測試（真的 supabase-js ＋ 本機模擬 API ＋ 真的資料庫）
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:8770';
const SHOTS = process.argv[2] || '.';
const results = []; let failed = 0;
const ok = (c, n) => { results.push(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) failed++; };
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => localStorage.setItem('ts-lang', 'zh'));
  const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error' && !/fonts\.g|ERR_TUNNEL|404|realtime|websocket/i.test(m.text())) errs.push(m.text()); });
  await p.goto(BASE + '/');
  await p.waitForSelector('#ctaBtn');
  ok(await p.locator('#inappBar').isHidden(), '1 一般瀏覽器不顯示內建瀏覽器提示');
  ok((await p.locator('#loginBtn').innerText()).trim() === '登入', '1 頁首按鈕為「登入」（不限 Google）');
  // 先填表再建立 → 跳出登入 → Email 驗證碼 → 同意 → 自動建立並進入編輯器
  await p.fill('#dest', '曼'); await p.keyboard.press('ArrowDown'); await p.keyboard.press('Enter');
  await p.selectOption('#party', '4');
  await p.click('#ctaBtn');
  await p.waitForSelector('#authDlg[open]');
  ok((await p.locator('#authDlg .auth-btn').count()) === 5, '2 五種登入方式（含手機驗證碼）');
  await p.click('#authDlg [data-auth=email]');
  await p.fill('#authEmail', 'ken.tw@example.com'); await p.click('#authDlg .auth-primary');
  await p.fill('#authCode', '123456'); await p.click('#authDlg .auth-primary');
  await p.waitForSelector('#consentDlg[open]');
  ok(true, '2 登入後接續建立，先出現資料使用同意');
  await Promise.all([p.waitForURL(/editor\.html\?trip=/), p.click('#cAgree')]);
  await p.waitForSelector('#skel[hidden]', { state: 'attached' });
  ok((await p.locator('.top h1').innerText()).includes('曼谷'), '2 建立行程並進入編輯器');
  // 回首頁：邀請面板改成多平台分享
  await p.goto(BASE + '/#mine');
  await p.waitForSelector('[data-target=invPanel]');
  await p.click('[data-target=invPanel]');
  await p.waitForSelector('#invPanel .share-sheet');
  const url = await p.locator('#invPanel .share-sheet').getAttribute('data-url');
  ok(/\/i\/[0-9a-f-]{36}#t=/.test(url), '3 首頁邀請改用 /i/ 預覽網址');
  const chans = await p.locator('#invPanel [data-share]').evaluateAll(x => x.map(e => e.dataset.share));
  ok(['line', 'whatsapp', 'telegram', 'copy', 'qr'].every(c => chans.includes(c)), '3 LINE／WhatsApp／Telegram／複製／QR ' + chans);
  await p.click('#invPanel [data-share=copy]');
  await p.waitForSelector('#toast.show').then(() => ok(true, '3 複製邀請提示'), () => ok(false, '3 複製邀請提示'));
  await p.screenshot({ path: `${SHOTS}/home_invite.png` });
  ok(errs.length === 0, '4 首頁沒有程式錯誤 ' + errs.join(' | '));

  // LINE 內建瀏覽器：首頁提示可以一鍵用瀏覽器開啟
  const line = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.19.0' });
  await line.addInitScript(() => localStorage.setItem('ts-lang', 'zh'));
  const lp = await line.newPage(); await lp.goto(BASE + '/');
  await lp.waitForSelector('#inappBar:not([hidden])');
  ok((await lp.locator('#inappOpen').getAttribute('href')).includes('openExternalBrowser=1'), '5 LINE：一鍵用瀏覽器開啟');
  const fb = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/480.0.0.0;]' });
  await fb.addInitScript(() => localStorage.setItem('ts-lang', 'zh'));
  const fp = await fb.newPage(); await fp.goto(BASE + '/');
  await fp.waitForSelector('#inappBar:not([hidden])');
  ok((await fp.locator('#inappOpen').getAttribute('href')).startsWith('intent://'), '5 Android Facebook：用 Chrome 開啟');
  await fp.screenshot({ path: `${SHOTS}/home_inapp_fb.png` });
  await fp.click('#loginBtn'); await fp.waitForSelector('#authDlg[open]');
  await fp.screenshot({ path: `${SHOTS}/login_inapp_fb.png` });
  ok(!(await fp.locator('#authDlg [data-auth=google]').count()), '5 Facebook 內不顯示 Google');
  // 手機驗證碼（香港號碼）
  const fs = require('fs'), last = () => JSON.parse(fs.readFileSync(__dirname + '/storage/last_otp.json', 'utf8'));
  ok(!(await fp.locator('#authDlg [data-auth=whatsapp]').count()), '6 沒有 WhatsApp 選項');
  await fp.click('#authDlg [data-auth=sms]');
  await fp.selectOption('#authCc', '+852'); await fp.fill('#authPhone', '123'); await fp.click('#authDlg .auth-primary');
  ok((await fp.locator('#authDlg .auth-err').innerText()).includes('格式'), '6 手機號碼格式檢查');
  await fp.fill('#authPhone', '9123 4567'); await fp.click('#authDlg .auth-primary');
  await fp.waitForSelector('#authDlg [data-form=pcode]');
  ok(last().phone === '+85291234567' && last().channel === 'sms', '6 用簡訊送碼到 +852 號碼 ' + JSON.stringify(last()));
  ok((await fp.locator('#authDlg').innerText()).includes('+852 9123 4567'), '6 顯示送到哪個號碼');
  await fp.fill('#authCode', '123456'); await fp.click('#authDlg .auth-primary');
  await fp.waitForSelector('#acctWrap:not([hidden])');
  ok((await fp.locator('#acctEmail').innerText()).includes('4567') && !(await fp.locator('body').innerText()).includes('91234567'), '6 手機驗證碼登入成功，畫面只顯示末四碼');
  // 台灣號碼：0912… 自動去掉開頭的 0
  const tw = await b.newContext({ viewport: { width: 390, height: 844 } });
  await tw.addInitScript(() => localStorage.setItem('ts-lang', 'zh'));
  const tp = await tw.newPage(); await tp.goto(BASE + '/'); await tp.click('#loginBtn'); await tp.waitForSelector('#authDlg[open]');
  await tp.click('#authDlg [data-auth=sms]'); await tp.selectOption('#authCc', '+886'); await tp.fill('#authPhone', '0912-345-678'); await tp.click('#authDlg .auth-primary');
  await tp.waitForSelector('#authDlg [data-form=pcode]');
  ok(last().phone === '+886912345678' && (await tp.locator('#authDlg').innerText()).includes('+886 912 345 678'), '6 台灣號碼 0912-345-678 → +886912345678，顯示 +886 912 345 678');
  await tp.screenshot({ path: `${SHOTS}/login_phone_code.png` });

  await b.close();
  console.log(results.join('\n')); console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log(results.join('\n')); console.error('CRASH', e); process.exit(2); });
