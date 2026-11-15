import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { createApplication } from "../src/app.js";
import { Store } from "../src/store.js";
import { ROOT } from "../src/config.js";
import type { Activity } from "../src/ledger.js";
import { FakeChain, YOCTO } from "./board-fixture.js";
import { loadBrief } from "../src/growth/brief.js";
import { Board } from "../src/growth/board.js";
import { centsForYocto, loadPolicy, toCents, validatePolicy, yoctoForCents, type GrowthPolicy } from "../src/growth/policy.js";
import { createGrowthRuntime } from "../src/growth/runtime.js";
import { DryLlm, type JsonRequest, type JsonResult, type Llm } from "../src/growth/llm.js";

const rawPolicy = () => parse(readFileSync(join(ROOT, "growth", "policy.yaml"), "utf8"));

const mkBoard = (chain: FakeChain | undefined, over: Partial<GrowthPolicy> = {}, canWrite = true) => {
  const feed: Activity[] = [];
  const policy = { ...loadPolicy(), ...over } as GrowthPolicy;
  const board = new Board({ ledger: chain, loadPolicy: () => policy, now: () => chain?.nowMs ?? 0, log: e => feed.push(e), canWrite: () => canWrite });
  return { board, feed, policy };
};
const optionFor = (usd: number) => JSON.stringify({ max_expense_per_period: yoctoForCents(toCents(usd), 500, 50).toString() });

describe("board policy and math", () => {
  it("ships a valid board section; tiers map to exact NEAR and back", () => {
    const p = loadPolicy();
    expect(p.board).toMatchObject({ enabled: true, usd_per_near: 5, growth_share_pct: 50, bootstrap_cycle_usd: 1 });
    const opts = mkBoard(undefined).board.tierOptions(p);
    expect(opts.map(o => o.maxExpenseYocto)).toEqual(["0", "400000000000000000000000", "800000000000000000000000", "2000000000000000000000000"]);
    expect(JSON.parse(opts[2]!.json)).toEqual({ max_expense_per_period: "800000000000000000000000" }); // exactly what the contract parses
    for (const o of opts) expect(centsForYocto(BigInt(o.maxExpenseYocto), 500, 50)).toBe(Math.round(o.capUsd * 100));
    expect(toCents(0.07)).toBe(7);
    expect(() => toCents(0.001)).toThrow("2 decimals");
    expect(() => toCents(-1)).toThrow();
  });
  it("rejects boards the owner cannot stand behind", () => {
    const base = rawPolicy();
    const withBoard = (b: object) => validatePolicy({ ...base, board: { ...base.board, ...b } });
    expect(() => withBoard({ tiers_usd: [0, 1, 99] })).toThrow("owner is the ceiling");
    expect(() => withBoard({ tiers_usd: [2, 1] })).toThrow("ascending");
    expect(() => withBoard({ tiers_usd: [1] })).toThrow("2-6");
    expect(() => withBoard({ growth_share_pct: 0 })).toThrow("1-100");
    expect(() => withBoard({ growth_share_pct: 101 })).toThrow("1-100");
    expect(() => withBoard({ usd_per_near: 0 })).toThrow("usd_per_near");
    expect(() => withBoard({ bootstrap_cycle_usd: 9 })).toThrow("bootstrap");
    expect(() => withBoard({ voting_period_secs: 5 })).toThrow("voting_period_secs");
    expect(() => withBoard({ usd_per_near: 3, growth_share_pct: 7, tiers_usd: [0, 1] })).toThrow("not exactly representable");
    expect(validatePolicy({ ...base, board: undefined }).board.enabled).toBe(false); // absent section = no Board
  });
});

