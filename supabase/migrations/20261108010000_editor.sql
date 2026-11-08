-- =====================================================================
-- Travel Studio · 行程編輯器指令（PRD V1.3 FR-05～FR-17、FR-40、FR-41）
-- 寫入一律走這裡；同時修改同一欄位時以「欄位級版本」偵測衝突，不靜默覆蓋（FR-15）
-- =====================================================================

-- 行程有變動就更新 updated_at（首頁依此排序）
create or replace function public.touch_trip(p_trip uuid) returns void
language sql security definer set search_path = '' as $$
  update public.trips set updated_at = now() where id = p_trip
$$;

create or replace function public.log_revision(p_trip uuid, p_op text, p_payload jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into public.trip_revisions (trip_id, actor_id, op, payload) values (p_trip, auth.uid(), p_op, coalesce(p_payload, '{}'))
$$;

-- 只接受 https 網址（FR-12）
create or replace function public.safe_url(p text) returns boolean
language sql immutable set search_path = '' as $$
  select p is null or p = '' or (p ~* '^https://[^\s<>"]+$' and char_length(p) <= 2000)
$$;

-- 卡片對外的樣子：非成員看不到確認碼、付款與實際花費（FR-18）
create or replace function public.item_json(i public.trip_items, p_member boolean) returns jsonb
language sql stable set search_path = '' as $$
  select case when p_member then to_jsonb(i)
              else to_jsonb(i) - 'booking_code' - 'paid_minor' - 'paid_by' - 'actual_minor' - 'remind_on' - 'created_by' end
$$;

-- ---------- 讀取整份行程 ----------
create or replace function public.get_trip(p_trip uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_role public.member_role := public.trip_role(p_trip); v_trip public.trips; v_member boolean;
begin
  select * into v_trip from public.trips where id = p_trip and deleted_at is null;
  if not found or (v_role is null and (v_trip.visibility = 'private' or v_trip.held_at is not null)) then   -- link：知道網址的人可唯讀；public：另外出現在探索區
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_member := v_role is not null;
  return jsonb_build_object(
    'role', v_role,
    'me', auth.uid(),
    'is_anonymous', public.is_anon(),
    'trip', to_jsonb(v_trip) - 'owner_id' - 'is_test',
    'place', (select jsonb_build_object('slug', p.slug, 'name_zh', p.name_zh, 'name_en', p.name_en, 'timezone', p.timezone)
              from public.places p where p.id = v_trip.destination_place_id),
    'days', (select coalesce(jsonb_agg(to_jsonb(d) order by d.day_index), '[]') from public.trip_days d where d.trip_id = p_trip),
    'items', (select coalesce(jsonb_agg(public.item_json(i, v_member) order by i.sort), '[]')
              from public.trip_items i where i.trip_id = p_trip and i.deleted_at is null),
    'memos', case when v_member then (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'item_id', m.item_id, 'body', m.body,
                    'created_at', m.created_at, 'author', c.nickname, 'mine', m.author_id = auth.uid()) order by m.created_at), '[]')
                    from public.item_memos m join public.trip_items i on i.id = m.item_id and i.trip_id = p_trip and i.deleted_at is null
                    left join public.collaborators c on c.trip_id = p_trip and c.user_id = m.author_id) else '[]'::jsonb end,
    'stamp_types', (select coalesce(jsonb_agg(to_jsonb(s) order by s.sort, s.label), '[]') from public.stamp_types s where s.trip_id = p_trip),
    'item_stamps', (select coalesce(jsonb_agg(jsonb_build_object('item_id', x.item_id, 'stamp_type_id', x.stamp_type_id, 'stamped_at', x.stamped_at)), '[]')
                    from public.item_stamps x join public.trip_items i on i.id = x.item_id and i.trip_id = p_trip and i.deleted_at is null),
    'members', case when v_member then (select coalesce(jsonb_agg(jsonb_build_object('user_id', c.user_id, 'nickname', c.nickname, 'role', c.role,
                    'is_me', c.user_id = auth.uid(), 'via_link', c.via_link is not null) order by c.joined_at), '[]')
                    from public.collaborators c where c.trip_id = p_trip)
               else (select coalesce(jsonb_agg(jsonb_build_object('nickname', c.nickname, 'role', c.role)), '[]')
                     from public.collaborators c where c.trip_id = p_trip and c.role = 'owner') end
  );
