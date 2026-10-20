// Migratsiyalarni Supabase Management API orqali qo'llaydi va supabase_migrations.schema_migrations ga yozadi.
// node scripts/apply-migrations.mjs  (token: ~/.supabase/access-token, ref: ~/.supabase/korea-car-ref.txt)
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const token = readFileSync(join(homedir(), ".supabase", "access-token"), "utf8").trim();
const ref = readFileSync(join(homedir(), ".supabase", "korea-car-ref.txt"), "utf8").trim();
const q = async (query) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ query }),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${body}`);
  return JSON.parse(body);
};

await q(`create schema if not exists supabase_migrations;
  create table if not exists supabase_migrations.schema_migrations (version text primary key, name text, statements text[])`);
const done = new Set((await q("select version from supabase_migrations.schema_migrations")).map((r) => r.version));
const dir = new URL("../supabase/migrations/", import.meta.url);
for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
  const version = f.split("_")[0];
  if (done.has(version)) { console.log("o'tkazildi", f); continue; }
  const sql = readFileSync(new URL(f, dir), "utf8");
  await q(`begin;\n${sql}\ninsert into supabase_migrations.schema_migrations (version, name) values ('${version}', '${f}');\ncommit;`);
  console.log("qo'llandi ", f);
}
