-- Shaxsni tasdiqlash hujjatlari uchun YOPIQ bucket: foydalanuvchi faqat o'z papkasiga (uid/...) yuklaydi,
-- o'qishni faqat o'zi va admin qila oladi. Lokal test Postgres'ida storage sxemasi bo'lmasa — o'tkaziladi.
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'storage') then
    raise notice 'storage sxemasi yo''q (lokal test) — KYC bucket o''tkazildi';
    return;
  end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('kyc', 'kyc', false, 10485760, array['image/jpeg', 'image/png', 'application/pdf'])
  on conflict (id) do nothing;

  execute $p$create policy kyc_upload_own on storage.objects for insert to authenticated
    with check (bucket_id = 'kyc' and (storage.foldername(name))[1] = auth.uid()::text)$p$;
  execute $p$create policy kyc_read_own_or_admin on storage.objects for select to authenticated
    using (bucket_id = 'kyc' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()))$p$;
end $$;

-- submit_verification: hujjat yo'li foydalanuvchining o'z papkasida bo'lishi shart
create or replace function public.submit_verification(p_doc_type text, p_doc_path text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles := public._me(); v_id uuid;
begin
  if p_doc_path is null or split_part(p_doc_path, '/', 1) <> me.id::text then perform public._err('forbidden'); end if;
  insert into public.verification_requests (user_id, doc_type, doc_path) values (me.id, p_doc_type, p_doc_path) returning id into v_id;
  update public.profiles set verification = 'pending' where id = me.id and verification <> 'verified';
  perform public._audit('verification_submitted', 'profile', me.id::text, jsonb_build_object('request', v_id, 'doc_type', p_doc_type));
  return v_id;
end $$;
revoke execute on function public.submit_verification(text, text) from public, anon;
grant execute on function public.submit_verification(text, text) to authenticated;
