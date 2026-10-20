// Pul: faqat butun sonlar (minor units). Float hisob yo'q.
export const MINOR_UNITS: Record<string, number> = { USD: 2, KRW: 0, KGS: 2, UZS: 2, RUB: 2 };

/** "1234" yoki "1234.5" (USD) -> sent. Noto'g'ri kiritish -> null. */
export function parseUsdToCents(input: string): number | null {
  const s = input.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/** Avtomobil valyutasidagi asosiy birlik -> minor units ("15000000" KRW -> 15000000; "12.5" KGS -> 1250). */
export function parseToMinor(input: string, currency: string): number | null {
  const mu = MINOR_UNITS[currency];
  if (mu === undefined) return null;
  const s = input.trim().replace(/\s/g, "").replace(",", ".");
  const re = mu === 0 ? /^\d{1,12}$/ : new RegExp(`^\\d{1,12}(\\.\\d{1,${mu}})?$`);
  if (!re.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 10 ** mu + (mu ? Number(frac.padEnd(mu, "0")) : 0);
}

export function formatMinor(minor: number | string | null | undefined, currency: string, locale = "ru-RU"): string {
  if (minor === null || minor === undefined) return "—";
  const mu = MINOR_UNITS[currency] ?? 2;
  const n = Number(minor);
  return new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: mu, maximumFractionDigits: mu })
    .format(n / 10 ** mu);
}

export const formatUsd = (cents: number | string | null | undefined, locale?: string) => formatMinor(cents, "USD", locale);
