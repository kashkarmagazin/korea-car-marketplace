-- Real Supabase bazasida to'liq auksion jarayoni. Oxirida ATAYLAB xato tashlanadi -> hammasi ROLLBACK, ma'lumot qolmaydi.
do $$
declare
  s uuid := gen_random_uuid(); b1 uuid := gen_random_uuid(); b2 uuid := gen_random_uuid();
  v_car uuid; v_a uuid; r jsonb; out text := ''; ok int := 0; bad int := 0; v_txt text; v_n int;
  procedure_dummy int;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (s, 'kc-s-' || s || '@test.invalid', '{}'), (b1, 'kc-b1-' || b1 || '@test.invalid', '{}'), (b2, 'kc-b2-' || b2 || '@test.invalid', '{}');
  update public.profiles set verification = 'verified', full_name = 'Test ' || left(id::text, 4), phone = '+996 700 000 00' || (case id when s then '1' when b1 then '2' else '3' end)
   where id in (s, b1, b2);

  -- sotuvchi nomidan
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', s, 'role', 'authenticated')::text, true);
  insert into public.cars (seller_id, make, model, year, damage, currency) values (s, 'Hyundai', 'Avante', 2020, 'none', 'USD') returning id into v_car;
  v_a := public.create_auction(v_car, 10000, 30000);
  select extract(epoch from ends_at - starts_at)::int into v_n from public.auctions where listing_id = v_a;
  if v_n = 259200 then ok := ok + 1; out := out || ' [72h OK]'; else bad := bad + 1; out := out || ' [72h FAIL ' || v_n || ']'; end if;
  begin perform public.place_bid(v_a, 10000); bad := bad + 1; out := out || ' [own_bid FAIL]';
  exception when others then if sqlerrm like 'KC:own_auction' then ok := ok + 1; out := out || ' [own_bid rad OK]'; else raise; end if; end;

  -- b1
  perform set_config('request.jwt.claims', json_build_object('sub', b1, 'role', 'authenticated')::text, true);
  begin perform public.place_bid(v_a, 9900); bad := bad + 1;
  exception when others then if sqlerrm = 'KC:amount_out_of_range' then ok := ok + 1; out := out || ' [99 rad OK]'; else raise; end if; end;
  begin perform public.place_bid(v_a, 600100); bad := bad + 1;
  exception when others then if sqlerrm = 'KC:amount_out_of_range' then ok := ok + 1; out := out || ' [6001 rad OK]'; else raise; end if; end;
  r := public.place_bid(v_a, 10000);
  if (r ->> 'high_usd_cents')::int = 10000 then ok := ok + 1; out := out || ' [100 qabul OK]'; else bad := bad + 1; end if;
  begin perform reserve_usd_cents from public.auctions where listing_id = v_a; bad := bad + 1; out := out || ' [reserve ochiq FAIL]';
  exception when insufficient_privilege then ok := ok + 1; out := out || ' [reserve yopiq OK]'; end;

  -- b2: past stavka rad, keyin anti-sniping
  perform set_config('request.jwt.claims', json_build_object('sub', b2, 'role', 'authenticated')::text, true);
  begin perform public.place_bid(v_a, 10000); bad := bad + 1;
  exception when others then if sqlerrm = 'KC:not_higher_than_current' then ok := ok + 1; out := out || ' [teng rad OK]'; else raise; end if; end;
  perform set_config('role', 'postgres', true);
  update public.auctions set starts_at = clock_timestamp() - interval '72 hours', ends_at = clock_timestamp() + interval '60 seconds' where listing_id = v_a;
  perform set_config('role', 'authenticated', true);
  r := public.place_bid(v_a, 40000);
  if (r ->> 'extended')::boolean then ok := ok + 1; out := out || ' [anti-snipe OK]'; else bad := bad + 1; out := out || ' [anti-snipe FAIL]'; end if;

  -- muddat o'tdi -> server yakunlaydi
  perform set_config('role', 'postgres', true);
  update public.auctions set ends_at = clock_timestamp() - interval '1 second' where listing_id = v_a;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', b1, 'role', 'authenticated')::text, true);
  v_txt := public.finalize_auction_if_due(v_a);
  if v_txt = 'reserve_met' then ok := ok + 1; out := out || ' [yakun reserve_met OK]'; else bad := bad + 1; out := out || ' [yakun ' || coalesce(v_txt,'null') || ']'; end if;
  begin perform * from public.deal_contacts(v_a); bad := bad + 1; out := out || ' [begona kontakt FAIL]';
  exception when others then if sqlerrm = 'KC:forbidden' then ok := ok + 1; out := out || ' [begona kontakt yopiq OK]'; else raise; end if; end;

  perform set_config('request.jwt.claims', json_build_object('sub', b2, 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.deal_contacts(v_a) where role = 'seller' and phone like '+996%';
  if v_n = 1 then ok := ok + 1; out := out || ' [golib kontakt OK]'; else bad := bad + 1; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', s, 'role', 'authenticated')::text, true);
  perform public.complete_auction_sale(v_a, 'bank_transfer');
  perform set_config('role', 'postgres', true);
  select count(*) into v_n from public.cars where id = v_car and status = 'sold';
  if v_n = 1 then ok := ok + 1; out := out || ' [sotildi OK]'; else bad := bad + 1; end if;
  select count(*) into v_n from public.audit_log where entity_id = v_a::text;
  out := out || ' [audit yozuvlari=' || v_n || ']';

  raise exception 'NATIJA ok=% bad=% :%', ok, bad, out;   -- ataylab: ROLLBACK
end $$;
