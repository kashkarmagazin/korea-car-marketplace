// Ruxsatsiz stavka/admin amallari, firibgarlikka qarshi himoya, o'zgarmas tarix, depozit, oddiy sotuv.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { asService, asUser, createAuction, createCar, createUser, expectKc, pool, resetDb, rpc } from "./helpers";

let p: pg.Pool;
let seller: string, b1: string, b2: string, admin: string;

beforeAll(async () => {
  await resetDb();
  p = pool();
});
afterAll(async () => p.end());
beforeEach(async () => {
  seller = await createUser(p);
  b1 = await createUser(p);
  b2 = await createUser(p);
  admin = await createUser(p, { admin: true });
  await p.query(`update public.settings set max_bids_per_minute = 5, require_verified_bidder = true, deposit_required = false,
                 deposit_usd_cents = 0, bid_increment_usd_cents = 5000`);
});
const bid = (uid: string | null, a: string, cents: number) => rpc(p, uid, "place_bid", a, cents);

describe("8. Ruxsatsiz stavka", () => {
  it("autentifikatsiyasiz (anon) stavka berib bo'lmaydi", async () => {
    const { id } = await createAuction(p, seller);
    await expect(bid(null, id, 10000)).rejects.toThrow(/permission denied/);
  });

  it("JWT bor, lekin profil yo'q (soxta uid) — auth_required", async () => {
    const { id } = await createAuction(p, seller);
    expect(await expectKc(bid("00000000-0000-0000-0000-000000000001", id, 10000))).toBe("auth_required");
  });

  it("bids jadvaliga to'g'ridan-to'g'ri yozib bo'lmaydi", async () => {
    const { id } = await createAuction(p, seller);
    await expect(asUser(p, b1, (c) => c.query(
      "insert into public.bids (auction_id, bidder_id, amount_usd_cents, car_currency, fx_rate, amount_car_minor) values ($1,$2,10000,'USD',1,10000)", [id, b1]))).rejects.toThrow(/permission denied/);
  });

  it("o'z avtomobiliga stavka berib bo'lmaydi", async () => {
    const { id } = await createAuction(p, seller);
    expect(await expectKc(bid(seller, id, 10000))).toBe("own_auction");
  });

  it("tasdiqlanmagan va bloklangan hisob stavka bera olmaydi", async () => {
    const { id } = await createAuction(p, seller);
    const unv = await createUser(p, { verified: false });
    const blk = await createUser(p, { blocked: true });
    expect(await expectKc(bid(unv, id, 10000))).toBe("verification_required");
    expect(await expectKc(bid(blk, id, 10000))).toBe("user_blocked");
  });

  it("o'z stavkasini o'zi oshirish (sun'iy narx) rad etiladi", async () => {
    const { id } = await createAuction(p, seller);
    await bid(b1, id, 10000);
    expect(await expectKc(bid(b1, id, 20000))).toBe("already_highest");
  });

  it("daqiqasiga stavka limiti", async () => {
    const auctions = await Promise.all(Array.from({ length: 6 }, () => createAuction(p, seller)));
    for (let i = 0; i < 5; i++) await bid(b1, auctions[i].id, 10000);
    expect(await expectKc(bid(b1, auctions[5].id, 10000))).toBe("rate_limited");
  });

  it("rezerv narx va eng yuqori stavkachi boshqa foydalanuvchiga ochiq emas", async () => {
    const { id } = await createAuction(p, seller, 10000, 300000);
    await expect(asUser(p, b1, (c) => c.query("select reserve_usd_cents from public.auctions where listing_id=$1", [id]))).rejects.toThrow(/permission denied/);
    await expect(asUser(p, b1, (c) => c.query("select high_bidder_id from public.auctions where listing_id=$1", [id]))).rejects.toThrow(/permission denied/);
    expect(await expectKc(rpc(p, b1, "my_reserve", id))).toBe("forbidden");
    expect(Number(await rpc(p, seller, "my_reserve", id))).toBe(300000);
  });
});

