-- Korea Car Marketplace: biznes qoidalari serverda (Postgres funksiyalari).
-- Xatolar 'KC:<kod>' ko'rinishida qaytariladi; interfeys ularni uz/ru/ky tiliga tarjima qiladi.

-- ================================================================ yordamchilar
create function public._err(code text) returns void language plpgsql as $$
begin
  raise exception using message = 'KC:' || code, errcode = 'P0001';
end $$;

create function public.server_now() returns timestamptz language sql volatile as $$
  select clock_timestamp()
$$;

create function public._audit(p_action text, p_entity text, p_entity_id text, p_data jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.audit_log (actor, action, entity, entity_id, data)
  values (auth.uid(), p_action, p_entity, p_entity_id, coalesce(p_data, '{}'::jsonb));
$$;

create function public._notify(p_user uuid, p_kind text, p_payload jsonb)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.notifications (user_id, kind, payload) values (p_user, p_kind, p_payload);
$$;

-- Joriy foydalanuvchi (autentifikatsiya va bloklanganlik tekshiruvi bilan)
create function public._me() returns public.profiles
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v public.profiles;
begin
  if auth.uid() is null then perform public._err('auth_required'); end if;
  select * into v from public.profiles where id = auth.uid();
  if not found then perform public._err('auth_required'); end if;
  if v.blocked then perform public._err('user_blocked'); end if;
  return v;
end $$;

create function public._require_admin() returns public.profiles
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v public.profiles := public._me();
begin
  if v.role <> 'admin' then perform public._err('forbidden'); end if;
  return v;
end $$;

create function public._require_reason(p_reason text) returns text language plpgsql immutable as $$
begin
  if p_reason is null or length(trim(p_reason)) < 3 then perform public._err('reason_required'); end if;
  return trim(p_reason);
end $$;

-- USD (sent) -> avtomobil valyutasi (minor units). Aniq numeric hisob, yarim birlik noldan uzoqqa yaxlitlanadi.
create function public.usd_to_minor(p_usd_cents bigint, p_rate numeric, p_minor_units smallint)
returns bigint language sql immutable strict as $$
  select round(p_usd_cents::numeric * p_rate * (10::numeric ^ p_minor_units) / 100)::bigint
$$;

-- Joriy (eskirmagan) kurs: USD uchun 1. Kurs yo'q yoki eskirgan bo'lsa — xato (taxmin qilinmaydi).
create function public._fx(p_currency char(3), p_at timestamptz)
returns numeric language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_rate numeric; v_time timestamptz; v_max interval;
begin
  if p_currency = 'USD' then return 1; end if;
  select fx_max_age into v_max from public.settings;
  select rate, fetched_at into v_rate, v_time from public.fx_rates
   where quote = p_currency order by fetched_at desc, id desc limit 1;
  if v_rate is null or v_time < p_at - v_max then perform public._err('fx_rate_unavailable'); end if;
  return v_rate;
end $$;

-- ================================================================ avtomobil e'lonlari
create function public.create_sale_listing(p_car uuid, p_price_minor bigint, p_negotiable boolean default true)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles := public._me(); v_car public.cars; v_s public.settings; v_id uuid;
begin
  select * into v_s from public.settings;
  select * into v_car from public.cars where id = p_car for update;
  if not found or v_car.seller_id <> me.id then perform public._err('not_your_car'); end if;
  if v_s.require_verified_seller and me.verification <> 'verified' then perform public._err('verification_required'); end if;
  if v_car.status not in ('draft', 'listed') then perform public._err('car_not_available'); end if;
  if p_price_minor is null or p_price_minor <= 0 then perform public._err('invalid_price'); end if;
  begin
    insert into public.listings (car_id, kind) values (p_car, 'sale') returning id into v_id;
  exception when unique_violation then
    perform public._err('car_already_listed');
  end;
  insert into public.sale_listings (listing_id, price_minor, negotiable) values (v_id, p_price_minor, coalesce(p_negotiable, true));
  update public.cars set status = 'listed' where id = p_car;
  perform public._audit('sale_listed', 'listing', v_id::text, jsonb_build_object('car', p_car, 'price_minor', p_price_minor, 'currency', v_car.currency));
  return v_id;
end $$;

create function public.create_auction(p_car uuid, p_start_usd_cents bigint, p_reserve_usd_cents bigint default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles := public._me(); v_car public.cars; v_s public.settings; v_id uuid; v_now timestamptz := clock_timestamp();
begin
  select * into v_s from public.settings;
  select * into v_car from public.cars where id = p_car for update;
  if not found or v_car.seller_id <> me.id then perform public._err('not_your_car'); end if;
  if v_s.require_verified_seller and me.verification <> 'verified' then perform public._err('verification_required'); end if;
  if v_car.status not in ('draft', 'listed') then perform public._err('car_not_available'); end if;
  if p_start_usd_cents is null or p_start_usd_cents < v_s.min_bid_usd_cents or p_start_usd_cents > v_s.max_bid_usd_cents
     or p_start_usd_cents % 100 <> 0 then
    perform public._err('start_price_out_of_range');
  end if;
  if p_reserve_usd_cents is not null and (p_reserve_usd_cents < p_start_usd_cents or p_reserve_usd_cents > v_s.max_bid_usd_cents
     or p_reserve_usd_cents % 100 <> 0) then
    perform public._err('reserve_out_of_range');
  end if;
  begin
    insert into public.listings (car_id, kind) values (p_car, 'auction') returning id into v_id;
  exception when unique_violation then
    perform public._err('car_already_listed');
  end;
  -- Vaqt FAQAT serverda belgilanadi (UTC timestamptz); mijoz vaqti ishlatilmaydi.
  insert into public.auctions (listing_id, start_price_usd_cents, reserve_usd_cents, starts_at, ends_at, original_ends_at,
                               deposit_usd_cents, deposit_terms)
  values (v_id, p_start_usd_cents, p_reserve_usd_cents, v_now, v_now + v_s.auction_duration, v_now + v_s.auction_duration,
          case when v_s.deposit_required then v_s.deposit_usd_cents else 0 end,
          case when v_s.deposit_required then v_s.deposit_terms else '{}'::jsonb end);
  update public.cars set status = 'listed' where id = p_car;
  perform public._audit('auction_created', 'auction', v_id::text,
    jsonb_build_object('car', p_car, 'start', p_start_usd_cents, 'has_reserve', p_reserve_usd_cents is not null,
                       'starts_at', v_now, 'ends_at', v_now + v_s.auction_duration));
  return v_id;
end $$;

-- Sotuvchi e'lonni qaytarib oladi: sotuvni istalgan payt, auksionni faqat stavka bo'lmasa
create function public.withdraw_listing(p_listing uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles := public._me(); v_l public.listings; v_seller uuid; v_bids int;
begin
  select l.* into v_l from public.listings l where l.id = p_listing for update;
  select seller_id into v_seller from public.cars where id = v_l.car_id;
  if v_l.id is null or v_seller <> me.id then perform public._err('forbidden'); end if;
  if v_l.status <> 'active' then perform public._err('listing_not_active'); end if;
  if v_l.kind = 'auction' then
    select bid_count into v_bids from public.auctions where listing_id = p_listing for update;
    if v_bids > 0 then perform public._err('auction_has_bids'); end if;
    update public.auctions set result = 'cancelled', finalized_at = clock_timestamp() where listing_id = p_listing;
  else
    update public.offers set status = 'rejected', responded_at = now() where listing_id = p_listing and status = 'pending';
  end if;
  update public.listings set status = 'cancelled', closed_at = now() where id = p_listing;
  update public.cars set status = 'draft' where id = v_l.car_id;
  perform public._audit('listing_withdrawn', 'listing', p_listing::text, '{}'::jsonb);
end $$;

-- ================================================================ ODDIY SOTUV
create function public.make_offer(p_listing uuid, p_amount_minor bigint, p_message text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles := public._me(); v_l public.listings; v_sl public.sale_listings; v_seller uuid; v_id uuid;
begin
  select * into v_l from public.listings where id = p_listing for update;
  if v_l.id is null or v_l.kind <> 'sale' then perform public._err('listing_not_found'); end if;
  if v_l.status <> 'active' then perform public._err('listing_not_active'); end if;
  select seller_id into v_seller from public.cars where id = v_l.car_id;
  if v_seller = me.id then perform public._err('own_listing'); end if;
  select * into v_sl from public.sale_listings where listing_id = p_listing;
  if p_amount_minor is null or p_amount_minor <= 0 then perform public._err('invalid_price'); end if;
  if not v_sl.negotiable and p_amount_minor <> v_sl.price_minor then perform public._err('not_negotiable'); end if;
  update public.offers set status = 'withdrawn', responded_at = now()
   where listing_id = p_listing and buyer_id = me.id and status = 'pending';
  insert into public.offers (listing_id, buyer_id, amount_minor, kind, message)
  values (p_listing, me.id, p_amount_minor, 'offer', p_message) returning id into v_id;
  perform public._notify(v_seller, 'offer_received', jsonb_build_object('listing', p_listing, 'offer', v_id, 'amount_minor', p_amount_minor));
  perform public._audit('offer_made', 'offer', v_id::text, jsonb_build_object('listing', p_listing, 'amount_minor', p_amount_minor));
  return v_id;
end $$;

-- "Sotib olish jarayonini boshlash": belgilangan narxda so'rov (sotuvchi tasdiqlaydi)
create function public.start_purchase(p_listing uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles := public._me(); v_l public.listings; v_price bigint; v_seller uuid; v_id uuid;
begin
  select * into v_l from public.listings where id = p_listing for update;
  if v_l.id is null or v_l.kind <> 'sale' then perform public._err('listing_not_found'); end if;
  if v_l.status <> 'active' then perform public._err('listing_not_active'); end if;
  select seller_id into v_seller from public.cars where id = v_l.car_id;
  if v_seller = me.id then perform public._err('own_listing'); end if;
  select price_minor into v_price from public.sale_listings where listing_id = p_listing;
  update public.offers set status = 'withdrawn', responded_at = now()
   where listing_id = p_listing and buyer_id = me.id and status = 'pending';
  insert into public.offers (listing_id, buyer_id, amount_minor, kind) values (p_listing, me.id, v_price, 'buy_now') returning id into v_id;
  perform public._notify(v_seller, 'purchase_requested', jsonb_build_object('listing', p_listing, 'offer', v_id));
  perform public._audit('purchase_started', 'offer', v_id::text, jsonb_build_object('listing', p_listing, 'amount_minor', v_price));
  return v_id;
end $$;

create function public.respond_offer(p_offer uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles := public._me(); v_o public.offers; v_l public.listings; v_seller uuid;
begin
  select * into v_o from public.offers where id = p_offer;
  if v_o.id is null then perform public._err('offer_not_found'); end if;
  select * into v_l from public.listings where id = v_o.listing_id for update;
  select seller_id into v_seller from public.cars where id = v_l.car_id;
  if v_seller <> me.id then perform public._err('forbidden'); end if;
  select * into v_o from public.offers where id = p_offer for update;
  if v_o.status <> 'pending' then perform public._err('offer_not_pending'); end if;
  if p_accept then
    if v_l.status <> 'active' then perform public._err('listing_not_active'); end if;
    update public.offers set status = 'accepted', responded_at = now() where id = p_offer;
    update public.listings set status = 'pending_completion' where id = v_l.id;
  else
    update public.offers set status = 'rejected', responded_at = now() where id = p_offer;
  end if;
  perform public._notify(v_o.buyer_id, case when p_accept then 'offer_accepted' else 'offer_rejected' end,
    jsonb_build_object('listing', v_l.id, 'offer', p_offer));
  perform public._audit(case when p_accept then 'offer_accepted' else 'offer_rejected' end, 'offer', p_offer::text,
    jsonb_build_object('listing', v_l.id));
end $$;

-- Kelishuv amalda bajarildi (to'lov/hujjatlar) — avtomobil sotuvdan chiqariladi
create function public.complete_sale(p_listing uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles := public._me(); v_l public.listings; v_seller uuid;
begin
  select * into v_l from public.listings where id = p_listing for update;
  if v_l.id is null or v_l.kind <> 'sale' then perform public._err('listing_not_found'); end if;
  select seller_id into v_seller from public.cars where id = v_l.car_id;
  if v_seller <> me.id and me.role <> 'admin' then perform public._err('forbidden'); end if;
  if v_l.status <> 'pending_completion' then perform public._err('no_accepted_offer'); end if;
  update public.listings set status = 'sold', closed_at = now() where id = p_listing;
  update public.cars set status = 'sold' where id = v_l.car_id;
  update public.offers set status = 'rejected', responded_at = now() where listing_id = p_listing and status = 'pending';
  perform public._audit('sale_completed', 'listing', p_listing::text, '{}'::jsonb);
end $$;

-- Kelishilgan xarid amalga oshmadi — e'lon yana faol
create function public.cancel_pending_sale(p_listing uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles := public._me(); v_l public.listings; v_seller uuid; v_reason text := public._require_reason(p_reason);
begin
  select * into v_l from public.listings where id = p_listing for update;
  select seller_id into v_seller from public.cars where id = v_l.car_id;
  if v_l.id is null or (v_seller <> me.id and me.role <> 'admin') then perform public._err('forbidden'); end if;
  if v_l.status <> 'pending_completion' then perform public._err('no_accepted_offer'); end if;
  update public.offers set status = 'withdrawn', responded_at = now() where listing_id = p_listing and status = 'accepted';
  update public.listings set status = 'active' where id = p_listing;
  perform public._audit('pending_sale_cancelled', 'listing', p_listing::text, jsonb_build_object('reason', v_reason));
end $$;

-- ================================================================ DEPOZIT
-- Foydalanuvchi depozit so'rovini yaratadi (miqdor va shartlar auksion boshlanishida qotirilgan).
create function public.request_deposit(p_auction uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles := public._me(); v_a public.auctions; v_d public.deposits;
begin
  select * into v_a from public.auctions where listing_id = p_auction;
  if v_a.listing_id is null then perform public._err('auction_not_found'); end if;
  if v_a.deposit_usd_cents = 0 then perform public._err('deposit_not_required'); end if;
  insert into public.deposits (auction_id, user_id, amount_usd_cents) values (p_auction, me.id, v_a.deposit_usd_cents)
  on conflict (auction_id, user_id) do nothing;
  select * into v_d from public.deposits where auction_id = p_auction and user_id = me.id;
  return jsonb_build_object('deposit', v_d.id, 'status', v_d.status, 'amount_usd_cents', v_d.amount_usd_cents, 'terms', v_a.deposit_terms);
end $$;

-- FAQAT service_role (to'lov provayderi webhook'i imzosi tekshirilgandan keyin) chaqiradi.
create function public.confirm_deposit_payment(p_deposit uuid, p_provider text, p_provider_ref text, p_amount_usd_cents bigint)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_d public.deposits;
begin
  select * into v_d from public.deposits where id = p_deposit for update;
  if v_d.id is null then perform public._err('deposit_not_found'); end if;
  if p_provider is null or p_provider_ref is null then perform public._err('provider_ref_required'); end if;
  if p_amount_usd_cents <> v_d.amount_usd_cents then perform public._err('deposit_amount_mismatch'); end if;
  if v_d.status = 'paid' and v_d.provider_ref = p_provider_ref then return; end if;  -- takroriy webhook
  if v_d.status <> 'pending' then perform public._err('deposit_not_pending'); end if;
  update public.deposits set status = 'paid', provider = p_provider, provider_ref = p_provider_ref, confirmed_at = now()
   where id = p_deposit;
  perform public._audit('deposit_confirmed_by_provider', 'deposit', p_deposit::text,
    jsonb_build_object('provider', p_provider, 'ref', p_provider_ref, 'amount', p_amount_usd_cents));
end $$;

-- ================================================================ STAVKA
create function public.place_bid(p_auction uuid, p_amount_usd_cents bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me public.profiles := public._me();
  v_s public.settings; v_a public.auctions; v_l public.listings; v_car public.cars;
  v_now timestamptz; v_rate numeric; v_mu smallint; v_bid uuid; v_recent int; v_new_end timestamptz; v_extended boolean := false;
begin
  select * into v_s from public.settings;
  if v_s.require_verified_bidder and me.verification <> 'verified' then perform public._err('verification_required'); end if;

  -- Concurrency: auksion qatori qulflanadi — bir vaqtdagi stavkalar ketma-ket ko'rib chiqiladi.
  select * into v_a from public.auctions where listing_id = p_auction for update;
  if v_a.listing_id is null then perform public._err('auction_not_found'); end if;
  v_now := clock_timestamp();   -- qulf olingandan KEYINGI server vaqti

  select * into v_l from public.listings where id = p_auction;
  select * into v_car from public.cars where id = v_l.car_id;
  if v_l.status = 'paused' then perform public._err('auction_paused'); end if;
  if v_l.status <> 'active' or v_a.finalized_at is not null then perform public._err('auction_not_active'); end if;
  if v_now < v_a.starts_at then perform public._err('auction_not_started'); end if;
  if v_now >= v_a.ends_at then perform public._err('auction_ended'); end if;
  if v_car.seller_id = me.id then perform public._err('own_auction'); end if;

  if p_amount_usd_cents is null or p_amount_usd_cents < v_s.min_bid_usd_cents or p_amount_usd_cents > v_s.max_bid_usd_cents then
    perform public._err('amount_out_of_range');
  end if;
  if p_amount_usd_cents % 100 <> 0 then perform public._err('whole_dollars_only'); end if;
  if v_a.high_usd_cents is null then
    if p_amount_usd_cents < v_a.start_price_usd_cents then perform public._err('below_start_price'); end if;
  else
    if v_a.high_bidder_id = me.id then perform public._err('already_highest'); end if;
    if p_amount_usd_cents <= v_a.high_usd_cents then perform public._err('not_higher_than_current'); end if;
    if p_amount_usd_cents < v_a.high_usd_cents + v_s.bid_increment_usd_cents then perform public._err('below_min_increment'); end if;
  end if;

  select count(*) into v_recent from public.bids where bidder_id = me.id and created_at > v_now - interval '1 minute';
  if v_recent >= v_s.max_bids_per_minute then perform public._err('rate_limited'); end if;

  if v_a.deposit_usd_cents > 0 and not exists (
       select 1 from public.deposits where auction_id = p_auction and user_id = me.id and status = 'paid') then
    perform public._err('deposit_required');
  end if;

  v_rate := public._fx(v_car.currency, v_now);
  select minor_units into v_mu from public.currencies where code = v_car.currency;

  insert into public.bids (auction_id, bidder_id, amount_usd_cents, car_currency, fx_rate, amount_car_minor, created_at)
  values (p_auction, me.id, p_amount_usd_cents, v_car.currency, v_rate,
          public.usd_to_minor(p_amount_usd_cents, v_rate, v_mu), v_now)
  returning id into v_bid;

  -- Anti-sniping: oxirgi oynada kelgan stavka tugashni uzaytiradi (har safar takrorlanishi mumkin)
  v_new_end := v_a.ends_at;
  if v_s.anti_snipe_enabled and v_a.ends_at - v_now <= v_s.anti_snipe_window then
    v_new_end := greatest(v_a.ends_at, v_now + v_s.anti_snipe_extend);
    v_extended := v_new_end > v_a.ends_at;
  end if;

  update public.auctions set
    high_bid_id = v_bid, high_usd_cents = p_amount_usd_cents, high_bidder_id = me.id,
    bid_count = bid_count + 1,
    bidder_count = (select count(distinct bidder_id) from public.bids where auction_id = p_auction and status = 'valid'),
    ends_at = v_new_end,
    extensions = extensions + case when v_extended then 1 else 0 end
  where listing_id = p_auction;

  perform public._audit('bid_placed', 'bid', v_bid::text,
    jsonb_build_object('auction', p_auction, 'amount_usd_cents', p_amount_usd_cents, 'at', v_now));
  if v_extended then
    perform public._audit('auction_extended_anti_snipe', 'auction', p_auction::text,
      jsonb_build_object('old_end', v_a.ends_at, 'new_end', v_new_end, 'bid', v_bid));
  end if;
  if v_a.high_bidder_id is not null and v_a.high_bidder_id <> me.id then
    perform public._notify(v_a.high_bidder_id, 'outbid', jsonb_build_object('auction', p_auction, 'amount_usd_cents', p_amount_usd_cents));
  end if;

  return jsonb_build_object('bid', v_bid, 'high_usd_cents', p_amount_usd_cents, 'ends_at', v_new_end,
                            'extended', v_extended, 'server_time', v_now);
end $$;

-- Eng yuqori haqiqiy stavka va hisoblagichlarni qayta hisoblash (stavka bekor qilingandan keyin)
create function public._recompute_auction(p_auction uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_top public.bids;
begin
  select * into v_top from public.bids where auction_id = p_auction and status = 'valid'
   order by amount_usd_cents desc, seq asc limit 1;
  update public.auctions set
    high_bid_id = v_top.id, high_usd_cents = v_top.amount_usd_cents, high_bidder_id = v_top.bidder_id,
    bid_count = (select count(*) from public.bids where auction_id = p_auction and status = 'valid'),
    bidder_count = (select count(distinct bidder_id) from public.bids where auction_id = p_auction and status = 'valid')
  where listing_id = p_auction;
end $$;

-- ================================================================ AUKSION YAKUNI
create function public._finalize_auction(p_auction uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare v_a public.auctions; v_l public.listings; v_car public.cars; v_s public.settings; v_now timestamptz; v_result text;
begin
  select * into v_a from public.auctions where listing_id = p_auction for update;
  if v_a.listing_id is null or v_a.finalized_at is not null then return null; end if;
  select * into v_l from public.listings where id = p_auction for update;
  v_now := clock_timestamp();
  if v_l.status <> 'active' or v_now < v_a.ends_at then return null; end if;   -- hali tugamagan yoki to'xtatilgan
  select * into v_s from public.settings;
  select * into v_car from public.cars where id = v_l.car_id;

  if v_a.high_bid_id is null then
    v_result := 'no_bids';
  elsif v_a.reserve_usd_cents is null or v_a.high_usd_cents >= v_a.reserve_usd_cents then
    v_result := 'reserve_met';
  else
    v_result := 'reserve_not_met';
  end if;

  if v_result = 'reserve_met' then
    -- Shartli g'olib: sotuv YAKUNLANMAGAN, faqat yakunlash bosqichi ochiladi
    update public.auctions set result = v_result, finalized_at = v_now, winner_id = v_a.high_bidder_id,
           winner_deadline = v_now + v_s.winner_completion_period where listing_id = p_auction;
    update public.listings set status = 'pending_completion' where id = p_auction;
    perform public._notify(v_a.high_bidder_id, 'auction_won',
      jsonb_build_object('auction', p_auction, 'amount_usd_cents', v_a.high_usd_cents, 'deadline', v_now + v_s.winner_completion_period));
    perform public._notify(v_car.seller_id, 'auction_sold_pending',
      jsonb_build_object('auction', p_auction, 'amount_usd_cents', v_a.high_usd_cents));
  else
    update public.auctions set result = v_result, finalized_at = v_now where listing_id = p_auction;
    update public.listings set status = 'ended_no_sale', closed_at = v_now where id = p_auction;
    update public.cars set status = 'draft' where id = v_l.car_id;
    perform public._notify(v_car.seller_id, 'auction_no_sale', jsonb_build_object('auction', p_auction, 'result', v_result));
    if v_a.high_bidder_id is not null then
      perform public._notify(v_a.high_bidder_id, 'auction_reserve_not_met', jsonb_build_object('auction', p_auction));
    end if;
  end if;
  perform public._audit('auction_finalized', 'auction', p_auction::text,
    jsonb_build_object('result', v_result, 'high_usd_cents', v_a.high_usd_cents, 'bid_count', v_a.bid_count, 'ends_at', v_a.ends_at, 'at', v_now));
  return v_result;
end $$;

-- Istalgan foydalanuvchi chaqirishi xavfsiz: faqat haqiqatan tugagan auksionni yakunlaydi.
create function public.finalize_auction_if_due(p_auction uuid)
returns text language sql security definer set search_path = public, pg_temp as $$
  select public._finalize_auction(p_auction)
$$;

-- Cron (har daqiqa) uchun: barcha muddati o'tganlarni yakunlaydi
create function public.finalize_due_auctions()
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; n int := 0;
begin
  for r in select listing_id from public.auctions where finalized_at is null and ends_at <= clock_timestamp() loop
    if public._finalize_auction(r.listing_id) is not null then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- G'olib xaridni yakunlamadi: sozlamadagi qayta auksion qoidasi qo'llanadi
create function public._handle_winner_default(p_auction uuid, p_reason text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare v_a public.auctions; v_l public.listings; v_s public.settings; v_runner public.bids; v_new uuid; v_now timestamptz := clock_timestamp();
        v_excluded uuid[]; v_car public.cars;
begin
  select * into v_a from public.auctions where listing_id = p_auction for update;
  select * into v_l from public.listings where id = p_auction for update;
  if v_a.result <> 'reserve_met' or v_l.status <> 'pending_completion' then perform public._err('no_pending_winner'); end if;
  select * into v_s from public.settings;
  select * into v_car from public.cars where id = v_l.car_id;

  perform public._audit('winner_defaulted', 'auction', p_auction::text,
    jsonb_build_object('winner', v_a.winner_id, 'deadline', v_a.winner_deadline, 'reason', p_reason, 'policy', v_s.relist_policy));
  perform public._notify(v_a.winner_id, 'winner_defaulted', jsonb_build_object('auction', p_auction));

  if v_s.relist_policy = 'offer_runner_up' then
    -- Avval sukut qilgan barcha g'oliblar chiqarib tashlanadi
    select coalesce(array_agg((data ->> 'winner')::uuid), '{}') into v_excluded
      from public.audit_log where entity = 'auction' and entity_id = p_auction::text and action = 'winner_defaulted';
    select * into v_runner from public.bids
     where auction_id = p_auction and status = 'valid' and bidder_id <> all (v_excluded)
       and (v_a.reserve_usd_cents is null or amount_usd_cents >= v_a.reserve_usd_cents)
     order by amount_usd_cents desc, seq asc limit 1;
    if v_runner.id is not null then
      update public.auctions set winner_id = v_runner.bidder_id, winner_deadline = v_now + v_s.winner_completion_period
       where listing_id = p_auction;
      perform public._notify(v_runner.bidder_id, 'runner_up_offer',
        jsonb_build_object('auction', p_auction, 'amount_usd_cents', v_runner.amount_usd_cents));
      perform public._audit('runner_up_offered', 'auction', p_auction::text,
        jsonb_build_object('winner', v_runner.bidder_id, 'amount_usd_cents', v_runner.amount_usd_cents));
      return 'runner_up_offered';
    end if;
  end if;

  update public.auctions set result = 'winner_defaulted' where listing_id = p_auction;
  update public.listings set status = 'ended_no_sale', closed_at = v_now where id = p_auction;

  if v_s.relist_policy = 'auto_relist' then
    insert into public.listings (car_id, kind) values (v_l.car_id, 'auction') returning id into v_new;
    insert into public.auctions (listing_id, start_price_usd_cents, reserve_usd_cents, starts_at, ends_at, original_ends_at,
                                 deposit_usd_cents, deposit_terms, relist_of)
    values (v_new, v_a.start_price_usd_cents, v_a.reserve_usd_cents, v_now, v_now + v_s.auction_duration, v_now + v_s.auction_duration,
            v_a.deposit_usd_cents, v_a.deposit_terms, p_auction);
    perform public._audit('auction_relisted', 'auction', v_new::text, jsonb_build_object('relist_of', p_auction));
    perform public._notify(v_car.seller_id, 'auction_relisted', jsonb_build_object('old', p_auction, 'new', v_new));
    return 'relisted';
  end if;

  update public.cars set status = 'draft' where id = v_l.car_id;
  perform public._notify(v_car.seller_id, 'winner_defaulted_manual', jsonb_build_object('auction', p_auction));
  return 'ended';
end $$;

-- Cron uchun: muddati o'tgan g'oliblar
create function public.process_winner_defaults()
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; n int := 0;
begin
  for r in select a.listing_id from public.auctions a join public.listings l on l.id = a.listing_id
            where a.result = 'reserve_met' and l.status = 'pending_completion' and a.winner_deadline < clock_timestamp() loop
    perform public._handle_winner_default(r.listing_id, 'deadline_passed');
    n := n + 1;
  end loop;
  return n;
end $$;

-- To'lov va hujjatlar tasdiqlangach sotuvchi yoki admin yakunlaydi
create function public.complete_auction_sale(p_auction uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles := public._me(); v_a public.auctions; v_l public.listings; v_seller uuid;
begin
  select * into v_a from public.auctions where listing_id = p_auction for update;
  select * into v_l from public.listings where id = p_auction for update;
  select seller_id into v_seller from public.cars where id = v_l.car_id;
  if v_a.listing_id is null or (v_seller <> me.id and me.role <> 'admin') then perform public._err('forbidden'); end if;
  if v_a.result <> 'reserve_met' or v_l.status <> 'pending_completion' then perform public._err('no_pending_winner'); end if;
  if clock_timestamp() > v_a.winner_deadline then perform public._err('winner_deadline_passed'); end if;
  update public.auctions set result = 'completed' where listing_id = p_auction;
  update public.listings set status = 'sold', closed_at = now() where id = p_auction;
  update public.cars set status = 'sold' where id = v_l.car_id;
  perform public._notify(v_a.winner_id, 'purchase_completed', jsonb_build_object('auction', p_auction));
  perform public._audit('auction_sale_completed', 'auction', p_auction::text, jsonb_build_object('winner', v_a.winner_id));
end $$;

-- ================================================================ ADMIN (har amal audit jurnaliga yoziladi)
create function public.admin_pause_auction(p_auction uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles := public._require_admin(); v_reason text := public._require_reason(p_reason); v_l public.listings;
begin
  perform 1 from public.auctions where listing_id = p_auction for update;
  select * into v_l from public.listings where id = p_auction and kind = 'auction' for update;
  if v_l.id is null then perform public._err('auction_not_found'); end if;
  if v_l.status <> 'active' then perform public._err('auction_not_active'); end if;
  update public.listings set status = 'paused' where id = p_auction;
  update public.auctions set paused_at = clock_timestamp() where listing_id = p_auction;
  perform public._audit('admin_auction_paused', 'auction', p_auction::text, jsonb_build_object('reason', v_reason));
end $$;

-- Davom ettirish: to'xtatilgan vaqt qolgan vaqtga qo'shiladi (ishtirokchilar vaqt yo'qotmaydi)
create function public.admin_resume_auction(p_auction uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles := public._require_admin(); v_reason text := public._require_reason(p_reason); v_a public.auctions; v_now timestamptz := clock_timestamp();
begin
  select * into v_a from public.auctions where listing_id = p_auction for update;
  if v_a.listing_id is null or v_a.paused_at is null then perform public._err('auction_not_paused'); end if;
  update public.auctions set ends_at = ends_at + (v_now - paused_at), paused_at = null where listing_id = p_auction;
  update public.listings set status = 'active' where id = p_auction;
  perform public._audit('admin_auction_resumed', 'auction', p_auction::text,
    jsonb_build_object('reason', v_reason, 'paused_for', (v_now - v_a.paused_at)::text, 'new_end', v_a.ends_at + (v_now - v_a.paused_at)));
end $$;

create function public.admin_cancel_auction(p_auction uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles := public._require_admin(); v_reason text := public._require_reason(p_reason); v_a public.auctions; v_l public.listings; v_seller uuid;
begin
  select * into v_a from public.auctions where listing_id = p_auction for update;
  select * into v_l from public.listings where id = p_auction for update;
  if v_a.listing_id is null then perform public._err('auction_not_found'); end if;
  if v_l.status not in ('active', 'paused', 'pending_completion') then perform public._err('auction_not_active'); end if;
  update public.auctions set result = 'cancelled', finalized_at = coalesce(finalized_at, clock_timestamp()), paused_at = null where listing_id = p_auction;
  update public.listings set status = 'cancelled', closed_at = now() where id = p_auction;
  update public.cars set status = 'draft' where id = v_l.car_id;
  select seller_id into v_seller from public.cars where id = v_l.car_id;
  perform public._notify(v_seller, 'auction_cancelled', jsonb_build_object('auction', p_auction, 'reason', v_reason));
  if v_a.high_bidder_id is not null then
    perform public._notify(v_a.high_bidder_id, 'auction_cancelled', jsonb_build_object('auction', p_auction, 'reason', v_reason));
  end if;
  perform public._audit('admin_auction_cancelled', 'auction', p_auction::text, jsonb_build_object('reason', v_reason));
end $$;

-- Stavkani o'chirish mumkin emas; admin faqat sababi bilan BEKOR qila oladi (jurnalga yoziladi)
create function public.admin_void_bid(p_bid uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles := public._require_admin(); v_reason text := public._require_reason(p_reason); v_b public.bids; v_a public.auctions;
begin
  select * into v_b from public.bids where id = p_bid;
  if v_b.id is null then perform public._err('bid_not_found'); end if;
  select * into v_a from public.auctions where listing_id = v_b.auction_id for update;
  if v_a.finalized_at is not null then perform public._err('auction_already_finalized'); end if;
  if v_b.status <> 'valid' then perform public._err('bid_already_voided'); end if;
  perform set_config('kc.bid_void', 'on', true);
  update public.bids set status = 'voided', void_reason = v_reason where id = p_bid;
  perform set_config('kc.bid_void', 'off', true);
  perform public._recompute_auction(v_b.auction_id);
  perform public._audit('admin_bid_voided', 'bid', p_bid::text,
    jsonb_build_object('auction', v_b.auction_id, 'amount_usd_cents', v_b.amount_usd_cents, 'bidder', v_b.bidder_id, 'reason', v_reason));
end $$;

create function public.admin_mark_winner_default(p_auction uuid, p_reason text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles := public._require_admin(); v_reason text := public._require_reason(p_reason);
begin
  return public._handle_winner_default(p_auction, v_reason);
end $$;

create function public.admin_update_settings(p_patch jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles := public._require_admin(); v_old jsonb; v_key text;
begin
  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key not in ('min_bid_usd_cents', 'max_bid_usd_cents', 'bid_increment_usd_cents', 'auction_duration', 'anti_snipe_enabled',
                     'anti_snipe_window', 'anti_snipe_extend', 'winner_completion_period', 'relist_policy', 'require_verified_bidder',
                     'require_verified_seller', 'max_bids_per_minute', 'fx_max_age', 'deposit_required', 'deposit_usd_cents', 'deposit_terms') then
      perform public._err('unknown_setting');
    end if;
  end loop;
  select to_jsonb(s) into v_old from public.settings s;
  update public.settings s set
    min_bid_usd_cents = coalesce((p_patch ->> 'min_bid_usd_cents')::bigint, s.min_bid_usd_cents),
    max_bid_usd_cents = coalesce((p_patch ->> 'max_bid_usd_cents')::bigint, s.max_bid_usd_cents),
    bid_increment_usd_cents = coalesce((p_patch ->> 'bid_increment_usd_cents')::bigint, s.bid_increment_usd_cents),
    auction_duration = coalesce((p_patch ->> 'auction_duration')::interval, s.auction_duration),
    anti_snipe_enabled = coalesce((p_patch ->> 'anti_snipe_enabled')::boolean, s.anti_snipe_enabled),
    anti_snipe_window = coalesce((p_patch ->> 'anti_snipe_window')::interval, s.anti_snipe_window),
    anti_snipe_extend = coalesce((p_patch ->> 'anti_snipe_extend')::interval, s.anti_snipe_extend),
    winner_completion_period = coalesce((p_patch ->> 'winner_completion_period')::interval, s.winner_completion_period),
    relist_policy = coalesce(p_patch ->> 'relist_policy', s.relist_policy),
    require_verified_bidder = coalesce((p_patch ->> 'require_verified_bidder')::boolean, s.require_verified_bidder),
    require_verified_seller = coalesce((p_patch ->> 'require_verified_seller')::boolean, s.require_verified_seller),
    max_bids_per_minute = coalesce((p_patch ->> 'max_bids_per_minute')::int, s.max_bids_per_minute),
    fx_max_age = coalesce((p_patch ->> 'fx_max_age')::interval, s.fx_max_age),
    deposit_required = coalesce((p_patch ->> 'deposit_required')::boolean, s.deposit_required),
    deposit_usd_cents = coalesce((p_patch ->> 'deposit_usd_cents')::bigint, s.deposit_usd_cents),
    deposit_terms = coalesce(p_patch -> 'deposit_terms', s.deposit_terms),
    updated_at = now();
  perform public._audit('admin_settings_updated', 'settings', 'settings', jsonb_build_object('old', v_old, 'patch', p_patch));
end $$;

create function public.admin_set_fx_rate(p_quote char(3), p_rate numeric)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles := public._require_admin();
begin
  if p_rate is null or p_rate <= 0 then perform public._err('invalid_rate'); end if;
  insert into public.fx_rates (quote, rate, set_by) values (p_quote, p_rate, me.id);
  perform public._audit('admin_fx_rate_set', 'fx_rate', p_quote, jsonb_build_object('rate', p_rate));
end $$;

create function public.submit_verification(p_doc_type text, p_doc_path text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles := public._me(); v_id uuid;
begin
  insert into public.verification_requests (user_id, doc_type, doc_path) values (me.id, p_doc_type, p_doc_path) returning id into v_id;
  update public.profiles set verification = 'pending' where id = me.id and verification <> 'verified';
  perform public._audit('verification_submitted', 'profile', me.id::text, jsonb_build_object('request', v_id, 'doc_type', p_doc_type));
  return v_id;
end $$;

create function public.admin_decide_verification(p_request uuid, p_approve boolean, p_note text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles := public._require_admin(); v_r public.verification_requests;
begin
  select * into v_r from public.verification_requests where id = p_request for update;
  if v_r.id is null or v_r.status <> 'pending' then perform public._err('request_not_pending'); end if;
  update public.verification_requests set status = case when p_approve then 'verified' else 'rejected' end::public.verification_status,
         admin_note = p_note, decided_at = now(), decided_by = me.id where id = p_request;
  update public.profiles set verification = case when p_approve then 'verified' else 'rejected' end::public.verification_status
   where id = v_r.user_id;
  perform public._notify(v_r.user_id, case when p_approve then 'verification_approved' else 'verification_rejected' end, jsonb_build_object('note', p_note));
  perform public._audit('admin_verification_decided', 'profile', v_r.user_id::text,
    jsonb_build_object('request', p_request, 'approved', p_approve, 'note', p_note));
end $$;

create function public.admin_set_user_blocked(p_user uuid, p_blocked boolean, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles := public._require_admin(); v_reason text := public._require_reason(p_reason);
begin
  if p_user = me.id then perform public._err('forbidden'); end if;
  update public.profiles set blocked = p_blocked where id = p_user;
  perform public._audit(case when p_blocked then 'admin_user_blocked' else 'admin_user_unblocked' end, 'profile', p_user::text,
    jsonb_build_object('reason', v_reason));
end $$;

-- Depozitni qaytarish/ushlab qolish FAQAT qo'lda, sababi bilan (avtomatik siyosat huquqiy tekshiruvgacha o'chiq)
create function public.admin_settle_deposit(p_deposit uuid, p_status text, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles := public._require_admin(); v_reason text := public._require_reason(p_reason); v_d public.deposits;
begin
  if p_status not in ('refunded', 'forfeited') then perform public._err('invalid_status'); end if;
  select * into v_d from public.deposits where id = p_deposit for update;
  if v_d.id is null or v_d.status not in ('paid', 'refund_requested') then perform public._err('deposit_not_paid'); end if;
  update public.deposits set status = p_status where id = p_deposit;
  perform public._audit('admin_deposit_' || p_status, 'deposit', p_deposit::text, jsonb_build_object('reason', v_reason, 'amount', v_d.amount_usd_cents));
end $$;

-- Sotuvchi o'z rezerv narxini ko'radi (boshqalar ko'rmaydi)
create function public.my_reserve(p_auction uuid)
returns bigint language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me public.profiles := public._me(); v bigint; v_seller uuid;
begin
  select a.reserve_usd_cents, c.seller_id into v, v_seller
    from public.auctions a join public.listings l on l.id = a.listing_id join public.cars c on c.id = l.car_id
   where a.listing_id = p_auction;
  if v_seller is distinct from me.id and me.role <> 'admin' then perform public._err('forbidden'); end if;
  return v;
end $$;
