# Travel Studio · 正式版

靜態網站（Cloudflare Pages ＋ Pages Functions）＋ Supabase（PostgreSQL、Auth、Realtime、Storage）。不需要建置工具。

> 程式功能已完整（首頁、加入頁、行程編輯器、多平台分享、預覽卡片、檢舉、四種登入）。**對外上線前仍要完成「上線前必須完成」的法務與帳號項目**，以及在真的 Supabase／Cloudflare 上做一次部署後檢查。

## 目錄

```
travel-studio/
├── supabase/migrations/
│   ├── 20261108000000_init.sql            資料庫結構、權限（RLS）、帳號／邀請／公開等 RPC、城市種子資料
│   ├── 20261108010000_editor.sql          編輯器 RPC（讀取、卡片、衝突偵測、天數、郵戳、備忘）＋ Realtime
│   ├── 20261108020000_storage.sql         照片上傳 bucket 與權限
│   └── 20261108030000_reports_share.sql   檢舉（3 人檢舉自動暫停公開）、分享預覽卡片資料
├── functions/                             Cloudflare Pages Functions（分享預覽卡片）
│   ├── t/[id].js                          閱讀網址 /t/<行程ID>
│   └── i/[id].js                          邀請網址 /i/<行程ID>#t=<邀請碼>
├── lib/preview.js                         預覽卡片共用程式
├── tests/                                 本機測試（見文末「測試」）
└── web/                                   網站本體（Build output directory）
    ├── index.html  editor.html  join.html  404.html  privacy.html  terms.html
    ├── _headers          安全標頭（CSP、HSTS 等）
    ├── robots.txt
    ├── assets/
    │   ├── config.js     ← 部署前要填的設定（Supabase、登入方式、客服 Email、Turnstile）
    │   ├── home.js  join.js  editor.js          三個頁面的程式
    │   ├── auth.js       登入／綁定帳號對話框（Google、Apple、LINE、Email 驗證碼）
    │   ├── share.js      多平台分享（系統分享面板、LINE、WhatsApp、Telegram、Messenger、QR code）與 App 內建瀏覽器偵測
    │   ├── go.js         預覽頁轉址
    │   ├── i18n.js  i18n-editor.js              繁中／英文介面文字
    │   ├── site.css  editor.css  common.css     樣式（5 套配色）
    │   ├── og-default.jpg                       預設分享圖（1200×630）
    │   └── vendor/       supabase-js 2.45.4、qrcode-generator 1.4.4（MIT，自帶，不依賴 CDN）
    └── tools/icons.py    圖示工具：把 Tabler 圖示寫進頁面，斷網也會顯示
```

## 完成了什麼

| 項目 | 狀態 |
|---|---|
| 資料庫：30 張表、RLS、35 個 RPC、事件紀錄、同意紀錄、預留空表 | ✅ PostgreSQL 16 上跑過權限與流程測試 |
| 登入：Google、Apple、LINE、Email 驗證碼；手機簡訊驗證碼已做好但**預設關閉**；App 內建瀏覽器（LINE、FB、IG、Messenger、Threads、WeChat）自動隱藏會被擋的 Google；匿名旅伴可綁定任一方式並保留編輯紀錄 | ✅ 手機與 Email 驗證碼流程端對端測過；Google／Apple／LINE／簡訊服務需在真的環境驗證 |
| 分享：手機系統分享面板（WhatsApp、LINE、Messenger、IG、WeChat…）、LINE／WhatsApp／Telegram／Messenger 按鈕、複製連結、QR code | ✅ |
| 預覽卡片：WhatsApp、LINE、Messenger、Telegram、Threads、iMessage 貼連結會顯示行程名稱、目的地、天數與照片 | ✅ 真的 Function 程式在本機測過；WeChat 不支援一般網站預覽 |
| 首頁：登入、內建瀏覽器引導、首次同意、目的地清單、旅伴人數、建立行程、我的行程、邀請旅伴、複製與刪除行程、探索區（功能開關）、按心心、隱私設定、匯出資料、刪除帳號、中英切換、5 套配色 | ✅ |
| 加入頁：預覽邀請、暱稱、同意、匿名加入、已有帳號登入後加入、無效連結、已加入、CAPTCHA | ✅ |
| 行程編輯器：6 種卡片、時間衝突提醒、營業時間提醒、費用預估（每人／整團、多幣別）、預算上限、已付款、實際花費、預約與提醒、訂位代碼、照片上傳、連結、郵戳、備忘、去了沒、排序與移動、住宿跨日 | ✅ |
| 協作：同欄位衝突偵測、離線排隊自動補送、Realtime 即時更新（連不上改輪詢）、誰在線 | ✅ 衝突與離線已測；Realtime 需在真的 Supabase 驗證 |
| 分享設定：私人／知道連結可看／公開（需同意公開授權、敏感欄位由資料庫遮蔽）、編輯與僅檢視邀請、移除成員、撤銷全部邀請 | ✅ |
| 檢舉：非成員可檢舉公開或連結分享的行程；3 位不同的人檢舉 → 自動暫停公開等審核；成員照常編輯 | ✅ |
| 404 頁 | ✅ |
| 端對端測試 | ✅ 編輯器 97 項＋首頁與登入 18 項全過 |

