/* ===================================================================
   部署設定：上線前請換成正式值（見 README「上線前要填的設定」）
   SUPABASE_ANON_KEY 是公開金鑰，設計上就會出現在前端；
   真正的權限由資料庫的 RLS 與 RPC 控制。service_role 金鑰絕對不能放這裡。
   =================================================================== */
window.TS_CONFIG = {
  SUPABASE_URL: 'https://YOUR-PROJECT-REF.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR-SUPABASE-ANON-KEY',
  EDITOR_PATH: 'editor.html',          // 行程編輯器頁面
  CONTACT_EMAIL: 'support@example.com',
  TURNSTILE_SITE_KEY: '',              // Cloudflare Turnstile 網站金鑰；Supabase 開啟 CAPTCHA 時必填
  STATS_DEFAULT_CHECKED: false,         // 「統計」同意預設不勾；律師確認可改為 true 時再改
  // 登入方式（順序＝畫面上的順序）。還沒在 Supabase 設定好的先拿掉，免得使用者點了才出錯。
  // 可用：'google'、'apple'、'line'、'sms'（手機簡訊驗證碼，需在 Supabase 設好 Phone provider，例如 Twilio Verify）、'email'
  // 手機驗證碼先關閉：簡訊服務、CAPTCHA、每日送碼上限都設好後，改成 ['google', 'apple', 'line', 'sms', 'email']
  AUTH_PROVIDERS: ['google', 'apple', 'line', 'email'],
  LINE_PROVIDER_ID: 'custom:line'      // Supabase「自訂 OAuth／OIDC 登入」裡 LINE 的識別碼
};
