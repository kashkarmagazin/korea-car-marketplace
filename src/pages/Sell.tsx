import { useState } from "react";
import { useApp } from "../lib/context";
import { call } from "../lib/supabase";
import { errorText, t, type UiKey } from "../lib/i18n";
import { MINOR_UNITS, parseToMinor, parseUsdToCents } from "../lib/money";
import { Verify } from "../components/Verify";

const DAMAGE = ["none", "minor", "moderate", "severe", "flood", "unknown"] as const;

/** Avtomobil qo'shish: belgilangan narxda sotuv YOKI 72 soatlik auksion (bir vaqtda faqat bittasi). */
export function Sell() {
  const { sb, lang, session } = useApp();
  const [f, setF] = useState({ make: "", model: "", year: "", mileage: "", damage: "unknown", notes: "", currency: "USD", photo: "",
    mode: "auction" as "auction" | "sale", price: "", negotiable: true, start: "100", reserve: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  if (!session) return <p>{errorText(lang, { message: "KC:auth_required" })}</p>;

  async function submit() {
    setMsg(null);
    try {
      const { data: car, error } = await sb.from("cars").insert({
        seller_id: session!.user.id, make: f.make, model: f.model, year: f.year ? Number(f.year) : null,
        mileage_km: f.mileage ? Number(f.mileage) : null, damage: f.damage, damage_notes: f.notes || null,
        currency: f.currency, photos: f.photo ? [f.photo] : [],
      }).select("id").single();
      if (error) throw error;
      if (f.mode === "sale") {
        const price = parseToMinor(f.price, f.currency);
        if (price === null) throw new Error("KC:invalid_price");
        await call(sb, "create_sale_listing", { p_car: car.id, p_price_minor: price, p_negotiable: f.negotiable });
      } else {
        const start = parseUsdToCents(f.start);
        const reserve = f.reserve ? parseUsdToCents(f.reserve) : null;
        if (start === null) throw new Error("KC:start_price_out_of_range");
        if (f.reserve && reserve === null) throw new Error("KC:reserve_out_of_range");
        await call(sb, "create_auction", { p_car: car.id, p_start_usd_cents: start, p_reserve_usd_cents: reserve });
      }
      setMsg({ ok: true, text: t(lang, "saved") });
    } catch (e) {
      setMsg({ ok: false, text: errorText(lang, e) });
    }
  }

  return (
    <section className="form">
      <Verify />
      <label>{t(lang, "make")}<input value={f.make} onChange={set("make")} /></label>
      <label>{t(lang, "model")}<input value={f.model} onChange={set("model")} /></label>
      <label>{t(lang, "year")}<input inputMode="numeric" value={f.year} onChange={set("year")} /></label>
      <label>{t(lang, "mileage")}<input inputMode="numeric" value={f.mileage} onChange={set("mileage")} /></label>
      <label>{t(lang, "damage")}
        <select value={f.damage} onChange={set("damage")}>{DAMAGE.map((d) => <option key={d} value={d}>{t(lang, `damage_${d}` as UiKey)}</option>)}</select>
      </label>
      <label>{t(lang, "damage")} ({t(lang, "message")})<textarea value={f.notes} onChange={set("notes")} /></label>
      <label>{t(lang, "photoUrl")}<input value={f.photo} onChange={set("photo")} /></label>
      <label>{t(lang, "currency")}
        <select value={f.currency} onChange={set("currency")}>{Object.keys(MINOR_UNITS).map((c) => <option key={c}>{c}</option>)}</select>
      </label>
      <fieldset>
        <legend>{t(lang, "mode")}</legend>
        <label><input type="radio" checked={f.mode === "auction"} onChange={() => setF({ ...f, mode: "auction" })} /> {t(lang, "modeAuction")}</label>
        <label><input type="radio" checked={f.mode === "sale"} onChange={() => setF({ ...f, mode: "sale" })} /> {t(lang, "modeSale")}</label>
      </fieldset>
      {f.mode === "sale" ? (
        <>
          <label>{t(lang, "price")} ({f.currency})<input value={f.price} onChange={set("price")} /></label>
          <label><input type="checkbox" checked={f.negotiable} onChange={(e) => setF({ ...f, negotiable: e.target.checked })} /> {t(lang, "negotiable")}</label>
        </>
      ) : (
        <>
          <label>{t(lang, "startPriceUsd")}<input value={f.start} onChange={set("start")} /></label>
          <label>{t(lang, "reserve")}<input value={f.reserve} onChange={set("reserve")} /></label>
        </>
      )}
      <button className="primary" onClick={submit}>{t(lang, "submit")}</button>
      {msg && <p className={msg.ok ? "ok" : "err"}>{msg.text}</p>}
    </section>
  );
}
