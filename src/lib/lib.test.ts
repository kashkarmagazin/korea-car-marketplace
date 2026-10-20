import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { anchorClock, formatLocal, formatRemaining, remainingMs, serverNow } from "./time";
import { formatMinor, parseToMinor, parseUsdToCents } from "./money";
import { ERRORS, LANGS, UI, errorText } from "./i18n";

describe("server vaqtiga asoslangan taymer", () => {
  const clock = anchorClock("2026-10-20T10:00:00.000Z", 1000, 1200); // RTT 200ms -> anchor 1100

  it("qolgan vaqt performance.now() bilan hisoblanadi, Date.now() ishlatilmaydi", () => {
    expect(serverNow(clock, 1100)).toBe(Date.parse("2026-10-20T10:00:00.000Z"));
    expect(remainingMs("2026-10-23T10:00:00.000Z", clock, 1100)).toBe(72 * 3600 * 1000);
    expect(remainingMs("2026-10-23T10:00:00.000Z", clock, 1100 + 3600_000)).toBe(71 * 3600 * 1000);
  });

  it("qurilma soati o'zgarsa ham natija o'zgarmaydi (Date.now soxta)", () => {
    const real = Date.now;
    Date.now = () => Date.parse("2030-01-01T00:00:00Z");
    try {
      expect(remainingMs("2026-10-23T10:00:00.000Z", clock, 1100)).toBe(72 * 3600 * 1000);
    } finally {
      Date.now = real;
    }
  });

  it("tugagandan keyin 0, format", () => {
    expect(remainingMs("2026-10-20T09:00:00.000Z", clock, 1100)).toBe(0);
    expect(formatRemaining(72 * 3600 * 1000)).toBe("3d 00:00:00");
    expect(formatRemaining(119_000)).toBe("00:01:59");
  });

  it("UTC vaqt foydalanuvchi mintaqasida ko'rsatiladi", () => {
    expect(formatLocal("2026-10-20T18:00:00Z", "ru-RU", "Asia/Bishkek")).toMatch(/0?0:00/);   // UTC+6 -> 00:00
    expect(formatLocal("2026-10-20T18:00:00Z", "ru-RU", "Asia/Seoul")).toMatch(/3:00/);       // UTC+9 -> 03:00
  });
});

describe("pul (butun sonlar)", () => {
  it("USD kiritish -> sent, float xatosiz", () => {
    expect(parseUsdToCents("100")).toBe(10000);
    expect(parseUsdToCents("6000")).toBe(600000);
    expect(parseUsdToCents("0.29")).toBe(29);          // 0.29*100 float'da 28.999…
    expect(parseUsdToCents("1 234,5")).toBe(123450);
    expect(parseUsdToCents("-5")).toBeNull();
    expect(parseUsdToCents("1.234")).toBeNull();
  });
  it("valyuta kasr birliklari: KRW 0, KGS 2", () => {
    expect(parseToMinor("15000000", "KRW")).toBe(15000000);
    expect(parseToMinor("1500.5", "KRW")).toBeNull();
    expect(parseToMinor("12.5", "KGS")).toBe(1250);
    expect(formatMinor(1711867, "KRW", "en-US")).toBe("₩1,711,867");
    expect(formatMinor(874512, "KGS", "en-US")).toMatch(/8,745\.12/);
  });
});

describe("uch tilli matnlar", () => {
  it("har bir UI matni uz/ru/ky da bor va bo'sh emas", () => {
    for (const [k, v] of Object.entries(UI)) for (const l of LANGS) expect((v as Record<string, string>)[l], `${k}.${l}`).toBeTruthy();
  });
  it("migratsiyalardagi HAR BIR server xato kodi uch tilda tarjima qilingan", () => {
    const dir = join(__dirname, "..", "..", "supabase", "migrations");
    const sql = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    const codes = new Set([...sql.matchAll(/_err\('([a-z_]+)'\)|KC:([a-z_]+)/g)].map((m) => m[1] ?? m[2]));
    expect(codes.size).toBeGreaterThan(40);
    for (const c of codes) for (const l of LANGS) expect(ERRORS[c]?.[l], `${c}.${l}`).toBeTruthy();
  });
  it("server xatosi foydalanuvchi tiliga o'giriladi", () => {
    expect(errorText("ru", new Error("KC:amount_out_of_range"))).toBe("Ставка должна быть от 100 до 6 000 USD");
    expect(errorText("ky", { message: "boshqa" })).toBe("Ката кетти");
  });
});
