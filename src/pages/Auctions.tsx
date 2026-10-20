import { useCallback, useEffect, useState } from "react";
import { useApp } from "../lib/context";
import { call } from "../lib/supabase";
import { errorText, LOCALE, t, type UiKey } from "../lib/i18n";
import { formatMinor, formatUsd, parseUsdToCents } from "../lib/money";
import { formatLocal } from "../lib/time";
import { Countdown } from "../components/Countdown";
import { Deal } from "../components/Deal";
import { Profile } from "../components/Profile";

export type AuctionRow = {
  auction_id: string; listing_status: string; make: string; model: string; year: number | null; mileage_km: number | null;
  damage: string; damage_notes: string | null; photos: string[]; currency: string; seller_verification: string;
  start_price_usd_cents: number; starts_at: string; ends_at: string; extensions: number; paused_at: string | null;
  high_usd_cents: number | null; bid_count: number; bidder_count: number; reserve_met: boolean | null; has_reserve: boolean;
  deposit_usd_cents: number; deposit_terms: Record<string, string>; result: string | null; finalized_at: string | null; winner_deadline: string | null;
  i_am_winner: boolean | null; i_am_highest: boolean | null; i_am_seller: boolean | null;
};
type BidRow = { seq: number; amount_usd_cents: number; amount_car_minor: number; car_currency: string; status: string; created_at: string; bidder_no: number; is_mine: boolean };
type Settings = { min_bid_usd_cents: number; max_bid_usd_cents: number; bid_increment_usd_cents: number };

export function AuctionList({ onOpen }: { onOpen: (id: string) => void }) {
  const { sb, lang } = useApp();
  const [rows, setRows] = useState<AuctionRow[] | null>(null);
  const load = useCallback(() => {
    sb.from("auctions_public").select("*").in("listing_status", ["active", "paused", "pending_completion"])
      .order("ends_at").then(({ data }) => setRows((data as AuctionRow[]) ?? []));
  }, [sb]);
  useEffect(() => {
    load();
    const ch = sb.channel("auctions-list").on("postgres_changes", { event: "*", schema: "public", table: "auctions" }, load).subscribe();
    const id = setInterval(load, 15_000);
    return () => { clearInterval(id); sb.removeChannel(ch); };
  }, [sb, load]);
  if (!rows) return <p>{t(lang, "loading")}</p>;
  if (!rows.length) return <p className="muted">{t(lang, "empty")}</p>;
  return <div className="grid">{rows.map((r) => <AuctionCard key={r.auction_id} a={r} onOpen={() => onOpen(r.auction_id)} />)}</div>;
}

export function AuctionCard({ a, onOpen }: { a: AuctionRow; onOpen: () => void }) {
  const { lang } = useApp();
  return (
    <article className="card" onClick={onOpen}>
      <img src={a.photos[0] || "/placeholder.svg"} alt={`${a.make} ${a.model}`} />
      <div className="card-body">
        <h3>{a.make} {a.model} {a.year ?? ""}</h3>
        <div className="row"><span className="muted">{t(lang, "currentBid")}</span><b>{formatUsd(a.high_usd_cents ?? null)}</b></div>
        <div className="row"><span className="muted">{t(lang, "bids")}</span><span>{a.bid_count} · {t(lang, "bidders")}: {a.bidder_count}</span></div>
        <div className="row"><span className="muted">{t(lang, "timeLeft")}</span><Countdown endsAt={a.ends_at} paused={!!a.paused_at} /></div>
        <div className="row"><span className="muted">{t(lang, "damage")}</span><span>{t(lang, `damage_${a.damage}` as UiKey)}</span></div>
        <SellerBadge v={a.seller_verification} />
        <button className="primary">{t(lang, "placeBid")}</button>
      </div>
    </article>
  );
}

export function SellerBadge({ v }: { v: string }) {
  const { lang } = useApp();
  return v === "verified"
    ? <span className="badge ok">✓ {t(lang, "sellerVerified")}</span>
    : <span className="badge">{t(lang, "sellerUnverified")}</span>;
}

