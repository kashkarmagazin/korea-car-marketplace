-- Avtomobil rasmlari (ochiq o'qish, faqat o'z papkasiga yuklash) va bildirishnomalarni o'qilgan deb belgilash.
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'storage') then
    raise notice 'storage sxemasi yo''q (lokal test) — car-photos o''tkazildi';
    return;
  end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('car-photos', 'car-photos', true, 8388608, array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do nothing;
  execute $p$create policy car_photos_upload_own on storage.objects for insert to authenticated
    with check (bucket_id = 'car-photos' and (storage.foldername(name))[1] = auth.uid()::text)$p$;
  execute $p$create policy car_photos_delete_own on storage.objects for delete to authenticated
    using (bucket_id = 'car-photos' and (storage.foldername(name))[1] = auth.uid()::text)$p$;
end $$;

-- Rasm havolalari faqat shu loyihaning car-photos bucket'idan yoki https bo'lishi kerak (javascript: va h.k. yo'q)
create function public.all_https(p text[]) returns boolean language sql immutable as $f$
  select coalesce(bool_and(left(x, 8) = 'https://' and length(x) <= 500), true) from unnest(p) x
$f$;
alter table public.cars add constraint cars_photos_https check (public.all_https(photos));
alter table public.cars add constraint cars_photos_count check (cardinality(photos) <= 12);

create function public.mark_notifications_read()
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles := public._me(); n int;
begin
  update public.notifications set read_at = now() where user_id = me.id and read_at is null;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.mark_notifications_read() from public, anon;
grant execute on function public.mark_notifications_read() to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;
