/** Amounts are always carried as integer strings in atomic units (e.g. USDC has 6 decimals). */
export const CURRENCY_DECIMALS: Record<string, number> = { USDC: 6, SAT: 0, EUR: 2, USD: 2 };

export function decimalsOf(currency: string): number {
  const d = CURRENCY_DECIMALS[currency];
  if (d === undefined) throw new Error(`Unknown currency ${currency}`);
  return d;
}

/** "0.02" USDC -> "20000". Rejects more precision than the currency supports. */
export function toAtomic(major: string | number, currency: string): string {
  const d = decimalsOf(currency);
  const s = String(major).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid amount ${s}`);
  const [int, frac = ""] = s.split(".");
  if (frac.replace(/0+$/, "").length > d) throw new Error(`Too many decimals for ${currency}: ${s}`);
  return (BigInt(int) * 10n ** BigInt(d) + BigInt((frac + "0".repeat(d)).slice(0, d) || "0")).toString();
}

/** "20000" USDC -> "0.02" */
export function toMajor(atomic: string | bigint, currency: string): string {
  const d = decimalsOf(currency);
  const v = BigInt(atomic);
  if (d === 0) return v.toString();
  const base = 10n ** BigInt(d);
  const frac = (v % base).toString().padStart(d, "0").replace(/0+$/, "");
  return (v / base).toString() + (frac ? "." + frac : "");
}

export const fmt = (atomic: string | bigint, currency: string) => `${toMajor(atomic, currency)} ${currency}`;
