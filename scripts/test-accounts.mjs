// Sinov hisoblari: admin (Yusuf) ga vaqtinchalik parol + 2 ta tasdiqlangan test xaridor.
// Parollar FAQAT ~/.supabase/korea-car-test-accounts.txt ga yoziladi (repoga emas, ekranga emas).
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const dir = join(homedir(), ".supabase");
const T = readFileSync(join(dir, "access-token"), "utf8").trim();
const ref = readFileSync(join(dir, "korea-car-ref.txt"), "utf8").trim();
const keys = await (await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys?reveal=true`, { headers: { Authorization: `Bearer ${T}` } })).json();
const secret = keys.find((k) => k.type === "secret").api_key;
const auth = (path, init = {}) => fetch(`https://${ref}.supabase.co/auth/v1/admin/${path}`, {
  ...init, headers: { apikey: secret, Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
}).then((r) => r.json());
const sql = (query) => fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: "POST", headers: { Authorization: `Bearer ${T}`, "Content-Type": "application/json" }, body: JSON.stringify({ query }),
}).then((r) => r.json());
const pw = () => randomBytes(9).toString("base64url");

const lines = [`Korea Car Marketplace — sinov hisoblari (${new Date().toISOString()})`, ""];
const all = (await auth("users?per_page=200")).users ?? [];

const admin = all.find((u) => u.email === "clubtimo99@gmail.com");
const adminPw = pw();
await auth(`users/${admin.id}`, { method: "PUT", body: JSON.stringify({ password: adminPw }) });
lines.push(`ADMIN (sotuvchi ham): clubtimo99@gmail.com / ${adminPw}`);

for (const [i, name, phone] of [[1, "Test Xaridor 1", "+996 700 000 001"], [2, "Test Xaridor 2", "+996 700 000 002"]]) {
  const email = `xaridor${i}@korea-car.test`;
  const p = pw();
  let u = all.find((x) => x.email === email);
  if (u) await auth(`users/${u.id}`, { method: "PUT", body: JSON.stringify({ password: p }) });
  else u = await auth("users", { method: "POST", body: JSON.stringify({ email, password: p, email_confirm: true }) });
  await sql(`update public.profiles set verification='verified', full_name='${name}', phone='${phone}' where id='${u.id}'`);
  lines.push(`XARIDOR ${i}: ${email} / ${p}`);
}
writeFileSync(join(dir, "korea-car-test-accounts.txt"), lines.join("\n") + "\n");
console.log("yozildi:", join(dir, "korea-car-test-accounts.txt"));
