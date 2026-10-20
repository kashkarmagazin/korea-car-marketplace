// Baza testlari uchun lokal PostgreSQL 15 (embedded-postgres: Docker/WSL va admin huquqi kerak emas).
// Ma'lumotlar vaqtinchalik papkada; testlardan keyin server to'xtatiladi va papka o'chiriladi.
import EmbeddedPostgres from "embedded-postgres";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export default async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "korea-car-pg-"));
  const port = await freePort();
  process.env.KC_TEST_DB_PORT = String(port); // helpers.ts shu portga ulanadi
  // Supabase kabi UTF-8 (Windows'da standart WIN1251 bo'lib qoladi)
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: "postgres",
    password: "test",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => undefined,
  });
  await pg.initialise();
  await pg.start();
  return async () => {
    try {
      await pg.stop();
    } catch {
      /* allaqachon to'xtagan */
    }
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      /* Windows fayl qulfi — vaqtinchalik papka OS tomonidan tozalanadi */
    }
  };
}
