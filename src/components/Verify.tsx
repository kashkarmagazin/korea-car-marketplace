import { useState } from "react";
import { useApp } from "../lib/context";
import { call } from "../lib/supabase";
import { errorText, t } from "../lib/i18n";

const DOCS = ["passport", "id_card", "driver_license", "business_registration"] as const;

/** Shaxsni tasdiqlash: hujjat yopiq 'kyc' bucket'ga (uid/ papkasiga) yuklanadi, admin ko'rib chiqadi. */
export function Verify() {
  const { sb, lang, session, profile } = useApp();
  const [doc, setDoc] = useState<(typeof DOCS)[number]>("passport");
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!session || !profile || profile.verification === "verified") return null;
  if (profile.verification === "pending") return <p className="notice">{t(lang, "verifyMe")} — {t(lang, "sent")}</p>;

  async function submit() {
    if (!file) return;
    try {
      const path = `${session!.user.id}/${Date.now()}-${file.name.replace(/[^\w.-]/g, "_")}`;
      const { error } = await sb.storage.from("kyc").upload(path, file);
      if (error) throw error;
      await call(sb, "submit_verification", { p_doc_type: doc, p_doc_path: path });
      setMsg({ ok: true, text: t(lang, "sent") });
    } catch (e) {
      setMsg({ ok: false, text: errorText(lang, e) });
    }
  }

  return (
    <div className="notice">
      <b>{t(lang, "verifyMe")}</b>
      <select value={doc} onChange={(e) => setDoc(e.target.value as (typeof DOCS)[number])}>{DOCS.map((d) => <option key={d}>{d}</option>)}</select>
      <input type="file" accept="image/jpeg,image/png,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <button onClick={submit} disabled={!file}>{t(lang, "submit")}</button>
      {msg && <p className={msg.ok ? "ok" : "err"}>{msg.text}</p>}
    </div>
  );
}
