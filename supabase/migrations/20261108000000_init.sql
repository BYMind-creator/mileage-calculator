-- =====================================================================
-- Travel Studio · 初始資料庫結構（對應 PRD V1.3 第 06、07、08 章）
-- 原則：
--   1. 所有人都是 auth.users（匿名受邀者也是），權限一律看 auth.uid()
--   2. 前端不直接寫資料表：DML 權限全部收回，寫入只走下方 RPC 指令
--   3. 每個指令寫入一筆 domain_events，不含 email、暱稱、自由文字
--   4. 預估與實際分欄；金額用整數最小單位＋幣別；時間帶時區
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- 列舉 ----------
create type public.trip_visibility as enum ('private','link','public');
create type public.member_role     as enum ('owner','editor','viewer');
create type public.actor_kind      as enum ('user','ai','system','partner');
create type public.item_kind       as enum ('place','food','activity','lodging','transport','note');
create type public.visit_status    as enum ('unknown','went','skipped');
create type public.booking_status  as enum ('none_needed','todo','booked');
create type public.cost_basis      as enum ('per_person','group');

-- ---------- 全站設定與功能開關（FR-30a） ----------
create table public.feature_flags (
  key        text primary key,
  enabled    boolean not null default false,
  value      jsonb,
  audience   jsonb,                -- 預留：指定對象、開放比例
  updated_at timestamptz not null default now()
);

-- ---------- 使用者 ----------
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url   text,
  locale       text check (locale in ('zh-Hant','en')),
  is_anonymous boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table public.privacy_consents (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  purpose       text not null check (purpose in ('service','stats','marketing')),
  granted       boolean not null,
  terms_version text not null,
  created_at    timestamptz not null default now()
);
create index on public.privacy_consents (user_id, purpose, created_at desc);

