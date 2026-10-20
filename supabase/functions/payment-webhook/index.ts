// Supabase Edge Function: to'lov provayderidan depozit tasdig'i.
// HOLAT: real provayder hali TANLANMAGAN. PAYMENT_WEBHOOK_SECRET sozlanmaguncha har so'rov 503 bilan rad etiladi,
// shuning uchun hech bir depozit "to'langan" deb belgilanmaydi. Provayder tanlangach, uning rasmiy imzo
// formatiga moslab verifyWebhook almashtiriladi va payload maydonlari tekshiriladi.
import { createClient } from "npm:@supabase/supabase-js@2";
import { verifyWebhook } from "../_shared/signature.ts";

Deno.serve(async (req) => {
  const secret = Deno.env.get("PAYMENT_WEBHOOK_SECRET");
  if (!secret) return new Response("payment provider not configured", { status: 503 });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const body = await req.text();
  const ok = await verifyWebhook({
    secret, body, nowMs: Date.now(),
    timestamp: req.headers.get("x-webhook-timestamp"),
    signature: req.headers.get("x-webhook-signature"),
  });
  if (!ok) return new Response("invalid signature", { status: 401 });

  let evt: { type?: string; deposit_id?: string; provider_ref?: string; amount_usd_cents?: number; status?: string };
  try { evt = JSON.parse(body); } catch { return new Response("bad json", { status: 400 }); }
  // Faqat muvaffaqiyatli to'lov hodisasi qabul qilinadi
  if (evt.type !== "payment.succeeded" || evt.status !== "succeeded" || !evt.deposit_id || !evt.provider_ref
      || !Number.isInteger(evt.amount_usd_cents)) {
    return new Response("ignored", { status: 202 });
  }

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { error } = await sb.rpc("confirm_deposit_payment", {
    p_deposit: evt.deposit_id, p_provider: Deno.env.get("PAYMENT_PROVIDER_NAME") ?? "provider",
    p_provider_ref: evt.provider_ref, p_amount_usd_cents: evt.amount_usd_cents,
  });
  if (error) return new Response(error.message, { status: 409 });
  return new Response("ok", { status: 200 });
});