export function AuctionDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { sb, lang, session, profile } = useApp();
  const [a, setA] = useState<AuctionRow | null>(null);
  const [bids, setBids] = useState<BidRow[]>([]);
  const [s, setS] = useState<Settings | null>(null);
  const [amount, setAmount] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [deposit, setDeposit] = useState<{ status: string } | null>(null);

  const load = useCallback(async () => {
    const [{ data: ar }, { data: br }, { data: sr }] = await Promise.all([
      sb.from("auctions_public").select("*").eq("auction_id", id).single(),
      sb.from("bids_public").select("*").eq("auction_id", id).order("seq", { ascending: false }).limit(100),
      sb.from("settings").select("min_bid_usd_cents, max_bid_usd_cents, bid_increment_usd_cents").single(),
    ]);
    setA(ar as AuctionRow);
    setBids((br as BidRow[]) ?? []);
    setS(sr as Settings);
  }, [sb, id]);

  useEffect(() => {
    load();
    // Real vaqtga yaqin: auksion qatori o'zgarsa darhol, qo'shimcha har 5 s
    const ch = sb.channel(`auction-${id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "auctions", filter: `listing_id=eq.${id}` }, load).subscribe();
    const iv = setInterval(load, 5_000);
    return () => { clearInterval(iv); sb.removeChannel(ch); };
  }, [sb, id, load]);

  const finalizeIfDue = useCallback(() => {
    call(sb, "finalize_auction_if_due", { p_auction: id }).then(load).catch(() => undefined);
  }, [sb, id, load]);

  if (!a || !s) return <p>{t(lang, "loading")}</p>;
  const minNext = a.high_usd_cents === null ? Math.max(a.start_price_usd_cents, s.min_bid_usd_cents)
    : Math.min(Number(a.high_usd_cents) + s.bid_increment_usd_cents, s.max_bid_usd_cents);
  const active = a.listing_status === "active" && !a.finalized_at;

  async function placeBid() {
    const cents = parseUsdToCents(amount);
    if (cents === null) return setMsg({ ok: false, text: errorText(lang, { message: "KC:amount_out_of_range" }) });
    setBusy(true);
    try {
      await call(sb, "place_bid", { p_auction: id, p_amount_usd_cents: cents });
      setMsg({ ok: true, text: t(lang, "bidAccepted") });
      setAmount("");
    } catch (e) {
      setMsg({ ok: false, text: errorText(lang, e) });
    } finally {
      setBusy(false);
      load();
    }
  }

  async function requestDeposit() {
    try { setDeposit(await call(sb, "request_deposit", { p_auction: id })); }
    catch (e) { setMsg({ ok: false, text: errorText(lang, e) }); }
  }

  return (
    <section className="detail">
      <button onClick={onBack}>←</button>
      <div className="detail-grid">
        <div>{a.photos.map((p) => <img key={p} src={p} alt="" className="photo" />)}</div>
        <div>
          <h2>{a.make} {a.model} {a.year ?? ""}</h2>
          <SellerBadge v={a.seller_verification} />
          <dl>
            <dt>{t(lang, "currentBid")}</dt><dd className="big">{formatUsd(a.high_usd_cents)}</dd>
            <dt>{t(lang, "startPrice")}</dt><dd>{formatUsd(a.start_price_usd_cents)}</dd>
            <dt>{t(lang, "bids")} / {t(lang, "bidders")}</dt><dd>{a.bid_count} / {a.bidder_count}</dd>
            <dt>{t(lang, "timeLeft")}</dt><dd><Countdown endsAt={a.ends_at} paused={!!a.paused_at} onZero={finalizeIfDue} />
              {a.extensions > 0 && <span className="badge warn"> {t(lang, "extended")} ×{a.extensions}</span>}</dd>
            <dt>{t(lang, "endsAt")}</dt><dd>{formatLocal(a.ends_at, LOCALE[lang])}</dd>
            <dt>{t(lang, "damage")}</dt><dd>{t(lang, `damage_${a.damage}` as UiKey)}{a.damage_notes ? ` — ${a.damage_notes}` : ""}</dd>
            <dd>{!a.has_reserve ? t(lang, "noReserve") : a.reserve_met ? t(lang, "reserveMet") : t(lang, "reserveNotMet")}</dd>
          </dl>

          {a.result && <ResultBanner a={a} onDone={load} />}

          {a.deposit_usd_cents > 0 && (
            <div className="notice">
              <b>{t(lang, "deposit")}: {formatUsd(a.deposit_usd_cents)}</b>
              <p>{t(lang, "depositTerms")}: {a.deposit_terms?.[lang] || "—"}</p>
              {deposit ? <p>{t(lang, "depositPending")}. {t(lang, "paymentNotConnected")}.</p>
                : session && <button onClick={requestDeposit}>{t(lang, "requestDeposit")}</button>}
            </div>
          )}

          {active && session && !a.i_am_seller && profile && (!profile.full_name || !profile.phone) && <Profile />}
          {active && session && !a.i_am_seller && (
            <div className="bidbox">
              {a.i_am_highest && <p className="ok">{t(lang, "youAreHighest")}</p>}
              <label>{t(lang, "yourBid")}
                <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={String(minNext / 100)} />
              </label>
              <p className="muted">{t(lang, "minNextBid")}: {formatUsd(minNext)} · {t(lang, "bidRange")}: {formatUsd(s.min_bid_usd_cents)} – {formatUsd(s.max_bid_usd_cents)}</p>
              <button className="primary" disabled={busy} onClick={placeBid}>{t(lang, "placeBid")}</button>
            </div>
          )}
          {!session && <p className="muted">{errorText(lang, { message: "KC:auth_required" })}</p>}
          {msg && <p className={msg.ok ? "ok" : "err"}>{msg.text}</p>}
        </div>
      </div>

      <h3>{t(lang, "bidHistory")}</h3>
      <table>
        <tbody>
          {bids.map((b) => (
            <tr key={b.seq} className={b.status === "voided" ? "voided" : ""}>
              <td>{b.is_mine ? t(lang, "you") : `${t(lang, "bidder")} #${b.bidder_no}`}</td>
              <td>{formatUsd(b.amount_usd_cents)}</td>
              <td className="muted">{b.car_currency !== "USD" ? formatMinor(b.amount_car_minor, b.car_currency) : ""}</td>
              <td className="muted">{formatLocal(b.created_at, LOCALE[lang])}</td>
              <td>{b.status === "voided" ? t(lang, "voided") : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ResultBanner({ a, onDone }: { a: AuctionRow; onDone: () => void }) {
  const { lang } = useApp();
  const map: Record<string, UiKey> = {
    reserve_met: "resultPending", reserve_not_met: "resultNoSale", no_bids: "resultNoSale",
    winner_defaulted: "resultNoSale", completed: "resultSold", cancelled: "resultCancelled",
  };
  return (
    <div className="notice">
      <b>{a.i_am_winner && a.result === "reserve_met" ? t(lang, "resultWon") : t(lang, map[a.result!] ?? "ended")}</b>
      {a.result === "reserve_met" && a.winner_deadline && <span> {formatLocal(a.winner_deadline, LOCALE[lang])}</span>}
      {a.result === "reserve_met" && (a.i_am_seller || a.i_am_winner) && (
        <Deal listingId={a.auction_id} isSeller={!!a.i_am_seller} completeFn="complete_auction_sale" onDone={onDone} />
      )}
    </div>
  );
}