-- ---------- 地點主檔（自建；外部 ID 只當對照，PRD 02.5） ----------
create table public.places (
  id           uuid primary key default gen_random_uuid(),
  slug         text unique,
  level        text not null check (level in ('city','poi')),
  name_zh      text,
  name_en      text,
  country_code char(2),
  country_zh   text,
  country_en   text,
  aliases      text[] not null default '{}',
  lat          double precision,
  lng          double precision,
  timezone     text,
  source       text not null default 'internal' check (source in ('internal','user','osm','google','partner')),
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create table public.place_external_refs (
  place_id    uuid not null references public.places(id) on delete cascade,
  provider    text not null check (provider in ('google','osm')),
  external_id text not null,
  primary key (provider, external_id)
);

-- ---------- 行程 ----------
create table public.trips (
  id                   uuid primary key default gen_random_uuid(),
  owner_id             uuid not null references auth.users(id) on delete cascade,
  title                text not null check (char_length(title) between 1 and 80),
  destination_place_id uuid references public.places(id),
  destination_text     text not null check (char_length(destination_text) between 1 and 80),
  start_date           date not null,
  end_date             date not null,
  timezone             text,
  base_currency        char(3),
  party_size           text check (party_size in ('1','2','3','4','5','6','7-9','10+')),
  budget_cap_minor     bigint,
  visibility           public.trip_visibility not null default 'private',
  origin               text not null default 'blank' check (origin in ('blank','copy','platform','ai','import')),
  copied_from          uuid references public.trips(id) on delete set null,
  cover_url            text,
  schema_version       int not null default 1,
  is_test              boolean not null default false,
  published_at         timestamptz,
  held_at              timestamptz,                    -- 被多人檢舉時暫停對外公開，審核後解除
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,
  check (end_date >= start_date and end_date - start_date < 30)
);
create index on public.trips (owner_id);
create index on public.trips (visibility, published_at desc) where deleted_at is null;

create table public.trip_days (
  id        uuid primary key default gen_random_uuid(),
  trip_id   uuid not null references public.trips(id) on delete cascade,
  day_index smallint not null,
  date      date not null,
  subtitle  text,
  unique (trip_id, day_index)
);

create table public.trip_items (
  id             uuid primary key default gen_random_uuid(),
  trip_id        uuid not null references public.trips(id) on delete cascade,
  day_id         uuid not null references public.trip_days(id) on delete cascade,
  end_day_id     uuid references public.trip_days(id) on delete set null,   -- 住宿跨日
  kind           public.item_kind not null default 'place',
  sort           int not null default 0,
  title          text not null,
  place_id       uuid references public.places(id),
  start_time     time,
  end_time       time,
  is_fixed       boolean not null default false,
  currency       char(3),
  cost_basis     public.cost_basis not null default 'per_person',
  est_min_minor  bigint,
  est_max_minor  bigint,
  actual_minor   bigint,                         -- 實際花費，不覆寫預估（FR-41）
  paid_by        uuid references auth.users(id) on delete set null,   -- V2 分帳
  paid_minor     bigint,
  booking_status public.booking_status,
  booking_url    text,
  booking_code   text,                           -- 公開時遮蔽（FR-18）
  remind_on      date,
  visit_status   public.visit_status not null default 'unknown',
  extra          jsonb not null default '{}',    -- 各 kind 的專屬欄位
  field_versions jsonb not null default '{}',    -- 欄位級版本（同步模型）
  created_by     uuid references auth.users(id) on delete set null,
  actor_type     public.actor_kind not null default 'user',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);
create index on public.trip_items (trip_id, day_id, sort);

create table public.item_memos (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid not null references public.trip_items(id) on delete cascade,
  author_id  uuid references auth.users(id) on delete set null,
  body       text not null check (char_length(body) <= 1000),
  created_at timestamptz not null default now()
);

-- ---------- 協作 ----------
create table public.share_links (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid not null references public.trips(id) on delete cascade,
  kind       text not null check (kind in ('edit','view')),
  token_hash bytea not null unique,              -- 只存雜湊
  created_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.collaborators (
  trip_id   uuid not null references public.trips(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  role      public.member_role not null,
  nickname  text check (char_length(nickname) between 1 and 20),
  via_link  uuid references public.share_links(id) on delete set null,   -- 經由哪個邀請連結加入
  joined_at timestamptz not null default now(),
  primary key (trip_id, user_id)
);
create index on public.collaborators (user_id);

create table public.trip_revisions (
  id         bigint generated always as identity primary key,
  trip_id    uuid not null references public.trips(id) on delete cascade,
  actor_id   uuid references auth.users(id) on delete set null,
  op         text not null,
  payload    jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table public.trip_likes (
  trip_id    uuid not null references public.trips(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (trip_id, user_id)
);

-- ---------- 郵戳（連動型不另存，FR-40） ----------
create table public.stamp_types (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid not null references public.trips(id) on delete cascade,
  label      text not null check (char_length(label) <= 12),
  ink        text not null default 'red',
  sort       int not null default 0,
  is_default boolean not null default false,
  unique (trip_id, label)
);
create table public.item_stamps (
  item_id       uuid not null references public.trip_items(id) on delete cascade,
  stamp_type_id uuid not null references public.stamp_types(id) on delete cascade,
  stamped_by    uuid references auth.users(id) on delete set null,
  stamped_at    timestamptz not null default now(),
  primary key (item_id, stamp_type_id)
);

-- ---------- 外部連結轉址 /go/:id（FR-12） ----------
create table public.outbound_links (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid references public.trip_items(id) on delete cascade,
  url        text not null check (url ~* '^https://'),
  clicks     bigint not null default 0,
  created_at timestamptz not null default now()
);

-- ---------- 事件（PRD 02.7） ----------
create table public.domain_events (
  id           bigint generated always as identity primary key,
  name         text not null,
  trip_id      uuid references public.trips(id) on delete set null,
  user_id      uuid references auth.users(id) on delete set null,
  actor_type   public.actor_kind not null default 'user',
  is_anonymous boolean not null default false,
  stats_ok     boolean not null default false,   -- 統計同意；統計只取 true
  props        jsonb not null default '{}',
  created_at   timestamptz not null default now()
);
create index on public.domain_events (name, created_at);

-- ---------- 檢舉與後台（M4 使用，先建表） ----------
create table public.reports (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid references public.trips(id) on delete cascade,
  reporter_id uuid references auth.users(id) on delete set null,
  source_hash text,
  category    text not null check (category in ('inappropriate','copyright','privacy','spam','other')),
  note        text,
  status      text not null default 'open' check (status in ('open','in_review','removed','rejected')),
  created_at  timestamptz not null default now()
);
create table public.report_actions (
  id         bigint generated always as identity primary key,
  report_id  uuid not null references public.reports(id) on delete cascade,
  admin_id   uuid references auth.users(id) on delete set null,
  action     text not null,
  reason     text,
  created_at timestamptz not null default now()
);
create table public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role    text not null check (role in ('admin','moderator'))
);
create table public.audit_events (
  id         bigint generated always as identity primary key,
  admin_id   uuid references auth.users(id) on delete set null,
  action     text not null,
  target     text,
  reason     text,
  created_at timestamptz not null default now()
);

-- ---------- 預留空表（V1.5–V3，PRD 第 09 章） ----------
create table public.place_visits (id uuid primary key default gen_random_uuid(), item_id uuid references public.trip_items(id) on delete cascade, user_id uuid references auth.users(id) on delete cascade, visited_on date, created_at timestamptz not null default now());
create table public.reviews (id uuid primary key default gen_random_uuid(), place_id uuid references public.places(id) on delete cascade, user_id uuid references auth.users(id) on delete cascade, rating smallint check (rating between 1 and 5), body text, is_public boolean not null default false, created_at timestamptz not null default now());
create table public.expense_shares (item_id uuid references public.trip_items(id) on delete cascade, user_id uuid references auth.users(id) on delete cascade, share_minor bigint not null, primary key (item_id, user_id));
create table public.fx_rates (base char(3), quote char(3), rate numeric not null, as_of date, primary key (base, quote, as_of));
create table public.notification_prefs (user_id uuid primary key references auth.users(id) on delete cascade, channels jsonb not null default '{}');
create table public.entitlements (user_id uuid references auth.users(id) on delete cascade, feature text, valid_until timestamptz, primary key (user_id, feature));
create table public.usage_counters (user_id uuid references auth.users(id) on delete cascade, feature text, period date, used int not null default 0, primary key (user_id, feature, period));
create table public.subscriptions (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id) on delete cascade, provider text, status text, created_at timestamptz not null default now());
create table public.partners (id uuid primary key default gen_random_uuid(), name text not null, sponsored_label text, created_at timestamptz not null default now());

-- =====================================================================
-- 輔助函式
-- =====================================================================
create or replace function public.is_anon() returns boolean
language sql stable set search_path = '' as $$
  select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
$$;

create or replace function public.trip_role(p_trip uuid) returns public.member_role
language sql stable security definer set search_path = '' as $$
  select c.role from public.collaborators c
  join public.trips t on t.id = c.trip_id and t.deleted_at is null
  where c.trip_id = p_trip and c.user_id = auth.uid()
$$;

create or replace function public.current_terms_version() returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select value #>> '{}' from public.feature_flags where key = 'terms_version'), 'unset')
$$;

create or replace function public.has_service_consent(p_user uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.privacy_consents
    where user_id = p_user and purpose = 'service' and granted
      and terms_version = public.current_terms_version())
$$;

create or replace function public.stats_ok(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select granted from public.privacy_consents
                   where user_id = p_user and purpose = 'stats'
                   order by created_at desc limit 1), false)
$$;

-- 事件寫入：只收結構化屬性；呼叫端不得放入 email、暱稱、自由文字
create or replace function public.emit(p_name text, p_trip uuid, p_props jsonb default '{}')
returns void language sql security definer set search_path = '' as $$
  insert into public.domain_events (name, trip_id, user_id, actor_type, is_anonymous, stats_ok, props)
  values (p_name, p_trip, auth.uid(), 'user', public.is_anon(), public.stats_ok(auth.uid()), coalesce(p_props, '{}'))
$$;

create or replace function public.require_member(p_trip uuid, p_roles public.member_role[]) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not_signed_in' using errcode = '28000'; end if;
  if public.trip_role(p_trip) is null or not (public.trip_role(p_trip) = any(p_roles)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end $$;

create or replace function public.require_full_account() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not_signed_in' using errcode = '28000'; end if;
  if public.is_anon() then raise exception 'google_required' using errcode = '42501'; end if;
  if not public.has_service_consent() then raise exception 'consent_required' using errcode = '42501'; end if;
end $$;

-- ---------- 新使用者自動建立 profile；匿名者綁定帳號時同步 ----------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name, avatar_url, is_anonymous)
  values (new.id,
          coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', nullif(split_part(coalesce(new.email, ''), '@', 1), '')),
          new.raw_user_meta_data ->> 'avatar_url',
          coalesce(new.is_anonymous, false));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.handle_user_updated() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(old.is_anonymous, false) and not coalesce(new.is_anonymous, false) then
    update public.profiles
       set is_anonymous = false,
           display_name = coalesce(display_name, new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name',
                                   nullif(split_part(coalesce(new.email, ''), '@', 1), '')),
           avatar_url   = coalesce(avatar_url, new.raw_user_meta_data ->> 'avatar_url'),
           updated_at   = now()
     where id = new.id;
    insert into public.domain_events (name, user_id, is_anonymous, stats_ok)
    values ('identity_linked', new.id, false, public.stats_ok(new.id));
  end if;
  return new;
end $$;
create trigger on_auth_user_updated after update on auth.users
  for each row execute function public.handle_user_updated();

-- =====================================================================
-- RPC 指令層（PRD 7.1 第 2 點：所有寫入只走這裡）
-- =====================================================================

-- 同意紀錄（FR-43）：service 必要，stats / marketing 分項
create or replace function public.record_consent(p_stats boolean, p_marketing boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v text := public.current_terms_version();
begin
  if auth.uid() is null then raise exception 'not_signed_in' using errcode = '28000'; end if;
  insert into public.privacy_consents (user_id, purpose, granted, terms_version) values
    (auth.uid(), 'service', true, v),
    (auth.uid(), 'stats', coalesce(p_stats, false), v),
    (auth.uid(), 'marketing', coalesce(p_marketing, false), v);
  perform public.emit('consent_recorded', null, jsonb_build_object('stats', coalesce(p_stats,false), 'marketing', coalesce(p_marketing,false), 'terms_version', v));
end $$;

create or replace function public.my_consent()
returns table (purpose text, granted boolean, terms_version text, current_version text)
language sql stable security definer set search_path = '' as $$
  select distinct on (c.purpose) c.purpose, c.granted, c.terms_version, public.current_terms_version()
  from public.privacy_consents c where c.user_id = auth.uid()
  order by c.purpose, c.created_at desc
$$;

-- 建立行程（FR-01、FR-02）
create or replace function public.create_trip(
  p_title text, p_place_id uuid, p_dest_text text, p_start date, p_end date, p_party text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_trip uuid; v_days int; v_tz text; v_cc text; v_nick text; v_title text;
begin
  perform public.require_full_account();
  if p_dest_text is null or btrim(p_dest_text) = '' then raise exception 'destination_required' using errcode = '22023'; end if;
  if p_start is null or p_end is null or p_end < p_start then raise exception 'invalid_dates' using errcode = '22023'; end if;
  v_days := (p_end - p_start) + 1;
  if v_days > 30 then raise exception 'too_many_days' using errcode = '22023'; end if;
  if p_party is not null and p_party not in ('1','2','3','4','5','6','7-9','10+') then raise exception 'invalid_party' using errcode = '22023'; end if;

  select timezone, country_code into v_tz, v_cc from public.places where id = p_place_id;
  v_title := coalesce(nullif(btrim(p_title), ''), btrim(p_dest_text) || ' ' || v_days || ' 日');
  select coalesce(display_name, '旅人') into v_nick from public.profiles where id = auth.uid();

  insert into public.trips (owner_id, title, destination_place_id, destination_text, start_date, end_date, timezone, party_size)
  values (auth.uid(), left(v_title, 80), p_place_id, left(btrim(p_dest_text), 80), p_start, p_end, v_tz, p_party)
  returning id into v_trip;

  insert into public.trip_days (trip_id, day_index, date)
  select v_trip, g, p_start + (g - 1) from generate_series(1, v_days) g;

  insert into public.collaborators (trip_id, user_id, role, nickname)
  values (v_trip, auth.uid(), 'owner', left(v_nick, 20));

  insert into public.stamp_types (trip_id, label, ink, sort, is_default) values
    (v_trip, '必去', 'red', 1, true), (v_trip, '雨天備案', 'purple', 2, true);

  perform public.emit('trip_created', v_trip, jsonb_build_object(
    'days', v_days, 'party_size', p_party, 'matched', p_place_id is not null,
    'country_code', v_cc, 'start_month', extract(month from p_start)::int));
  return v_trip;
end $$;

-- 我的行程（首頁、我的行程頁）
create or replace function public.my_trips(p_limit int default 20)
returns table (
  id uuid, title text, destination_text text, place_slug text, start_date date, end_date date,
  days int, planned_days int, members int, visibility public.trip_visibility, role public.member_role,
  est_per_person_minor bigint, currency text, cover_url text, updated_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select t.id, t.title, t.destination_text, p.slug, t.start_date, t.end_date,
         (t.end_date - t.start_date + 1)::int,
         (select count(distinct i.day_id)::int from public.trip_items i where i.trip_id = t.id and i.deleted_at is null and i.kind <> 'note'),
         (select count(*)::int from public.collaborators c2 where c2.trip_id = t.id),
         t.visibility, c.role,
         (select sum(case when i.cost_basis = 'group' and nullif(t.party_size,'') ~ '^[0-9]+$'
                          then coalesce(i.est_max_minor, i.est_min_minor) / t.party_size::int
                          else coalesce(i.est_max_minor, i.est_min_minor) end)::bigint
            from public.trip_items i where i.trip_id = t.id and i.deleted_at is null),
         t.base_currency, t.cover_url, t.updated_at
  from public.collaborators c
  join public.trips t on t.id = c.trip_id and t.deleted_at is null
  left join public.places p on p.id = t.destination_place_id
  where c.user_id = auth.uid()
  order by t.updated_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 100)
$$;

-- 邀請連結（FR-13、FR-16）：回傳明碼一次，資料庫只存雜湊
create or replace function public.create_invite(p_trip uuid, p_kind text default 'edit')
returns text language plpgsql security definer set search_path = '' as $$
declare v_token text;
begin
  perform public.require_member(p_trip, array['owner']::public.member_role[]);
  if p_kind not in ('edit','view') then raise exception 'invalid_kind' using errcode = '22023'; end if;
  v_token := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/=', '-_');
  insert into public.share_links (trip_id, kind, token_hash, created_by)
  values (p_trip, p_kind, extensions.digest(v_token, 'sha256'), auth.uid());
  perform public.emit('invite_created', p_trip, jsonb_build_object('kind', p_kind));
  return v_token;
end $$;

create or replace function public.revoke_invites(p_trip uuid, p_remove_members boolean default true)
returns int language plpgsql security definer set search_path = '' as $$
declare v_removed int := 0;
begin
  perform public.require_member(p_trip, array['owner']::public.member_role[]);
  update public.share_links set revoked_at = now() where trip_id = p_trip and revoked_at is null;
  if p_remove_members then
    delete from public.collaborators
     where trip_id = p_trip and role <> 'owner'
       and via_link in (select id from public.share_links where trip_id = p_trip);
    get diagnostics v_removed = row_count;
  end if;
  perform public.emit('invites_revoked', p_trip, jsonb_build_object('removed', v_removed));
  return v_removed;
end $$;

create or replace function public.remove_collaborator(p_trip uuid, p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_member(p_trip, array['owner']::public.member_role[]);
  delete from public.collaborators where trip_id = p_trip and user_id = p_user and role <> 'owner';
  perform public.emit('collaborator_removed', p_trip, '{}');
end $$;

-- 可見性（FR-18）：改公開前必須同意公開內容授權（PRD 8.2）
create or replace function public.set_visibility(p_trip uuid, p_visibility public.trip_visibility, p_agree_public_license boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_member(p_trip, array['owner']::public.member_role[]);
  perform public.require_full_account();
  if p_visibility = 'public' and not coalesce(p_agree_public_license, false) then
    raise exception 'public_license_required' using errcode = '42501';
  end if;
  update public.trips
     set visibility = p_visibility,
         published_at = case when p_visibility = 'public' then coalesce(published_at, now()) else published_at end,
         updated_at = now()
   where id = p_trip;
  if p_visibility = 'public' then
    insert into public.privacy_consents (user_id, purpose, granted, terms_version)
    values (auth.uid(), 'stats', public.stats_ok(auth.uid()), public.current_terms_version());
  end if;
  perform public.emit('visibility_changed', p_trip, jsonb_build_object('visibility', p_visibility));
end $$;

-- 加入頁先看到的行程資訊（持有連結者才看得到）
create or replace function public.invite_preview(p_token text)
returns table (trip_id uuid, title text, start_date date, end_date date, owner_name text, kind text)
language sql stable security definer set search_path = '' as $$
  select t.id, t.title, t.start_date, t.end_date, c.nickname, s.kind
  from public.share_links s
  join public.trips t on t.id = s.trip_id and t.deleted_at is null
  left join public.collaborators c on c.trip_id = t.id and c.role = 'owner'
  where s.token_hash = extensions.digest(coalesce(p_token,''), 'sha256')
    and s.revoked_at is null and (s.expires_at is null or s.expires_at > now())
$$;

-- 受邀者加入（FR-14）：匿名或已登入皆可，須先完成服務同意
create or replace function public.join_invite(p_token text, p_nickname text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_link record; v_role public.member_role; v_nick text := btrim(coalesce(p_nickname, ''));
begin
  if auth.uid() is null then raise exception 'not_signed_in' using errcode = '28000'; end if;
  if not public.has_service_consent() then raise exception 'consent_required' using errcode = '42501'; end if;
  if char_length(v_nick) not between 1 and 20 then raise exception 'invalid_nickname' using errcode = '22023'; end if;
  select s.* into v_link from public.share_links s
   join public.trips t on t.id = s.trip_id and t.deleted_at is null
   where s.token_hash = extensions.digest(coalesce(p_token,''), 'sha256')
     and s.revoked_at is null and (s.expires_at is null or s.expires_at > now());
  if not found then raise exception 'invite_invalid' using errcode = '22023'; end if;
  v_role := case when v_link.kind = 'edit' then 'editor' else 'viewer' end;
  insert into public.collaborators (trip_id, user_id, role, nickname, via_link)
  values (v_link.trip_id, auth.uid(), v_role, v_nick, v_link.id)
  on conflict (trip_id, user_id) do update
    set nickname = excluded.nickname,
        via_link = coalesce(public.collaborators.via_link, excluded.via_link),
        role = case when public.collaborators.role = 'owner' then 'owner'::public.member_role
                    when public.collaborators.role = 'editor' or excluded.role = 'editor' then 'editor'::public.member_role
                    else 'viewer'::public.member_role end;
  perform public.emit('invite_joined', v_link.trip_id, jsonb_build_object('kind', v_link.kind));
  return v_link.trip_id;
end $$;

-- 刪除行程（軟刪除，公開行程同步下架）
create or replace function public.delete_trip(p_trip uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_member(p_trip, array['owner']::public.member_role[]);
  update public.trips set deleted_at = now(), visibility = 'private', updated_at = now() where id = p_trip;
  update public.share_links set revoked_at = now() where trip_id = p_trip and revoked_at is null;
  perform public.emit('trip_deleted', p_trip, '{}');
end $$;

-- 複製行程（FR-22）：不複製確認碼、付款、實際花費、到訪、備忘
create or replace function public.copy_trip(p_trip uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_src public.trips; v_new uuid; v_nick text;
begin
  perform public.require_full_account();
  select * into v_src from public.trips where id = p_trip and deleted_at is null;
  if not found or (public.trip_role(p_trip) is null and (v_src.visibility <> 'public' or v_src.held_at is not null)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select coalesce(display_name, '旅人') into v_nick from public.profiles where id = auth.uid();
  insert into public.trips (owner_id, title, destination_place_id, destination_text, start_date, end_date, timezone,
                            base_currency, party_size, origin, copied_from)
  values (auth.uid(), left(v_src.title, 80), v_src.destination_place_id, v_src.destination_text, v_src.start_date,
          v_src.end_date, v_src.timezone, v_src.base_currency, v_src.party_size, 'copy', v_src.id)
  returning id into v_new;
  insert into public.trip_days (trip_id, day_index, date, subtitle)
  select v_new, day_index, date, subtitle from public.trip_days where trip_id = p_trip;
  insert into public.trip_items (trip_id, day_id, end_day_id, kind, sort, title, place_id, start_time, end_time, is_fixed,
                                 currency, cost_basis, est_min_minor, est_max_minor, booking_status, booking_url, extra,
                                 created_by, actor_type)
  select v_new, nd.id, ne.id, i.kind, i.sort, i.title, i.place_id, i.start_time, i.end_time, i.is_fixed,
         i.currency, i.cost_basis, i.est_min_minor, i.est_max_minor,
         case when i.booking_status = 'booked' then 'todo'::public.booking_status else i.booking_status end,
         i.booking_url, i.extra, auth.uid(), 'user'
  from public.trip_items i
  join public.trip_days od on od.id = i.day_id
  join public.trip_days nd on nd.trip_id = v_new and nd.day_index = od.day_index
  left join public.trip_days oe on oe.id = i.end_day_id
  left join public.trip_days ne on ne.trip_id = v_new and ne.day_index = oe.day_index
  where i.trip_id = p_trip and i.deleted_at is null;
  insert into public.collaborators (trip_id, user_id, role, nickname) values (v_new, auth.uid(), 'owner', left(v_nick, 20));
  insert into public.stamp_types (trip_id, label, ink, sort, is_default)
  select v_new, label, ink, sort, is_default from public.stamp_types where trip_id = p_trip;
  perform public.emit('trip_copied', v_new, jsonb_build_object('from_public', v_src.visibility = 'public'));
  return v_new;
end $$;

-- 心心（FR-20）：需正式帳號（非匿名），每帳號每行程一票
create or replace function public.toggle_like(p_trip uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_liked boolean;
begin
  perform public.require_full_account();
  if not exists (select 1 from public.trips where id = p_trip and visibility = 'public' and deleted_at is null and held_at is null) then
    raise exception 'not_public' using errcode = '42501';
  end if;
  delete from public.trip_likes where trip_id = p_trip and user_id = auth.uid();
  if found then v_liked := false;
  else insert into public.trip_likes (trip_id, user_id) values (p_trip, auth.uid()); v_liked := true; end if;
  perform public.emit('trip_liked', p_trip, jsonb_build_object('liked', v_liked));
  return v_liked;
end $$;

-- 公開行程列表（探索區；只回公開欄位）
create or replace function public.public_trips(p_sort text default 'likes', p_limit int default 12)
returns table (id uuid, title text, destination_text text, place_slug text, days int, likes bigint, likes_week bigint,
               liked_by_me boolean, author text, published_at timestamptz, est_per_person_minor bigint, currency text, cover_url text)
language sql stable security definer set search_path = '' as $$
  select t.id, t.title, t.destination_text, p.slug, (t.end_date - t.start_date + 1)::int,
         (select count(*) from public.trip_likes l where l.trip_id = t.id),
         (select count(*) from public.trip_likes l where l.trip_id = t.id and l.created_at > now() - interval '7 days'),
         exists (select 1 from public.trip_likes l where l.trip_id = t.id and l.user_id = auth.uid()),
         (select c.nickname from public.collaborators c where c.trip_id = t.id and c.role = 'owner'),
         t.published_at,
         (select sum(coalesce(i.est_max_minor, i.est_min_minor))::bigint from public.trip_items i
           where i.trip_id = t.id and i.deleted_at is null and i.cost_basis = 'per_person'),
         t.base_currency, t.cover_url
  from public.trips t left join public.places p on p.id = t.destination_place_id
  where t.visibility = 'public' and t.deleted_at is null and t.held_at is null and not t.is_test
  order by case when p_sort = 'new' then extract(epoch from t.published_at) end desc nulls last,
           case when p_sort = 'week' then (select count(*) from public.trip_likes l where l.trip_id = t.id and l.created_at > now() - interval '7 days') end desc nulls last,
           (select count(*) from public.trip_likes l where l.trip_id = t.id) desc,
           t.published_at desc
  limit least(greatest(coalesce(p_limit, 12), 1), 50)
$$;

-- 前端事件（只接受白名單）
create or replace function public.log_event(p_name text, p_trip uuid default null, p_props jsonb default '{}')
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return; end if;
  if p_name not in ('invite_copied','share_opened','outbound_clicked','export_pdf','explore_viewed') then
    raise exception 'event_not_allowed' using errcode = '22023';
  end if;
  if pg_column_size(coalesce(p_props, '{}')) > 2048 then raise exception 'props_too_large' using errcode = '22023'; end if;
  if p_trip is not null and public.trip_role(p_trip) is null
     and not exists (select 1 from public.trips where id = p_trip and visibility <> 'private' and deleted_at is null) then
    return;
  end if;
  perform public.emit(p_name, p_trip, p_props);
end $$;

-- 匯出我的資料（FR-44）
create or replace function public.export_my_data()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'exported_at', now(),
    'profile', (select to_jsonb(p) - 'id' from public.profiles p where p.id = auth.uid()),
    'consents', (select coalesce(jsonb_agg(to_jsonb(c) - 'user_id' order by c.created_at), '[]') from public.privacy_consents c where c.user_id = auth.uid()),
    'trips', (select coalesce(jsonb_agg(jsonb_build_object(
                'trip', to_jsonb(t),
                'days', (select coalesce(jsonb_agg(to_jsonb(d) order by d.day_index), '[]') from public.trip_days d where d.trip_id = t.id),
                'items', (select coalesce(jsonb_agg(to_jsonb(i) order by i.sort), '[]') from public.trip_items i where i.trip_id = t.id and i.deleted_at is null))), '[]')
              from public.trips t where t.owner_id = auth.uid() and t.deleted_at is null))
$$;

-- 刪除帳號（FR-44）：立即刪除；行程隨 owner 刪除；事件保留但 user_id 設為 null
create or replace function public.delete_my_account()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not_signed_in' using errcode = '28000'; end if;
  perform public.emit('account_deleted', null, '{}');
  delete from auth.users where id = auth.uid();
end $$;

-- =====================================================================
-- RLS：讀取規則（寫入一律走 RPC）
-- =====================================================================
alter table public.feature_flags        enable row level security;
alter table public.profiles             enable row level security;
alter table public.privacy_consents     enable row level security;
alter table public.places               enable row level security;
alter table public.place_external_refs  enable row level security;
alter table public.trips                enable row level security;
alter table public.trip_days            enable row level security;
alter table public.trip_items           enable row level security;
alter table public.item_memos           enable row level security;
alter table public.collaborators        enable row level security;
alter table public.share_links          enable row level security;
alter table public.trip_revisions       enable row level security;
alter table public.trip_likes           enable row level security;
alter table public.stamp_types          enable row level security;
alter table public.item_stamps          enable row level security;
alter table public.outbound_links       enable row level security;
alter table public.domain_events        enable row level security;
alter table public.reports              enable row level security;
alter table public.report_actions       enable row level security;
alter table public.admin_users          enable row level security;
alter table public.audit_events         enable row level security;
alter table public.place_visits         enable row level security;
alter table public.reviews              enable row level security;
alter table public.expense_shares       enable row level security;
alter table public.fx_rates             enable row level security;
alter table public.notification_prefs   enable row level security;
alter table public.entitlements         enable row level security;
alter table public.usage_counters       enable row level security;
alter table public.subscriptions        enable row level security;
alter table public.partners             enable row level security;

create policy flags_read on public.feature_flags for select using (true);
create policy places_read on public.places for select using (true);

create policy profiles_read on public.profiles for select using (
  id = auth.uid() or exists (
    select 1 from public.collaborators a join public.collaborators b on a.trip_id = b.trip_id
    where a.user_id = auth.uid() and b.user_id = public.profiles.id));

create policy consents_read on public.privacy_consents for select using (user_id = auth.uid());

-- 行程內容只有成員能直接讀取資料表。非成員（公開、知道連結）一律走 get_trip／public_trips，
-- 由資料庫遮蔽訂位代碼、付款、實際花費、提醒日、建立者；否則直接查資料表就能繞過遮蔽。
create policy trips_read on public.trips for select using (
  deleted_at is null and public.trip_role(id) is not null);

create policy days_read on public.trip_days for select using (public.trip_role(trip_id) is not null);

create policy items_read on public.trip_items for select using (
  deleted_at is null and public.trip_role(trip_id) is not null);

create policy memos_read on public.item_memos for select using (
  exists (select 1 from public.trip_items i where i.id = item_id and public.trip_role(i.trip_id) is not null));

create policy collaborators_read on public.collaborators for select using (public.trip_role(trip_id) is not null);
create policy stamps_read on public.stamp_types for select using (public.trip_role(trip_id) is not null);
create policy item_stamps_read on public.item_stamps for select using (
  exists (select 1 from public.trip_items i where i.id = item_id and public.trip_role(i.trip_id) is not null));
create policy likes_read_own on public.trip_likes for select using (user_id = auth.uid());
-- 其餘資料表（share_links、domain_events、檢舉、後台、預留表）沒有讀取政策 = 前端一律讀不到

-- =====================================================================
-- 權限：收回所有直接寫入；函式只開放給需要的角色
-- =====================================================================
revoke insert, update, delete, truncate on all tables in schema public from anon, authenticated;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.is_anon(), public.trip_role(uuid), public.current_terms_version()
  to anon, authenticated;
grant execute on function public.invite_preview(text), public.public_trips(text, int) to anon, authenticated;
grant execute on function
  public.has_service_consent(uuid), public.record_consent(boolean, boolean), public.my_consent(),
  public.create_trip(text, uuid, text, date, date, text), public.my_trips(int),
  public.create_invite(uuid, text), public.revoke_invites(uuid, boolean), public.remove_collaborator(uuid, uuid),
  public.set_visibility(uuid, public.trip_visibility, boolean), public.join_invite(text, text),
  public.delete_trip(uuid), public.copy_trip(uuid), public.toggle_like(uuid),
  public.log_event(text, uuid, jsonb), public.export_my_data(), public.delete_my_account()
  to authenticated;
-- 注意：Supabase 的匿名使用者也屬於 authenticated 角色；
-- 需要正式帳號（Google、Apple、LINE、Email，非匿名）的指令在函式內以 require_full_account() 擋下。

-- =====================================================================
-- 初始設定與城市種子資料
-- =====================================================================
insert into public.feature_flags (key, enabled, value) values
  ('terms_version', true, '"2026-11-08"'),
  ('explore', false, null),
  ('require_login_to_create', true, null),
  ('invitee_anonymous', true, null),
  ('require_login_to_like', true, null);

insert into public.places (slug, level, name_zh, name_en, country_code, country_zh, country_en, aliases, timezone) values
  ('bkk','city','曼谷','Bangkok','TH','泰國','Thailand','{BKK,krung thep}','Asia/Bangkok'),
  ('cnx','city','清邁','Chiang Mai','TH','泰國','Thailand','{CNX}','Asia/Bangkok'),
  ('hkt','city','普吉島','Phuket','TH','泰國','Thailand','{HKT,布吉}','Asia/Bangkok'),
  ('tyo','city','東京','Tokyo','JP','日本','Japan','{TYO}','Asia/Tokyo'),
  ('osa','city','大阪','Osaka','JP','日本','Japan','{KIX}','Asia/Tokyo'),
  ('kyo','city','京都','Kyoto','JP','日本','Japan','{}','Asia/Tokyo'),
  ('fuk','city','福岡','Fukuoka','JP','日本','Japan','{FUK}','Asia/Tokyo'),
  ('spk','city','札幌','Sapporo','JP','日本','Japan','{北海道,CTS}','Asia/Tokyo'),
  ('oka','city','沖繩','Okinawa','JP','日本','Japan','{那霸,Naha,OKA}','Asia/Tokyo'),
  ('sel','city','首爾','Seoul','KR','韓國','South Korea','{ICN,漢城}','Asia/Seoul'),
  ('pus','city','釜山','Busan','KR','韓國','South Korea','{PUS}','Asia/Seoul'),
  ('sin','city','新加坡','Singapore','SG','新加坡','Singapore','{SIN,星加坡}','Asia/Singapore'),
  ('kul','city','吉隆坡','Kuala Lumpur','MY','馬來西亞','Malaysia','{KL,KUL}','Asia/Kuala_Lumpur'),
  ('dps','city','峇里島','Bali','ID','印尼','Indonesia','{巴里島,DPS}','Asia/Makassar'),
  ('sgn','city','胡志明市','Ho Chi Minh City','VN','越南','Vietnam','{西貢,Saigon,SGN}','Asia/Ho_Chi_Minh'),
  ('han','city','河內','Hanoi','VN','越南','Vietnam','{HAN}','Asia/Bangkok'),
  ('dad','city','峴港','Da Nang','VN','越南','Vietnam','{DAD}','Asia/Ho_Chi_Minh'),
  ('hkg','city','香港','Hong Kong','HK','香港','Hong Kong','{HK,HKG}','Asia/Hong_Kong'),
  ('mfm','city','澳門','Macau','MO','澳門','Macau','{MFM,Macao}','Asia/Macau'),
  ('tpe','city','台北','Taipei','TW','台灣','Taiwan','{臺北,TPE}','Asia/Taipei'),
  ('txg','city','台中','Taichung','TW','台灣','Taiwan','{臺中}','Asia/Taipei'),
  ('tnn','city','台南','Tainan','TW','台灣','Taiwan','{臺南}','Asia/Taipei'),
  ('khh','city','高雄','Kaohsiung','TW','台灣','Taiwan','{KHH}','Asia/Taipei'),
  ('hun','city','花蓮','Hualien','TW','台灣','Taiwan','{}','Asia/Taipei'),
  ('par','city','巴黎','Paris','FR','法國','France','{PAR,CDG}','Europe/Paris'),
  ('lon','city','倫敦','London','GB','英國','United Kingdom','{LON,LHR}','Europe/London'),
  ('nyc','city','紐約','New York','US','美國','United States','{NYC,JFK}','America/New_York');
