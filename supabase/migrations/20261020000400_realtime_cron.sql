-- Real vaqtga yaqin yangilanish (Supabase Realtime) va server cron vazifalari.
-- Lokal test Postgres'ida bu kengaytmalar bo'lmasligi mumkin — shunda jim o'tkazib yuboriladi.

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.auctions, public.listings;
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('kc_finalize_auctions', '* * * * *', 'select public.finalize_due_auctions()');
    perform cron.schedule('kc_winner_defaults', '*/5 * * * *', 'select public.process_winner_defaults()');
  else
    raise notice 'pg_cron mavjud emas: finalize_due_auctions() ni tashqi rejalashtiruvchi chaqirishi kerak';
  end if;
end $$;