describe("Stavkalar tarixi o'zgarmas", () => {
  it("foydalanuvchi o'z stavkasini o'chira/o'zgartira olmaydi", async () => {
    const { id } = await createAuction(p, seller);
    await bid(b1, id, 10000);
    await expect(asUser(p, b1, (c) => c.query("delete from public.bids where bidder_id=$1", [b1]))).rejects.toThrow(/permission denied/);
    await expect(asUser(p, b1, (c) => c.query("update public.bids set amount_usd_cents = 1 where bidder_id=$1", [b1]))).rejects.toThrow(/permission denied/);
  });

  it("hatto baza egasi (superuser) ham stavkani o'chira yoki miqdorini o'zgartira olmaydi", async () => {
    const { id } = await createAuction(p, seller);
    await bid(b1, id, 10000);
    await expect(p.query("delete from public.bids where auction_id=$1", [id])).rejects.toThrow(/bid_immutable/);
    await expect(p.query("update public.bids set amount_usd_cents = 99900 where auction_id=$1", [id])).rejects.toThrow(/bid_immutable/);
    await expect(p.query("truncate public.bids cascade")).rejects.toThrow(/audit_immutable/);
  });

  it("admin stavkani faqat sababi bilan bekor qiladi; bu jurnalga yoziladi va eng yuqori stavka qayta hisoblanadi", async () => {
    const { id } = await createAuction(p, seller);
    await bid(b1, id, 10000);
    await bid(b2, id, 20000);
    const b2bid = (await p.query("select id from public.bids where bidder_id=$1", [b2])).rows[0].id;
    expect(await expectKc(rpc(p, admin, "admin_void_bid", b2bid, ""))).toBe("reason_required");
    await rpc(p, admin, "admin_void_bid", b2bid, "soxta hisob (shill)");
    const a = (await p.query("select high_usd_cents, high_bidder_id, bid_count, bidder_count from public.auctions where listing_id=$1", [id])).rows[0];
    expect(a).toEqual({ high_usd_cents: "10000", high_bidder_id: b1, bid_count: 1, bidder_count: 1 });
    const hist = (await p.query("select status, void_reason from public.bids where id=$1", [b2bid])).rows[0];
    expect(hist).toEqual({ status: "voided", void_reason: "soxta hisob (shill)" });       // o'chirilmagan, tarixda qoladi
    const log = (await p.query("select actor from public.audit_log where action='admin_bid_voided' and entity_id=$1", [b2bid])).rows;
    expect(log).toEqual([{ actor: admin }]);
  });

  it("audit jurnalini o'zgartirib/o'chirib bo'lmaydi (superuser ham)", async () => {
    await p.query("insert into public.audit_log (action, entity) values ('t','t')");
    await expect(p.query("update public.audit_log set action='x'")).rejects.toThrow(/audit_immutable/);
    await expect(p.query("delete from public.audit_log")).rejects.toThrow(/audit_immutable/);
  });

  it("auksionni to'g'ridan-to'g'ri SQL bilan o'zgartirish ham jurnalga tushadi", async () => {
    const { id } = await createAuction(p, seller);
    await p.query("update public.auctions set ends_at = ends_at + interval '1 day' where listing_id=$1", [id]);
    const r = (await p.query("select data->>'db_user' u from public.audit_log where action='auction_row_changed' and entity_id=$1", [id])).rows;
    expect(r.at(-1)).toEqual({ u: "postgres" });
  });
});

