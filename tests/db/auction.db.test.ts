// Auksion qoidalari: chegaralar, oshirish qadami, concurrency, 72 soat, anti-sniping, rezerv, g'olib sukuti.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { asService, asUser, createAuction, createUser, expectKc, pool, resetDb, rpc, setEndsAt } from "./helpers";

let p: pg.Pool;
let seller: string, b1: string, b2: string, b3: string;

beforeAll(async () => {
  await resetDb();
  p = pool();
});
afterAll(async () => p.end());

beforeEach(async () => {
  seller = await createUser(p);
  b1 = await createUser(p);
  b2 = await createUser(p);
  b3 = await createUser(p);
  // Har test toza sozlamalar bilan (superuser — trigger baribir jurnalga yozadi)
  await p.query(`update public.settings set min_bid_usd_cents = 10000, max_bid_usd_cents = 600000, bid_increment_usd_cents = 5000,
    anti_snipe_enabled = true, anti_snipe_window = '2 minutes', anti_snipe_extend = '2 minutes', relist_policy = 'manual',
    max_bids_per_minute = 60, require_verified_bidder = true, deposit_required = false, auction_duration = '72 hours'`);
});

const bid = (uid: string, a: string, cents: number) => rpc(p, uid, "place_bid", a, cents);

describe("1. 100 / 6000 USD chegaralari", () => {
  it("aniq 100 USD (boshlang'ich) va aniq 6000 USD qabul qilinadi", async () => {
    const { id } = await createAuction(p, seller, 10000);
    const r1 = await bid(b1, id, 10000);
    expect(r1.high_usd_cents).toBe(10000);
    const r2 = await bid(b2, id, 600000);
    expect(r2.high_usd_cents).toBe(600000);
  });

  it("99 USD, 99.99 USD va 6000.01 / 6001 USD rad etiladi; butun dollar bo'lmasa rad", async () => {
    const { id } = await createAuction(p, seller, 10000);
    expect(await expectKc(bid(b1, id, 9900))).toBe("amount_out_of_range");
    expect(await expectKc(bid(b1, id, 9999))).toBe("amount_out_of_range");
    expect(await expectKc(bid(b1, id, 600001))).toBe("amount_out_of_range");
    expect(await expectKc(bid(b1, id, 600100))).toBe("amount_out_of_range");
    expect(await expectKc(bid(b1, id, 15050))).toBe("whole_dollars_only");
  });

  it("boshlang'ich narx ham 100–6000 oralig'ida bo'lishi shart; rezerv < boshlang'ich bo'lmaydi", async () => {
    const car1 = (await createAuction(p, seller, 10000)).car;
    void car1;
    const { car } = await createAuction(p, seller, 20000);
    void car;
    const s2 = await createUser(p);
    const mk = async (start: number, reserve: number | null) => {
      const c = await asUser(p, s2, async (x) =>
        (await x.query("insert into public.cars (seller_id, make, model) values ($1,'Kia','K5') returning id", [s2])).rows[0].id);
      return rpc(p, s2, "create_auction", c, start, reserve);
    };
    expect(await expectKc(mk(9900, null))).toBe("start_price_out_of_range");
    expect(await expectKc(mk(600100, null))).toBe("start_price_out_of_range");
    expect(await expectKc(mk(50000, 40000))).toBe("reserve_out_of_range");
    expect(await expectKc(mk(50000, 700000))).toBe("reserve_out_of_range");
  });

  it("admin chegarani 100–6000 dan tashqariga kengaytira olmaydi", async () => {
    const admin = await createUser(p, { admin: true });
    await expect(rpc(p, admin, "admin_update_settings", JSON.stringify({ min_bid_usd_cents: 5000 }))).rejects.toThrow(/bid_bounds/);
    await expect(rpc(p, admin, "admin_update_settings", JSON.stringify({ max_bid_usd_cents: 700000 }))).rejects.toThrow(/bid_bounds/);
  });
});

