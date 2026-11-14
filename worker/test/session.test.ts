import { describe, expect, it } from "vitest";
import { WorkerSession } from "../src/session.js";
import { MODEL_PIN, PRICE_TABLE, type ServerToWorker, type WorkerToServer } from "@agentcorp/shared";
const task = (id: string): Extract<ServerToWorker, { t: "task" }> => ({ t: "task", attemptId: id, jobId: "job", subtask: "copy", leaseGeneration: 1, maxUnits: "100", prompt: "review", pageText: "data", model: MODEL_PIN });

it("refuses server rates that disagree with contributor rates before reserving", async () => {
  const sent: WorkerToServer[] = [];
  const cap = { reserve: async () => { throw new Error("must not reserve"); }, checkpoint: async () => true, commit: async () => {}, abandon: async () => {} };
  const session = new WorkerSession(cap, m => sent.push(m));
  await session.handle({ ...task("underpriced"), price: { ...PRICE_TABLE[MODEL_PIN]!, inPerMTok: 0.01 } });
  await session.handle({ ...task("unknown"), model: "unknown-model", price: PRICE_TABLE[MODEL_PIN] });
  expect(sent).toEqual([{ t: "refused", attemptId: "underpriced", reason: "unsupported" }, { t: "refused", attemptId: "unknown", reason: "unsupported" }]);
});

it("runs with contributor-configured rates when server agrees", async () => {
  const { claude } = await import("../src/providers/claude.js");
  const price = { inPerMTok: 2, outPerMTok: 10, cacheReadPerMTok: 0.5, cacheWritePerMTok: 2 };
  const sent: WorkerToServer[] = [];
  const cap = { reserve: async () => true, checkpoint: async () => true, commit: async () => {}, abandon: async () => {} };
  const session = new WorkerSession(cap, m => sent.push(m), async (_p, _u, _s, target) => {
    expect(target.price).toEqual(price);
    return { text: "done", meter: { units: "1", exact: true }, killed: false };
  }, undefined, new Map([["claude", { adapter: claude }]]), { "custom-model": price });
  await session.handle({ ...task("matched"), model: "custom-model", price });
  expect(sent).toContainEqual(expect.objectContaining({ t: "result", attemptId: "matched" }));
});

describe("worker session lifecycle", () => {
  it("claims before awaiting reservation and cancels before disconnect completes", async () => {
    const sent: WorkerToServer[] = [];
    let reserve!: (okay: boolean) => void; let began!: () => void;
    const running = new Promise<void>(resolve => { began = resolve; });
    let committed = -1n;
    const session = new WorkerSession({ reserve: () => new Promise(resolve => { reserve = resolve; }), checkpoint: async () => true, commit: async u => { committed = u; }, abandon: async () => { committed = 100n; } }, m => sent.push(m), async (_prompt, usage, signal) => {
      began(); await usage({ units: "45", exact: false });
      await new Promise<void>(resolve => signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true }));
      return { text: "", meter: { units: "45", exact: false }, killed: true };
    });
    const first = session.handle(task("one")); await session.handle(task("two"));
    expect(sent).toContainEqual({ t: "refused", attemptId: "two", reason: "busy" });
    reserve(true); await running; await session.disconnect(); await first;
    expect(committed).toBe(100n); expect(session.activeAttempt).toBeUndefined();
    expect(sent.some(m => m.t === "result")).toBe(false);
  });
  it("reports incurred units when cap rejects observed spend", async () => {
    const sent: WorkerToServer[] = []; let committed = 0n;
    const session = new WorkerSession({ reserve: async () => true, checkpoint: async () => false, commit: async u => { committed = u; }, abandon: async () => { committed = 120n; } }, m => sent.push(m), async (_prompt, usage) => {
      expect(await usage({ units: "120", exact: false })).toBe(false);
      return { text: "", meter: { units: "120", exact: false }, killed: true };
    });
    await session.handle(task("one")); expect(committed).toBe(120n);
    expect(sent).toContainEqual({ t: "failed", attemptId: "one", leaseGeneration: 1, units: "120", exact: false, reason: "cap" });
  });
  it("cancel targets active attempt and preserves failure units", async () => {
    const sent: WorkerToServer[] = []; let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const session = new WorkerSession({ reserve: async () => true, checkpoint: async () => true, commit: async () => {}, abandon: async () => {} }, m => sent.push(m), async (_p, _u, signal) => {
      started(); await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { text: "", meter: { units: "12", exact: false }, killed: true };
    });
    const work = session.handle(task("one")); await ready;
    await session.handle({ t: "cancel", attemptId: "one" }); await work;
    expect(sent).toContainEqual({ t: "failed", attemptId: "one", leaseGeneration: 1, units: "12", exact: false, reason: "cancelled" });
  });
});

