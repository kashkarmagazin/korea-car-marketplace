// Baza testlari uchun yordamchilar: toza baza, migratsiyalar, foydalanuvchi nomidan so'rov.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";

const port = () => process.env.KC_TEST_DB_PORT || "54339";
const adminUrl = () => `postgres://postgres:test@127.0.0.1:${port()}/postgres`;
export const dbUrl = (db = "kc_test") => `postgres://postgres:test@127.0.0.1:${port()}/${db}`;
const ROOT = join(__dirname, "..", "..");

export async function resetDb(db = "kc_test"): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`drop database if exists ${db} with (force)`);
  await admin.query(`create database ${db}`);
  await admin.end();

  const c = new pg.Client({ connectionString: dbUrl(db) });
  await c.connect();
  await c.query(readFileSync(join(ROOT, "tests", "db", "auth_stub.sql"), "utf8"));
  const dir = join(ROOT, "supabase", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    try {
      await c.query(readFileSync(join(dir, f), "utf8"));
    } catch (e) {
      throw new Error(`Migratsiya xatosi ${f}: ${(e as Error).message}`);
    }
  }
  await c.end();
}

export const pool = (db?: string, max = 30) => {
  const p = new pg.Pool({ connectionString: dbUrl(db), max });
  p.on("error", () => undefined);
  return p;
};

/** auth.users ga foydalanuvchi qo'shadi (trigger profil yaratadi). */
export async function createUser(
  p: pg.Pool,
  opts: { admin?: boolean; verified?: boolean; blocked?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await p.query("insert into auth.users (id, email) values ($1, $2)", [id, `${id.slice(0, 8)}@test.local`]);
  await p.query("update public.profiles set role = $2, verification = $3, blocked = $4 where id = $1", [
    id,
    opts.admin ? "admin" : "user",
    opts.verified === false ? "unverified" : "verified",
    opts.blocked ?? false,
  ]);
  return id;
}

/** PostgREST'dagidek: authenticated/anon roli + JWT claims bilan bitta tranzaksiya. */
export async function asUser<T>(p: pg.Pool, uid: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await p.connect();
  try {
    await c.query("begin");
    await c.query(`set local role ${uid ? "authenticated" : "anon"}`);
    await c.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(uid ? { sub: uid, role: "authenticated" } : { role: "anon" }),
    ]);
    const r = await fn(c);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** service_role (cron / webhook) nomidan. */
export async function asService<T>(p: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await p.connect();
  try {
    await c.query("begin");
    await c.query("set local role service_role");
    const r = await fn(c);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

export const rpc = async (p: pg.Pool, uid: string | null, fn: string, ...args: unknown[]) => {
  const ph = args.map((_, i) => `$${i + 1}`).join(", ");
  return asUser(p, uid, async (c) => (await c.query(`select public.${fn}(${ph}) as r`, args)).rows[0].r);
};

/** Avtomobil yaratadi (sotuvchi nomidan, RLS orqali). */
export async function createCar(p: pg.Pool, seller: string, currency = "USD"): Promise<string> {
  return asUser(p, seller, async (c) =>
    (await c.query(
      "insert into public.cars (seller_id, make, model, year, damage, currency, photos) values ($1, 'Hyundai', 'Sonata', 2019, 'minor', $2, '{a.jpg}') returning id",
      [seller, currency],
    )).rows[0].id,
  );
}

/** Auksion ochadi; qaytaradi: auction (listing) id. */
export async function createAuction(p: pg.Pool, seller: string, start = 10000, reserve: number | null = null, currency = "USD") {
  const car = await createCar(p, seller, currency);
  const id: string = await rpc(p, seller, "create_auction", car, start, reserve);
  return { id, car };
}

/** Test: auksion tugash vaqtini superuser sifatida siljitish (vaqtni "o'tkazish"). */
export async function setEndsAt(p: pg.Pool, auction: string, sqlExpr: string) {
  // Boshlanish ham mos ravishda suriladi (ends_at > starts_at cheklovi saqlanadi)
  await p.query(`update public.auctions set starts_at = least(starts_at, (${sqlExpr}) - interval '72 hours'), ends_at = ${sqlExpr} where listing_id = $1`, [auction]);
}

export const kcError = (e: unknown) => {
  const m = /KC:([a-z_]+)/.exec((e as Error).message ?? "");
  return m ? m[1] : (e as Error).message;
};

export async function expectKc(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    return kcError(e);
  }
  throw new Error("Xato kutilgan edi, lekin amal muvaffaqiyatli bo'ldi");
}

export const uuid = randomUUID;
