-- =====================================================================
-- 檢舉（FR-21）與分享預覽卡片
-- =====================================================================

-- ---------- 檢舉 ----------
-- 誰可以檢舉：任何已登入的帳號（含匿名旅伴），對象是自己看得到的「公開」或「知道連結可看」行程。
-- 同一人對同一行程只算一筆（再送會更新類別與說明）；每人每天最多 10 筆。
-- 3 位不同的人檢舉且尚未處理 → 自動暫停對外公開（held_at），等審核。成員仍可正常編輯。
create unique index if not exists reports_one_open_per_reporter
  on public.reports (trip_id, reporter_id) where status in ('open', 'in_review');

create or replace function public.report_trip(p_trip uuid, p_category text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_trip public.trips; v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_n int; v_held boolean := false;
begin
  if auth.uid() is null then raise exception 'not_signed_in' using errcode = '28000'; end if;
  if p_category not in ('inappropriate','copyright','privacy','spam','other') then raise exception 'invalid_category' using errcode = '22023'; end if;
  if char_length(coalesce(v_note, '')) > 500 then raise exception 'too_long' using errcode = '22023'; end if;
  select * into v_trip from public.trips where id = p_trip and deleted_at is null;
  if not found or v_trip.visibility = 'private' then raise exception 'not_found' using errcode = '22023'; end if;
  if public.trip_role(p_trip) is not null then raise exception 'is_member' using errcode = '22023'; end if;
  if (select count(*) from public.reports where reporter_id = auth.uid() and created_at > now() - interval '1 day') >= 10 then
    raise exception 'rate_limited' using errcode = '22023';
  end if;

  insert into public.reports (trip_id, reporter_id, category, note)
  values (p_trip, auth.uid(), p_category, v_note)
  on conflict (trip_id, reporter_id) where status in ('open', 'in_review')
  do update set category = excluded.category, note = excluded.note, created_at = now();

  select count(distinct reporter_id) into v_n from public.reports where trip_id = p_trip and status in ('open', 'in_review');
  if v_n >= 3 and v_trip.held_at is null then
    update public.trips set held_at = now() where id = p_trip;
    insert into public.audit_events (admin_id, action, target, reason)
    values (null, 'trip_auto_held', 'trip:' || p_trip, v_n || ' reporters');
    v_held := true;
  end if;
  -- 事件只記類別，不記說明文字
  perform public.emit('trip_reported', p_trip, jsonb_build_object('category', p_category, 'auto_held', v_held));
  return jsonb_build_object('ok', true);
end $$;

-- ---------- 分享預覽卡片（給 Cloudflare Pages Functions 用） ----------
-- p_kind = 'read'：只回「公開／知道連結可看」的行程；私人行程回 null（卡片顯示通用文字）。
-- p_kind = 'invite'：私人行程也回名稱與日期，因為邀請連結本來就是發給要加入的人；
--   但不回照片，也不回任何卡片內容。代價：知道行程 ID 的人看得到行程名稱與日期（ID 是 122 位元隨機值，只出現在邀請／閱讀連結裡）。
-- 被暫停公開或已刪除的行程一律回 null。
create or replace function public.share_preview(p_trip uuid, p_kind text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'title', t.title,
    'destination', coalesce(p.name_zh, t.destination_text),
    'start_date', t.start_date,
    'end_date', t.end_date,
    'days', (select count(*) from public.trip_days d where d.trip_id = t.id),
    'stops', (select count(*) from public.trip_items i where i.trip_id = t.id and i.deleted_at is null and i.kind not in ('transport','note')),
    'party_size', t.party_size,
    'owner', (select c.nickname from public.collaborators c where c.trip_id = t.id and c.role = 'owner'),
    'visibility', t.visibility,
    'photo_url', case when t.visibility <> 'private' then coalesce(
        case when t.cover_url like 'https://%' then t.cover_url end,
        (select i.extra ->> 'photo_url' from public.trip_items i join public.trip_days d on d.id = i.day_id
          where i.trip_id = t.id and i.deleted_at is null and i.extra ->> 'photo_url' like 'https://%'
          order by d.day_index, i.sort limit 1)) end)
  from public.trips t left join public.places p on p.id = t.destination_place_id
  where t.id = p_trip and t.deleted_at is null and t.held_at is null
    and (p_kind = 'invite' or (p_kind = 'read' and t.visibility <> 'private'))
$$;

revoke execute on function public.report_trip(uuid, text, text), public.share_preview(uuid, text) from public;
grant execute on function public.report_trip(uuid, text, text) to authenticated;
grant execute on function public.share_preview(uuid, text) to anon, authenticated;
