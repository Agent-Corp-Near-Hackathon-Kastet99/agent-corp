import { expect, it } from "vitest";
import { acceptOffers, DEFAULT_WORKER_POLICY, settleReport, workerPolicy } from "../src/providers.js";
const policy = (credit: string[] = ["provider-cost"]) => workerPolicy({ models: [{ provider: "codex", model: "test-model", usd_per_mtok: { input: 2, output: 10, cache_read: 0.5, cache_write: 2 } }], credit_bases: credit });
const offer = { id: "codex", verified: true, costSource: "list-price", confinement: "tools-disabled" };
it("intersects model offers with owner policy and refuses false exact-cost capabilities", () => {
  expect(acceptOffers(policy(), [offer])).toHaveLength(1);
  expect(acceptOffers(policy(), [{ ...offer, models: ["different"] }])).toEqual([]);
  expect(acceptOffers(policy(), [{ ...offer, costSource: "provider-cost" }])).toEqual([]);
  expect(acceptOffers(policy(), [{ ...offer, verified: false }])).toEqual([]);
  expect(acceptOffers(DEFAULT_WORKER_POLICY, undefined)).toHaveLength(1);
});
it("recomputes inferred units from owner prices; credit requires separate opt-in", () => {
  const p = policy(), target = p.models[0]!;
  const report = { units: "999", exact: false, basis: "list-price", usage: { input: 100, output: 10, cacheRead: 20, cacheWrite: 0 } };
  expect(settleReport(p, target, report)).toMatchObject({ units: "310", exact: false, creditable: false });
  expect(settleReport(policy(["list-price"]), target, report)).toMatchObject({ units: "310", exact: false, creditable: true });
  expect(settleReport(p, target, { ...report, exact: true })).toBeUndefined();
  expect(settleReport(p, target, { ...report, basis: "provider-cost", exact: true })).toBeUndefined();
  expect(settleReport(p, target, { ...report, usage: undefined })).toBeUndefined();
  expect(settleReport(p, target, { ...report, usage: { ...report.usage, input: -1 } })).toBeUndefined();
});
it("never credits incomplete reports or accepts malformed policy", () => {
  const p = policy(["list-price"]);
  expect(settleReport(p, p.models[0]!, { units: "45", exact: false, basis: "estimate" })).toMatchObject({ creditable: false });
  expect(() => workerPolicy({ models: [{ provider: "other", model: "unknown" }] })).toThrow("usd_per_mtok");
  expect(() => workerPolicy({ models: [], credit_bases: ["estimate"] })).toThrow("credit_bases");
});
