// Server vaqtiga asoslangan taymer.
// Qurilma soati ishlatilmaydi: server_now() javobi monoton performance.now() bilan bog'lanadi,
// shuning uchun foydalanuvchi soatni o'zgartirsa ham qolgan vaqt o'zgarmaydi.
// Auksion haqiqiy tugashi baribir serverda tekshiriladi (place_bid / finalize).

export type ServerClock = { serverMsAtAnchor: number; perfAtAnchor: number };

/** Yarim-yo'l (RTT/2) tuzatishi bilan server soatini bog'laydi. */
export function anchorClock(serverIso: string, perfBefore: number, perfAfter: number): ServerClock {
  return { serverMsAtAnchor: Date.parse(serverIso), perfAtAnchor: (perfBefore + perfAfter) / 2 };
}

export function serverNow(clock: ServerClock, perfNow: number): number {
  return clock.serverMsAtAnchor + (perfNow - clock.perfAtAnchor);
}

export function remainingMs(endsAtIso: string, clock: ServerClock, perfNow: number): number {
  return Math.max(0, Date.parse(endsAtIso) - serverNow(clock, perfNow));
}

export function splitDuration(ms: number): { d: number; h: number; m: number; s: number } {
  const t = Math.floor(ms / 1000);
  return { d: Math.floor(t / 86400), h: Math.floor((t % 86400) / 3600), m: Math.floor((t % 3600) / 60), s: t % 60 };
}

export function formatRemaining(ms: number): string {
  const { d, h, m, s } = splitDuration(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d > 0 ? `${d}d ` : ""}${p(h)}:${p(m)}:${p(s)}`;
}

/** UTC vaqtni foydalanuvchining mahalliy mintaqasida ko'rsatish. */
export function formatLocal(iso: string, locale: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(iso));
}
