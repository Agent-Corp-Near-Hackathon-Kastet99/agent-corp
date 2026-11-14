import { createHash, timingSafeEqual } from "node:crypto";

export const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export type UtmParts = { channel: string; cycle: number; asset: string };

/** Attribution link: every published URL carries channel + cycle + asset so revenue maps back to the bet. */
export function utmLink(base: string, p: UtmParts): string {
  const u = new URL(base);
  u.searchParams.set("utm_source", p.channel);
  u.searchParams.set("utm_medium", "social");
  u.searchParams.set("utm_campaign", `cycle-${p.cycle}`);
  u.searchParams.set("utm_content", p.asset);
  return u.toString();
}

export const URL_IN_TEXT = /https?:\/\/[^\s)]+/gi;

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 400);

/** Filename-safe slug. */
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "x";
