import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HackathonDemo, envPublisher, rpcVerifier, CONNECT_GRANT, TOKEN_BASELINE, PREMIUM_PRICE_YOCTO, type Post } from "../src/hackathon.js";
const roots: string[] = [];
const post: Post = { text: "Sam Alt-Ram is live", url: "https://x.com/agentcorp/status/1234567890", publishedAt: 1_700_000_000_000, tokensUsed: 1000, basis: "provider" };
const HASH = "5".repeat(44);
function make(over: Partial<ConstructorParameters<typeof HackathonDemo>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hack-")); roots.push(dir);
  const file = join(dir, "h.json");
  const demo = new HackathonDemo({ file, explorer: "https://explorer.test", companyAccount: "corp.testnet", stepMs: 10, publisher: async () => post, getBalance: async () => "5000000000000000000000000", verifyPayment: async () => ({ amountYocto: "1000000000000000000000000" }), ...over });
  return { demo, file };
}
afterEach(() => { vi.useRealTimers(); roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });
const run = async (ms = 100) => { await vi.advanceTimersByTimeAsync(ms); };

describe("HackathonDemo", () => {
  it("accepts only an exact on-chain Smoke Grenade call", async () => {
    const response = { result: { status: { SuccessValue: "" }, transaction: { signer_id: "me.testnet", receiver_id: "corp.testnet", actions: [{ FunctionCall: { method_name: "buy_smoke_grenade", deposit: PREMIUM_PRICE_YOCTO.toString() } }] } } };
    const verify = rpcVerifier("https://rpc.example", "corp.testnet", async () => new Response(JSON.stringify(response)));
    await expect(verify(HASH, "me.testnet")).resolves.toEqual({ amountYocto: PREMIUM_PRICE_YOCTO.toString() });
    const wrong = structuredClone(response); wrong.result.transaction.actions[0]!.FunctionCall.method_name = "buy_pass";
    const reject = rpcVerifier("https://rpc.example", "corp.testnet", async () => new Response(JSON.stringify(wrong)));
    await expect(reject(HASH, "me.testnet")).rejects.toThrow("Smoke Grenade");
  });
  it("starts with mock baseline, no AI budget and You at 0%", async () => {
    const { demo } = make(); const s = await demo.snapshot();
    expect(s.tokens).toMatchObject({ totalUsed: TOKEN_BASELINE, availableBudget: 0, connected: false });
    expect(s.distribution.investors).toEqual([{ name: "alice.testnet", bps: 4000 }, { name: "bob.testnet", bps: 6000 }, { name: "You", you: true, bps: 0 }]);
    expect(s.company).toMatchObject({ balanceSource: "testnet-rpc", account: "corp.testnet" });
    expect(s.tasks.find(t => t.id === "marketing-launch-post")).toMatchObject({ status: "todo" });
  });
  it("seeds only real work and never marks unverified tasks Done or invents usage", async () => {
    const s = await make().demo.snapshot();
    expect(s.tasks.filter(t => t.source === "repo").every(t => t.usedTokens === null && t.budgetTokens === null)).toBe(true);
    for (const id of ["product-office", "product-lighting", "marketing-announcement", "self-efficiency", "self-allocation"]) expect(s.tasks.find(t => t.id === id)!.status).toBe("todo");
    expect(s.tasks.filter(t => t.status === "done").every(t => t.result)).toBe(true);
  });
  it("connect runs the marketing job To Do → In Progress → Done and updates contribution and share", async () => {
    vi.useFakeTimers(); const { demo } = make();
    expect(demo.connectAi("me.testnet")).toEqual({ started: true });
    let s = await demo.snapshot(); const card = () => s.tasks.find(t => t.id === "marketing-launch-post")!;
    expect(s.notices.map(n => n.title)).toEqual(["New AI Resources Connected", "Budget appeared. New task started", "5,000 AI Tokens Available"]);
    expect(card()).toMatchObject({ status: "in-progress", stage: "Budget Allocated" });
    expect(s.tokens.availableBudget).toBe(CONNECT_GRANT - 2000);
    await run(); s = await demo.snapshot();
    expect(card()).toMatchObject({ status: "done", usedTokens: 1000, links: [{ label: "View on X", url: post.url }] });
    expect(s.tokens).toMatchObject({ totalUsed: TOKEN_BASELINE + 1000, availableBudget: CONNECT_GRANT - 1000 });
    expect(s.investor.contributionTokens).toBe(1000);
    expect(s.investor.shareBps).toBe(Math.floor(1000 * 10_000 / (TOKEN_BASELINE + 1000)));
    expect(s.distribution.investors.reduce((a, i) => a + i.bps, 0)).toBeLessThanOrEqual(10_000);
  });
  it("records a verified worker connection without starting a marketing job", async () => {
    const { demo } = make();
    demo.recordWorkerConnection("me.testnet");
    const s = await demo.snapshot();
    expect(s.tokens).toMatchObject({ connected: true, availableBudget: CONNECT_GRANT });
    expect(s.investor.account).toBe("me.testnet");
    expect(s.job).toBeNull();
  });
  it("is idempotent: a second connect does not start a second job", async () => {
    vi.useFakeTimers(); const publisher = vi.fn(async () => post); const { demo } = make({ publisher });
    demo.connectAi("me.testnet"); expect(demo.connectAi("me.testnet")).toEqual({ started: false });
    await run(); demo.connectAi("me.testnet"); await run();
    expect(publisher).toHaveBeenCalledTimes(1);
  });
  it("records a connected investor's latest proposal vote", async () => {
    const { demo } = make();
    expect((await demo.snapshot([], "me.testnet")).proposal.myVote).toBeNull();
    demo.vote("me.testnet", "for");
    expect((await demo.snapshot([], "me.testnet")).proposal.myVote).toBe("for");
    demo.vote("me.testnet", "against");
    expect((await demo.snapshot([], "me.testnet")).proposal.myVote).toBe("against");
  });
  it("keeps a failed publish In Progress with the reason, no link, and allows an explicit retry", async () => {
    vi.useFakeTimers(); let fail = true; const { demo } = make({ publisher: async () => { if (fail) throw new Error("X down"); return post; } });
    demo.connectAi("me.testnet"); await run();
    let s = await demo.snapshot(); const card = () => s.tasks.find(t => t.id === "marketing-launch-post")!;
    expect(card()).toMatchObject({ status: "in-progress", failed: "X down", links: [] }); expect(s.investor.contributionTokens).toBe(0);
    fail = false; expect(demo.connectAi("me.testnet")).toEqual({ started: true }); await run(); s = await demo.snapshot();
    expect(card().status).toBe("done");
  });
  it("does not republish after a restart that interrupted publishing", async () => {
    vi.useFakeTimers(); const publisher = vi.fn(() => new Promise<Post>(() => {}));
    const a = make({ publisher }); a.demo.connectAi("me.testnet"); await run(); a.demo.stop();
    const again = vi.fn(async () => post);
    const b = new HackathonDemo({ file: a.file, explorer: "x", companyAccount: "corp.testnet", stepMs: 10, publisher: again });
    await run(); const s = await b.snapshot();
    expect(again).not.toHaveBeenCalled(); expect(s.job?.error).toMatch(/check X/);
  });
  it("records one verified payment as one Smoke Grenade", async () => {
    const verify = vi.fn(async () => ({ amountYocto: "1000000000000000000000000" }));
    const { demo } = make({ verifyPayment: verify });
    await expect(demo.recordPayment("short", "me.testnet")).rejects.toThrow(/Invalid/);
    const p = await demo.recordPayment(HASH, "me.testnet");
    expect(p.explorerUrl).toBe(`https://explorer.test/txns/${HASH}`);
    await demo.recordPayment(HASH, "me.testnet"); expect(verify).toHaveBeenCalledTimes(1);
    expect(demo.availableSmokes("me.testnet")).toBe(1); expect(demo.availableSmokes("other.testnet")).toBe(0);
    demo.consumeSmokes("me.testnet", 1); expect(demo.availableSmokes("me.testnet")).toBe(0);
    expect(() => demo.consumeSmokes("me.testnet", 1)).toThrow("payment required");
    const rejecting = make({ verifyPayment: async () => { throw new Error("not a payment"); } }).demo;
    await expect(rejecting.recordPayment(HASH, "me.testnet")).rejects.toThrow("not a payment");
    expect((await rejecting.snapshot()).payments).toEqual([]);
  });
  it("mirrors each newly verified Smoke Grenade sale into Company Operations once", async () => {
    const paymentLog = vi.fn();
    const { demo } = make({ paymentLog });
    await demo.recordPayment(HASH, "me.testnet");
    await demo.recordPayment(HASH, "me.testnet");
    expect(paymentLog).toHaveBeenCalledTimes(1);
    expect(paymentLog).toHaveBeenCalledWith(expect.objectContaining({
      actor: "CUSTOMER", txHash: HASH, explorerUrl: `https://explorer.test/txns/${HASH}`,
    }));
  });
  it("replays persisted verified sales into Company Operations on restart", async () => {
    const a = make();
    await a.demo.recordPayment(HASH, "me.testnet");
    const paymentLog = vi.fn();
    new HackathonDemo({ file: a.file, explorer: "https://explorer.test", companyAccount: "corp.testnet", paymentLog });
    expect(paymentLog).toHaveBeenCalledWith(expect.objectContaining({ actor: "CUSTOMER", txHash: HASH }));
  });
  it("starts the X-post task only after a payment is verified", async () => {
    vi.useFakeTimers(); const { demo } = make();
    await demo.recordPayment(HASH, "me.testnet");
    let s = await demo.snapshot();
    expect(s.job).toMatchObject({ stage: "budget_allocated" });
    await run(); s = await demo.snapshot();
    expect(s.job?.post).toMatchObject(post);
    await demo.recordPayment(HASH, "me.testnet");
    expect((await demo.snapshot()).job?.id).toBe(s.job?.id);
  });
  it("sends verified-payment launch copy through a worker before publishing", async () => {
    vi.useFakeTimers(); const requested: string[] = [];
    const publisher = vi.fn(async (text?: string) => ({ ...post, text: text ?? post.text }));
    const { demo } = make({ publisher, requestLaunchCopy: id => requested.push(id) });
    await demo.recordPayment(HASH, "me.testnet"); await run(20);
    expect(requested).toHaveLength(1);
    await demo.completeLaunchCopy(requested[0]!, { id: `launch-copy-${requested[0]}`, kind: "marketing", title: "X", prompt: "p", status: "done", output: "Foundry Stack puts unused AI capacity to work.", usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5 } });
    const s = await demo.snapshot();
    expect(publisher).toHaveBeenCalledWith("Foundry Stack puts unused AI capacity to work.");
    expect(s.job).toMatchObject({ stage: "completed", post: { tokensUsed: 14 } });
  });
  it("withdrawal is simulated, bounded by the investor's share, and cannot double spend", async () => {
    vi.useFakeTimers(); const { demo } = make();
    expect(() => demo.withdraw("me.testnet")).toThrow(/Nothing/);
    demo.connectAi("me.testnet"); await run(); await demo.recordPayment(HASH, "me.testnet");
    const s = await demo.snapshot();
    const expected = (10n ** 24n * BigInt(s.investor.shareBps)) / 10_000n;
    expect(s.investor.availableYocto).toBe(expected.toString());
    const w = demo.withdraw("me.testnet"); expect(w).toMatchObject({ simulated: true, amountYocto: expected.toString() });
    expect(w).not.toHaveProperty("txHash");
    expect(() => demo.withdraw("me.testnet")).toThrow(/Nothing/);
  });
  it("reset clears the demo but keeps verified payments unless asked", async () => {
    vi.useFakeTimers(); const { demo } = make();
    demo.connectAi("me.testnet"); await run(); await demo.recordPayment(HASH, "me.testnet");
    demo.reset(); let s = await demo.snapshot();
    expect(s.job).toBeNull(); expect(s.tokens.connected).toBe(false); expect(s.payments).toHaveLength(1);
    demo.reset({ payments: true }); s = await demo.snapshot(); expect(s.payments).toHaveLength(0);
    expect(s.tasks.find(t => t.id === "marketing-launch-post")!.status).toBe("todo");
  });
  it("kanban follows worker task state", async () => {
    const { demo } = make();
    const s = await demo.snapshot([{ id: "t1", kind: "qa", title: "QA", prompt: "p", status: "running" }, { id: "t2", kind: "marketing", title: "Caps", prompt: "p", status: "done", output: "ok" }]);
    expect(s.tasks.find(t => t.id === "worker-t1")).toMatchObject({ status: "in-progress", department: "product" });
    expect(s.tasks.find(t => t.id === "worker-t2")).toMatchObject({ status: "done", department: "marketing", result: "ok" });
  });
  it("adds completed worker token usage to the dashboard total and that worker's contribution", async () => {
    const { demo } = make();
    const tasks = [
      { id: "mine", kind: "qa" as const, title: "QA", prompt: "p", status: "done" as const, worker: "me.testnet", usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 40 } },
      { id: "other", kind: "build" as const, title: "Build", prompt: "p", status: "done" as const, worker: "other.testnet", usage: { input: 200, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { id: "running", kind: "qa" as const, title: "Running", prompt: "p", status: "running" as const, worker: "me.testnet", usage: { input: 999, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ];
    const s = await demo.snapshot(tasks, "me.testnet");
    expect(s.tokens.totalUsed).toBe(TOKEN_BASELINE + 390);
    expect(s.investor).toMatchObject({ account: "me.testnet", contributionTokens: 190, shareBps: Math.floor(190 * 10_000 / (TOKEN_BASELINE + 390)) });
    expect(s.tasks.find(t => t.id === "worker-mine")).toMatchObject({ usedTokens: 190 });
    expect(s.tasks.find(t => t.id === "worker-running")).toMatchObject({ usedTokens: null });
  });
  it("the default publisher refuses to invent a post", async () => {
    await expect(envPublisher({})()).rejects.toThrow(/not configured/);
    await expect(envPublisher({ HACKATHON_X_POST_URL: "https://evil.example/status/1", HACKATHON_X_POST_TEXT: "t", HACKATHON_X_POSTED_AT: "2026-11-15T00:00:00Z" })()).rejects.toThrow(/not configured/);
    const ok = await envPublisher({ HACKATHON_X_POST_URL: post.url, HACKATHON_X_POST_TEXT: "hello", HACKATHON_X_POSTED_AT: "2026-11-15T00:00:00Z", HACKATHON_X_POST_TOKENS: "900" })();
    expect(ok).toMatchObject({ url: post.url, tokensUsed: 900, basis: "provider" });
  });
});

import { writeFileSync, mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { createApplication } from "../src/app.js";
import { Store } from "../src/store.js";
import { TestLedger } from "./ledger-fixture.js";
describe("hackathon HTTP routes", () => {
  const servers: Server[] = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r())))); });
  async function boot(withDemo: boolean, gameOnly = false) {
    const dir = mkdtempSync(join(tmpdir(), "hack-http-")); roots.push(dir);
    const web = join(dir, "web"); mkdirSync(web); writeFileSync(join(web, "landing.html"), "landing"); writeFileSync(join(web, "index.html"), "ledger");
    const zip = join(dir, "mac.zip"); writeFileSync(zip, "zip-bytes");
    const hackathon = withDemo ? new HackathonDemo({ file: join(dir, "h.json"), explorer: "https://explorer.test", companyAccount: "corp.testnet", getBalance: async () => undefined }) : undefined;
    const server = createApplication({ ledger: new TestLedger(), store: new Store(join(dir, "s.json")), webRoot: web, hackathon, macDownload: zip, gameOnly, gameOrigin: gameOnly ? "https://game.example" : undefined });
    servers.push(server); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  it("serves state publicly, marks an unreachable balance, and requires a wallet session to mutate", async () => {
    const url = await boot(true);
    const s = await (await fetch(`${url}/api/hackathon/state`)).json();
    expect(s.company).toMatchObject({ balanceYocto: null, balanceSource: "unavailable" }); expect(s.me).toBeNull();
    const post = (p: string) => fetch(`${url}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    for (const p of ["connect-ai", "reset", "withdraw", "payment"]) expect((await post(`/api/hackathon/${p}`)).status).toBe(401);
    expect((await fetch(`${url}/api/hackathon/reset`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" })).status).toBe(403);
  });
  it("has no hackathon routes when not configured; game backend exposes only state and payment", async () => {
    expect((await fetch(`${await boot(false)}/api/hackathon/state`)).status).toBe(404);
    const game = await boot(true, true);
    expect((await fetch(`${game}/api/hackathon/state`)).status).toBe(200);
    expect((await fetch(`${game}/api/hackathon/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
  });
  it("serves landing at / and the ledger at /ledger, and the macOS download only when the file exists", async () => {
    const url = await boot(true);
    expect(await (await fetch(`${url}/`)).text()).toBe("landing"); expect(await (await fetch(`${url}/ledger`)).text()).toBe("ledger");
    const dl = await fetch(`${url}/download/agent-corp-macos-arm64.zip`);
    expect(dl.headers.get("content-type")).toBe("application/zip"); expect(await dl.text()).toBe("zip-bytes");
  });
});