describe("2. Joriy eng yuqori stavkadan past yoki teng taklif", () => {
  it("boshlang'ich narxdan past, joriy stavkaga teng, va qadamdan kichik oshirish rad etiladi", async () => {
    const { id } = await createAuction(p, seller, 50000);
    expect(await expectKc(bid(b1, id, 40000))).toBe("below_start_price");
    await bid(b1, id, 50000);
    expect(await expectKc(bid(b2, id, 50000))).toBe("not_higher_than_current");
    expect(await expectKc(bid(b2, id, 30000))).toBe("not_higher_than_current");
    expect(await expectKc(bid(b2, id, 54900))).toBe("below_min_increment"); // qadam 50 USD
    const ok = await bid(b2, id, 55000);
    expect(ok.high_usd_cents).toBe(55000);
  });

  it("boshlang'ich narx, rezerv va oshirish qadami — alohida tushunchalar", async () => {
    const admin = await createUser(p, { admin: true });
    await rpc(p, admin, "admin_update_settings", JSON.stringify({ bid_increment_usd_cents: 20000 }));
    const { id } = await createAuction(p, seller, 10000, 300000);
    await bid(b1, id, 10000);                                         // boshlang'ich narxda
    expect(await expectKc(bid(b2, id, 29900))).toBe("below_min_increment");
    await bid(b2, id, 30000);                                         // +200 qadam
    const row = (await p.query("select * from public.auctions_public where auction_id = $1", [id])).rows[0];
    expect(row.reserve_met).toBe(false);                               // rezerv (3000) hali bajarilmagan
    expect(row).not.toHaveProperty("reserve_usd_cents");               // rezerv qiymati ochiq emas
    expect(Number(row.high_usd_cents)).toBe(30000);
  });
});

describe("3. Bir vaqtdagi stavkalar (concurrency)", () => {
  it("30 ta parallel stavka: noto'g'ri g'olib yo'q, qabul qilinganlar qat'iy o'sib boradi", async () => {
    const { id } = await createAuction(p, seller, 10000);
    const bidders = await Promise.all(Array.from({ length: 30 }, () => createUser(p)));
    // Ko'pchiligi bir xil miqdorni bir vaqtda beradi — faqat bittasi o'tishi kerak
    const amounts = bidders.map((_, i) => 10000 + Math.floor(i / 3) * 5000);
    const results = await Promise.allSettled(bidders.map((u, i) => bid(u, id, amounts[i])));
    const accepted = (await p.query(
      "select bidder_id, amount_usd_cents::int as a from public.bids where auction_id = $1 and status = 'valid' order by seq", [id])).rows;
    // seq tartibida qat'iy o'sish (hech qachon pastroq stavka keyin qabul qilinmagan)
    for (let i = 1; i < accepted.length; i++) expect(accepted[i].a).toBeGreaterThanOrEqual(accepted[i - 1].a + 5000);
    const a = (await p.query("select * from public.auctions where listing_id = $1", [id])).rows[0];
    const max = Math.max(...accepted.map((r) => r.a));
    expect(Number(a.high_usd_cents)).toBe(max);
    expect(a.high_bidder_id).toBe(accepted[accepted.length - 1].bidder_id);
    expect(a.bid_count).toBe(accepted.length);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(accepted.length);
    // Haqiqiy raqobat bo'lgan: bir xil miqdorlar tufayli ko'p stavka rad etilgan
    expect(accepted.length).toBeLessThan(30);
    expect(accepted.length).toBeGreaterThanOrEqual(1);
    // Bir xil miqdorda ikkita haqiqiy stavka yo'q
    expect(new Set(accepted.map((r) => r.a)).size).toBe(accepted.length);
  });

  it("ikki xaridor aynan bir xil miqdorni bir vaqtda beradi — faqat bittasi qabul qilinadi", async () => {
    const { id } = await createAuction(p, seller, 10000);
    const r = await Promise.allSettled([bid(b1, id, 20000), bid(b2, id, 20000)]);
    expect(r.filter((x) => x.status === "fulfilled").length).toBe(1);
    const rej = r.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(rej.reason.message).toMatch(/not_higher_than_current/);
  });
});

