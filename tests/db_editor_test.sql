\set ON_ERROR_STOP 0
\pset tuples_only on
\pset format unaligned
insert into auth.users (id,email,is_anonymous,raw_user_meta_data) values
 ('11111111-1111-1111-1111-111111111111','owner@gmail.com',false,'{"full_name":"小明"}'),
 ('22222222-2222-2222-2222-222222222222',null,true,'{}'),
 ('33333333-3333-3333-3333-333333333333','viewer@gmail.com',false,'{"name":"小觀"}'),
 ('44444444-4444-4444-4444-444444444444','stranger@gmail.com',false,'{"name":"路人"}');
create temp table ctx(k text primary key, v text); grant all on ctx to authenticated, anon;
create or replace function pg_temp.c(k text) returns text language sql as $$ select v from ctx where ctx.k=c.k $$;

-- 擁有者建立行程（未來日期）與今天開始的行程
set role authenticated; set request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","is_anonymous":false}';
select public.record_consent(true,false) \g /dev/null
insert into ctx values ('trip', public.create_trip('曼谷吃喝', (select id from public.places where slug='bkk'), '曼谷', current_date+12, current_date+14, '4'));
insert into ctx values ('today', public.create_trip('今天出發', null, '台北', current_date, current_date+1, '2'));
insert into ctx values ('d1', (select id::text from public.trip_days where trip_id=pg_temp.c('trip')::uuid and day_index=1));
insert into ctx values ('d2', (select id::text from public.trip_days where trip_id=pg_temp.c('trip')::uuid and day_index=2));
\echo == 1 新增三張卡、在第一張後插入，排序正確
insert into ctx values ('a', public.add_item(pg_temp.c('trip')::uuid, pg_temp.c('d1')::uuid, 'place', '恰圖恰市集')->>'id');
insert into ctx values ('b', public.add_item(pg_temp.c('trip')::uuid, pg_temp.c('d1')::uuid, 'food', 'Jay Fai')->>'id');
insert into ctx values ('c', public.add_item(pg_temp.c('trip')::uuid, pg_temp.c('d1')::uuid, 'transport', 'Grab', pg_temp.c('a')::uuid)->>'id');
select string_agg(title, ' > ' order by sort) from public.trip_items where day_id=pg_temp.c('d1')::uuid and deleted_at is null;
\echo == 2 設定時間、費用、營業時間；不安全網址被擋
select (public.update_item(pg_temp.c('b')::uuid, '{"start_time":"14:00","end_time":"15:30","is_fixed":true,"est_min_minor":80000,"est_max_minor":100000,"currency":"THB","booking_status":"booked","booking_code":"JF-8821","extra":{"hours":{"open":"14:00","close":"23:00","closed":[1]},"map_url":"https://maps.app.goo.gl/x"}}', '{}')->'conflicts');
select public.update_item(pg_temp.c('b')::uuid, '{"booking_url":"javascript:alert(1)"}', '{}');
select public.update_item(pg_temp.c('b')::uuid, '{"owner_id":"x"}', '{}');
\echo == 3 建立邀請：編輯連結給匿名朋友、觀看連結給另一人
insert into ctx values ('edit_tok', public.create_invite(pg_temp.c('trip')::uuid,'edit'));
insert into ctx values ('view_tok', public.create_invite(pg_temp.c('trip')::uuid,'view'));
select public.update_item(pg_temp.c('a')::uuid, '{"title":"恰圖恰週末市集"}', '{"title":0}')->'conflicts' as owner_title_update;
reset role;

set role authenticated; set request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","is_anonymous":true}';
select public.record_consent(false,false) \g /dev/null
select public.join_invite(pg_temp.c('edit_tok'), 'Amy') \g /dev/null
\echo == 4 匿名編輯者：同一欄位用舊版本修改 → 衝突不覆蓋；其他欄位正常寫入
select public.update_item(pg_temp.c('a')::uuid, '{"title":"市集（Amy 版）","start_time":"10:00"}', '{"title":0,"start_time":0}')->'conflicts';
select title, start_time from public.trip_items where id=pg_temp.c('a')::uuid;
\echo == 5 匿名編輯者可新增卡片、加備忘、蓋自訂郵戳
insert into ctx values ('m1', public.add_memo(pg_temp.c('a')::uuid, '想找藤編包'));
select public.add_item(pg_temp.c('trip')::uuid, pg_temp.c('d2')::uuid, 'lodging', 'Riva Surya')->>'kind';
select public.toggle_stamp(pg_temp.c('a')::uuid, (select id from public.stamp_types where trip_id=pg_temp.c('trip')::uuid and label='必去'));
\echo == 6 匿名編輯者不能改行程設定、不能刪天
select public.update_trip(pg_temp.c('trip')::uuid, '{"title":"hack"}');
select public.remove_day(pg_temp.c('trip')::uuid, pg_temp.c('d2')::uuid);
reset role;

