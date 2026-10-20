-- To'lov sayt orqali EMAS: bank o'tkazmasi yoki sotuvchi va xaridor kelishuvi bilan.
-- 1) Kelishuv bosqichida g'olib/xaridor va sotuvchi bir-birining ism va telefonini ko'radi.
-- 2) Sotuvchi "pul oldim" deb to'lov usulini ko'rsatib tasdiqlagandagina sotuv yakunlanadi (jurnalga yoziladi).
-- 3) Stavka berish, taklif va e'lon uchun profilda ism va telefon bo'lishi shart.

alter table public.profiles add constraint profiles_phone_format
  check (phone is null or phone ~ '^\+?[0-9][0-9\s()\-]{6,20}$');

alter table public.auctions add column payment_method text check (payment_method in ('bank_transfer', 'agreed'));
alter table public.sale_listings add column payment_method text check (payment_method in ('bank_transfer', 'agreed'));

create function public._require_contact(p public.profiles) returns void language plpgsql as $$
begin
  if p.phone is null or p.full_name is null or length(trim(p.full_name)) < 2 then perform public._err('profile_incomplete'); end if;
end $$;

create function public._me_contact() returns public.profiles
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v public.profiles := public._me();
begin
  perform public._require_contact(v);
  return v;
end $$;

-- Kontakt kerak bo'lgan amallar: o'ramalar (asl funksiya ichida _me() chaqiriladi, bu yerda oldindan tekshiriladi)
do $$
declare f text;
begin
  foreach f in array array['place_bid(uuid,bigint)', 'make_offer(uuid,bigint,text)', 'start_purchase(uuid)',
                           'create_auction(uuid,bigint,bigint)', 'create_sale_listing(uuid,bigint,boolean)'] loop
    execute format('alter function public.%s rename to %s', f, '_core_' || split_part(f, '(', 1));
  end loop;
end $$;

