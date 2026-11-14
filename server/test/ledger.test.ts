import { expect, it } from "vitest";
import { readDashboard, type LedgerView } from "../src/ledger.js";

it("reads every page using each contract collection's limit", async () => {
  const datasets: Record<string, number[]> = {
    get_contributors: Array.from({ length: 105 }, (_, i) => i),
    get_expenses: Array.from({ length: 100 }, (_, i) => i),
    get_proposals: Array.from({ length: 51 }, (_, i) => i),
    get_periods: [0, 1],
  };
  const calls: Array<{ method: string; from: number; limit: number }> = [];
  const view: LedgerView = async <T>(method: string, args?: Record<string, unknown>) => {
    if (!(method in datasets)) return { source: method } as T;
    const from = Number(args?.from_index), limit = Number(args?.limit);
    calls.push({ method, from, limit });
    return datasets[method]!.slice(from, from + limit) as T;
  };
  const dashboard = await readDashboard(view);
  expect(dashboard.contributors).toHaveLength(105);
  expect(dashboard.expenses).toHaveLength(100);
  expect(dashboard.proposals).toHaveLength(51);
  expect(calls).toContainEqual({ method: "get_proposals", from: 50, limit: 50 });
  expect(calls).toContainEqual({ method: "get_expenses", from: 100, limit: 100 });
});