describe("4. 72 soatlik taymer va yakunlash", () => {
  it("tugash vaqti serverda: aniq starts_at + 72 soat (UTC timestamptz)", async () => {
    const { id } = await createAuction(p, seller);
    const a = (await p.query("select starts_at, ends_at, extract(epoch from ends_at - starts_at) as secs from public.auctions where listing_id = $1", [id])).rows[0];
    expect(Number(a.secs)).toBe(72 * 3600);
  });

  it("72 soat o'tgach stavka rad etiladi va server natijani aniqlaydi", async () => {
    const { id } = await createAuction(p, seller, 10000);
    await bid(b1, id, 10000);
    await bid(b2, id, 20000);
    // "72 soat o'tdi": boshlanishni 72 soat ortga suramiz
    await p.query("update public.auctions set starts_at = starts_at - interval '72 hours 1 second', ends_at = ends_at - interval '72 hours 1 second' where listing_id = $1", [id]);
    expect(await expectKc(bid(b3, id, 30000))).toBe("auction_ended");
    const n = await asService(p, async (c) => (await c.query("select public.finalize_due_auctions() as n")).rows[0].n);
    expect(n).toBeGreaterThanOrEqual(1);
    const a = (await p.query("select a.*, l.status from public.auctions a join public.listings l on l.id = a.listing_id where a.listing_id = $1", [id])).rows[0];
    expect(a.result).toBe("reserve_met");          // rezerv yo'q
    expect(a.winner_id).toBe(b2);
    expect(a.status).toBe("pending_completion");    // shartli g'olib, sotuv hali yakunlanmagan
    const notif = (await p.query("select user_id, kind from public.notifications where payload->>'auction' = $1", [id])).rows;
    expect(notif).toEqual(expect.arrayContaining([{ user_id: b2, kind: "auction_won" }, { user_id: seller, kind: "auction_sold_pending" }]));
  });

  it("tugamagan auksionni hech kim yakunlay olmaydi (finalize_auction_if_due hech narsa qilmaydi)", async () => {
    const { id } = await createAuction(p, seller);
    expect(await rpc(p, b1, "finalize_auction_if_due", id)).toBeNull();
    expect((await p.query("select result from public.auctions where listing_id = $1", [id])).rows[0].result).toBeNull();
  });

  it("stavkasiz auksion: 'no_bids', avtomobil sotilmagan", async () => {
    const { id, car } = await createAuction(p, seller);
    await setEndsAt(p, id, "clock_timestamp() - interval '1 second'");
    expect(await rpc(p, b1, "finalize_auction_if_due", id)).toBe("no_bids");
    expect((await p.query("select status from public.cars where id = $1", [car])).rows[0].status).toBe("draft");
  });
});

describe("5. Anti-sniping", () => {
  it("oxirgi 2 daqiqada stavka -> tugash 2 daqiqaga uzayadi va takrorlanadi", async () => {
    const { id } = await createAuction(p, seller, 10000);
    await setEndsAt(p, id, "clock_timestamp() + interval '60 seconds'");
    const r1 = await bid(b1, id, 10000);
    expect(r1.extended).toBe(true);
    const secs1 = (await p.query("select extract(epoch from ends_at - clock_timestamp()) s from public.auctions where listing_id=$1", [id])).rows[0].s;
    expect(Number(secs1)).toBeGreaterThan(115);
    expect(Number(secs1)).toBeLessThanOrEqual(120);
    await setEndsAt(p, id, "clock_timestamp() + interval '30 seconds'");
    const r2 = await bid(b2, id, 15000);
    expect(r2.extended).toBe(true);
    const a = (await p.query("select extensions from public.auctions where listing_id=$1", [id])).rows[0];
    expect(a.extensions).toBe(2);
    const log = (await p.query("select count(*)::int n from public.audit_log where action='auction_extended_anti_snipe' and entity_id=$1", [id])).rows[0].n;
    expect(log).toBe(2);
  });

  it("oxirgi oynadan tashqaridagi stavka uzaytirmaydi; admin o'chirsa — uzaytirilmaydi", async () => {
    const { id } = await createAuction(p, seller, 10000);
    const r = await bid(b1, id, 10000);
    expect(r.extended).toBe(false);
    const admin = await createUser(p, { admin: true });
    await rpc(p, admin, "admin_update_settings", JSON.stringify({ anti_snipe_enabled: false }));
    await setEndsAt(p, id, "clock_timestamp() + interval '30 seconds'");
    expect((await bid(b2, id, 15000)).extended).toBe(false);
  });
});

