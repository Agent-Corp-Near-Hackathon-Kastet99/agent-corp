import { describe, expect, it } from "vitest";
import { CompanyAgents } from "../src/agents.js";
import { loadConfig, toYocto } from "../src/config.js";
import { TestLedger } from "./ledger-fixture.js";

describe("accounting-agent Interface", () => {
  it("runs approval, payment and close in accounting order", async () => {
    const ledger = new TestLedger(); const agents = new CompanyAgents(ledger, () => {});
    await agents.tick(loadConfig());
    expect(ledger.calls).toEqual(["ceo:record_expense", "oracle:pay_expense", "oracle:close_distribution"]);
  });
  it("skips missing or smaller Board budget and respects owner cap", async () => {
    const ledger = new TestLedger(); const agents = new CompanyAgents(ledger, () => {});
    ledger.budget = null; expect(await agents.ceoTick(loadConfig())).toBe(0);
    ledger.budget = { proposal_id: 0, option: "", max_expense_per_period: toYocto("0.01").toString() };
    expect(await agents.ceoTick(loadConfig())).toBe(0);
    ledger.budget.max_expense_per_period = toYocto("1").toString();
    ledger.config.constraints.max_expense_per_period = toYocto("0.01").toString();
    expect(await agents.ceoTick(loadConfig())).toBe(0); expect(ledger.calls).toEqual([]);
  });
  it("serializes overlapping approval passes and dedupes by period rather than timestamp", async () => {
    const ledger = new TestLedger(); const agents = new CompanyAgents(ledger, () => {}); const config = loadConfig();
    await Promise.all([agents.ceoTick(config), agents.ceoTick(config)]); expect(ledger.expenses).toHaveLength(1);
    await agents.oraclePayExpenses();
    ledger.period.id++; ledger.period.expenses_approved = "0"; // identical timestamp in next period
    expect(await agents.ceoTick(config)).toBe(1); expect(ledger.expenses).toHaveLength(2);
  });
  it("keeps failed payment unpaid and prevents duplicate outstanding standing costs", async () => {
    const ledger = new TestLedger(); ledger.failPayment = true; const logs: string[] = [];
    const agents = new CompanyAgents(ledger, a => logs.push(a.text));
    await agents.ceoTick(loadConfig()); expect(await agents.oraclePayExpenses()).toBe(0);
    ledger.period.id++; ledger.period.expenses_approved = "0";
    expect(await agents.ceoTick(loadConfig())).toBe(0); expect(ledger.period.operating_costs).toBe("0");
    expect(logs.some(text => text.includes("failed"))).toBe(true);
  });
});
