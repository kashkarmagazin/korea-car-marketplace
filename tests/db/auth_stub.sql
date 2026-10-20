-- FAQAT LOKAL TEST UCHUN: oddiy PostgreSQL'da Supabase muhitining minimal imitatsiyasi.
-- (Haqiqiy Supabase'da bular allaqachon mavjud — bu faylni Supabase'ga qo'llamang.)
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema auth;
create schema extensions;
grant usage on schema auth, extensions, public to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key,
  email text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- Supabase'dagi standart huquqlar (migratsiya ularni o'zi yopishi kerak)
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
