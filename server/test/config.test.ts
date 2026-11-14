import { describe, expect, it } from "vitest";
import { loadConfig, validateConfig, constraintsFromConfig } from "../src/config.js";
import { account } from "../src/near.js";
import type { KeyFile } from "../src/credentials.js";

describe("owner constraints", () => {
  it("validates all inputs before deriving contract constraints", () => {
    const config = loadConfig();
    expect(constraintsFromConfig(config).period_secs).toBe("604800");
    for (const pct of [0.29, 0.57, 1.15, 2.01]) expect(constraintsFromConfig(validateConfig({ ...config, expense_reserve_pct: pct })).expense_reserve_bps).toBe(Math.round(pct * 100));
    for (const change of [{ period_days: Infinity }, { period_days: NaN }, { expense_reserve_pct: 0.001 }, { vendors: {} }, { pass_price_near: "1.2.3" }, { vendors: [{ ...config.vendors[0], amount_near: "-1" }] }, { vendors: [{ ...config.vendors[0], payee: "../alice" }] }]) expect(() => validateConfig({ ...config, ...change })).toThrow();
    expect(() => validateConfig({ ...config, vendors: [...config.vendors, ...config.vendors] })).toThrow("duplicate");
  });
  it("never falls back from missing agent scoped key to full access", () => {
    const keys = { accounts: { oracle: { accountId: "oracle.testnet", privateKey: "must-not-be-used" }, ceo: { accountId: "ceo.testnet", privateKey: "must-not-be-used" } } } as KeyFile;
    expect(() => account(keys, "oracle")).toThrow("Missing scoped key");
    expect(() => account(keys, "ceo")).toThrow("Missing scoped key");
  });
});