create function public.place_bid(p_auction uuid, p_amount_usd_cents bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin perform public._me_contact(); return public._core_place_bid(p_auction, p_amount_usd_cents); end $$;

create function public.make_offer(p_listing uuid, p_amount_minor bigint, p_message text default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
begin perform public._me_contact(); return public._core_make_offer(p_listing, p_amount_minor, p_message); end $$;

create function public.start_purchase(p_listing uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
begin perform public._me_contact(); return public._core_start_purchase(p_listing); end $$;

create function public.create_auction(p_car uuid, p_start_usd_cents bigint, p_reserve_usd_cents bigint default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
begin perform public._me_contact(); return public._core_create_auction(p_car, p_start_usd_cents, p_reserve_usd_cents); end $$;

create function public.create_sale_listing(p_car uuid, p_price_minor bigint, p_negotiable boolean default true) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
begin perform public._me_contact(); return public._core_create_sale_listing(p_car, p_price_minor, p_negotiable); end $$;

-- Ichki (_core_) funksiyalarni mijoz to'g'ridan-to'g'ri chaqira olmaydi
revoke execute on function public._core_place_bid(uuid, bigint), public._core_make_offer(uuid, bigint, text),
  public._core_start_purchase(uuid), public._core_create_auction(uuid, bigint, bigint),
  public._core_create_sale_listing(uuid, bigint, boolean) from public, anon, authenticated;
revoke execute on function public._me_contact(), public._require_contact(public.profiles) from public, anon, authenticated;
revoke execute on function public.place_bid(uuid, bigint), public.make_offer(uuid, bigint, text), public.start_purchase(uuid),
  public.create_auction(uuid, bigint, bigint), public.create_sale_listing(uuid, bigint, boolean) from public, anon;
grant execute on function public.place_bid(uuid, bigint), public.make_offer(uuid, bigint, text), public.start_purchase(uuid),
  public.create_auction(uuid, bigint, bigint), public.create_sale_listing(uuid, bigint, boolean) to authenticated;

-- Kelishuv tomonlari: auksion (g'olib <-> sotuvchi) yoki sotuv (qabul qilingan taklif egasi <-> sotuvchi)
create function public.deal_contacts(p_listing uuid)
returns table (role text, full_name text, phone text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me public.profiles := public._me(); v_l public.listings; v_seller uuid; v_buyer uuid;
begin
  select * into v_l from public.listings where id = p_listing;
  if v_l.id is null then perform public._err('listing_not_found'); end if;
  select seller_id into v_seller from public.cars where id = v_l.car_id;
  if v_l.kind = 'auction' then
    select winner_id into v_buyer from public.auctions
     where listing_id = p_listing and result in ('reserve_met', 'completed');
  else
    select buyer_id into v_buyer from public.offers where listing_id = p_listing and status = 'accepted';
  end if;
  if v_buyer is null or v_l.status not in ('pending_completion', 'sold') then perform public._err('no_deal'); end if;
  if me.id = v_seller then
    return query select 'buyer'::text, p.full_name, p.phone from public.profiles p where p.id = v_buyer;
  elsif me.id = v_buyer then
    return query select 'seller'::text, p.full_name, p.phone from public.profiles p where p.id = v_seller;
  elsif me.role = 'admin' then
    return query select 'seller'::text, p.full_name, p.phone from public.profiles p where p.id = v_seller
      union all select 'buyer'::text, p.full_name, p.phone from public.profiles p where p.id = v_buyer;
  else
    perform public._err('forbidden');
  end if;
end $$;
revoke execute on function public.deal_contacts(uuid) from public, anon;
grant execute on function public.deal_contacts(uuid) to authenticated;

-- Yakunlash: to'lov usuli majburiy (bank o'tkazmasi yoki kelishuv), sotuvchi pulni olganini tasdiqlaydi
drop function public.complete_auction_sale(uuid);
create function public.complete_auction_sale(p_auction uuid, p_payment_method text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles := public._me(); v_a public.auctions; v_l public.listings; v_seller uuid;
begin
  if p_payment_method is null or p_payment_method not in ('bank_transfer', 'agreed') then perform public._err('payment_method_required'); end if;
  select * into v_a from public.auctions where listing_id = p_auction for update;
  select * into v_l from public.listings where id = p_auction for update;
  select seller_id into v_seller from public.cars where id = v_l.car_id;
  if v_a.listing_id is null or (v_seller <> me.id and me.role <> 'admin') then perform public._err('forbidden'); end if;
  if v_a.result <> 'reserve_met' or v_l.status <> 'pending_completion' then perform public._err('no_pending_winner'); end if;
  if clock_timestamp() > v_a.winner_deadline then perform public._err('winner_deadline_passed'); end if;
  update public.auctions set result = 'completed', payment_method = p_payment_method where listing_id = p_auction;
  update public.listings set status = 'sold', closed_at = now() where id = p_auction;
  update public.cars set status = 'sold' where id = v_l.car_id;
  perform public._notify(v_a.winner_id, 'purchase_completed', jsonb_build_object('auction', p_auction));
  perform public._audit('auction_sale_completed', 'auction', p_auction::text,
    jsonb_build_object('winner', v_a.winner_id, 'amount_usd_cents', v_a.high_usd_cents, 'payment_method', p_payment_method));
end $$;
revoke execute on function public.complete_auction_sale(uuid, text) from public, anon;
grant execute on function public.complete_auction_sale(uuid, text) to authenticated;

drop function public.complete_sale(uuid);
create function public.complete_sale(p_listing uuid, p_payment_method text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles := public._me(); v_l public.listings; v_seller uuid;
begin
  if p_payment_method is null or p_payment_method not in ('bank_transfer', 'agreed') then perform public._err('payment_method_required'); end if;
  select * into v_l from public.listings where id = p_listing for update;
  if v_l.id is null or v_l.kind <> 'sale' then perform public._err('listing_not_found'); end if;
  select seller_id into v_seller from public.cars where id = v_l.car_id;
  if v_seller <> me.id and me.role <> 'admin' then perform public._err('forbidden'); end if;
  if v_l.status <> 'pending_completion' then perform public._err('no_accepted_offer'); end if;
  update public.sale_listings set payment_method = p_payment_method where listing_id = p_listing;
  update public.listings set status = 'sold', closed_at = now() where id = p_listing;
  update public.cars set status = 'sold' where id = v_l.car_id;
  update public.offers set status = 'rejected', responded_at = now() where listing_id = p_listing and status = 'pending';
  perform public._audit('sale_completed', 'listing', p_listing::text, jsonb_build_object('payment_method', p_payment_method));
end $$;
revoke execute on function public.complete_sale(uuid, text) from public, anon;
grant execute on function public.complete_sale(uuid, text) to authenticated;

-- Profilni to'ldirish (ism + telefon) — telefon formati CHECK bilan tekshiriladi
create function public.update_my_profile(p_full_name text, p_phone text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles := public._me();
begin
  if p_full_name is null or length(trim(p_full_name)) < 2 then perform public._err('profile_incomplete'); end if;
  begin
    update public.profiles set full_name = trim(p_full_name), phone = nullif(trim(p_phone), '') where id = me.id;
  exception when check_violation then
    perform public._err('invalid_phone');
  end;
end $$;
revoke execute on function public.update_my_profile(text, text) from public, anon;
grant execute on function public.update_my_profile(text, text) to authenticated;