set role authenticated; set request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","is_anonymous":false}';
select public.record_consent(false,false) \g /dev/null
select public.join_invite(pg_temp.c('view_tok'), '小觀') \g /dev/null
\echo == 7 觀看者：讀得到（含確認碼），不能新增或修改
select g->>'role', (select e->>'booking_code' from jsonb_array_elements(g->'items') e where e->>'title'='Jay Fai') from (select public.get_trip(pg_temp.c('trip')::uuid) g) x;
select public.add_item(pg_temp.c('trip')::uuid, pg_temp.c('d1')::uuid, 'place', 'x');
select public.update_item(pg_temp.c('a')::uuid, '{"title":"x"}', '{}');
reset role;

\echo == 8 路人看私人行程被拒；公開後看得到但遮蔽確認碼、看不到備忘與成員
set role authenticated; set request.jwt.claims = '{"sub":"44444444-4444-4444-4444-444444444444","is_anonymous":false}';
select public.get_trip(pg_temp.c('trip')::uuid);
reset role;
set role authenticated; set request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","is_anonymous":false}';
select public.set_visibility(pg_temp.c('trip')::uuid, 'public', true) \g /dev/null
reset role;
set role anon; set request.jwt.claims = '';
select (select count(*) from jsonb_array_elements(g->'items') e where e ? 'booking_code') as code_fields,
       jsonb_array_length(g->'memos') as memos, jsonb_array_length(g->'members') as members_visible, g->>'role' as role
from (select public.get_trip(pg_temp.c('trip')::uuid) g) x;
reset role;

set role authenticated; set request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","is_anonymous":false}';
\echo == 9 跨日移動與排序
select public.move_item(pg_temp.c('c')::uuid, pg_temp.c('d2')::uuid, 0);
select string_agg(title||'#'||sort, ' > ' order by sort) from public.trip_items where day_id=pg_temp.c('d1')::uuid and deleted_at is null;
select string_agg(title||'#'||sort, ' > ' order by sort) from public.trip_items where day_id=pg_temp.c('d2')::uuid and deleted_at is null;
select public.move_item(pg_temp.c('b')::uuid, pg_temp.c('d1')::uuid, 0);
select string_agg(title, ' > ' order by sort) from public.trip_items where day_id=pg_temp.c('d1')::uuid and deleted_at is null;
\echo == 10 複製卡片：已訂改回待訂、不帶確認碼
select x->>'booking_status', x->>'booking_code' from (select public.duplicate_item(pg_temp.c('b')::uuid) x) y;
\echo == 11 到訪：未出發不能標；今天出發的可以
select public.set_visit(pg_temp.c('a')::uuid, 'went', 52000);
insert into ctx values ('t1', public.add_item(pg_temp.c('today')::uuid, (select id from public.trip_days where trip_id=pg_temp.c('today')::uuid and day_index=1), 'place', '鼎泰豐')->>'id');
select x->>'visit_status', x->>'actual_minor', x->>'est_max_minor' from (select public.set_visit(pg_temp.c('t1')::uuid, 'went', 52000) x) y;
\echo == 12 行程設定：改出發日 → 每天日期跟著移；設幣別 → 未設幣別的卡片補上
select (public.update_trip(pg_temp.c('trip')::uuid, jsonb_build_object('start_date', (current_date+20)::text, 'base_currency','THB','party_size','3','budget_cap_minor',1500000))->>'end_date')::date - current_date as end_offset;
select string_agg(day_index||':'||(date-current_date), ',' order by day_index) from public.trip_days where trip_id=pg_temp.c('trip')::uuid;
select count(*) as items_without_currency from public.trip_items where trip_id=pg_temp.c('trip')::uuid and currency is null and deleted_at is null;
\echo == 13 增加一天、刪掉第 2 天（含卡片）→ 重新編號
select (public.add_day(pg_temp.c('trip')::uuid)->>'day_index');
select public.remove_day(pg_temp.c('trip')::uuid, pg_temp.c('d2')::uuid);
select string_agg(day_index||':'||(date-current_date), ',' order by day_index), (select end_date-current_date from public.trips where id=pg_temp.c('trip')::uuid) from public.trip_days where trip_id=pg_temp.c('trip')::uuid;
\echo == 14 自訂郵戳：重名、墨色、上限
select public.create_stamp_type(pg_temp.c('trip')::uuid, '必吃', 'red')->>'label';
select public.create_stamp_type(pg_temp.c('trip')::uuid, '必吃', 'red');
select public.create_stamp_type(pg_temp.c('trip')::uuid, '好看', 'pink');
\echo == 15 備忘：別人的備忘只有擁有者能刪
select public.delete_memo(pg_temp.c('m1')::uuid);
select count(*) from public.item_memos;
\echo == 16 子標題、刪卡
select public.set_day_subtitle(pg_temp.c('d1')::uuid, '老城與河畔');
select public.delete_item(pg_temp.c('a')::uuid);
select jsonb_array_length(public.get_trip(pg_temp.c('trip')::uuid)->'items') as items_left, (select subtitle from public.trip_days where id=pg_temp.c('d1')::uuid);
reset role;
\echo == 17 事件不含自由文字
select name, props from public.domain_events where name like 'item%' or name like 'day%' or name='memo_added' order by id;
select count(*) as pii from public.domain_events where props::text ~ '(恰圖恰|Jay|藤編|Amy|小明|JF-)';