end $$;

-- ---------- 卡片 ----------
create or replace function public.add_item(p_trip uuid, p_day uuid, p_kind public.item_kind, p_title text, p_after uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_sort int; v_item public.trip_items; v_cur text;
begin
  perform public.require_member(p_trip, array['owner','editor']::public.member_role[]);
  if not exists (select 1 from public.trip_days where id = p_day and trip_id = p_trip) then raise exception 'invalid_day' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(p_title, ''))) not between 1 and 120 then raise exception 'invalid_title' using errcode = '22023'; end if;
  if (select count(*) from public.trip_items where trip_id = p_trip and deleted_at is null) >= 500 then raise exception 'too_many_items' using errcode = '22023'; end if;
  if p_after is not null then
    select sort + 1 into v_sort from public.trip_items where id = p_after and day_id = p_day and deleted_at is null;
  end if;
  if v_sort is null then
    select coalesce(max(sort), -1) + 1 into v_sort from public.trip_items where day_id = p_day and deleted_at is null;
  else
    update public.trip_items set sort = sort + 1 where day_id = p_day and sort >= v_sort;
  end if;
  select base_currency into v_cur from public.trips where id = p_trip;
  insert into public.trip_items (trip_id, day_id, kind, sort, title, currency, created_by, actor_type)
  values (p_trip, p_day, p_kind, v_sort, btrim(p_title), v_cur, auth.uid(), 'user')
  returning * into v_item;
  perform public.touch_trip(p_trip);
  perform public.log_revision(p_trip, 'add_item', jsonb_build_object('item', v_item.id));
  perform public.emit('item_added', p_trip, jsonb_build_object('kind', p_kind));
  return to_jsonb(v_item);
end $$;

