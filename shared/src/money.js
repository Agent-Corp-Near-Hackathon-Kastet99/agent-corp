/** Exact NEAR amounts shared by browser rendering and owner configuration. */
export const YOCTO = 10n ** 24n;
/** @param {string | number} near */
export function toYocto(near) {
  const text = String(near).trim();
  if (!/^[0-9]+(?:\.[0-9]{1,24})?$/.test(text)) throw new Error(`bad NEAR amount: ${near}`);
  const [whole, frac = ""] = text.split(".");
  const value = BigInt(whole) * YOCTO + BigInt(frac.padEnd(24, "0"));
  if (value > (1n << 128n) - 1n) throw new Error("NEAR amount exceeds U128");
  return value;
}
/** @param {bigint | string} yocto @param {number} decimals @returns {string} */
export function fmt(yocto, decimals = 2) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 24) throw new Error("decimals must be 0-24");
  const value = BigInt(yocto);
  if (value < 0n) return `-${fmt(-value, decimals)}`;
  const scale = 10n ** BigInt(24 - decimals);
  const rounded = (value + scale / 2n) / scale;
  if (decimals === 0) return rounded.toString();
  const text = rounded.toString().padStart(decimals + 1, "0");
  return `${text.slice(0, -decimals)}.${text.slice(-decimals)}`;
}
