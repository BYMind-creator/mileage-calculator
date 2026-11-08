\set ON_ERROR_STOP 0
\pset tuples_only on
\pset format unaligned
insert into auth.users (id,email,is_anonymous,raw_user_meta_data) values
 ('11111111-1111-1111-1111-111111111111','owner@gmail.com',false,'{"full_name":"小明"}'),
 ('22222222-2222-2222-2222-222222222222',null,true,'{}'),
 ('33333333-3333-3333-3333-333333333333','stranger@gmail.com',false,'{"name":"路人"}');
create temp table ctx(k text primary key, v text); grant all on ctx to authenticated, anon;

\echo == 1 未同意就建立行程（應拒絕 consent_required）
set role authenticated; set request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","is_anonymous":false}';
select public.create_trip('', (select id from public.places where slug='bkk'), '曼谷', '2026-11-20', '2026-11-24', '4');
\echo == 2 同意後建立行程（5 天）
select public.record_consent(true,false);
insert into ctx values ('trip', public.create_trip('', (select id from public.places where slug='bkk'), '曼谷', '2026-11-20', '2026-11-24', '4'));
select title, days, members, role from public.my_trips();
\echo == 3 直接寫資料表（應被拒）
insert into public.trips(owner_id,title,destination_text,start_date,end_date) values (auth.uid(),'x','x','2026-01-01','2026-01-02');
update public.trips set title='hack';
\echo == 4 超過 30 天（應拒絕 too_many_days）
select public.create_trip('x', null, '巴黎', '2026-01-01', '2026-02-15', null);
\echo == 5 建立邀請
insert into ctx values ('tok', public.create_invite((select v::uuid from ctx where k='trip'),'edit'));
select length(v) > 20 from ctx where k='tok';
reset role;

\echo == 6 未登入的人預覽邀請
set role anon; set request.jwt.claims = '';
select title, owner_name, kind from public.invite_preview((select v from ctx where k='tok'));
select count(*) as anon_sees_trips from public.trips;
reset role;

\echo == 7 匿名受邀者：不能建立行程；同意後加入；看得到行程
set role authenticated; set request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","is_anonymous":true}';
select public.join_invite((select v from ctx where k='tok'), 'Amy');
select public.record_consent(false,false);
select public.create_trip('x', null, '台北', '2026-01-01', '2026-01-02', null);
select public.join_invite((select v from ctx where k='tok'), 'Amy') = (select v::uuid from ctx where k='trip') as joined;
select role, nickname from public.collaborators where user_id = auth.uid();
select count(*) as friend_sees_trip from public.trips;
select public.toggle_like((select v::uuid from ctx where k='trip'));
reset role;

\echo == 8 路人：看不到私人行程、無效邀請、不能複製私人行程
set role authenticated; set request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","is_anonymous":false}';
select public.record_consent(true,true);
select count(*) as stranger_sees from public.trips;
select public.join_invite('bad-token', 'x');
select public.copy_trip((select v::uuid from ctx where k='trip'));
reset role;

\echo == 9 擁有者公開行程（未同意授權應拒絕，同意後成功）
set role authenticated; set request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","is_anonymous":false}';
select public.set_visibility((select v::uuid from ctx where k='trip'), 'public', false);
select public.set_visibility((select v::uuid from ctx where k='trip'), 'public', true);
reset role;

\echo == 10 路人按心心、複製公開行程；探索列表
set role authenticated; set request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","is_anonymous":false}';
select public.toggle_like((select v::uuid from ctx where k='trip')) as liked;
insert into ctx values ('copy', public.copy_trip((select v::uuid from ctx where k='trip')));
select title, role from public.my_trips();
reset role;
set role anon; set request.jwt.claims = '';
select title, likes, author from public.public_trips('likes', 10);
reset role;

\echo == 11 前端事件白名單
set role authenticated; set request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","is_anonymous":false}';
select public.log_event('invite_copied', (select v::uuid from ctx where k='trip'), '{}');
select public.log_event('drop_tables', null, '{}');
\echo == 12 撤銷邀請：匿名朋友被移除
select public.revoke_invites((select v::uuid from ctx where k='trip')) as removed;
reset role;
set role authenticated; set request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","is_anonymous":true}';
select count(*) as friend_member_rows from public.collaborators;
reset role;

\echo == 13 匯出資料、刪除帳號
set role authenticated; set request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","is_anonymous":false}';
select jsonb_array_length(public.export_my_data()->'trips') as exported_trips;
select public.delete_my_account();
reset role;
select count(*) as stranger_left from auth.users where id='33333333-3333-3333-3333-333333333333';
select count(*) as copy_left from public.trips where id=(select v::uuid from ctx where k='copy');

\echo == 14 事件：不含 email、名稱；統計同意旗標
select name, user_id is not null as has_user, stats_ok, props from public.domain_events order by id;
select count(*) as events_with_pii from public.domain_events where props::text ~* '(@|小明|Amy|路人)';

\echo == 15 匿名者綁定 Google
update auth.users set is_anonymous=false, raw_user_meta_data='{"full_name":"Amy Chen"}' where id='22222222-2222-2222-2222-222222222222';
select is_anonymous, display_name from public.profiles where id='22222222-2222-2222-2222-222222222222';
\echo == 16 擁有者刪除行程
set role authenticated; set request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","is_anonymous":false}';
select public.delete_trip((select v::uuid from ctx where k='trip'));
select count(*) as owner_trips_after_delete from public.my_trips();
reset role;