## 部署步驟

### 1. Supabase

1. 建立專案。**資料區域會影響隱私權政策的跨境傳輸說明**，請先和律師確認。
2. 執行資料庫遷移：Supabase CLI `supabase db push`，或依檔名順序把 `supabase/migrations/` 裡的四份檔案分別貼到 SQL Editor 執行。
3. Project Settings → API：複製 Project URL 與 `anon` public key，填進 `web/assets/config.js`。**`service_role` 金鑰絕對不能放進前端。**
4. Authentication 設定（選單名稱可能隨 Supabase 版本調整）：
   - **Anonymous sign-ins**：啟用（受邀者匿名加入）。
   - **Manual linking**：啟用（匿名旅伴之後綁定帳號，保留同一個帳號）。
   - **CAPTCHA protection**：啟用並選 Cloudflare Turnstile，填 Secret key；網站金鑰填到 `config.js` 的 `TURNSTILE_SITE_KEY`。
   - **URL Configuration**：Site URL 填正式網址；Redirect URLs 加入 `https://你的網域/**`。
   - 四種登入方式見下一節。
5. **Realtime**：到 Database → Publications 確認 `trip_items`、`trip_days`、`trips`、`collaborators`、`item_memos`、`item_stamps`、`stamp_types` 都在 `supabase_realtime`。
6. **Storage**：確認 `trip-photos` bucket 存在；若遷移時 storage schema 尚未建立，再跑一次 `20261108020000_storage.sql`。

### 2. 登入方式

`config.js` 的 `AUTH_PROVIDERS` 決定畫面上出現哪些方式。**還沒設定好的先從清單拿掉**，免得使用者點了才出錯。

| 方式 | 設定 | 注意 |
|---|---|---|
| **Google** | Google Cloud 建 OAuth 用戶端（網頁應用程式），重新導向 URI `https://<專案代碼>.supabase.co/auth/v1/callback`；同意畫面只申請 `openid`、`email`、`profile`，填隱私權政策與服務條款網址後送審。Supabase 啟用 Google provider。 | App 內建瀏覽器會被 Google 擋，頁面已自動隱藏 |
| **Apple** | Apple Developer：建 Services ID（Sign in with Apple，網域填正式網域，Return URL 填上面的 Supabase callback）、建 Sign in with Apple 金鑰。Supabase 啟用 Apple provider，填 Services ID、Team ID、Key ID、金鑰。 | 使用者可選「隱藏我的 Email」，收到的是 Apple 轉寄地址；Apple 金鑰產生的 secret 每 6 個月要更新一次 |
| **LINE** | LINE Developers：建 LINE Login channel，Callback URL 填上面的 Supabase callback；在 OpenID Connect 申請 **Email 權限**（要附隱私權政策截圖）。Supabase → Authentication → Providers → 自訂 OAuth／OIDC，識別碼填 `line`（前端用 `custom:line`）。 | **需實測**。OIDC 模式填 issuer `https://access.line.me`；若驗證 ID token 失敗，改用 OAuth2 模式：authorize `https://access.line.me/oauth2/v2.1/authorize`、token `https://api.line.me/oauth2/v2.1/token`、userinfo `https://api.line.me/oauth2/v2.1/userinfo`，scope `openid profile email`。沒申請到 Email 時只拿得到 LINE 名稱 |
| **Email 驗證碼** | Supabase 啟用 Email provider；**一定要接自己的寄信服務**（Settings → Auth → SMTP，例如 Resend、SendGrid；內建寄信每小時只能寄幾封）。Email Templates 的「Magic Link」與「Change Email Address」內容要放 `{{ .Token }}`（6 位數驗證碼），驗證碼有效時間設 600 秒。 | 寄件網域要設定 SPF、DKIM，避免進垃圾郵件 |
| **手機驗證碼（預設關閉）** | 簡訊服務、CAPTCHA、每日送碼上限都設好後，`AUTH_PROVIDERS` 改成 `['google', 'apple', 'line', 'sms', 'email']`。Supabase 啟用 Phone provider，選簡訊服務（建議 Twilio Verify，台灣、香港、澳門都能送）。用 Twilio Verify 時簡訊內容與有效時間由 Twilio 管理；用一般 Twilio 簡訊時，Supabase 的簡訊範本要放 `{{ .Code }}`。到 Twilio 的地區設定開啟台灣、香港、澳門，並設定每日送碼上限防盜刷。 | 每則簡訊有費用，但只有建立行程的人和選擇綁定的朋友會用到，朋友加入不用登入。手機號碼只用來登入，畫面只顯示末四碼；隱私權政策要寫明。一定要開 CAPTCHA，避免被大量灌簡訊 |