-- 欄位級版本：p_base 帶上「編輯開始時看到的版本」；伺服器版本較新的欄位不覆蓋，回傳衝突
create or replace function public.update_item(p_item uuid, p_patch jsonb, p_base jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_old public.trip_items; v_new public.trip_items; v_apply jsonb := '{}'; v_conf jsonb := '[]';
  v_fv jsonb; k text; v_cur int; v_base int;
  allowed text[] := array['title','kind','start_time','end_time','is_fixed','currency','cost_basis','est_min_minor','est_max_minor',
                          'paid_minor','booking_status','booking_url','booking_code','remind_on','extra','end_day_id','place_id'];
begin
  select * into v_old from public.trip_items where id = p_item and deleted_at is null for update;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  perform public.require_member(v_old.trip_id, array['owner','editor']::public.member_role[]);
  v_fv := v_old.field_versions;
  for k in select jsonb_object_keys(coalesce(p_patch, '{}')) loop
    if not (k = any(allowed)) then raise exception 'field_not_allowed' using errcode = '22023'; end if;
    v_cur := coalesce((v_fv ->> k)::int, 0);
    v_base := (p_base ->> k)::int;
    if v_base is not null and v_cur > v_base then
      v_conf := v_conf || to_jsonb(k);
    else
      v_apply := v_apply || jsonb_build_object(k, p_patch -> k);
      v_fv := v_fv || jsonb_build_object(k, v_cur + 1);
    end if;
  end loop;

  v_new := jsonb_populate_record(v_old, v_apply);
  if char_length(btrim(coalesce(v_new.title, ''))) not between 1 and 120 then raise exception 'invalid_title' using errcode = '22023'; end if;
  if not (public.safe_url(v_new.booking_url) and public.safe_url(v_new.extra ->> 'map_url')
          and public.safe_url(v_new.extra ->> 'site_url') and public.safe_url(v_new.extra ->> 'photo_url')) then
    raise exception 'invalid_url' using errcode = '22023';
  end if;
  if coalesce(v_new.est_min_minor, 0) < 0 or coalesce(v_new.est_max_minor, 0) < 0 or coalesce(v_new.paid_minor, 0) < 0 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  if v_new.currency is not null and v_new.currency !~ '^[A-Z]{3}$' then raise exception 'invalid_currency' using errcode = '22023'; end if;
  if v_new.end_day_id is not null and not exists (select 1 from public.trip_days where id = v_new.end_day_id and trip_id = v_old.trip_id) then
    raise exception 'invalid_day' using errcode = '22023';
  end if;
  if pg_column_size(v_new.extra) > 8192 then raise exception 'extra_too_large' using errcode = '22023'; end if;

  update public.trip_items set
    title = btrim(v_new.title), kind = v_new.kind, start_time = v_new.start_time, end_time = v_new.end_time, is_fixed = v_new.is_fixed,
    currency = v_new.currency, cost_basis = v_new.cost_basis, est_min_minor = v_new.est_min_minor, est_max_minor = v_new.est_max_minor,
    paid_minor = v_new.paid_minor, booking_status = v_new.booking_status, booking_url = nullif(v_new.booking_url, ''),
    booking_code = nullif(v_new.booking_code, ''), remind_on = v_new.remind_on, extra = coalesce(v_new.extra, '{}'),
    end_day_id = v_new.end_day_id, place_id = v_new.place_id, field_versions = v_fv, updated_at = now()
  where id = p_item returning * into v_new;

  if v_apply ?| array['start_time','end_time'] then perform public.emit('item_time_set', v_old.trip_id, jsonb_build_object('kind', v_new.kind)); end if;
  if v_apply ?| array['est_min_minor','est_max_minor'] then perform public.emit('item_cost_set', v_old.trip_id, jsonb_build_object('kind', v_new.kind, 'currency', v_new.currency)); end if;
  if v_apply <> '{}' then
    perform public.touch_trip(v_old.trip_id);
    perform public.log_revision(v_old.trip_id, 'update_item', jsonb_build_object('item', p_item, 'fields', (select jsonb_agg(x) from jsonb_object_keys(v_apply) x)));
  end if;
  return jsonb_build_object('item', to_jsonb(v_new), 'conflicts', v_conf);
end $$;

create or replace function public.delete_item(p_item uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_trip uuid; v_kind public.item_kind;
begin
  select trip_id, kind into v_trip, v_kind from public.trip_items where id = p_item and deleted_at is null;
  if v_trip is null then raise exception 'not_found' using errcode = '22023'; end if;
  perform public.require_member(v_trip, array['owner','editor']::public.member_role[]);
  update public.trip_items set deleted_at = now(), updated_at = now() where id = p_item;
  perform public.touch_trip(v_trip);
  perform public.log_revision(v_trip, 'delete_item', jsonb_build_object('item', p_item));
  perform public.emit('item_removed', v_trip, jsonb_build_object('kind', v_kind));
end $$;

-- 移動：同一天上下移、或移到其他天（FR-05，手機不需拖曳）
create or replace function public.move_item(p_item uuid, p_day uuid, p_index int)
returns void language plpgsql security definer set search_path = '' as $$
declare v_it public.trip_items; v_ids uuid[];
begin
  select * into v_it from public.trip_items where id = p_item and deleted_at is null;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  perform public.require_member(v_it.trip_id, array['owner','editor']::public.member_role[]);
  if not exists (select 1 from public.trip_days where id = p_day and trip_id = v_it.trip_id) then raise exception 'invalid_day' using errcode = '22023'; end if;
  select coalesce(array_agg(id order by sort, created_at), '{}') into v_ids
    from public.trip_items where day_id = p_day and deleted_at is null and id <> p_item;
  p_index := greatest(0, least(coalesce(p_index, 0), coalesce(array_length(v_ids, 1), 0)));
  v_ids := v_ids[1:p_index] || p_item || v_ids[p_index + 1:];
  update public.trip_items i set sort = x.ord - 1, day_id = p_day, updated_at = case when i.id = p_item then now() else i.updated_at end
    from unnest(v_ids) with ordinality as x(id, ord) where i.id = x.id;
  if v_it.day_id <> p_day then
    update public.trip_items i set sort = x.ord - 1
      from (select id, row_number() over (order by sort, created_at) as ord from public.trip_items where day_id = v_it.day_id and deleted_at is null) x
      where i.id = x.id;
  end if;
  perform public.touch_trip(v_it.trip_id);
  perform public.log_revision(v_it.trip_id, 'move_item', jsonb_build_object('item', p_item, 'day', p_day, 'index', p_index));
  perform public.emit('item_moved', v_it.trip_id, jsonb_build_object('cross_day', v_it.day_id <> p_day));
end $$;

create or replace function public.duplicate_item(p_item uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_it public.trip_items; v_new public.trip_items;
begin
  select * into v_it from public.trip_items where id = p_item and deleted_at is null;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  perform public.require_member(v_it.trip_id, array['owner','editor']::public.member_role[]);
  update public.trip_items set sort = sort + 1 where day_id = v_it.day_id and sort > v_it.sort and deleted_at is null;
  insert into public.trip_items (trip_id, day_id, end_day_id, kind, sort, title, place_id, start_time, end_time, is_fixed, currency, cost_basis,
                                 est_min_minor, est_max_minor, booking_status, booking_url, extra, created_by, actor_type)
  values (v_it.trip_id, v_it.day_id, v_it.end_day_id, v_it.kind, v_it.sort + 1, v_it.title, v_it.place_id, v_it.start_time, v_it.end_time,
          v_it.is_fixed, v_it.currency, v_it.cost_basis, v_it.est_min_minor, v_it.est_max_minor,
          case when v_it.booking_status = 'booked' then 'todo'::public.booking_status else v_it.booking_status end,
          v_it.booking_url, v_it.extra, auth.uid(), 'user')
  returning * into v_new;
  perform public.touch_trip(v_it.trip_id);
  perform public.emit('item_added', v_it.trip_id, jsonb_build_object('kind', v_it.kind, 'duplicate', true));
  return to_jsonb(v_new);
end $$;

-- 旅途中到訪（FR-41）：出發日前一天起才能標記；實際花費不覆寫預估
create or replace function public.set_visit(p_item uuid, p_status public.visit_status, p_actual_minor bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_it public.trip_items; v_start date;
begin
  select * into v_it from public.trip_items where id = p_item and deleted_at is null;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  perform public.require_member(v_it.trip_id, array['owner','editor']::public.member_role[]);
  select start_date into v_start from public.trips where id = v_it.trip_id;
  if current_date < v_start - 1 then raise exception 'trip_not_started' using errcode = '22023'; end if;
  if p_actual_minor is not null and p_actual_minor < 0 then raise exception 'invalid_amount' using errcode = '22023'; end if;
  update public.trip_items set visit_status = p_status, actual_minor = coalesce(p_actual_minor, actual_minor), updated_at = now()
   where id = p_item returning * into v_it;
  perform public.touch_trip(v_it.trip_id);
  perform public.emit('item_visited', v_it.trip_id, jsonb_build_object('status', p_status, 'kind', v_it.kind, 'has_actual', p_actual_minor is not null));
  return to_jsonb(v_it);
end $$;

-- ---------- 備忘夾頁 ----------
create or replace function public.add_memo(p_item uuid, p_body text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_trip uuid; v_id uuid;
begin
  select trip_id into v_trip from public.trip_items where id = p_item and deleted_at is null;
  if v_trip is null then raise exception 'not_found' using errcode = '22023'; end if;
  perform public.require_member(v_trip, array['owner','editor']::public.member_role[]);
  if char_length(btrim(coalesce(p_body, ''))) not between 1 and 1000 then raise exception 'invalid_memo' using errcode = '22023'; end if;
  insert into public.item_memos (item_id, author_id, body) values (p_item, auth.uid(), btrim(p_body)) returning id into v_id;
  perform public.touch_trip(v_trip);
  perform public.emit('memo_added', v_trip, '{}');
  return v_id;
end $$;

create or replace function public.delete_memo(p_memo uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_trip uuid; v_author uuid;
begin
  select i.trip_id, m.author_id into v_trip, v_author from public.item_memos m join public.trip_items i on i.id = m.item_id where m.id = p_memo;
  if v_trip is null then raise exception 'not_found' using errcode = '22023'; end if;
  if v_author is distinct from auth.uid() then perform public.require_member(v_trip, array['owner']::public.member_role[]);
  else perform public.require_member(v_trip, array['owner','editor']::public.member_role[]); end if;
  delete from public.item_memos where id = p_memo;
end $$;

-- ---------- 行程設定與天數（FR-02） ----------
create or replace function public.update_trip(p_trip uuid, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_t public.trips; v_start date; v_n int;
begin
  perform public.require_member(p_trip, array['owner']::public.member_role[]);
  select * into v_t from public.trips where id = p_trip for update;
  if p_patch ? 'title' then
    if char_length(btrim(coalesce(p_patch ->> 'title', ''))) not between 1 and 80 then raise exception 'invalid_title' using errcode = '22023'; end if;
    v_t.title := btrim(p_patch ->> 'title');
  end if;
  if p_patch ? 'party_size' then
    if (p_patch ->> 'party_size') is not null and (p_patch ->> 'party_size') not in ('1','2','3','4','5','6','7-9','10+') then raise exception 'invalid_party' using errcode = '22023'; end if;
    v_t.party_size := p_patch ->> 'party_size';
  end if;
  if p_patch ? 'base_currency' then
    if (p_patch ->> 'base_currency') is not null and (p_patch ->> 'base_currency') !~ '^[A-Z]{3}$' then raise exception 'invalid_currency' using errcode = '22023'; end if;
    v_t.base_currency := p_patch ->> 'base_currency';
    update public.trip_items set currency = v_t.base_currency where trip_id = p_trip and currency is null;
  end if;
  if p_patch ? 'budget_cap_minor' then
    if (p_patch ->> 'budget_cap_minor')::bigint < 0 then raise exception 'invalid_amount' using errcode = '22023'; end if;
    v_t.budget_cap_minor := (p_patch ->> 'budget_cap_minor')::bigint;
  end if;
  if p_patch ? 'start_date' then
    v_start := (p_patch ->> 'start_date')::date;
    select count(*) into v_n from public.trip_days where trip_id = p_trip;
    v_t.start_date := v_start; v_t.end_date := v_start + v_n - 1;
    update public.trip_days set date = v_start + day_index - 1 where trip_id = p_trip;
  end if;
  update public.trips set title = v_t.title, party_size = v_t.party_size, base_currency = v_t.base_currency, budget_cap_minor = v_t.budget_cap_minor,
         start_date = v_t.start_date, end_date = v_t.end_date, updated_at = now()
   where id = p_trip;
  perform public.emit('trip_updated', p_trip, jsonb_build_object('fields', (select jsonb_agg(x) from jsonb_object_keys(p_patch) x)));
  return to_jsonb(v_t) - 'owner_id';
end $$;

create or replace function public.add_day(p_trip uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_n int; v_start date; v_day public.trip_days;
begin
  perform public.require_member(p_trip, array['owner','editor']::public.member_role[]);
  select count(*) into v_n from public.trip_days where trip_id = p_trip;
  if v_n >= 30 then raise exception 'too_many_days' using errcode = '22023'; end if;
  select start_date into v_start from public.trips where id = p_trip;
  insert into public.trip_days (trip_id, day_index, date) values (p_trip, v_n + 1, v_start + v_n) returning * into v_day;
  update public.trips set end_date = v_start + v_n, updated_at = now() where id = p_trip;
  perform public.emit('day_added', p_trip, '{}');
  return to_jsonb(v_day);
end $$;

create or replace function public.remove_day(p_trip uuid, p_day uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_n int; v_start date;
begin
  perform public.require_member(p_trip, array['owner']::public.member_role[]);
  select count(*) into v_n from public.trip_days where trip_id = p_trip;
  if v_n <= 1 then raise exception 'last_day' using errcode = '22023'; end if;
  if not exists (select 1 from public.trip_days where id = p_day and trip_id = p_trip) then raise exception 'invalid_day' using errcode = '22023'; end if;
  update public.trip_items set deleted_at = now() where day_id = p_day and deleted_at is null;
  update public.trip_items set end_day_id = null where end_day_id = p_day;
  delete from public.trip_days where id = p_day;
  select start_date into v_start from public.trips where id = p_trip;
  -- 先改成負數再改回來，避免重新編號時撞到 (trip_id, day_index) 唯一限制
  update public.trip_days set day_index = -day_index where trip_id = p_trip;
  update public.trip_days d set day_index = x.rn::smallint, date = v_start + x.rn::int - 1
    from (select id, row_number() over (order by day_index desc) as rn from public.trip_days where trip_id = p_trip) x where d.id = x.id;
  update public.trips set end_date = v_start + v_n - 2, updated_at = now() where id = p_trip;
  perform public.log_revision(p_trip, 'remove_day', jsonb_build_object('day', p_day));
  perform public.emit('day_removed', p_trip, '{}');
end $$;

create or replace function public.set_day_subtitle(p_day uuid, p_text text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_trip uuid;
begin
  select trip_id into v_trip from public.trip_days where id = p_day;
  perform public.require_member(v_trip, array['owner','editor']::public.member_role[]);
  if char_length(coalesce(p_text, '')) > 60 then raise exception 'too_long' using errcode = '22023'; end if;
  update public.trip_days set subtitle = nullif(btrim(p_text), '') where id = p_day;
  perform public.touch_trip(v_trip);
end $$;

-- ---------- 自訂郵戳（FR-40；連動型由訂位／付款欄位顯示，不在這裡） ----------
create or replace function public.create_stamp_type(p_trip uuid, p_label text, p_ink text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_s public.stamp_types;
begin
  perform public.require_member(p_trip, array['owner','editor']::public.member_role[]);
  if char_length(btrim(coalesce(p_label, ''))) not between 1 and 12 then raise exception 'invalid_label' using errcode = '22023'; end if;
  if p_ink not in ('red','brown','green','blue','purple') then raise exception 'invalid_ink' using errcode = '22023'; end if;
  if (select count(*) from public.stamp_types where trip_id = p_trip) >= 20 then raise exception 'too_many_stamps' using errcode = '22023'; end if;
  if exists (select 1 from public.stamp_types where trip_id = p_trip and lower(label) = lower(btrim(p_label))) then raise exception 'duplicate_label' using errcode = '22023'; end if;
  insert into public.stamp_types (trip_id, label, ink, sort) values
    (p_trip, btrim(p_label), p_ink, (select coalesce(max(sort), 0) + 1 from public.stamp_types where trip_id = p_trip))
  returning * into v_s;
  return to_jsonb(v_s);
end $$;

create or replace function public.delete_stamp_type(p_stamp uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_trip uuid;
begin
  select trip_id into v_trip from public.stamp_types where id = p_stamp;
  perform public.require_member(v_trip, array['owner','editor']::public.member_role[]);
  delete from public.stamp_types where id = p_stamp;
  perform public.log_revision(v_trip, 'delete_stamp_type', jsonb_build_object('stamp', p_stamp));
end $$;

create or replace function public.toggle_stamp(p_item uuid, p_stamp uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_trip uuid;
begin
  select trip_id into v_trip from public.trip_items where id = p_item and deleted_at is null;
  perform public.require_member(v_trip, array['owner','editor']::public.member_role[]);
  if not exists (select 1 from public.stamp_types where id = p_stamp and trip_id = v_trip) then raise exception 'invalid_stamp' using errcode = '22023'; end if;
  delete from public.item_stamps where item_id = p_item and stamp_type_id = p_stamp;
  if found then return false; end if;
  insert into public.item_stamps (item_id, stamp_type_id, stamped_by) values (p_item, p_stamp, auth.uid());
  perform public.touch_trip(v_trip);
  return true;
end $$;

-- ---------- 權限 ----------
revoke execute on function public.touch_trip(uuid), public.log_revision(uuid, text, jsonb), public.item_json(public.trip_items, boolean)
  from public, anon, authenticated;
grant execute on function public.safe_url(text) to anon, authenticated;
grant execute on function public.get_trip(uuid) to anon, authenticated;
grant execute on function
  public.add_item(uuid, uuid, public.item_kind, text, uuid), public.update_item(uuid, jsonb, jsonb), public.delete_item(uuid),
  public.move_item(uuid, uuid, int), public.duplicate_item(uuid), public.set_visit(uuid, public.visit_status, bigint),
  public.add_memo(uuid, text), public.delete_memo(uuid), public.update_trip(uuid, jsonb), public.add_day(uuid),
  public.remove_day(uuid, uuid), public.set_day_subtitle(uuid, text), public.create_stamp_type(uuid, text, text),
  public.delete_stamp_type(uuid), public.toggle_stamp(uuid, uuid)
  to authenticated;

-- ---------- 即時同步（FR-15）：Supabase 才有 supabase_realtime 發布 ----------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.trips, public.trip_days, public.trip_items,
      public.item_memos, public.item_stamps, public.stamp_types, public.collaborators;
  end if;
end $$;
