import { useCallback, useEffect, useState } from "react";
import { useApp } from "../lib/context";
import { AUTH, LOCALE, NOTIFY } from "../lib/i18n";
import { formatLocal } from "../lib/time";

type N = { id: number; kind: string; payload: Record<string, unknown>; created_at: string; read_at: string | null };

/** 🔔 Ilova ichidagi bildirishnomalar (Realtime + har 30 s yangilanadi). */
export function Notifications({ onOpenAuction }: { onOpenAuction: (id: string) => void }) {
  const { sb, lang, session } = useApp();
  const [items, setItems] = useState<N[]>([]);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    if (!session) return;
    sb.from("notifications").select("*").order("created_at", { ascending: false }).limit(50)
      .then(({ data }) => setItems((data as N[]) ?? []));
  }, [sb, session]);

  useEffect(() => {
    if (!session) return;
    load();
    const ch = sb.channel("my-notifications")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${session.user.id}` }, load)
      .subscribe();
    const id = setInterval(load, 30_000);
    return () => { clearInterval(id); sb.removeChannel(ch); };
  }, [sb, session, load]);

  if (!session) return null;
  const unread = items.filter((n) => !n.read_at).length;

  return (
    <div className="notif">
      <button onClick={() => setOpen(!open)} aria-label={AUTH.notifications[lang]}>🔔{unread > 0 && <span className="dot">{unread}</span>}</button>
      {open && (
        <div className="notif-panel">
          <div className="row">
            <b>{AUTH.notifications[lang]}</b>
            {unread > 0 && <button className="link" onClick={() => sb.rpc("mark_notifications_read").then(load)}>{AUTH.markRead[lang]}</button>}
          </div>
          {items.length === 0 && <p className="muted">—</p>}
          {items.map((n) => {
            const auction = (n.payload.auction ?? n.payload.new) as string | undefined;
            return (
              <div key={n.id} className={n.read_at ? "notif-item" : "notif-item unread"}
                onClick={() => { if (auction) { onOpenAuction(auction); setOpen(false); } }}>
                <div>{NOTIFY[n.kind]?.[lang] ?? n.kind}</div>
                <small className="muted">{formatLocal(n.created_at, LOCALE[lang])}</small>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