同一個人用不同方式登入，**Email 相同才會自動合併成同一個帳號**；LINE 沒給 Email、Apple 隱藏 Email、用手機號碼登入時，會是另一個帳號。

**朋友共編不需要登入**：受邀的人點連結、輸入暱稱就能編輯；登入只用在建立行程、想綁定帳號的朋友、對公開行程按心心或複製。

### 3. Cloudflare Pages

1. **一定要用 Git 連線或 Wrangler 部署**（預覽卡片用的 Functions，在後台拖拉上傳時不會生效）：
   - Git 連線：Root directory 設為 `travel-studio`，Build command 留空，Build output directory 設為 `web`。
   - 或在 `travel-studio/` 資料夾執行 `npx wrangler pages deploy web --project-name 你的專案名稱`（會一起帶上 `functions/`）。
2. Settings → Environment variables（Production）：`SUPABASE_URL`、`SUPABASE_ANON_KEY`（和 `config.js` 相同）。
3. 綁定正式網域。`_headers` 會自動套用安全標頭；`/t/`、`/i/` 由 Functions 自己帶標頭。

### 4. 部署後檢查

- [ ] Chrome、Safari 開首頁 → 四種登入方式各登入一次 → 同意 → 建立行程 → 新增卡片、上傳一張照片
- [ ] 在 LINE、Instagram、Facebook、WeChat 裡打開首頁：看不到 Google、出現「用瀏覽器開啟」提示；用 LINE 或 Email 驗證碼能登入
- [ ] 「邀請旅伴」→ 分別傳到 WhatsApp、LINE、Messenger、Telegram：**對話裡出現預覽卡片（行程名稱＋圖）**；點開輸入暱稱加入
- [ ] 用 [Facebook 分享偵錯工具](https://developers.facebook.com/tools/debug/) 貼一個 `/t/` 網址，確認預覽卡片正確
- [ ] 兩支手機同時開著同一份行程：一邊改，另一邊幾秒內更新，右側顯示「N 人在線」
- [ ] 兩支手機同時改同一張卡片的名稱 → 後存的人看到衝突提示
- [ ] 手機開飛航模式寫一則備忘 → 關掉飛航模式後自動送出
- [ ] 分享設定改公開 → 無痕視窗打開閱讀網址：看不到訂位代碼與備忘；按「檢舉」能送出
- [ ] 撤銷全部邀請 → 受邀者重新整理後不能再編輯
- [ ] 打一個不存在的網址 → 出現 404 頁
- [ ] 列印／PDF：Chrome 與 Safari 各印一次
- [ ] 隱私設定 → 匯出資料、刪除帳號

## 上線前必須完成（擋住上線）

| # | 項目 | 誰 |
|---|---|---|
| 1 | 隱私權政策、服務條款正式條文（中英文）：要寫明各登入方式會取得哪些資料（手機驗證碼會收集手機號碼）（LINE 可能沒有 Email、Apple 可能是轉寄 Email）、檢舉處理方式；條文版本要和資料庫 `terms_version` 一致 | 律師 |
| 2 | 合約寫明資料所有權：誰是資料控管者、開發方能否使用去識別化統計、結束後資料處理 | 律師、AJ |
| 3 | 「統計」同意要預設勾選還是不勾（目前預設不勾，`config.js` 的 `STATS_DEFAULT_CHECKED`） | 律師 |
| 4 | Google OAuth 同意畫面審核、LINE Email 權限申請、Apple Sign in 設定 | 客戶帳號 |
| 5 | 寄信服務（SMTP）與寄件網域 SPF／DKIM；簡訊服務（Twilio Verify）帳號與預算上限 | 客戶帳號 |
| 6 | 公司名稱、客服 Email（`config.js` 的 `CONTACT_EMAIL`，檢舉對話框也會顯示） | 客戶 |
| 7 | 檢舉處理流程：誰看、多久內回覆、用下面的 SQL 處理 | 客戶營運 |
| 8 | 在 Supabase 實測 `delete_my_account`。若不允許函式刪除 `auth.users`，改用 Edge Function 搭配 `auth.admin.deleteUser` | 開發 |
| 9 | 在真的 Supabase 驗證 Realtime 與照片上傳；Realtime 連不上時會自動改成每 20 秒更新，不會壞但體驗較差 | 開發 |
| 10 | LINE 登入實測（見上方設定表的注意事項） | 開發 |

## 已知限制與取捨

| 項目 | 說明 |
|---|---|
| WeChat 預覽卡片 | WeChat 不讀一般網站的預覽標籤，貼連結只會顯示網址。分享時可用 QR code。要卡片需公眾號＋微信 JS-SDK，不在範圍內 |
| 邀請預覽會顯示私人行程名稱 | `/i/` 預覽卡片會顯示建立者暱稱、行程名稱、目的地與日期（不含照片與內容），讓收到邀請的人知道要加入什麼。代價是：知道行程 ID 的人（例如被移除的成員）看得到這些。行程 ID 是 122 位元隨機值，只出現在連結裡 |
| 「知道連結可看」 | 被移除的成員若記得閱讀網址，仍可唯讀瀏覽（遮蔽後的內容）；要完全擋掉請改回「私人」 |
| 照片網址 | `trip-photos` 是公開 bucket，檔名隨機無法列舉；拿到網址的人可以直接看照片 |
| 分享預覽快取 | 預覽頁快取 5 分鐘；各聊天 App 也會自己快取預覽，改名或改公開範圍後可能要過一陣子才更新 |

## 目前沒有做的（已預留，之後加不必大改）

| 項目 | 現況 | 預留 |
|---|---|---|
| 地點搜尋（FR-08） | 卡片手動輸入名稱、地圖連結、營業時間 | `place_id`、`places`、`place_external_refs` |
| 版本紀錄與還原（FR-17） | 每次修改都寫進 `trip_revisions`，還沒有還原介面 | 資料已在累積 |
| 拖曳排序 | 用「往上／往下／移到其他天」按鈕 | `move_item` 已支援任意位置 |
| 外部連結轉址統計 `/go/` | 直接開連結，同時記一筆 `outbound_clicked` 事件 | `outbound_links` 表 |
| 分帳 | 只記「已付金額」 | `paid_by` 欄位 |
| 後台（檢舉審核、功能開關、統計儀表板） | 用 SQL 操作 | `reports`、`report_actions`、`admin_users`、`audit_events` |

## 營運常用 SQL

```sql
-- 開啟探索區（公開行程 ≥20 份且涵蓋 ≥3 個目的地時）
update public.feature_flags set enabled = true, updated_at = now() where key = 'explore';

-- 條款改版：更新版本號後，使用者下次建立行程會重新看到同意畫面
update public.feature_flags set value = '"2027-01-01"', updated_at = now() where key = 'terms_version';

-- 待處理檢舉（含是否已自動暫停公開）
select r.created_at, r.category, r.note, t.title, t.visibility, t.held_at is not null as held, t.id as trip_id
from public.reports r join public.trips t on t.id = r.trip_id
where r.status in ('open', 'in_review') order by r.created_at;

-- 審核後：檢舉不成立 → 解除暫停
update public.trips set held_at = null where id = '<trip_id>';
update public.reports set status = 'rejected' where trip_id = '<trip_id>' and status in ('open', 'in_review');

-- 審核後：檢舉成立 → 改為私人（建立者與旅伴仍可編輯）
update public.trips set visibility = 'private', held_at = null where id = '<trip_id>';
update public.reports set status = 'removed' where trip_id = '<trip_id>' and status in ('open', 'in_review');

-- 資料層 KPI（只取同意統計的事件）
select date_trunc('week', created_at) as week, name, count(*)
from public.domain_events where stats_ok group by 1, 2 order by 1 desc, 3 desc;

-- 邀請從哪個 App 送出（WhatsApp、LINE、系統分享面板、複製、QR…）
select props ->> 'channel' as channel, props ->> 'kind' as kind, count(*)
from public.domain_events where name in ('share_opened', 'invite_copied') and stats_ok group by 1, 2 order by 3 desc;

-- 登入方式分布
select coalesce(raw_app_meta_data ->> 'provider', 'anonymous') as provider, count(*) from auth.users group by 1 order by 2 desc;

-- 目的地匹配率、團型分布
select round(100.0 * count(*) filter (where destination_place_id is not null) / nullif(count(*), 0), 1) as matched_pct
from public.trips where deleted_at is null and not is_test;
select coalesce(party_size, '未填') as party, count(*) from public.trips where deleted_at is null and not is_test group by 1 order by 2 desc;
```

## 新增圖示

```bash
npm pack @tabler/icons@3.19.0 && tar xzf tabler-icons-3.19.0.tgz
python3 web/tools/icons.py package/icons
```

在 HTML 寫 `<i class="ti ti-名稱"></i>`、在 JS 用 `ic('ti-名稱')`，再執行一次工具即可。

## 測試

`tests/` 是開發時用的測試，**不需要部署**。

| 檔案 | 內容 |
|---|---|
| `supabase_stub.sql` | 在一般 PostgreSQL 模擬 Supabase 的角色、`auth.users`、`auth.uid()` |
| `db_rpc_test.sql`、`db_editor_test.sql` | 資料庫權限與流程測試（直接用 psql 跑，看輸出） |
| `shim.py` | 模擬 Supabase API（RPC、資料表讀取、Storage、Email 驗證碼，測試碼固定 123456），讓真的 supabase-js 連到本機資料庫 |
| `fn-server.mjs` | 在本機跑真的 `functions/` 預覽卡片程式 |
| `editor-test.js` | 編輯器、分享、預覽卡片、檢舉、登入、資料遮蔽，97 項 |
| `home-test.js` | 首頁與加入頁回歸：Email 驗證碼登入後接續建立、邀請分享、內建瀏覽器偵測、手機驗證碼（香港、台灣號碼），18 項 |

```bash
# PostgreSQL 16 在 port 55432；建 tse2e 資料庫並依序執行 supabase_stub.sql 與四份遷移
pip install psycopg2-binary
python3 tests/shim.py web 8770 tse2e &
node tests/fn-server.mjs . 8771 http://127.0.0.1:8770 &
node tests/editor-test.js ./shots && node tests/home-test.js ./shots
```

## 設計原則

1. **統一身分**：匿名受邀者也是正式帳號，權限一律看 `auth.uid()`；登入規則是 `feature_flags` 的設定值。
2. **寫入只走 RPC**：資料表的 INSERT／UPDATE／DELETE 權限全部收回。
3. **讀取分兩層**：成員可直接讀資料表；非成員一律走 `get_trip`／`public_trips`／`share_preview`，由資料庫遮蔽訂位代碼、付款、實際花費、提醒日、備忘、成員名單。
4. **事件不含個資**：`domain_events` 只存結構化屬性（檢舉只記類別、分享只記管道）；統計只取 `stats_ok = true`。
5. **金額與時間**：整數最小單位＋幣別；預估與實際分欄；行程帶時區。
6. **地點主檔自建**：Google place_id 只當外部對照。
7. **不靜默覆蓋**：每個欄位有版本號；兩人同時改同一欄位時，後存的人看到衝突並自己決定。
8. **不綁單一平台**：登入、分享、預覽卡片都不限 Google 或 LINE；台灣與香港常用的 App 都能用。
