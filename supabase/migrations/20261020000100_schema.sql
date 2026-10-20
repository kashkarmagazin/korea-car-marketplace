-- Korea Car Marketplace: sxema.
-- Pul qiymatlari BUTUN SON (minor units) sifatida saqlanadi: USD -> sent, KRW -> von (0 kasr), KGS -> tiyin.
-- Hech qanday hisob float'da qilinmaydi.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- foydalanuvchilar
create type public.user_role as enum ('user', 'admin');
create type public.verification_status as enum ('unverified', 'pending', 'verified', 'rejected');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  phone text,
  role public.user_role not null default 'user',
  verification public.verification_status not null default 'unverified',
  blocked boolean not null default false,
  lang text not null default 'uz' check (lang in ('uz', 'ru', 'ky')),
  created_at timestamptz not null default now()
);

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, nullif(new.raw_user_meta_data ->> 'full_name', ''));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create table public.verification_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  doc_type text not null check (doc_type in ('passport', 'id_card', 'driver_license', 'business_registration')),
  doc_path text not null,              -- Storage'dagi fayl yo'li (yopiq bucket)
  status public.verification_status not null default 'pending',
  admin_note text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references public.profiles (id)
);

-- ---------------------------------------------------------------- valyuta
create table public.currencies (
  code char(3) primary key,
  minor_units smallint not null check (minor_units between 0 and 3)
);
insert into public.currencies values ('USD', 2), ('KRW', 0), ('KGS', 2), ('UZS', 2), ('RUB', 2);

-- rate = 1 USD necha QUOTE birligiga teng (asosiy birlikda, masalan 1 USD = 1387.25 KRW)
create table public.fx_rates (
  id bigint generated always as identity primary key,
  quote char(3) not null references public.currencies (code) check (quote <> 'USD'),
  rate numeric(20, 8) not null check (rate > 0),
  fetched_at timestamptz not null default now(),
  set_by uuid references public.profiles (id)
);
create index fx_rates_quote_time on public.fx_rates (quote, fetched_at desc);

