-- Korea Car Marketplace: RLS, ruxsatlar, ommaviy ko'rinishlar va o'zgarmas jurnal.

-- ================================================================ o'zgarmaslik triggerlari
create function public._audit_immutable() returns trigger language plpgsql as $$
begin
  raise exception using message = 'KC:audit_immutable', errcode = 'P0001';
end $$;
create trigger audit_no_update before update or delete on public.audit_log
  for each row execute function public._audit_immutable();
create trigger audit_no_truncate before truncate on public.audit_log
  for each statement execute function public._audit_immutable();

-- Stavkalar: o'chirish TAQIQLANGAN; o'zgartirish faqat admin_void_bid ichida (status/void_reason)
create function public._bids_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception using message = 'KC:bid_immutable', errcode = 'P0001';
  end if;
  if coalesce(current_setting('kc.bid_void', true), '') <> 'on'
     or new.id <> old.id or new.seq <> old.seq or new.auction_id <> old.auction_id or new.bidder_id <> old.bidder_id
     or new.amount_usd_cents <> old.amount_usd_cents or new.amount_car_minor <> old.amount_car_minor
     or new.fx_rate <> old.fx_rate or new.created_at <> old.created_at or new.status <> 'voided' then
    raise exception using message = 'KC:bid_immutable', errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger bids_guard before update or delete on public.bids
  for each row execute function public._bids_guard();
create trigger bids_no_truncate before truncate on public.bids
  for each statement execute function public._audit_immutable();

-- Auksion vaqti/natijasi/g'olibidagi HAR QANDAY o'zgarish jurnalga tushadi (to'g'ridan-to'g'ri SQL bilan ham)
create function public._auctions_audit() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.ends_at is distinct from old.ends_at or new.result is distinct from old.result
     or new.winner_id is distinct from old.winner_id or new.reserve_usd_cents is distinct from old.reserve_usd_cents
     or new.start_price_usd_cents is distinct from old.start_price_usd_cents or new.starts_at is distinct from old.starts_at
     or new.paused_at is distinct from old.paused_at or new.high_usd_cents is distinct from old.high_usd_cents then
    insert into public.audit_log (actor, action, entity, entity_id, data)
    values (auth.uid(), 'auction_row_changed', 'auction', new.listing_id::text, jsonb_build_object(
      'db_user', current_user,
      'ends_at', jsonb_build_array(old.ends_at, new.ends_at),
      'result', jsonb_build_array(old.result, new.result),
      'winner', jsonb_build_array(old.winner_id, new.winner_id),
      'high_usd_cents', jsonb_build_array(old.high_usd_cents, new.high_usd_cents),
      'reserve', jsonb_build_array(old.reserve_usd_cents, new.reserve_usd_cents),
      'paused_at', jsonb_build_array(old.paused_at, new.paused_at)));
  end if;
  return new;
end $$;
create trigger auctions_audit after update on public.auctions
  for each row execute function public._auctions_audit();

create function public._settings_audit() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.audit_log (actor, action, entity, entity_id, data)
  values (auth.uid(), 'settings_row_changed', 'settings', 'settings',
          jsonb_build_object('db_user', current_user, 'old', to_jsonb(old), 'new', to_jsonb(new)));
  return new;
end $$;
create trigger settings_audit after update on public.settings
  for each row execute function public._settings_audit();

-- ================================================================ ruxsatlar: avval hammasini yopamiz
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

alter table public.profiles enable row level security;
alter table public.verification_requests enable row level security;
alter table public.currencies enable row level security;
alter table public.fx_rates enable row level security;
alter table public.settings enable row level security;
alter table public.cars enable row level security;
alter table public.listings enable row level security;
alter table public.sale_listings enable row level security;
alter table public.offers enable row level security;
alter table public.auctions enable row level security;
alter table public.bids enable row level security;
alter table public.deposits enable row level security;
alter table public.notifications enable row level security;
alter table public.audit_log enable row level security;

create function public.is_admin() returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin' and not blocked)
$$;

-- profiles: o'zini ko'radi, ismi/telefonini o'zgartiradi (rol/tasdiq/blok — yo'q)
create policy profiles_self on public.profiles for select to authenticated using (id = auth.uid() or public.is_admin());
create policy profiles_self_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
grant select on public.profiles to authenticated;
grant update (full_name, phone, lang) on public.profiles to authenticated;

create policy vr_own on public.verification_requests for select to authenticated using (user_id = auth.uid() or public.is_admin());
grant select on public.verification_requests to authenticated;

-- Ma'lumotnoma jadvallar: hamma o'qiydi
create policy cur_read on public.currencies for select using (true);
create policy fx_read on public.fx_rates for select using (true);
create policy settings_read on public.settings for select using (true);
grant select on public.currencies, public.fx_rates, public.settings to anon, authenticated;

-- cars: e'londagilar hammaga ko'rinadi; sotuvchi o'z qoralamasini yaratadi va tavsifini tahrirlaydi
create policy cars_read on public.cars for select using (status <> 'draft' or seller_id = auth.uid() or public.is_admin());
create policy cars_insert on public.cars for insert to authenticated with check (seller_id = auth.uid() and status = 'draft');
create policy cars_update on public.cars for update to authenticated using (seller_id = auth.uid() and status in ('draft', 'listed'))
  with check (seller_id = auth.uid());
grant select on public.cars to anon, authenticated;
grant insert (seller_id, make, model, year, mileage_km, vin, damage, damage_notes, photos, currency) on public.cars to authenticated;
grant update (make, model, year, mileage_km, vin, damage, damage_notes, photos) on public.cars to authenticated;

create policy listings_read on public.listings for select using (true);
create policy sale_read on public.sale_listings for select using (true);
grant select on public.listings, public.sale_listings to anon, authenticated;

