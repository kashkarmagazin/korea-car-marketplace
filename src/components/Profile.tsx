import { useState } from "react";
import { useApp } from "../lib/context";
import { call } from "../lib/supabase";
import { errorText, t } from "../lib/i18n";

/** Ism va telefon — stavka, taklif va e'lon uchun majburiy (kelishuvda tomonlarga ko'rsatiladi). */
export function Profile({ onSaved }: { onSaved?: () => void }) {
  const { sb, lang, profile, reloadProfile } = useApp();
  const [name, setName] = useState(profile?.full_name ?? "");
  const [phone, setPhone] = useState(profile?.phone ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!profile) return null;

  async function save() {
    try {
      await call(sb, "update_my_profile", { p_full_name: name, p_phone: phone });
      setMsg({ ok: true, text: t(lang, "saved") });
      reloadProfile();
      onSaved?.();
    } catch (e) {
      setMsg({ ok: false, text: errorText(lang, e) });
    }
  }

  return (
    <div className="notice">
      {(!profile.full_name || !profile.phone) && <b>{t(lang, "fillProfile")}</b>}
      <label>{t(lang, "fullName")}<input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>{t(lang, "phone")}<input inputMode="tel" placeholder="+996 550 123 456" value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
      <button onClick={save}>{t(lang, "save")}</button>
      {msg && <p className={msg.ok ? "ok" : "err"}>{msg.text}</p>}
    </div>
  );
}
