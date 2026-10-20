import { useState } from "react";
import { useApp } from "../lib/context";
import { AUTH, t } from "../lib/i18n";

/** Email + parol bilan kirish / ro'yxatdan o'tish (email xat limitiga bog'liq emas). */
export function Auth() {
  const { sb, lang } = useApp();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    const { error } = mode === "in"
      ? await sb.auth.signInWithPassword({ email, password: pw })
      : await sb.auth.signUp({ email, password: pw });
    setBusy(false);
    if (error) setErr(mode === "in" ? AUTH.badLogin[lang] : error.message);
  }

  return (
    <form className="auth" onSubmit={submit}>
      <input type="email" required autoComplete="email" placeholder={t(lang, "email")} value={email} onChange={(e) => setEmail(e.target.value)} />
      <input type="password" required minLength={8} autoComplete={mode === "in" ? "current-password" : "new-password"}
        placeholder={AUTH.password[lang]} value={pw} onChange={(e) => setPw(e.target.value)} />
      <button className="primary" disabled={busy}>{mode === "in" ? t(lang, "signIn") : AUTH.signUp[lang]}</button>
      <button type="button" className="link" onClick={() => setMode(mode === "in" ? "up" : "in")}>
        {mode === "in" ? AUTH.noAccount[lang] : AUTH.haveAccount[lang]}
      </button>
      {err && <span className="err">{err}</span>}
    </form>
  );
}