it("retains full reservation when cancellation arrives before first usage event", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path"); const { tmpdir } = await import("node:os");
  const { DailyCap } = await import("../src/cap.js");
  const root = await mkdtemp(join(tmpdir(), "corp-session-")); const cap = new DailyCap(100n, root); await cap.acquire();
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const session = new WorkerSession(cap, () => {}, async (_p, _usage, signal) => {
    started(); await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    return { text: "", meter: { units: "0", exact: false }, killed: true };
  });
  const work = session.handle(task("one")); await ready; await session.disconnect(); await work;
  expect(cap.usedUnits).toBe(100n); await cap.release(); await rm(root, { recursive: true, force: true });
});

it("enforces token limit separately from contribution units", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path"); const { tmpdir } = await import("node:os");
  const { DailyCap } = await import("../src/cap.js");
  const root = await mkdtemp(join(tmpdir(), "corp-token-cap-"));
  const cost = new DailyCap(1000n, join(root, "cost")); const tokens = new DailyCap(50n, join(root, "tokens"));
  await cost.acquire(); await tokens.acquire(); const sent: WorkerToServer[] = [];
  const session = new WorkerSession(cost, m => sent.push(m), async (_p, usage) => {
    expect(await usage({ units: "20", exact: false, tokens: "51", tokensExact: false })).toBe(false);
    return { text: "", meter: { units: "20", exact: true, tokens: "51", tokensExact: true }, killed: true };
  }, tokens);
  await session.handle(task("token-test"));
  expect(tokens.usedUnits).toBe(51n); expect(cost.usedUnits).toBe(20n);
  expect(sent).toContainEqual(expect.objectContaining({ t: "failed", reason: "cap" }));
  await tokens.release(); await cost.release(); await rm(root, { recursive: true, force: true });
});

it("requires a token cap before offering a token-metered provider", async () => {
  const { codex } = await import("../src/providers/codex.js");
  const sent: WorkerToServer[] = [];
  const session = new WorkerSession({ reserve: async () => { throw new Error("must refuse before reserving"); }, checkpoint: async () => true, commit: async () => {}, abandon: async () => {} }, m => sent.push(m), async () => { throw new Error("must not run"); }, undefined, new Map([["codex", { adapter: codex }]]));
  await session.handle({ ...task("no-token-cap"), provider: "codex" });
  expect(sent).toEqual([{ t: "refused", attemptId: "no-token-cap", reason: "unsupported" }]);
});

it("retains both durable reservations when token-metered provider fails without usage", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path"); const { tmpdir } = await import("node:os");
  const { DailyCap } = await import("../src/cap.js");
  const { codex } = await import("../src/providers/codex.js");
  const root = await mkdtemp(join(tmpdir(), "corp-missing-usage-"));
  const cost = new DailyCap(1000n, join(root, "cost")), tokens = new DailyCap(500n, join(root, "tokens"));
  await cost.acquire(); await tokens.acquire();
  try {
    const sent: WorkerToServer[] = [];
    const session = new WorkerSession(cost, m => sent.push(m), async () => ({ text: "", killed: false, error: "missing usage", meter: { units: "0", exact: false, basis: "estimate" } }), tokens, new Map([["codex", { adapter: codex }]]));
    await session.handle({ ...task("missing"), provider: "codex" });
    expect(cost.usedUnits).toBe(100n); expect(tokens.usedUnits).toBe(500n);
    expect(sent).toContainEqual(expect.objectContaining({ t: "failed", exact: false, basis: "estimate", reason: "missing usage" }));
  } finally { await tokens.release(); await cost.release(); await rm(root, { recursive: true, force: true }); }
});