describe("6. Rezerv narx bajarilmasligi", () => {
  it("rezerv bajarilmasa avtomobil sotilgan deb belgilanmaydi", async () => {
    const { id, car } = await createAuction(p, seller, 10000, 400000);
    await bid(b1, id, 10000);
    await bid(b2, id, 300000);
    await setEndsAt(p, id, "clock_timestamp() - interval '1 second'");
    expect(await rpc(p, b3, "finalize_auction_if_due", id)).toBe("reserve_not_met");
    const row = (await p.query(
      "select a.result, a.winner_id, l.status ls, c.status cs from public.auctions a join public.listings l on l.id=a.listing_id join public.cars c on c.id=l.car_id where a.listing_id=$1", [id])).rows[0];
    expect(row).toMatchObject({ result: "reserve_not_met", winner_id: null, ls: "ended_no_sale", cs: "draft" });
    expect(car).toBeTruthy();
    expect(await expectKc(rpc(p, seller, "complete_auction_sale", id, "bank_transfer"))).toBe("no_pending_winner");
  });

  it("rezerv aynan bajarilsa — shartli g'olib", async () => {
    const { id } = await createAuction(p, seller, 10000, 200000);
    await bid(b1, id, 200000);
    await setEndsAt(p, id, "clock_timestamp() - interval '1 second'");
    expect(await rpc(p, b3, "finalize_auction_if_due", id)).toBe("reserve_met");
  });
});

describe("7. G'olib xaridni yakunlamasligi", () => {
  async function wonAuction(reserve: number | null = null) {
    const { id, car } = await createAuction(p, seller, 10000, reserve);
    await bid(b1, id, 10000);
    await bid(b2, id, 30000);
    await bid(b3, id, 50000);
    await setEndsAt(p, id, "clock_timestamp() - interval '1 second'");
    await rpc(p, b1, "finalize_auction_if_due", id);
    await p.query("update public.auctions set winner_deadline = clock_timestamp() - interval '1 second' where listing_id = $1", [id]);
    return { id, car };
  }

  it("manual qoida: muddat o'tdi -> winner_defaulted, avtomobil sotilmagan, qayta qo'yilmaydi", async () => {
    const { id, car } = await wonAuction();
    expect(await expectKc(rpc(p, seller, "complete_auction_sale", id, "bank_transfer"))).toBe("winner_deadline_passed");
    await asService(p, (c) => c.query("select public.process_winner_defaults()"));
    const a = (await p.query("select result from public.auctions where listing_id=$1", [id])).rows[0];
    expect(a.result).toBe("winner_defaulted");
    expect((await p.query("select status from public.cars where id=$1", [car])).rows[0].status).toBe("draft");
    expect((await p.query("select count(*)::int n from public.listings where car_id=$1", [car])).rows[0].n).toBe(1);
  });

  it("auto_relist qoidasi: yangi 72 soatlik auksion ochiladi", async () => {
    await p.query("update public.settings set relist_policy = 'auto_relist'");
    const { id, car } = await wonAuction();
    await asService(p, (c) => c.query("select public.process_winner_defaults()"));
    const ls = (await p.query("select l.id, l.status, a.relist_of from public.listings l left join public.auctions a on a.listing_id=l.id where car_id=$1 order by l.created_at", [car])).rows;
    expect(ls).toHaveLength(2);
    expect(ls[1]).toMatchObject({ status: "active", relist_of: id });
  });

  it("offer_runner_up qoidasi: keyingi eng yuqori (boshqa) ishtirokchi g'olib bo'ladi", async () => {
    await p.query("update public.settings set relist_policy = 'offer_runner_up'");
    const { id } = await wonAuction();
    await asService(p, (c) => c.query("select public.process_winner_defaults()"));
    const a = (await p.query("select result, winner_id from public.auctions where listing_id=$1", [id])).rows[0];
    expect(a).toEqual({ result: "reserve_met", winner_id: b2 });
    // ikkinchisi ham yakunlamadi -> b1
    await p.query("update public.auctions set winner_deadline = clock_timestamp() - interval '1 second' where listing_id = $1", [id]);
    await asService(p, (c) => c.query("select public.process_winner_defaults()"));
    expect((await p.query("select winner_id from public.auctions where listing_id=$1", [id])).rows[0].winner_id).toBe(b1);
  });

  it("muddat ichida sotuvchi yakunlasa — sotildi", async () => {
    const { id, car } = await createAuction(p, seller, 10000);
    await bid(b1, id, 10000);
    await setEndsAt(p, id, "clock_timestamp() - interval '1 second'");
    await rpc(p, b2, "finalize_auction_if_due", id);
    await rpc(p, seller, "complete_auction_sale", id, "bank_transfer");
    expect((await p.query("select status from public.cars where id=$1", [car])).rows[0].status).toBe("sold");
  });
});

