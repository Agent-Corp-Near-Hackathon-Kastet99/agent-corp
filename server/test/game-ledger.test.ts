import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const rpc = vi.hoisted(() => ({ view: vi.fn(), call: vi.fn() }));
vi.mock("near-api-js", () => ({ Account: class {} }));
vi.mock("../src/near.js", () => ({ provider: {}, view: rpc.view, call: rpc.call }));
import { createGameLedger } from "../src/game-ledger.js";
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "game-ledger-")); rpc.view.mockReset(); rpc.call.mockReset(); rpc.view.mockImplementation(async (_contract, method) => method === "get_config" ? { demo_mode: true, constraints: { pass_price: "100" } } : false); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const make = () => createGameLedger({ contractId: "contract.testnet", customerId: "customer.testnet", customerKey: "ed25519:test", maxPrice: "100", purchaseMarker: join(dir, "purchase") });
it("limits signing to one purchase even after an ambiguous failure", async () => {
  const ledger = make(); rpc.call.mockRejectedValue(new Error("RPC timeout"));
  await expect(ledger.call("customer", "buy_pass", {}, { depositYocto: 100n })).rejects.toThrow("RPC timeout");
  await expect(ledger.call("customer", "buy_pass", {}, { depositYocto: 100n })).rejects.toThrow("already attempted");
  await expect(ledger.call("owner", "buy_pass", {}, { depositYocto: 100n })).rejects.toThrow("cannot sign");
  expect(rpc.call).toHaveBeenCalledTimes(1);
});
it("rejects a pass already owned or a price above the limit", async () => {
  const ledger = make();
  rpc.view.mockResolvedValueOnce({ demo_mode: true, constraints: { pass_price: "101" } });
  await expect(ledger.call("customer", "buy_pass", {}, { depositYocto: 101n })).rejects.toThrow("limit");
  rpc.view.mockResolvedValueOnce({ demo_mode: true, constraints: { pass_price: "100" } }).mockResolvedValueOnce(true);
  await expect(ledger.call("customer", "buy_pass", {}, { depositYocto: 100n })).rejects.toThrow("already has a pass");
  expect(rpc.call).not.toHaveBeenCalled();
});
