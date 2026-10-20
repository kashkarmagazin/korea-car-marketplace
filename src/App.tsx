import { useState } from "react";
import { AppProvider, useApp } from "./lib/context";
import { supabase } from "./lib/supabase";
import { LANGS, t, type Lang } from "./lib/i18n";
import { AuctionDetail, AuctionList } from "./pages/Auctions";
import { SaleList } from "./pages/Sales";
import { Sell } from "./pages/Sell";
import { Admin } from "./pages/Admin";

type Tab = "auctions" | "sales" | "sell" | "admin";

function Shell() {
  const { sb, lang, setLang, session, profile } = useApp();
  const [tab, setTab] = useState<Tab>("auctions");
  const [auction, setAuction] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  return (
    <div className="app">
      <header>
        <h1>{t(lang, "appTitle")}</h1>
        <nav>
          {(["auctions", "sales", "sell"] as Tab[]).concat(profile?.role === "admin" ? ["admin"] : []).map((x) => (
            <button key={x} className={tab === x ? "active" : ""} onClick={() => { setTab(x); setAuction(null); }}>
              {t(lang, x === "auctions" ? "tabAuctions" : x === "sales" ? "tabSales" : x === "sell" ? "tabSell" : "tabAdmin")}
            </button>
          ))}
        </nav>
        <select value={lang} onChange={(e) => setLang(e.target.value as Lang)} aria-label="lang">
          {LANGS.map((l) => <option key={l} value={l}>{l.toUpperCase()}</option>)}
        </select>
        {session ? (
          <button onClick={() => sb.auth.signOut()}>{t(lang, "signOut")}</button>
        ) : (
          <form onSubmit={async (e) => { e.preventDefault(); const { error } = await sb.auth.signInWithOtp({ email }); setSent(!error); }}>
            <input type="email" required placeholder={t(lang, "email")} value={email} onChange={(e) => setEmail(e.target.value)} />
            <button>{t(lang, "sendLink")}</button>
            {sent && <span className="ok"> {t(lang, "linkSent")}</span>}
          </form>
        )}
      </header>
      <main>
        {tab === "auctions" && (auction
          ? <AuctionDetail id={auction} onBack={() => setAuction(null)} />
          : <AuctionList onOpen={setAuction} />)}
        {tab === "sales" && <SaleList />}
        {tab === "sell" && <Sell />}
        {tab === "admin" && <Admin />}
      </main>
    </div>
  );
}

export default function App() {
  if (!supabase) {
    const lang = (localStorage.getItem("lang") as Lang) || "uz";
    return <div className="app"><p className="err">{t(lang, "notConfigured")}</p></div>;
  }
  return <AppProvider sb={supabase}><Shell /></AppProvider>;
}