describe("Valyuta: USD stavka avtomobil valyutasiga to'g'ri o'tkaziladi", () => {
  it("KRW (0 kasr) va KGS (2 kasr): aniq numeric hisob, kurs snapshot saqlanadi", async () => {
    const admin = await createUser(p, { admin: true });
    await rpc(p, admin, "admin_set_fx_rate", "KRW", "1387.25");
    await rpc(p, admin, "admin_set_fx_rate", "KGS", "87.4512");
    const krw = await createAuction(p, seller, 12300, null, "KRW");
    await bid(b1, krw.id, 123400);                  // 1234.00 USD * 1387.25 = 1 711 866.5 -> 1 711 867 von
    const kgs = await createAuction(p, seller, 10000, null, "KGS");
    await bid(b1, kgs.id, 10000);                    // 100 USD * 87.4512 = 8745.12 som -> 874512 tiyin
    const rows = (await p.query("select car_currency, fx_rate::text, amount_car_minor::text from public.bids where bidder_id=$1 order by seq", [b1])).rows;
    expect(rows).toEqual([
      { car_currency: "KRW", fx_rate: "1387.25000000", amount_car_minor: "1711867" },
      { car_currency: "KGS", fx_rate: "87.45120000", amount_car_minor: "874512" },
    ]);
  });

  it("kurs yo'q yoki eskirgan bo'lsa stavka qabul qilinmaydi (taxmin qilinmaydi)", async () => {
    const r = await createAuction(p, seller, 10000, null, "RUB");
    expect(await expectKc(bid(b1, r.id, 10000))).toBe("fx_rate_unavailable");
    await p.query("insert into public.fx_rates (quote, rate, fetched_at) values ('RUB', 95, now() - interval '25 hours')");
    expect(await expectKc(bid(b1, r.id, 10000))).toBe("fx_rate_unavailable");
  });
});

describe("Taymer va admin to'xtatishi", () => {
  it("pauza vaqtida stavka yo'q; davom ettirilganda qolgan vaqt saqlanadi; jurnalga yoziladi", async () => {
    const admin = await createUser(p, { admin: true });
    const { id } = await createAuction(p, seller);
    const before = (await p.query("select ends_at from public.auctions where listing_id=$1", [id])).rows[0].ends_at as Date;
    await rpc(p, admin, "admin_pause_auction", id, "shubhali faollik");
    expect(await expectKc(bid(b1, id, 10000))).toBe("auction_paused");
    await p.query("update public.auctions set paused_at = paused_at - interval '1 hour' where listing_id=$1", [id]); // 1 soat pauza
    await rpc(p, admin, "admin_resume_auction", id, "tekshirildi");
    const after = (await p.query("select ends_at from public.auctions where listing_id=$1", [id])).rows[0].ends_at as Date;
    expect(after.getTime() - before.getTime()).toBeGreaterThanOrEqual(3600_000);
    const acts = (await p.query("select action from public.audit_log where entity_id=$1 and action like 'admin_%' order by id", [id])).rows.map((r) => r.action);
    expect(acts).toEqual(["admin_auction_paused", "admin_auction_resumed"]);
  });

  it("bekor qilish sababsiz bo'lmaydi va jurnalga yoziladi", async () => {
    const admin = await createUser(p, { admin: true });
    const { id } = await createAuction(p, seller);
    expect(await expectKc(rpc(p, admin, "admin_cancel_auction", id, ""))).toBe("reason_required");
    await rpc(p, admin, "admin_cancel_auction", id, "soxta e'lon");
    const l = (await p.query("select data->>'reason' r, actor from public.audit_log where action='admin_auction_cancelled' and entity_id=$1", [id])).rows[0];
    expect(l).toEqual({ r: "soxta e'lon", actor: admin });
  });
});
