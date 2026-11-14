import { it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLocalPrices } from "../src/prices.js";
import { MODEL_PIN } from "@agentcorp/shared";

it("loads contributor prices and fails closed on malformed local policy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "local-prices-"));
  const file = join(dir, "prices.json");
  try {
    expect((await loadLocalPrices(file))[MODEL_PIN]).toBeDefined();
    const price = { inPerMTok: 2, outPerMTok: 10, cacheReadPerMTok: 0.5, cacheWritePerMTok: 2 };
    await writeFile(file, JSON.stringify({ "custom-model": price }));
    expect((await loadLocalPrices(file))["custom-model"]).toEqual(price);
    await writeFile(file, JSON.stringify({ "custom-model": { ...price, inPerMTok: 0 } }));
    await expect(loadLocalPrices(file)).rejects.toThrow("invalid local price");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