describe("Ruxsatsiz admin amallari", () => {
  it("oddiy foydalanuvchi admin funksiyalarini chaqira olmaydi", async () => {
    const { id } = await createAuction(p, seller);
    for (const [fn, args] of [
      ["admin_pause_auction", [id, "sabab bor"]],
      ["admin_cancel_auction", [id, "sabab bor"]],
      ["admin_update_settings", [JSON.stringify({ bid_increment_usd_cents: 100 })]],
      ["admin_set_fx_rate", ["KRW", "1"]],
      ["admin_set_user_blocked", [b2, true, "sabab bor"]],
    ] as [string, unknown[]][]) {
      expect(await expectKc(rpc(p, b1, fn, ...args))).toBe("forbidden");
    }
  });

  it("foydalanuvchi sozlamalar/kurs jadvallariga to'g'ridan-to'g'ri yoza olmaydi; o'z rolini admin qila olmaydi", async () => {
    await expect(asUser(p, b1, (c) => c.query("update public.settings set bid_increment_usd_cents = 100"))).rejects.toThrow(/permission denied/);
    await expect(asUser(p, b1, (c) => c.query("insert into public.fx_rates (quote, rate) values ('KRW', 1)"))).rejects.toThrow(/permission denied/);
    await expect(asUser(p, b1, (c) => c.query("update public.profiles set role='admin' where id=$1", [b1]))).rejects.toThrow(/permission denied/);
    await expect(asUser(p, b1, (c) => c.query("update public.profiles set verification='verified' where id=$1", [b1]))).rejects.toThrow(/permission denied/);
  });

  it("server funksiyalari (yakunlash, depozit tasdig'i) foydalanuvchiga yopiq", async () => {
    await expect(asUser(p, b1, (c) => c.query("select public.finalize_due_auctions()"))).rejects.toThrow(/permission denied/);
    await expect(asUser(p, b1, (c) => c.query("select public.process_winner_defaults()"))).rejects.toThrow(/permission denied/);
    await expect(asUser(p, b1, (c) => c.query("select public.confirm_deposit_payment(gen_random_uuid(), 'x', 'y', 1)"))).rejects.toThrow(/permission denied/);
  });

  it("admin sozlama o'zgarishi eski/yangi qiymat bilan jurnalga yoziladi", async () => {
    await rpc(p, admin, "admin_update_settings", JSON.stringify({ bid_increment_usd_cents: 10000 }));
    const r = (await p.query("select actor, data->'old'->>'bid_increment_usd_cents' o from public.audit_log where action='admin_settings_updated' order by id desc limit 1")).rows[0];
    expect(r).toEqual({ actor: admin, o: "5000" });
    await rpc(p, admin, "admin_update_settings", JSON.stringify({ bid_increment_usd_cents: 5000 }));
  });
});

describe("Depozit: faqat real provayder tasdig'idan keyin to'langan", () => {
  it("depozit talab qilinsa: so'rov 'pending', mijoz o'zi 'paid' qila olmaydi, stavka rad; provayder tasdig'idan keyin ruxsat", async () => {
    await p.query(`update public.settings set deposit_required = true, deposit_usd_cents = 20000,
                   deposit_terms = '{"uz":"Yutqazsangiz 3 ish kunida qaytariladi","ru":"Возврат за 3 рабочих дня","ky":"3 жумуш күндө кайтарылат"}'`);
    const { id } = await createAuction(p, seller);
    const pub = (await p.query("select deposit_usd_cents, deposit_terms from public.auctions_public where auction_id=$1", [id])).rows[0];
    expect(Number(pub.deposit_usd_cents)).toBe(20000);
    expect(pub.deposit_terms.ru).toMatch(/Возврат/);
    const d = await rpc(p, b1, "request_deposit", id);
    expect(d.status).toBe("pending");
    expect(await expectKc(bid(b1, id, 10000))).toBe("deposit_required");
    await expect(asUser(p, b1, (c) => c.query("update public.deposits set status='paid'"))).rejects.toThrow(/permission denied/);
    // noto'g'ri summa bilan "webhook" — rad
    await expect(asService(p, (c) => c.query("select public.confirm_deposit_payment($1,'stripe','evt_1',100)", [d.deposit]))).rejects.toThrow(/deposit_amount_mismatch/);
    await asService(p, (c) => c.query("select public.confirm_deposit_payment($1,'stripe','evt_1',20000)", [d.deposit]));
    expect((await bid(b1, id, 10000)).high_usd_cents).toBe(10000);
    // avtomatik ushlab qolish/qaytarish siyosatini yoqib bo'lmaydi
    await expect(p.query("update public.settings set deposit_auto_settlement = true")).rejects.toThrow(/deposit_auto_settlement/);
  });
});

