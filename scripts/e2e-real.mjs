// Brauzer (Edge, headless) + REAL Supabase: joylash, rasm yuklash, stavkalar, xatolar, bildirishnoma, admin jurnali.
// node scripts/e2e-real.mjs [url]   (parollar ~/.supabase/korea-car-test-accounts.txt dan o'qiladi, ekranga chiqmaydi)
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const URL_ = process.argv[2] || "http://localhost:4320/";
const acc = Object.fromEntries(readFileSync(join(homedir(), ".supabase", "korea-car-test-accounts.txt"), "utf8")
  .split("\n").filter((l) => l.includes(" / ")).map((l) => { const [k, rest] = l.split(": "); const [e, p] = rest.split(" / "); return [k.split(" ")[0] + (k.match(/\d/)?.[0] ?? ""), { e, p: p.trim() }]; }));
const photo = process.argv[3] || "C:/Users/usaym/kashkar-ish/studio/public/yt/promo_bg.jpg";
const results = [];
const check = (name, ok, extra = "") => { results.push(`${ok ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`); };

const browser = await chromium.launch({ channel: "msedge", headless: true });
const errors = [];
async function session(who) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${who}: ${e.message}`));
  await p.goto(URL_);
  await p.evaluate(() => localStorage.setItem("lang", "uz"));
  await p.reload();
  await p.fill("input[type=email]", acc[who].e);
  await p.fill("input[type=password]", acc[who].p);
  await p.click("form.auth button.primary");
  await p.waitForSelector("text=Chiqish", { timeout: 20000 });
  return { ctx, p };
}

const tag = `E2E ${new Date().toISOString().slice(11, 19)}`;
// 1) Admin: rasm bilan auksion joylash
{
  const { ctx, p } = await session("ADMIN");
  check("admin kirdi va Admin tabi ko'rinadi", await p.waitForSelector("nav >> text=Admin", { timeout: 15000 }).then(() => true, () => false));
  await p.click("nav >> text=Avtomobil joylash");
  await p.fill("label:has-text('Marka') input", "Hyundai");
  await p.fill("label:has-text('Model') input", `Sonata (${tag})`);
  await p.fill("label:has-text('Yil') input", "2020");
  await p.setInputFiles("input[type=file][multiple]", photo);
  await p.waitForSelector(".thumb img", { timeout: 30000 });
  check("rasm Storage'ga yuklandi", (await p.getAttribute(".thumb img", "src"))?.includes("/car-photos/") ?? false);
  await p.fill("label:has-text('Boshlang') input", "100");
  await p.fill("label:has-text('Rezerv') input", "300");
  await p.click("section.form button.primary:has-text('Joylash')");
  await p.waitForSelector("section.form p.ok, section.form p.err", { timeout: 20000 });
  const msg = await p.innerText("section.form p.ok, section.form p.err");
  check("auksion joylandi", msg.includes("Saqlandi"), msg);
  await ctx.close();
}
// 2) Xaridor 1: stavka 100, keyin noto'g'ri stavkalar
let auctionCard;
{
  const { ctx, p } = await session("XARIDOR1");
  await p.click(`.card:has-text("${tag}")`);
  await p.waitForSelector("text=Stavkalar tarixi");
  check("taymer ko'rinadi (≈72 soat)", /^(2d 23|3d 00):/.test((await p.innerText(".detail .countdown")).trim()), await p.innerText(".detail .countdown"));
  await p.fill(".bidbox input", "99");
  await p.click(".bidbox button.primary");
  await p.waitForSelector(".detail p.err");
  check("99 USD rad etildi (o'zbekcha xabar)", (await p.innerText(".detail p.err")).includes("100 dan 6 000"));
  await p.fill(".bidbox input", "100");
  await p.click(".bidbox button.primary");
  await p.waitForSelector(".detail p.ok:has-text('qabul')");
  check("100 USD qabul qilindi", true);
  await p.waitForSelector("text=Siz eng yuqori", { timeout: 10000 }).catch(() => undefined);
  check("'Siz eng yuqori stavkadasiz' ko'rinadi", await p.isVisible("text=Siz eng yuqori"));
  auctionCard = p.url();
  await ctx.close();
}
// 3) Xaridor 2: 120 (qadamdan kam) rad, 150 qabul
{
  const { ctx, p } = await session("XARIDOR2");
  await p.click(`.card:has-text("${tag}")`);
  await p.waitForSelector("text=Stavkalar tarixi");
  await p.fill(".bidbox input", "120");
  await p.click(".bidbox button.primary");
  await p.waitForSelector(".detail p.err");
  check("qadamdan kichik oshirish rad etildi", (await p.innerText(".detail p.err")).includes("qadam"));
  await p.fill(".bidbox input", "150");
  await p.click(".bidbox button.primary");
  await p.waitForSelector(".detail p.ok:has-text('qabul')");
  check("150 USD qabul qilindi", true);
  await p.waitForFunction(() => { const t = document.querySelector("table")?.textContent ?? ""; return t.includes("Siz") && t.includes("Ishtirokchi #1"); }, null, { timeout: 15000 }).catch(() => undefined);
  const hist = await p.innerText("table");
  check("tarixda ishtirokchilar anonim (#1, Siz)", hist.includes("Ishtirokchi #1") && hist.includes("Siz"), hist.replace(/s+/g, " ").slice(0, 160));
  check("rezerv bajarilmagan deb ko'rsatiladi", await p.isVisible("text=Rezerv narx hali bajarilmagan"));
  await ctx.close();
}
// 4) Xaridor 1: bildirishnoma, ruscha/qirg'izcha
{
  const { ctx, p } = await session("XARIDOR1");
  await p.waitForSelector(".notif .dot", { timeout: 20000 }).catch(() => undefined);
  check("xaridor 1 ga 'oshib ketishdi' bildirishnomasi keldi", await p.isVisible(".notif .dot"));
  await p.click(".notif > button");
  check("bildirishnoma matni", (await p.innerText(".notif-panel")).includes("oshib ketishdi"));
  await p.selectOption("select[aria-label=lang]", "ru");
  check("ruscha interfeys", await p.isVisible("nav >> text=Аукцион"));
  await p.selectOption("select[aria-label=lang]", "ky");
  check("qirg'izcha interfeys", await p.isVisible("nav >> text=Унаа жайгаштыруу"));
  await ctx.close();
}
// 5) Admin: jurnal
{
  const { ctx, p } = await session("ADMIN");
  await p.click("nav >> text=Admin");
  await p.waitForSelector("text=Audit jurnali");
  const audit = await p.innerText("table");
  check("admin jurnalida bid_placed va auction_created", audit.includes("bid_placed") && audit.includes("auction_created"));
  await ctx.close();
}
await browser.close();
console.log(results.join("\n"));
console.log(errors.length ? "JS XATOLARI:\n" + errors.join("\n") : "JS xatolari: yo'q");
void auctionCard;
