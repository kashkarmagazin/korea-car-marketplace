import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { supabase, syncServerClock } from "./supabase";
import type { Lang } from "./i18n";
import type { ServerClock } from "./time";

type Profile = { id: string; role: "user" | "admin"; verification: string; lang: Lang; blocked: boolean };
type Ctx = {
  sb: SupabaseClient;
  session: Session | null;
  profile: Profile | null;
  lang: Lang;
  setLang: (l: Lang) => void;
  clock: ServerClock | null;
};
const C = createContext<Ctx | null>(null);
export const useApp = () => {
  const v = useContext(C);
  if (!v) throw new Error("AppProvider yo'q");
  return v;
};

export function AppProvider({ sb, children }: { sb: SupabaseClient; children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [lang, setLangState] = useState<Lang>(() => (localStorage.getItem("lang") as Lang) || "uz");
  const [clock, setClock] = useState<ServerClock | null>(null);

  useEffect(() => {
    sb.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = sb.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, [sb]);

  useEffect(() => {
    if (!session) return setProfile(null);
    sb.from("profiles").select("id, role, verification, lang, blocked").eq("id", session.user.id).single()
      .then(({ data }) => setProfile(data as Profile | null));
  }, [sb, session]);

  // Server soati har 60 s qayta sinxronlanadi (internet uzilsa — oxirgi bog'lanish ishlatiladi)
  useEffect(() => {
    let alive = true;
    const sync = () => syncServerClock(sb).then((c) => alive && setClock(c)).catch(() => undefined);
    sync();
    const id = setInterval(sync, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, [sb]);

  const setLang = (l: Lang) => {
    localStorage.setItem("lang", l);
    setLangState(l);
    if (session) sb.from("profiles").update({ lang: l }).eq("id", session.user.id).then(() => undefined);
  };

  return <C.Provider value={{ sb, session, profile, lang, setLang, clock }}>{children}</C.Provider>;
}

export const supabaseClient = supabase;
