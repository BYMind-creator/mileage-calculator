-- =====================================================================
-- 照片上傳（FR-07）：bucket「trip-photos」，路徑 <trip_id>/<檔名>
-- 單檔上限 5 MB，只收 JPEG／PNG／WebP；只有該行程的擁有者與編輯者能上傳或刪除。
-- 讀取：公開 bucket（網址含隨機檔名，不可列舉）。若需更嚴格，可改私有 bucket＋簽名網址。
-- 只有 Supabase 環境才有 storage schema，本機測試資料庫會自動略過。
-- =====================================================================
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('trip-photos', 'trip-photos', true, 5242880, array['image/jpeg','image/png','image/webp'])
    on conflict (id) do nothing;

    execute $p$
      create policy "trip photos: editors upload" on storage.objects for insert to authenticated
      with check (bucket_id = 'trip-photos'
                  and public.trip_role(((storage.foldername(name))[1])::uuid) in ('owner','editor'))
    $p$;
    execute $p$
      create policy "trip photos: editors delete" on storage.objects for delete to authenticated
      using (bucket_id = 'trip-photos'
             and public.trip_role(((storage.foldername(name))[1])::uuid) in ('owner','editor'))
    $p$;
  end if;
end $$;
