import { readFile } from "node:fs/promises";
import { MODEL_ID_RE, PRICE_TABLE, validPrice, type Price } from "@agentcorp/shared";

/** Contributor-controlled rates. Missing files mean only built-in prices are trusted. */
export async function loadLocalPrices(file: string): Promise<Record<string, Price>> {
  let value: unknown;
  try { value = JSON.parse(await readFile(file, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...PRICE_TABLE };
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid local price table");
  const prices = { ...PRICE_TABLE };
  for (const [model, price] of Object.entries(value)) {
    if (!MODEL_ID_RE.test(model) || !validPrice(price)) throw new Error(`invalid local price for ${model}`);
    prices[model] = { ...price };
  }
  return prices;
}

export function samePrice(a: Price, b: Price): boolean {
  return a.inPerMTok === b.inPerMTok && a.outPerMTok === b.outPerMTok
    && a.cacheReadPerMTok === b.cacheReadPerMTok && a.cacheWritePerMTok === b.cacheWritePerMTok;
}
