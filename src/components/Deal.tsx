import { useEffect, useState } from "react";
import { useApp } from "../lib/context";
import { call } from "../lib/supabase";
import { errorText, t } from "../lib/i18n";

type Contact = { role: "seller" | "buyer"; full_name: string | null; phone: string | null };

/**
 * Kelishuv bosqichi: tomonlar bir-birining kontaktini ko'radi, to'lov saytdan tashqarida
 * (bank yoki kelishuv) bo'ladi; sotuvchi pulni olgach to'lov usulini ko'rsatib yakunlaydi.
 */
export function Deal({ listingId, isSeller, completeFn, onDone }: {
  listingId: string; isSeller: boolean; completeFn: "complete_auction_sale" | "complete_sale"; onDone: () => void;
}) {
  const { sb, lang } = useApp();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [method, setMethod] = useState<"bank_transfer" | "agreed">("bank_transfer");
  const [err, setErr] = useState("");

  useEffect(() => {
    sb.rpc("deal_contacts", { p_listing: listingId }).then(({ data }) => setContacts((data as Contact[]) ?? []));
  }, [sb, listingId]);

  async function complete() {
    try {
      const arg = completeFn === "complete_auction_sale" ? { p_auction: listingId } : { p_listing: listingId };
      await call(sb, completeFn, { ...arg, p_payment_method: method });
      onDone();
    } catch (e) {
      setErr(errorText(lang, e));
    }
  }

  return (
    <div className="notice">
      <p>{t(lang, "paymentInfo")}</p>
      {contacts.map((c) => (
        <p key={c.role}>
          <b>{t(lang, "dealContact")} ({t(lang, c.role === "seller" ? "roleSeller" : "roleBuyer")}):</b>{" "}
          {c.full_name} · {c.phone && <a href={`tel:${c.phone.replace(/[^\d+]/g, "")}`}>{c.phone}</a>}
          {c.phone && <> · <a href={`https://wa.me/${c.phone.replace(/\D/g, "")}`} target="_blank" rel="noreferrer">WhatsApp</a></>}
        </p>
      ))}
      {isSeller && (
        <div className="row">
          <select value={method} onChange={(e) => setMethod(e.target.value as "bank_transfer" | "agreed")}>
            <option value="bank_transfer">{t(lang, "payBank")}</option>
            <option value="agreed">{t(lang, "payAgreed")}</option>
          </select>
          <button className="primary" onClick={complete}>{t(lang, "paymentReceived")}</button>
        </div>
      )}
      {err && <p className="err">{err}</p>}
    </div>
  );
}
