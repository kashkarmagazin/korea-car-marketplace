// Real bazada scripts/real-flow.sql ni ishga tushiradi (u ataylab ROLLBACK bilan tugaydi) va natijani chiqaradi.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const T = readFileSync(join(homedir(), ".supabase", "access-token"), "utf8").trim();
const ref = readFileSync(join(homedir(), ".supabase", "korea-car-ref.txt"), "utf8").trim();
const sql = readFileSync(new URL("./real-flow.sql", import.meta.url), "utf8");
const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: "POST", headers: { Authorization: `Bearer ${T}`, "Content-Type": "application/json" }, body: JSON.stringify({ query: sql }),
});
const t = await r.text();
const m = t.match(/NATIJA ok=\d+ bad=\d+ :[^"]*/);
console.log(m ? m[0] : t.slice(0, 1000));
