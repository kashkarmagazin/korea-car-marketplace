import { useCallback, useEffect, useState } from "react";
import { useApp } from "../lib/context";
import { call } from "../lib/supabase";
import { errorText, LOCALE, t } from "../lib/i18n";
import { parseUsdToCents } from "../lib/money";
import { formatLocal } from "../lib/time";

type Audit = { id: number; at: string; actor: string | null; action: string; entity: string; entity_id: string | null; data: unknown };
type VReq = { id: string; user_id: string; doc_type: string; doc_path: string; status: string; created_at: string };
type Settings = Record<string, unknown> & { bid_increment_usd_cents: number; anti_snipe_enabled: boolean; anti_snipe_window: string;
  anti_snipe_extend: string; winner_completion_period: string; relist_policy: string };

/** Admin paneli: barcha amallar server funksiyalari orqali va audit jurnaliga yoziladi. */
export function Admin() {
  const { sb, lang, profile } = useApp();
  const [s, setS] = useState<Settings | null>(null);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [reqs, setReqs] = useState<VReq[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [auctionId, setAuctionId] = useState("");
  const [reason, setReason] = useState("");
  const [fx, setFx] = useState({ quote: "KRW", rate: "" });

  const load = useCallback(async () => {
    const [{ data: sd }, { data: ad }, { data: vd }] = await Promise.all([
      sb.from("settings").select("*").single(),
      sb.from("audit_log").select("*").order("id", { ascending: false }).limit(100),
      sb.from("verification_requests").select("*").eq("status", "pending").order("created_at"),
    ]);
    setS(sd as Settings);
    setAudit((ad as Audit[]) ?? []);
    setReqs((vd as VReq[]) ?? []);
  }, [sb]);
  useEffect(() => { load(); }, [load]);

  if (profile?.role !== "admin") return <p className="err">{errorText(lang, { message: "KC:forbidden" })}</p>;
  if (!s) return <p>{t(lang, "loading")}</p>;

  const run = async (fn: string, args: Record<string, unknown>) => {
    try { await call(sb, fn, args); setMsg({ ok: true, text: t(lang, "saved") }); load(); }
    catch (e) { setMsg({ ok: false, text: errorText(lang, e) }); }
  };

  return (
    <section className="form">
      <h3>{t(lang, "settings")}</h3>
      <label>{t(lang, "increment")}
        <input defaultValue={s.bid_increment_usd_cents / 100} onBlur={(e) => {
          const c = parseUsdToCents(e.target.value);
          if (c !== null && c !== s.bid_increment_usd_cents) run("admin_update_settings", { p_patch: { bid_increment_usd_cents: c } });
        }} />
      </label>
      <label><input type="checkbox" checked={s.anti_snipe_enabled}
        onChange={(e) => run("admin_update_settings", { p_patch: { anti_snipe_enabled: e.target.checked } })} /> {t(lang, "antiSnipe")}</label>
      <label>{t(lang, "antiSnipe")}: window / extend
        <input defaultValue={s.anti_snipe_window} onBlur={(e) => e.target.value !== s.anti_snipe_window && run("admin_update_settings", { p_patch: { anti_snipe_window: e.target.value } })} />
        <input defaultValue={s.anti_snipe_extend} onBlur={(e) => e.target.value !== s.anti_snipe_extend && run("admin_update_settings", { p_patch: { anti_snipe_extend: e.target.value } })} />
      </label>
      <label>{t(lang, "completionPeriod")}
        <input defaultValue={s.winner_completion_period} onBlur={(e) => e.target.value !== s.winner_completion_period && run("admin_update_settings", { p_patch: { winner_completion_period: e.target.value } })} />
      </label>
      <label>{t(lang, "relistPolicy")}
        <select value={s.relist_policy} onChange={(e) => run("admin_update_settings", { p_patch: { relist_policy: e.target.value } })}>
          <option value="manual">manual</option><option value="auto_relist">auto_relist</option><option value="offer_runner_up">offer_runner_up</option>
        </select>
      </label>

      <h3>{t(lang, "fxRate")}</h3>
      <div className="row">
        <select value={fx.quote} onChange={(e) => setFx({ ...fx, quote: e.target.value })}>{["KRW", "KGS", "UZS", "RUB"].map((c) => <option key={c}>{c}</option>)}</select>
        <input value={fx.rate} onChange={(e) => setFx({ ...fx, rate: e.target.value })} placeholder="1387.25" />
        <button onClick={() => run("admin_set_fx_rate", { p_quote: fx.quote, p_rate: fx.rate })}>{t(lang, "submit")}</button>
      </div>

      <h3>{t(lang, "tabAuctions")}</h3>
      <input placeholder="auction id" value={auctionId} onChange={(e) => setAuctionId(e.target.value)} />
      <input placeholder={t(lang, "reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="row">
        <button onClick={() => run("admin_pause_auction", { p_auction: auctionId, p_reason: reason })}>{t(lang, "pause")}</button>
        <button onClick={() => run("admin_resume_auction", { p_auction: auctionId, p_reason: reason })}>{t(lang, "resume")}</button>
        <button className="danger" onClick={() => run("admin_cancel_auction", { p_auction: auctionId, p_reason: reason })}>{t(lang, "cancel")}</button>
      </div>

      <h3>{t(lang, "verifications")}</h3>
      {reqs.length === 0 && <p className="muted">{t(lang, "empty")}</p>}
      {reqs.map((r) => (
        <div key={r.id} className="row">
          <span>{r.user_id.slice(0, 8)} · {r.doc_type} · {r.doc_path}</span>
          <span>
            <button onClick={() => run("admin_decide_verification", { p_request: r.id, p_approve: true, p_note: null })}>{t(lang, "accept")}</button>
            <button onClick={() => run("admin_decide_verification", { p_request: r.id, p_approve: false, p_note: reason || null })}>{t(lang, "reject")}</button>
          </span>
        </div>
      ))}

      {msg && <p className={msg.ok ? "ok" : "err"}>{msg.text}</p>}

      <h3>{t(lang, "auditLog")}</h3>
      <table>
        <tbody>
          {audit.map((a) => (
            <tr key={a.id}>
              <td className="muted">{formatLocal(a.at, LOCALE[lang])}</td>
              <td>{a.action}</td>
              <td>{a.entity}:{a.entity_id?.slice(0, 8)}</td>
              <td className="muted">{a.actor?.slice(0, 8) ?? "system"}</td>
              <td><code>{JSON.stringify(a.data).slice(0, 120)}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
