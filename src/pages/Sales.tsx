import { useCallback, useEffect, useState } from "react";
import { useApp } from "../lib/context";
import { call } from "../lib/supabase";
import { errorText, t, type UiKey } from "../lib/i18n";
import { formatMinor, parseToMinor } from "../lib/money";
import { SellerBadge } from "./Auctions";
import { Deal } from "../components/Deal";

type SaleRow = {
  listing_id: string; listing_status: string; make: string; model: string; year: number | null; mileage_km: number | null;
  damage: string; damage_notes: string | null; photos: string[]; currency: string; price_minor: number; negotiable: boolean;
  seller_verification: string; i_am_seller: boolean | null;
};
type Offer = { id: string; buyer_id: string; amount_minor: number; kind: string; message: string | null; status: string; created_at: string };

export function SaleList() {
  const { sb, lang } = useApp();
  const [rows, setRows] = useState<SaleRow[] | null>(null);
  const [open, setOpen] = useState<SaleRow | null>(null);
  const load = useCallback(() => {
    sb.from("sales_public").select("*").in("listing_status", ["active", "pending_completion"]).order("created_at", { ascending: false })
      .then(({ data }) => setRows((data as SaleRow[]) ?? []));
  }, [sb]);
  useEffect(load, [load]);
  if (open) return <SaleDetail s={open} onBack={() => { setOpen(null); load(); }} />;
  if (!rows) return <p>{t(lang, "loading")}</p>;
  if (!rows.length) return <p className="muted">{t(lang, "empty")}</p>;
  return (
    <div className="grid">
      {rows.map((s) => (
        <article key={s.listing_id} className="card" onClick={() => setOpen(s)}>
          <img src={s.photos[0] || `${import.meta.env.BASE_URL}placeholder.svg`} alt={`${s.make} ${s.model}`} />
          <div className="card-body">
            <h3>{s.make} {s.model} {s.year ?? ""}</h3>
            <div className="row"><span className="muted">{t(lang, "price")}</span><b>{formatMinor(s.price_minor, s.currency)}</b></div>
            {s.negotiable && <span className="badge">{t(lang, "negotiable")}</span>}
            <div className="row"><span className="muted">{t(lang, "damage")}</span><span>{t(lang, `damage_${s.damage}` as UiKey)}</span></div>
            <SellerBadge v={s.seller_verification} />
          </div>
        </article>
      ))}
    </div>
  );
}

function SaleDetail({ s, onBack }: { s: SaleRow; onBack: () => void }) {
  const { sb, lang, session } = useApp();
  const [amount, setAmount] = useState("");
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [offers, setOffers] = useState<Offer[]>([]);

  const loadOffers = useCallback(() => {
    if (!session) return;
    sb.from("offers").select("*").eq("listing_id", s.listing_id).order("created_at", { ascending: false })
      .then(({ data }) => setOffers((data as Offer[]) ?? []));
  }, [sb, s.listing_id, session]);
  useEffect(loadOffers, [loadOffers]);

  const run = async (fn: string, args: Record<string, unknown>) => {
    try { await call(sb, fn, args); setMsg({ ok: true, text: t(lang, "sent") }); loadOffers(); }
    catch (e) { setMsg({ ok: false, text: errorText(lang, e) }); }
  };

  return (
    <section className="detail">
      <button onClick={onBack}>←</button>
      <h2>{s.make} {s.model} {s.year ?? ""}</h2>
      {s.photos.map((p) => <img key={p} src={p} alt="" className="photo" />)}
      <p className="big">{formatMinor(s.price_minor, s.currency)} {s.negotiable && <span className="badge">{t(lang, "negotiable")}</span>}</p>
      <p>{t(lang, "damage")}: {t(lang, `damage_${s.damage}` as UiKey)}{s.damage_notes ? ` — ${s.damage_notes}` : ""}</p>
      <SellerBadge v={s.seller_verification} />

      {session && !s.i_am_seller && s.listing_status === "active" && (
        <div className="bidbox">
          <button className="primary" onClick={() => run("start_purchase", { p_listing: s.listing_id })}>{t(lang, "buyNow")}</button>
          {s.negotiable && (
            <>
              <label>{t(lang, "makeOffer")} ({s.currency})<input value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
              <label>{t(lang, "message")}<textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} /></label>
              <button onClick={() => {
                const minor = parseToMinor(amount, s.currency);
                if (minor === null) return setMsg({ ok: false, text: errorText(lang, { message: "KC:invalid_price" }) });
                run("make_offer", { p_listing: s.listing_id, p_amount_minor: minor, p_message: text || null });
              }}>{t(lang, "makeOffer")}</button>
            </>
          )}
        </div>
      )}

      {s.i_am_seller && (
        <>
          <h3>{t(lang, "offers")}</h3>
          {offers.map((o) => (
            <div key={o.id} className="row">
              <span>{formatMinor(o.amount_minor, s.currency)} · {o.kind} · {o.status}{o.message ? ` — ${o.message}` : ""}</span>
              {o.status === "pending" && (
                <span>
                  <button onClick={() => run("respond_offer", { p_offer: o.id, p_accept: true })}>{t(lang, "accept")}</button>
                  <button onClick={() => run("respond_offer", { p_offer: o.id, p_accept: false })}>{t(lang, "reject")}</button>
                </span>
              )}
            </div>
          ))}
          {s.listing_status === "pending_completion" && (
            <Deal listingId={s.listing_id} isSeller completeFn="complete_sale" onDone={onBack} />
          )}
        </>
      )}
      {!s.i_am_seller && s.listing_status === "pending_completion" && offers.some((o) => o.status === "accepted") && (
        <Deal listingId={s.listing_id} isSeller={false} completeFn="complete_sale" onDone={onBack} />
      )}
      {msg && <p className={msg.ok ? "ok" : "err"}>{msg.text}</p>}
    </section>
  );
}