-- ---------------------------------------------------------------- admin sozlamalari (bitta qator)
create table public.settings (
  id boolean primary key default true check (id),
  -- Stavka chegarasi: 100–6000 USD (qat'iy). Admin faqat shu oraliq ichida toraytira oladi.
  min_bid_usd_cents bigint not null default 10000,
  max_bid_usd_cents bigint not null default 600000,
  bid_increment_usd_cents bigint not null default 5000,
  auction_duration interval not null default interval '72 hours',
  anti_snipe_enabled boolean not null default true,
  anti_snipe_window interval not null default interval '2 minutes',
  anti_snipe_extend interval not null default interval '2 minutes',
  winner_completion_period interval not null default interval '3 days',
  relist_policy text not null default 'manual' check (relist_policy in ('manual', 'auto_relist', 'offer_runner_up')),
  require_verified_bidder boolean not null default true,
  require_verified_seller boolean not null default true,
  max_bids_per_minute integer not null default 5 check (max_bids_per_minute between 1 and 60),
  fx_max_age interval not null default interval '24 hours',
  deposit_required boolean not null default false,
  deposit_usd_cents bigint not null default 0 check (deposit_usd_cents >= 0),
  deposit_terms jsonb not null default '{"uz":"","ru":"","ky":""}'::jsonb,
  -- Depozitni avtomatik ushlab qolish/qaytarish huquqiy tekshiruvsiz YOQILMAYDI
  deposit_auto_settlement boolean not null default false check (deposit_auto_settlement = false),
  updated_at timestamptz not null default now(),
  constraint bid_bounds check (
    min_bid_usd_cents >= 10000 and max_bid_usd_cents <= 600000 and min_bid_usd_cents < max_bid_usd_cents
    and min_bid_usd_cents % 100 = 0 and max_bid_usd_cents % 100 = 0),
  constraint increment_ok check (bid_increment_usd_cents >= 100 and bid_increment_usd_cents % 100 = 0),
  constraint durations_ok check (auction_duration > interval '0' and anti_snipe_window >= interval '0'
    and anti_snipe_extend >= interval '0' and winner_completion_period > interval '0')
);
insert into public.settings default values;

-- ---------------------------------------------------------------- avtomobillar va e'lonlar
create table public.cars (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.profiles (id),
  make text not null check (length(trim(make)) between 1 and 60),
  model text not null check (length(trim(model)) between 1 and 60),
  year integer check (year between 1950 and 2100),
  mileage_km integer check (mileage_km >= 0),
  vin text,
  damage text not null default 'unknown' check (damage in ('none', 'minor', 'moderate', 'severe', 'flood', 'unknown')),
  damage_notes text,
  photos text[] not null default '{}',
  currency char(3) not null default 'USD' references public.currencies (code),
  status text not null default 'draft' check (status in ('draft', 'listed', 'sold', 'withdrawn')),
  created_at timestamptz not null default now()
);

-- Bitta avtomobil bir vaqtda faqat BITTA ochiq e'londa bo'la oladi (sotuv YOKI auksion).
create table public.listings (
  id uuid primary key default gen_random_uuid(),
  car_id uuid not null references public.cars (id),
  kind text not null check (kind in ('sale', 'auction')),
  status text not null default 'active'
    check (status in ('active', 'paused', 'pending_completion', 'sold', 'ended_no_sale', 'cancelled')),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create unique index listings_one_open_per_car on public.listings (car_id)
  where status in ('active', 'paused', 'pending_completion');

-- Oddiy sotuv
create table public.sale_listings (
  listing_id uuid primary key references public.listings (id),
  price_minor bigint not null check (price_minor > 0),   -- avtomobil valyutasida
  negotiable boolean not null default true
);

create table public.offers (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.sale_listings (listing_id),
  buyer_id uuid not null references public.profiles (id),
  amount_minor bigint not null check (amount_minor > 0),
  kind text not null check (kind in ('offer', 'buy_now')),
  message text check (length(message) <= 1000),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected', 'withdrawn')),
  created_at timestamptz not null default now(),
  responded_at timestamptz
);
create unique index offers_one_accepted on public.offers (listing_id) where status = 'accepted';

-- Auksion
create table public.auctions (
  listing_id uuid primary key references public.listings (id),
  start_price_usd_cents bigint not null,
  reserve_usd_cents bigint,                             -- sotuvchining yashirin minimal narxi
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  original_ends_at timestamptz not null,
  extensions integer not null default 0,
  paused_at timestamptz,
  high_bid_id uuid,
  high_usd_cents bigint,
  high_bidder_id uuid,
  bid_count integer not null default 0,
  bidder_count integer not null default 0,
  deposit_usd_cents bigint not null default 0,          -- boshlanishda sozlamadan nusxa olinadi
  deposit_terms jsonb not null default '{}'::jsonb,
  result text check (result in ('reserve_met', 'reserve_not_met', 'no_bids', 'winner_defaulted', 'completed', 'cancelled')),
  winner_id uuid references public.profiles (id),
  winner_deadline timestamptz,
  finalized_at timestamptz,
  relist_of uuid references public.auctions (listing_id),
  constraint auction_times check (ends_at > starts_at and original_ends_at > starts_at),
  constraint reserve_ge_start check (reserve_usd_cents is null or reserve_usd_cents >= start_price_usd_cents)
);
create index auctions_due on public.auctions (ends_at) where finalized_at is null;

create table public.bids (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  auction_id uuid not null references public.auctions (listing_id),
  bidder_id uuid not null references public.profiles (id),
  amount_usd_cents bigint not null check (amount_usd_cents > 0),
  car_currency char(3) not null references public.currencies (code),
  fx_rate numeric(20, 8) not null check (fx_rate > 0),   -- USD bo'lsa 1
  amount_car_minor bigint not null check (amount_car_minor > 0),
  status text not null default 'valid' check (status in ('valid', 'voided')),
  void_reason text,
  created_at timestamptz not null default clock_timestamp()
);
create unique index bids_unique_valid_amount on public.bids (auction_id, amount_usd_cents) where status = 'valid';
create index bids_auction_seq on public.bids (auction_id, seq);
create index bids_bidder_time on public.bids (bidder_id, created_at);

-- Depozit: faqat real to'lov provayderi tasdiqlagandan keyin 'paid'
create table public.deposits (
  id uuid primary key default gen_random_uuid(),
  auction_id uuid not null references public.auctions (listing_id),
  user_id uuid not null references public.profiles (id),
  amount_usd_cents bigint not null check (amount_usd_cents > 0),
  status text not null default 'pending' check (status in ('pending', 'paid', 'refund_requested', 'refunded', 'forfeited')),
  provider text,
  provider_ref text unique,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  unique (auction_id, user_id)
);

-- Bildirishnomalar navbati (yuboruvchi servis — Telegram/SMS/email — alohida ulanadi)
create table public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id),
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  read_at timestamptz
);
create index notifications_user on public.notifications (user_id, created_at desc);

-- Audit jurnali: faqat qo'shiladi, o'zgartirilmaydi va o'chirilmaydi
create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default clock_timestamp(),
  actor uuid,
  action text not null,
  entity text not null,
  entity_id text,
  data jsonb not null default '{}'::jsonb
);
create index audit_entity on public.audit_log (entity, entity_id);
