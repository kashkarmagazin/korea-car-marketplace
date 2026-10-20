// To'lov provayderi webhook imzosini tekshirish (HMAC-SHA256, hex). Deno va Node (WebCrypto) da ishlaydi.
// Imzo + vaqt tamg'asi tekshirilmaguncha hech qanday to'lov "to'langan" deb belgilanmaydi.

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Doimiy vaqtda solishtirish (timing attack'dan himoya). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function sign(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${body}`)));
}

/**
 * true faqat: sir sozlangan, vaqt tamg'asi ±5 daqiqa ichida va imzo mos bo'lsa.
 * nowMs — server vaqti (test uchun parametr).
 */
export async function verifyWebhook(opts: {
  secret: string | undefined; timestamp: string | null; signature: string | null; body: string; nowMs: number; toleranceSec?: number;
}): Promise<boolean> {
  const { secret, timestamp, signature, body, nowMs, toleranceSec = 300 } = opts;
  if (!secret || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > toleranceSec) return false;
  return safeEqual(await sign(secret, timestamp, body), signature.toLowerCase());
}