describe("effective growth cap (fail-closed)", () => {
  it("disabled → owner cap; no budget/no chain → bootstrap; budget → min(owner, board)", async () => {
    const owner = loadPolicy();
    expect(mkBoard(undefined, { board: { ...owner.board, enabled: false } }).board.effectiveCap()).toBe(5);
    expect(mkBoard(undefined).board.effectiveCap()).toBe(1); // enabled, no chain: bootstrap only
    const chain = new FakeChain();
    const { board } = mkBoard(chain);
    expect(board.effectiveCap()).toBe(1); // not synced yet
    await board.sync();
    expect(board.effectiveCap()).toBe(1); // synced, still no budget
    chain.budget = { proposal_id: 0, option: optionFor(2), max_expense_per_period: JSON.parse(optionFor(2)).max_expense_per_period };
    await board.sync();
    expect(board.snapshot().budget).toMatchObject({ proposalId: 0, capUsd: 2 });
    expect(board.effectiveCap()).toBe(2);
    chain.budget = { proposal_id: 1, option: optionFor(5), max_expense_per_period: (50n * YOCTO).toString() }; // 50 NEAR → $125 of growth: owner cap is the ceiling
    await board.sync();
    expect(board.snapshot().budget!.capUsd).toBe(125);
    expect(board.effectiveCap()).toBe(5);
  });
  it("a chain outage keeps the last known budget instead of failing open or crashing", async () => {
    const chain = new FakeChain();
    chain.budget = { proposal_id: 0, option: optionFor(2), max_expense_per_period: JSON.parse(optionFor(2)).max_expense_per_period };
    const { board } = mkBoard(chain);
    await board.sync();
    chain.down = true;
    const s = await board.sync();
    expect(s.chain).toBe("error");
    expect(s.error).toContain("rpc down");
    expect(board.effectiveCap()).toBe(2);
    expect(s.basis).toContain("proposal #0");
    const fresh = mkBoard(chain); // never synced + outage → bootstrap, not owner cap
    await fresh.board.sync();
    expect(fresh.board.effectiveCap()).toBe(1);
  });
  it("applyTo only lowers the cycle cap and leaves the total cap alone", async () => {
    const chain = new FakeChain();
    const { board, policy } = mkBoard(chain);
    await board.sync();
    const eff = board.applyTo(policy);
    expect(eff.cycle_budget_usd).toBe(1);
    expect(eff.total_budget_usd).toBe(policy.total_budget_usd);
    expect(policy.cycle_budget_usd).toBe(5); // original untouched
  });
  it("recomputes a cached Board cap when owner exchange policy changes", async () => {
    const chain = new FakeChain();
    chain.budget = { proposal_id: 0, option: optionFor(2), max_expense_per_period: JSON.parse(optionFor(2)).max_expense_per_period };
    const { board, policy } = mkBoard(chain);
    await board.sync();
    expect(board.effectiveCap({ ...policy, board: { ...policy.board, growth_share_pct: 25 } })).toBe(1);
  });
  it("finds open proposals beyond the first page", async () => {
    const chain = new FakeChain();
    const { board } = mkBoard(chain);
    await board.propose("first");
    const template = chain.proposals[0]!;
    chain.proposals = Array.from({ length: 51 }, (_, id) => ({ ...structuredClone(template), id, status: id === 50 ? { type: "Open" as const } : { type: "NoChange" as const } }));
    expect((await board.sync()).open?.id).toBe(50);
    await expect(board.propose("duplicate")).rejects.toThrow("already open");
  });
});