describe("Oddiy sotuv va auksion bir-biridan ajratilgan", () => {
  it("sotuvdagi avtomobilni auksionga qo'yib bo'lmaydi (va aksincha)", async () => {
    const car = await createCar(p, seller);
    await rpc(p, seller, "create_sale_listing", car, 1500000, true);
    expect(await expectKc(rpc(p, seller, "create_auction", car, 10000, null))).toBe("car_already_listed");
    const { car: car2 } = await createAuction(p, seller);
    expect(await expectKc(rpc(p, seller, "create_sale_listing", car2, 1000, true))).toBe("car_already_listed");
  });

  it("ikki parallel e'lon so'rovi — faqat bittasi o'tadi", async () => {
    const car = await createCar(p, seller);
    const r = await Promise.allSettled([rpc(p, seller, "create_sale_listing", car, 1000, true), rpc(p, seller, "create_auction", car, 10000, null)]);
    expect(r.filter((x) => x.status === "fulfilled").length).toBe(1);
  });

  it("taklif -> qabul -> yakunlash: avtomobil sotuvdan chiqadi; muzokarasiz e'londa boshqa narx rad", async () => {
    const car = await createCar(p, seller);
    const l = await rpc(p, seller, "create_sale_listing", car, 1500000, true);
    expect(await expectKc(rpc(p, seller, "make_offer", l, 1400000, null))).toBe("own_listing");
    const o = await rpc(p, b1, "make_offer", l, 1400000, "Naqd to'layman");
    await rpc(p, seller, "respond_offer", o, true);
    expect(await expectKc(rpc(p, b2, "start_purchase", l))).toBe("listing_not_active");
    await rpc(p, seller, "complete_sale", l);
    const s = (await p.query("select l.status ls, c.status cs from public.listings l join public.cars c on c.id=l.car_id where l.id=$1", [l])).rows[0];
    expect(s).toEqual({ ls: "sold", cs: "sold" });

    const car3 = await createCar(p, seller);
    const l3 = await rpc(p, seller, "create_sale_listing", car3, 900000, false);
    expect(await expectKc(rpc(p, b1, "make_offer", l3, 800000, null))).toBe("not_negotiable");
    const buy = await rpc(p, b1, "start_purchase", l3);
    expect(buy).toBeTruthy();
  });

  it("stavkasi bor auksionni sotuvchi qaytarib ololmaydi", async () => {
    const { id } = await createAuction(p, seller);
    await bid(b1, id, 10000);
    expect(await expectKc(rpc(p, seller, "withdraw_listing", id))).toBe("auction_has_bids");
  });
});

describe("Shaxsni tekshirish", () => {
  it("hujjat faqat o'z papkasidan; admin qarori jurnalga yoziladi va stavka huquqini ochadi", async () => {
    const u = await createUser(p, { verified: false });
    expect(await expectKc(rpc(p, u, "submit_verification", "passport", `${b1}/pass.jpg`))).toBe("forbidden");
    const req = await rpc(p, u, "submit_verification", "passport", `${u}/pass.jpg`);
    expect((await p.query("select verification from public.profiles where id=$1", [u])).rows[0].verification).toBe("pending");
    expect(await expectKc(rpc(p, b1, "admin_decide_verification", req, true, null))).toBe("forbidden");
    await rpc(p, admin, "admin_decide_verification", req, true, "pasport mos");
    const { id } = await createAuction(p, seller);
    expect((await bid(u, id, 10000)).high_usd_cents).toBe(10000);
    const log = (await p.query("select actor from public.audit_log where action='admin_verification_decided' and entity_id=$1", [u])).rows;
    expect(log).toEqual([{ actor: admin }]);
  });
});
