import { describe, expect, it } from "vitest";
import { sign, verifyWebhook } from "../../supabase/functions/_shared/signature";

describe("to'lov webhook imzosi (qalbaki bildirishnomalarga ishonmaslik)", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ type: "payment.succeeded", deposit_id: "d1", amount_usd_cents: 20000 });
  const now = 1_792_000_000_000;
  const ts = String(now / 1000);

  it("to'g'ri imzo qabul qilinadi", async () => {
    expect(await verifyWebhook({ secret, body, timestamp: ts, signature: await sign(secret, ts, body), nowMs: now })).toBe(true);
  });
  it("sir sozlanmagan, imzo yo'q, noto'g'ri sir yoki o'zgartirilgan tana — rad", async () => {
    const sig = await sign(secret, ts, body);
    expect(await verifyWebhook({ secret: undefined, body, timestamp: ts, signature: sig, nowMs: now })).toBe(false);
    expect(await verifyWebhook({ secret, body, timestamp: ts, signature: null, nowMs: now })).toBe(false);
    expect(await verifyWebhook({ secret, body, timestamp: ts, signature: await sign("boshqa", ts, body), nowMs: now })).toBe(false);
    expect(await verifyWebhook({ secret, body: body.replace("20000", "2"), timestamp: ts, signature: sig, nowMs: now })).toBe(false);
  });
  it("eski (qayta yuborilgan) xabar rad etiladi", async () => {
    const old = String(now / 1000 - 3600);
    expect(await verifyWebhook({ secret, body, timestamp: old, signature: await sign(secret, old, body), nowMs: now })).toBe(false);
  });
});