describe("proposing, voting, finalizing on the (fake) contract", () => {
  it("CEO proposes one option per tier; a second proposal is refused while one is open", async () => {
    const chain = new FakeChain();
    const { board } = mkBoard(chain);
    const r = await board.propose("Growth budget");
    expect(r.id).toBe(0);
    const call = chain.calls.find(c => c.method === "create_proposal")!;
    expect(call.role).toBe("ceo");
    expect(call.args).toMatchObject({ kind: "Budget", voting_period_secs: "3600" });
    expect((call.args.options as string[])).toHaveLength(4);
    expect(board.snapshot().open).toMatchObject({ id: 0, status: "Open", votable: true });
    expect(board.snapshot().open!.options.map(o => o.capUsd)).toEqual([0, 1, 2, 5]);
    await expect(board.propose("again")).rejects.toThrow("already open");
    expect(chain.proposals).toHaveLength(1);
  });
  it("refuses chain writes when they are off, and when the board is disabled", async () => {
    const chain = new FakeChain();
    await expect(mkBoard(chain, {}, false).board.propose("x")).rejects.toThrow("chain writes are off");
    await expect(mkBoard(chain, { board: { ...loadPolicy().board, enabled: false } }).board.propose("x")).rejects.toThrow("disabled");
    await expect(mkBoard(chain, {}, false).board.vote("alice", 0, 0)).rejects.toThrow("chain writes are off");
    await expect(mkBoard(chain, {}, false).board.finalize(0)).rejects.toThrow("chain writes are off");
    expect(chain.calls).toEqual([]);
  });
  it("unit-weighted vote → finalize once everyone voted → budget becomes the growth cap", async () => {
    const chain = new FakeChain();
    const { board, feed } = mkBoard(chain);
    await board.propose("Growth budget");
    await board.vote("alice", 0, 2); // 60k units → $2 tier
    expect(board.snapshot().open!.options[2]!.tally).toBe("60000");
    await board.sync({ finalize: true });
    expect(board.snapshot().open).toBeDefined(); // bob has not voted and time remains: not finalizable
    expect(board.effectiveCap()).toBe(1);
    await board.vote("bob", 0, 3); // 40k units → $5 tier; alice outweighs bob
    await board.sync({ finalize: true }); // all voted → permissionless finalize
    expect(chain.calls.some(c => c.method === "finalize" && c.role === "oracle")).toBe(true);
    expect(board.snapshot().open).toBeUndefined();
    expect(board.snapshot().budget).toMatchObject({ proposalId: 0, capUsd: 2 });
    expect(board.effectiveCap()).toBe(2);
    expect(feed.some(f => /passed with option 2/.test(f.text) && f.txHash)).toBe(true);
    expect(feed.filter(f => /voted option/.test(f.text)).every(f => f.text.includes("DEMO wallet"))).toBe(true);
  });
  it("re-voting replaces the earlier vote (weights, not counts)", async () => {
    const chain = new FakeChain();
    const { board } = mkBoard(chain);
    await board.propose("x");
    await board.vote("alice", 0, 1);
    await board.vote("alice", 0, 3);
    expect(board.snapshot().open!.options.map(o => o.tally)).toEqual(["0", "0", "0", "60000"]);
    expect(board.snapshot().open!.voters).toBe(1);
  });
  it("time passing finalizes without everyone voting; a tie or no votes keeps the previous budget", async () => {
    const chain = new FakeChain();
    const { board } = mkBoard(chain);
    await board.propose("first");
    chain.nowMs += 3_600_001; // voting period over, nobody voted
    await board.sync({ finalize: true });
    expect(chain.proposals[0].status.type).toBe("NoChange");
    expect(board.snapshot().budget).toBeUndefined();
    expect(board.effectiveCap()).toBe(1);
    await board.propose("second");
    chain.units = { alice: 50_000, bob: 50_000 };
    await board.vote("alice", 1, 1);
    await board.vote("bob", 1, 2);
    await board.sync({ finalize: true }); // all voted but tied
    expect(chain.proposals[1].status.type).toBe("NoChange");
    expect(board.effectiveCap()).toBe(1);
  });
  it("votes after the period, from non-contributors, and with bad input are rejected by the contract/guards", async () => {
    const chain = new FakeChain();
    const { board } = mkBoard(chain);
    await board.propose("x");
    await expect(board.vote("alice" as any, 0, -1)).rejects.toThrow("invalid");
    await expect(board.vote("mallory" as any, 0, 0)).rejects.toThrow("alice or bob");
    chain.nowMs += 3_600_001;
    await expect(board.vote("alice", 0, 0)).rejects.toThrow("voting period ended");
    chain.demo = false;
    await expect(board.vote("alice", 0, 0)).rejects.toThrow("demo_mode");
  });
  it("finalize falls back to a demo wallet when the oracle key predates the finalize allowance, and says so", async () => {
    const chain = new FakeChain();
    chain.oracleCanFinalize = false;
    const { board } = mkBoard(chain);
    await board.propose("x");
    await board.vote("alice", 0, 2); await board.vote("bob", 0, 2);
    await board.sync({ finalize: true });
    expect(chain.calls.filter(c => c.method === "finalize").map(c => c.role)).toEqual(["oracle", "alice"]);
    expect(board.effectiveCap()).toBe(2);
    // on a non-demo contract there is no fallback: failure is reported, sync does not throw, budget unchanged
    const real = new FakeChain(); real.oracleCanFinalize = false; real.demo = false;
    const b2 = mkBoard(real);
    await b2.board.propose("x");
    real.nowMs += 3_600_001;
    const snap = await b2.board.sync({ finalize: true });
    expect(snap.open).toBeDefined();
    expect(b2.feed.some(f => /could not be finalized/.test(f.text))).toBe(true);
    expect(real.calls.filter(c => c.method === "finalize").map(c => c.role)).toEqual(["oracle"]);
  });
});

