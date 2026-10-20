import { useEffect, useState } from "react";
import { useApp } from "../lib/context";
import { formatRemaining, remainingMs } from "../lib/time";
import { t } from "../lib/i18n";

/** Qolgan vaqt: server soatiga bog'langan; tugash vaqti doim serverdan (ends_at) olinadi. */
export function Countdown({ endsAt, paused, onZero }: { endsAt: string; paused?: boolean; onZero?: () => void }) {
  const { clock, lang } = useApp();
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const id = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const ms = clock ? remainingMs(endsAt, clock, now) : null;
  const done = ms === 0 && !paused;
  useEffect(() => {
    if (done) onZero?.();
  }, [done, endsAt, onZero]);

  if (paused) return <span className="badge warn">{t(lang, "paused")}</span>;
  if (ms === null) return <span>…</span>;
  if (ms === 0) return <span className="badge">{t(lang, "ended")}</span>;
  return <span className={ms < 120_000 ? "countdown urgent" : "countdown"}>{formatRemaining(ms)}</span>;
}