create policy offers_read on public.offers for select to authenticated using (
  buyer_id = auth.uid() or public.is_admin() or exists (
    select 1 from public.listings l join public.cars c on c.id = l.car_id where l.id = offers.listing_id and c.seller_id = auth.uid()));
grant select on public.offers to authenticated;

-- auctions: hamma ko'radi, LEKIN rezerv narx va eng yuqori stavkachi ID ustunlari yopiq
create policy auctions_read on public.auctions for select using (true);
grant select (listing_id, start_price_usd_cents, starts_at, ends_at, original_ends_at, extensions, paused_at, high_usd_cents,
              bid_count, bidder_count, deposit_usd_cents, deposit_terms, result, winner_deadline, finalized_at, relist_of)
  on public.auctions to anon, authenticated;

-- bids: foydalanuvchi faqat o'z stavkalarini to'liq ko'radi; umumiy tarix — bids_public orqali (anonim)
create policy bids_own on public.bids for select to authenticated using (bidder_id = auth.uid() or public.is_admin());
grant select on public.bids to authenticated;

create policy deposits_own on public.deposits for select to authenticated using (user_id = auth.uid() or public.is_admin());
grant select on public.deposits to authenticated;

create policy notif_own on public.notifications for select to authenticated using (user_id = auth.uid());
create policy notif_read_mark on public.notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;

create policy audit_admin on public.audit_log for select to authenticated using (public.is_admin());
grant select on public.audit_log to authenticated;

-- ================================================================ ommaviy ko'rinishlar (xavfsiz ustunlar)
create view public.auctions_public as
select a.listing_id as auction_id, l.status as listing_status, c.id as car_id, c.make, c.model, c.year, c.mileage_km,
       c.damage, c.damage_notes, c.photos, c.currency,
       p.verification as seller_verification,
       a.start_price_usd_cents, a.starts_at, a.ends_at, a.extensions, a.paused_at,
       a.high_usd_cents, a.bid_count, a.bidder_count,
       case when a.reserve_usd_cents is null then null else coalesce(a.high_usd_cents >= a.reserve_usd_cents, false) end as reserve_met,
       a.reserve_usd_cents is not null as has_reserve,
       a.deposit_usd_cents, a.deposit_terms, a.result, a.finalized_at, a.winner_deadline,
       (a.winner_id = auth.uid()) as i_am_winner, (a.high_bidder_id = auth.uid()) as i_am_highest,
       (c.seller_id = auth.uid()) as i_am_seller
  from public.auctions a
  join public.listings l on l.id = a.listing_id
  join public.cars c on c.id = l.car_id
  join public.profiles p on p.id = c.seller_id;

-- Stavkalar tarixi: ishtirokchilar "#1, #2 ..." deb belgilanadi (shaxs oshkor qilinmaydi)
create view public.bids_public as
with firsts as (
  select auction_id, bidder_id, min(seq) as first_seq from public.bids group by auction_id, bidder_id
), labels as (
  select auction_id, bidder_id, row_number() over (partition by auction_id order by first_seq) as n from firsts
)
select b.auction_id, b.seq, b.amount_usd_cents, b.car_currency, b.amount_car_minor, b.status, b.created_at,
       lb.n as bidder_no, (b.bidder_id = auth.uid()) as is_mine
  from public.bids b join labels lb on lb.auction_id = b.auction_id and lb.bidder_id = b.bidder_id;

create view public.sales_public as
select l.id as listing_id, l.status as listing_status, c.id as car_id, c.make, c.model, c.year, c.mileage_km, c.damage,
       c.damage_notes, c.photos, c.currency, s.price_minor, s.negotiable, p.verification as seller_verification,
       (c.seller_id = auth.uid()) as i_am_seller, l.created_at
  from public.listings l
  join public.sale_listings s on s.listing_id = l.id
  join public.cars c on c.id = l.car_id
  join public.profiles p on p.id = c.seller_id;

revoke all on public.auctions_public, public.bids_public, public.sales_public from anon, authenticated;
grant select on public.auctions_public, public.bids_public, public.sales_public to anon, authenticated;

-- ================================================================ funksiyalarga ruxsat
grant execute on function public.server_now() to anon, authenticated;
grant execute on function public.usd_to_minor(bigint, numeric, smallint) to anon, authenticated;
grant execute on function public.finalize_auction_if_due(uuid) to anon, authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function
  public.create_sale_listing(uuid, bigint, boolean), public.create_auction(uuid, bigint, bigint), public.withdraw_listing(uuid),
  public.make_offer(uuid, bigint, text), public.start_purchase(uuid), public.respond_offer(uuid, boolean),
  public.complete_sale(uuid), public.cancel_pending_sale(uuid, text),
  public.request_deposit(uuid), public.place_bid(uuid, bigint), public.complete_auction_sale(uuid),
  public.submit_verification(text, text), public.my_reserve(uuid),
  public.admin_pause_auction(uuid, text), public.admin_resume_auction(uuid, text), public.admin_cancel_auction(uuid, text),
  public.admin_void_bid(uuid, text), public.admin_mark_winner_default(uuid, text), public.admin_update_settings(jsonb),
  public.admin_set_fx_rate(char, numeric), public.admin_decide_verification(uuid, boolean, text),
  public.admin_set_user_blocked(uuid, boolean, text), public.admin_settle_deposit(uuid, text, text)
to authenticated;

-- Faqat server (service_role / cron): yakunlash, sukutlar, depozit tasdig'i
grant execute on function public.finalize_due_auctions(), public.process_winner_defaults(),
  public.confirm_deposit_payment(uuid, text, text, bigint) to service_role;
