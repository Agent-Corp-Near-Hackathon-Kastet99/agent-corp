import { describe, expect, it } from "vitest";
import { canWithdraw, closedPeriods } from "../web/dashboard-model.js";

describe("dashboard financial display", () => {
  const wallets = { alice: "alice.testnet", bob: "bob.testnet", customer: "buyer.testnet" };
  it("only offers a demo withdrawal for a contributor with claimable balance", () => {
    expect(canWithdraw({ account_id: wallets.alice, claimable: "0" }, wallets)).toBeNull();
    expect(canWithdraw({ account_id: wallets.alice, claimable: "480000000000000000000000" }, wallets)).toBe("alice");
    expect(canWithdraw({ account_id: wallets.customer, claimable: "1" }, wallets)).toBeNull();
    expect(canWithdraw({ account_id: wallets.bob, claimable: "invalid" }, wallets)).toBeNull();
  });
  it("shows only closed periods, newest first without mutating the ledger", () => {
    const periods = [{ id: 1, status: "Closed" }, { id: 2, status: "Closed" }, { id: 3, status: "Open" }];
    expect(closedPeriods(periods).map((p: { id: number }) => p.id)).toEqual([2, 1]);
    expect(periods[0]?.id).toBe(1);
  });
});