/** ---------------------------------------------------------------- through the whole harness */
const roots: string[] = [], servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))));
  roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true }));
});
class Greedy implements Llm {
  readonly live = false; readonly model = "greedy";
  async json<T>(req: JsonRequest<T>): Promise<JsonResult<T>> {
    if (req.label !== "ceo.directive") return new DryLlm().json(req);
    return { value: req.validate({ ...(req.dry() as object), budget_usd: 5 }), costUsd: 0 };
  }
}
async function harness(opts: { chain?: FakeChain; writes?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "growth-board-")); roots.push(root);
  const chain = opts.chain ?? new FakeChain();
  const store = new Store(join(root, "state.json"));
  const growth = createGrowthRuntime({ log: store.log, dir: join(root, "g"), stateFile: join(root, "g", "a.json"), ledger: chain, llm: new Greedy(), dryRun: true,
    env: { GROWTH_ADMIN_TOKEN: "t", ...(opts.writes === false ? {} : { GROWTH_BOARD_WRITES: "on" }) }, now: () => chain.nowMs,
    loadBrief: () => { const b = loadBrief(); return { ...b, product: { ...b.product, url: "https://g.example/" } }; } });
  const server = createApplication({ store, growth });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const admin = (path: string, body?: unknown, token = "t") => fetch(`${url}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "x-growth-admin": token, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { chain, growth, admin, store };
}

describe("Board inside the growth harness", () => {
  it("full loop: CEO asks for more than the cap → on-chain proposal → Board votes → finalize → spending cap rises", async () => {
    const { chain, growth, admin } = await harness();
    // Before any Board budget: paid spend above the bootstrap allowance is refused by the gate.
    const before = await growth.engine.act({ cycle: 1, kind: "fal.image", summary: "key art", costUsd: 3 });
    expect(before.rec.status).toBe("DENIED");
    expect(before.rec.reason).toContain("over cycle budget");

    const rec = await growth.loop.runCycle();
    expect(rec.error).toBeUndefined();
    expect(rec.directive!.budget_usd).toBe(1); // asked for $5, clamped to the bootstrap cap
    const proposeAction = growth.engine.d.state.list({ cycle: 1 }).find(a => a.kind === "board.propose")!;
    expect(proposeAction).toMatchObject({ status: "EXECUTED", externalId: "proposal-0" });
    expect(proposeAction.url).toContain("explorer");
    expect(chain.proposals[0]).toMatchObject({ kind: "Budget", status: { type: "Open" } });

    // The state endpoint exposes the live vote; demo wallets vote through the admin route.
    let s = await (await admin("/api/growth/state")).json();
    expect(s.board.open).toMatchObject({ id: 0, votable: true });
    expect(s.budget.effectiveCycleCapUsd).toBe(1);
    expect((await admin("/api/growth/board/vote", { wallet: "alice", option: 3 })).status).toBe(200);
    expect((await admin("/api/growth/board/vote", { wallet: "bob", option: 3 })).status).toBe(200);
    const fin = await admin("/api/growth/board/finalize", {});
    expect(fin.status).toBe(200);
    s = await (await admin("/api/growth/state")).json();
    expect(s.board.budget).toMatchObject({ proposalId: 0, capUsd: 5 });
    expect(s.budget.effectiveCycleCapUsd).toBe(5);

    // Same request that was refused before is now allowed; the owner total cap still applies.
    const after = await growth.engine.act({ cycle: 2, kind: "fal.image", summary: "key art", costUsd: 3 }, async () => undefined);
    expect(after.rec.status).toBe("EXECUTED");
    const next = await growth.loop.runCycle();
    expect(next.directive!.budget_usd).toBe(5);
    expect(growth.engine.d.state.list({ cycle: 2 }).some(a => a.kind === "board.propose")).toBe(false); // no new vote needed
  });

  it("does not re-propose while a vote is open, and says so in the feed", async () => {
    const { chain, growth, store } = await harness();
    await growth.loop.runCycle();
    await growth.loop.runCycle();
    expect(chain.calls.filter(c => c.method === "create_proposal")).toHaveLength(1);
    expect(store.activity(50).some(a => /already open/.test(a.text))).toBe(true);
  });

  it("dry-run without GROWTH_BOARD_WRITES never touches the chain, and the action is labelled DRY", async () => {
    const { chain, growth, admin } = await harness({ writes: false });
    await growth.loop.runCycle();
    expect(chain.calls).toEqual([]);
    const a = growth.engine.d.state.list({ cycle: 1 }).find(x => x.kind === "board.propose")!;
    expect(a.summary.startsWith("[DRY]")).toBe(true);
    expect(a.externalId).toMatch(/^DRY-/);
    const s = await (await admin("/api/growth/state")).json();
    expect(s.board.canWrite).toBe(false);
    expect((await admin("/api/growth/board/vote", { wallet: "alice", option: 0, proposalId: 0 })).status).toBe(400);
  });

  it("no chain connection: Board is fail-closed to the bootstrap cap and the request becomes a human task", async () => {
    const root = mkdtempSync(join(tmpdir(), "growth-board-")); roots.push(root);
    const rt = createGrowthRuntime({ log: () => undefined, dir: join(root, "g"), stateFile: join(root, "g", "a.json"), llm: new Greedy(), dryRun: true, env: {},
      loadBrief: () => { const b = loadBrief(); return { ...b, product: { ...b.product, url: "https://g.example/" } }; } });
    const rec = await rt.loop.runCycle();
    expect(rec.directive!.budget_usd).toBe(1);
    expect(rt.engine.d.state.list({ cycle: 1 }).find(a => a.kind === "board.proposal")).toMatchObject({ status: "HUMAN_TASK" });
    expect(rt.board.snapshot()).toMatchObject({ chain: "none", effectiveCycleCapUsd: 1 });
  });

  it("board routes need the admin token and validate input", async () => {
    const { admin, growth } = await harness();
    for (const p of ["/api/growth/board/sync", "/api/growth/board/vote", "/api/growth/board/finalize"]) expect((await admin(p, {}, "wrong")).status, p).toBe(401);
    expect((await admin("/api/growth/board/vote", { wallet: "mallory", option: 0 })).status).toBe(400);
    expect((await admin("/api/growth/board/vote", { wallet: "alice", option: 0 })).status).toBe(409); // nothing open
    expect((await admin("/api/growth/board/finalize", {})).status).toBe(409);
    expect((await admin("/api/growth/board/sync", {})).status).toBe(200);
    await growth.board.propose("x");
    expect((await admin("/api/growth/board/finalize", { proposalId: 0 })).status).toBe(400); // voting still open
  });

});
