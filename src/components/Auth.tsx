import { useState } from "react";
import { useApp } from "../lib/context";
import { AUTH, t, type Lang } from "../lib/i18n";

const SHOW: Record<Lang, string> = { uz: "Parolni ko'rsatish", ru: "Показать пароль", ky: "Сырсөздү көрсөтүү" };
const HIDE: Record<Lang, string> = { uz: "Parolni yashirish", ru: "Скрыть пароль", ky: "Сырсөздү жашыруу" };

/** Email + parol bilan kirish / ro'yxatdan o'tish (email xat limitiga bog'liq emas). */
export function Auth() {
  const { sb, lang } = useApp();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [showPw, setShowPw] = useState(false);
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
      <span className="pw-wrap">
        <input type={showPw ? "text" : "password"} required minLength={8} autoComplete={mode === "in" ? "current-password" : "new-password"}
          placeholder={AUTH.password[lang]} value={pw} onChange={(e) => setPw(e.target.value)} />
        <button type="button" className="pw-eye" onClick={() => setShowPw(!showPw)}
          aria-label={(showPw ? HIDE : SHOW)[lang]} title={(showPw ? HIDE : SHOW)[lang]}>
          {showPw ? "🙈" : "👁"}
        </button>
      </span>
      <button className="primary" disabled={busy}>{mode === "in" ? t(lang, "signIn") : AUTH.signUp[lang]}</button>
      <button type="button" className="link" onClick={() => setMode(mode === "in" ? "up" : "in")}>
        {mode === "in" ? AUTH.noAccount[lang] : AUTH.haveAccount[lang]}
      </button>
      {err && <span className="err">{err}</span>}
    </form>
  );
}
