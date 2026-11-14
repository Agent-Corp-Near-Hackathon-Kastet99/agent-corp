import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadBrief } from "../src/growth/brief.js";
import { loadPolicy } from "../src/growth/policy.js";
import { createGrowthRuntime, type GrowthRuntime } from "../src/growth/runtime.js";
import { DryLlm, type JsonRequest, type JsonResult, type Llm } from "../src/growth/llm.js";
import { finalizeVariant } from "../src/growth/roles.js";
import type { Activity } from "../src/ledger.js";
import type { GrowthEnv } from "../src/growth/env.js";

const REAL_URL = "https://ramheist.example/play";
const brief = () => { const b = loadBrief(); return { ...b, product: { ...b.product, url: REAL_URL } }; };
function build(o: { dryRun?: boolean; env?: GrowthEnv; f?: typeof fetch; llm?: Llm; policy?: Partial<ReturnType<typeof loadPolicy>>; now?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "growth-e-"));
  const feed: Activity[] = [];
  const rt = createGrowthRuntime({
    log: e => feed.push(e), dir, stateFile: join(dir, "actions.json"), env: o.env ?? {}, fetchImpl: o.f, llm: o.llm, dryRun: o.dryRun ?? true, now: o.now,
    loadBrief: brief, loadPolicy: () => ({ ...loadPolicy(), ...(o.policy ?? {}) }),
  });
  return { rt, feed, dir };
}
const byKind = (rt: GrowthRuntime, kind: string, cycle = 1) => rt.engine.d.state.list({ cycle }).filter(a => a.kind === kind);

/** Wraps DryLlm so a test can override individual labels. */
class Scripted implements Llm {
  readonly live = false; readonly model = "scripted";
  constructor(private readonly over: Record<string, (req: JsonRequest<unknown>) => unknown>) {}
  async json<T>(req: JsonRequest<T>): Promise<JsonResult<T>> {
    const o = this.over[req.label];
    return o ? { value: req.validate(o(req as JsonRequest<unknown>)), costUsd: 0 } : new DryLlm().json(req);
  }
}

describe("dry-run cycle (no keys, no network)", () => {
  it("releases the cycle lock after setup or final persistence fails", async () => {
    const { rt } = build();
    const sync = vi.spyOn(rt.board, "sync").mockRejectedValueOnce(new Error("sync failed"));
    await expect(rt.loop.runCycle()).rejects.toThrow("sync failed");
    expect(rt.loop.busy).toBe(false);
    sync.mockRestore();
    const save = vi.spyOn(rt.engine.d.cycles, "save");
    save.mockImplementationOnce(() => { throw new Error("save failed"); });
    await expect(rt.loop.runCycle()).rejects.toThrow("save failed");
    expect(rt.loop.busy).toBe(false);
    save.mockRestore();
    expect((await rt.loop.runCycle()).error).toBeUndefined();
    const finalSave = vi.spyOn(rt.engine.d.cycles, "save").mockImplementation(c => {
      if (c.finishedAt) throw new Error("final save failed");
    });
    await expect(rt.loop.runCycle()).rejects.toThrow("final save failed");
    expect(rt.loop.busy).toBe(false);
    finalSave.mockRestore();
  });
  it("serializes overlapping ticks while Board sync is pending", async () => {
    const { rt } = build();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const original = rt.board.sync.bind(rt.board);
    const sync = vi.spyOn(rt.board, "sync");
    sync.mockImplementationOnce(async (...args) => { await pending; return original(...args); });
    const first = rt.loop.tick();
    expect(await rt.loop.tick()).toBe("busy");
    release();
    expect(await first).toBe("ran cycle 1");
  });
  it("runs the whole pipeline, labels everything DRY, and never executes an L2 action", async () => {
    const { rt, feed } = build();
    const rec = await rt.loop.runCycle();
    expect(rec.error).toBeUndefined();
    expect(rec.cycle).toBe(1);
    expect(rec.steps.map(s => [s.name, s.status])).toEqual([["sense", "done"], ["decide", "done"], ["research", "done"], ["create", "done"], ["gate", "done"], ["publish", "done"]]);
    expect(rec.directive).toMatchObject({ stage: "awareness", cycle: 1 });
    expect(rec.directive!.diagnosis).toContain("No audience data");
    expect(rec.assets.length).toBeGreaterThan(0);
    expect(rec.assets.filter(a => a.selected)).toHaveLength(1);
    for (const a of rec.assets) expect(existsSync(rt.engine.assetPath(a.file))).toBe(true);
    expect(rec.targets.every(t => t.why.includes("DRY-RUN SAMPLE"))).toBe(true);

    const st = rt.engine.d.state;
    const bsky = byKind(rt, "bluesky.post")[0]!;
    expect(bsky.status).toBe("EXECUTED");
    expect(bsky.externalId).toMatch(/^DRY-/);
    expect(bsky.url).toBeUndefined();
    expect(bsky.text).toContain("utm_campaign=cycle-1");
    expect(bsky.text).toContain("DEMO / testnet");
    const x = byKind(rt, "postiz.create_post.now")[0]!;
    expect(x.status).toBe("PENDING_APPROVAL");
    expect(x.text).not.toMatch(/https?:/); // link lives in the reply
    expect(x.parts![0]!.isReply).toBe(true);
    expect(x.parts![0]!.text).toContain("utm_source=x");
    expect(byKind(rt, "postiz.create_post.draft")[0]!.status).toBe("EXECUTED");
    const reddit = byKind(rt, "reddit.post")[0]!;
    expect(reddit.status).toBe("HUMAN_TASK");
    expect(st.pending()).toHaveLength(1);
    expect(feed.some(f => f.actor === "CEO" && f.text.startsWith("[DRY]"))).toBe(true);
    expect(feed.filter(f => f.actor === "MARKETING" && /^(cleared|awaiting|handed|blocked)/.test(f.text)).every(f => f.text.includes("[DRY]"))).toBe(true);
    expect(st.spentUsd()).toBe(0);
  });

  it("approving executes via the dispatcher, once", async () => {
    const { rt } = build();
    await rt.loop.runCycle();
    const x = rt.engine.d.state.pending()[0]!;
    rt.engine.d.state.approve(x.id, "ostap");
    expect(await rt.engine.executeRunnable()).toEqual({ done: 1, failed: 0 });
    expect(rt.engine.d.state.get(x.id)!.status).toBe("EXECUTED");
    expect(await rt.engine.executeRunnable()).toEqual({ done: 0, failed: 0 });
  });

  it("holds queued approvals when policy or execution mode changes", async () => {
    const policy = { growth_paused: false };
    const { rt } = build({ policy });
    await rt.loop.runCycle();
    const action = rt.engine.d.state.pending()[0]!;
    rt.engine.d.state.approve(action.id, "owner");
    policy.growth_paused = true;
    expect(await rt.engine.executeRunnable()).toEqual({ done: 0, failed: 0 });
    policy.growth_paused = false;
    rt.engine.d.dryRun = false;
    expect(await rt.engine.executeRunnable()).toEqual({ done: 0, failed: 0 });
    expect(rt.engine.d.state.get(action.id)?.status).toBe("APPROVED");
    rt.engine.d.dryRun = true;
    expect(await rt.engine.executeRunnable()).toEqual({ done: 1, failed: 0 });
  });

  it("guardrail probe is refused and never queued for approval", async () => {
    const { rt } = build();
    const r = rt.loop.probeGuardrail();
    expect(r.status).toBe("DENIED");
    expect(r.reason).toMatch(/dividend/);
    expect(rt.engine.d.state.pending()).toHaveLength(0);
  });

  it("measure + learn: reads first-party events, writes learnings, next cycle sees them", async () => {
    const { rt } = build();
    await rt.loop.runCycle();
    for (const anon of ["a1", "a2", "a3"]) rt.engine.d.events.record({ name: "page_view", anon, cycle: 1, channel: "bluesky" });
    rt.engine.d.events.record({ name: "wallet_connect", anon: "a1", cycle: 1 });
    const done = await rt.loop.measureCycle(1);
    expect(done.measurement).toMatchObject({ metric: "click", value: 3, target: 25, outcome: "miss", funnelSource: "local" });
    expect(done.learning).toContain("click = 3");
    expect(rt.engine.d.cycles.learnings()).toContain("Cycle 1");
    const c2 = await rt.loop.runCycle();
    expect(c2.cycle).toBe(2);
    expect(c2.directive!.diagnosis).toContain("3 visitors"); // decision now cites real numbers
    expect(c2.directive!.stage).toBe("traffic"); // wallet_connect = 1
  });

  it("zero data is reported as no_data, not as a made-up number", async () => {
    const { rt } = build();
    await rt.loop.runCycle();
    const m = (await rt.loop.measureCycle(1)).measurement!;
    expect(m).toMatchObject({ value: 0, outcome: "no_data", funnelSource: "none" });
  });

  it("seeded example is labelled, has no actions, and does not consume cycle numbers", async () => {
    const { rt } = build();
    const s = rt.loop.seed();
    expect(s.seeded).toBe(true);
    expect(s.directive!.diagnosis).toContain("SEEDED EXAMPLE");
    expect(rt.engine.d.state.list()).toHaveLength(0);
    expect(rt.engine.d.cycles.nextNumber()).toBe(1);
    await expect(rt.loop.measureCycle(0)).rejects.toThrow("seeded");
    expect(rt.loop.seed().startedAt).toBe(s.startedAt); // idempotent
  });

  it("refuses when paused, when already running, and tick() orchestrates measure then next cycle", async () => {
    const { rt } = build({ policy: { growth_paused: true } });
    await expect(rt.loop.runCycle()).rejects.toThrow("paused");
    let t = 1_000_000;
    const { rt: rt2 } = build({ now: () => t });
    const first = rt2.loop.runCycle();
    await expect(rt2.loop.runCycle()).rejects.toThrow("already running");
    await first;
    expect(await rt2.loop.tick()).toBe("waiting for measurement window");
    t += 25 * 3_600_000;
    expect(await rt2.loop.tick()).toBe("measured cycle 1");
    expect(await rt2.loop.tick()).toBe("ran cycle 2");
  });

  it("waitlist: records consent then sends confirmation through the gate", async () => {
    const { rt } = build();
    expect(await rt.loop.waitlistSignup("Fan@Example.com")).toEqual({ added: true });
    expect(await rt.loop.waitlistSignup("fan@example.com")).toEqual({ added: false });
    const sent = rt.engine.d.state.list().filter(a => a.kind === "resend.send.optin");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.status).toBe("EXECUTED");
    expect(sent[0]!.summary).not.toContain("fan@example.com"); // address is masked in the feed
    await expect(rt.loop.waitlistSignup("not-an-email")).rejects.toThrow("invalid email");
  });

  it("asset paths cannot escape the assets dir", () => {
    const { rt } = build();
    for (const bad of ["../x", "a/../b", "a/b/c", "/etc/passwd", ".hidden", "a b", "..", ""]) expect(() => rt.engine.assetPath(bad), bad).toThrow("invalid asset");
    expect(rt.engine.assetPath("c1-clip/clip-16x9.mp4")).toContain("assets");
  });
});

describe("finalizeVariant", () => {
  it("adds UTM link and testnet label in code; X keeps the link in a reply", () => {
    const b = brief();
    const t = finalizeVariant({ channel: "bluesky", text: "Sneak in. {{LINK}}" }, b, 4);
    expect(t.text).toContain("utm_content=c4-bluesky");
    expect(t.text.endsWith("(DEMO / testnet)")).toBe(true);
    const x = finalizeVariant({ channel: "x", text: "Hook {{LINK}}", reply: "Play:" }, b, 4);
    expect(x.text).not.toContain("http");
    expect(x.parts![0]!.text).toContain("utm_source=x");
    const noToken = finalizeVariant({ channel: "discord", text: "no token here" }, b, 1);
    expect(noToken.text).toContain(REAL_URL);
  });
});

describe("live mode with mocked network", () => {
  const png = new Uint8Array([137, 80, 78, 71]);
  function network() {
    const calls: { url: string; body?: string }[] = [];
    const f = (async (url: string | URL | Request, init: RequestInit = {}) => {
      const u = String(url);
      calls.push({ url: u, body: typeof init.body === "string" ? init.body : undefined });
      const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
      if (u.startsWith("https://fal.run/")) return json({ images: [{ url: "https://cdn.fal/i.png", content_type: "image/png" }] });
      if (u === "https://cdn.fal/i.png") return new Response(png, { headers: { "content-type": "image/png" } });
      if (u.startsWith("https://api.exa.ai/")) return json({ results: [{ title: "r/stealthgames", url: "https://reddit.com/r/stealthgames", text: "stealth" }, { title: "News", url: "https://news.example/a", text: "n" }] });
      if (u.includes("createSession")) return json({ accessJwt: "J", did: "did:plc:z" });
      if (u.includes("uploadBlob")) return json({ blob: { ref: "b" } });
      if (u.includes("createRecord")) return json({ uri: "at://did:plc:z/app.bsky.feed.post/abc" });
      if (u.endsWith("/integrations")) return json([{ id: "int-x", identifier: "x" }, { id: "int-li", identifier: "linkedin" }]);
      if (u.endsWith("/upload")) return json({ id: "m1", path: "https://cdn/m1.png" });
      if (u.endsWith("/posts")) return json([{ postId: "post-1" }]);
      if (u.includes("api.telegram.org")) return json({ ok: true, result: { message_id: 1, chat: { username: "ch" } } });
      if (u.includes("discord.com")) return json({ id: "d1" });
      return new Response("unexpected " + u, { status: 500 });
    }) as typeof fetch;
    return { f, calls };
  }
  const env: GrowthEnv = { FAL_KEY: "f", EXA_API_KEY: "e", BLUESKY_HANDLE: "corp.bsky.social", BLUESKY_APP_PASSWORD: "p", POSTIZ_API_KEY: "z", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "@ch", DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/x" };

  it("executes L0/L1 for real, queues L2, verifies targets against search output, tracks spend", async () => {
    const net = network();
    const llm = new Scripted({
      "researcher.targets": () => ({ targets: [{ name: "r/stealthgames", url: "https://reddit.com/r/stealthgames", why: "genre" }, { name: "invented", url: "https://made-up.example/x", why: "nope" }] }),
    });
    const { rt } = build({ dryRun: false, env, f: net.f, llm });
    const rec = await rt.loop.runCycle();
    expect(rec.error).toBeUndefined();
    expect(rec.targets.map(t => t.url)).toEqual(["https://reddit.com/r/stealthgames"]); // invented URL dropped
    expect(rec.assets.some(a => a.file.endsWith(".png") && a.model === "fal-ai/flux/schnell")).toBe(true);
    const bsky = byKind(rt, "bluesky.post")[0]!;
    expect(bsky).toMatchObject({ status: "EXECUTED", url: "https://bsky.app/profile/corp.bsky.social/post/abc" });
    const create = net.calls.find(c => c.url.includes("createRecord"))!;
    expect(JSON.parse(create.body!).record.text).toContain("utm_campaign=cycle-1");
    expect(net.calls.some(c => c.url.includes("uploadBlob"))).toBe(true); // image attached
    expect(byKind(rt, "telegram.post")[0]!.status).toBe("EXECUTED");
    expect(byKind(rt, "discord.post")[0]!.status).toBe("EXECUTED");
    const draft = byKind(rt, "postiz.create_post.draft")[0]!;
    expect(draft).toMatchObject({ status: "EXECUTED", externalId: "post-1" });
    // X is pending: nothing was sent to Postiz for it yet
    const xs = byKind(rt, "postiz.create_post.now")[0]!;
    expect(xs.status).toBe("PENDING_APPROVAL");
    const postsBefore = net.calls.filter(c => c.url.endsWith("/posts")).length;
    expect(postsBefore).toBe(1); // only the LinkedIn draft
    rt.engine.d.state.approve(xs.id, "ostap");
    await rt.engine.executeRunnable();
    const posts = net.calls.filter(c => c.url.endsWith("/posts"));
    expect(posts).toHaveLength(2);
    const body = JSON.parse(posts[1]!.body!);
    expect(body.type).toBe("now");
    expect(body.posts[0].integration.id).toBe("int-x");
    expect(body.posts[0].value).toHaveLength(2); // main + reply-with-link
    expect(body.posts[0].value[1].content).toContain("utm_source=x");
    expect(rt.engine.d.state.get(xs.id)).toMatchObject({ status: "EXECUTED", externalId: "post-1" });
    expect(rt.engine.d.state.spentUsd()).toBeGreaterThan(0);
    expect(rt.engine.d.state.spentUsd()).toBeLessThanOrEqual(5);
    for (const c of net.calls) expect(c.body ?? "").not.toMatch(/DRY-/);
  });

  it("a failing channel is recorded FAILED and does not stop the cycle or leak secrets", async () => {
    const net = network();
    const f = (async (url: string | URL | Request, init?: RequestInit) => String(url).includes("api.telegram.org") ? new Response("boom", { status: 500 }) : net.f(url, init)) as typeof fetch;
    const { rt } = build({ dryRun: false, env, f, llm: new Scripted({}) });
    const rec = await rt.loop.runCycle();
    expect(rec.error).toBeUndefined();
    const tg = byKind(rt, "telegram.post")[0]!;
    expect(tg.status).toBe("FAILED");
    expect(tg.reason).not.toContain("t/sendMessage");
    expect(tg.reason).not.toMatch(/bott\b/);
    expect(byKind(rt, "bluesky.post")[0]!.status).toBe("EXECUTED");
  });

  it("budget caps stop paid steps but the cycle still completes", async () => {
    const net = network();
    const { rt } = build({ dryRun: false, env, f: net.f, llm: new Scripted({}), policy: { cycle_budget_usd: 0.04, total_budget_usd: 0.04 } });
    const rec = await rt.loop.runCycle();
    const fal = byKind(rt, "fal.image");
    expect(fal.length).toBeGreaterThan(0);
    expect(fal.every(a => a.status === "DENIED" && /budget/.test(a.reason!))).toBe(true);
    expect(net.calls.some(c => c.url.startsWith("https://fal.run/"))).toBe(false);
    expect(rec.assets.filter(a => a.kind === "image")).toHaveLength(0);
    expect(rt.engine.d.state.spentUsd()).toBeLessThanOrEqual(0.04);
  });

  it("lint blocks bad model copy before approval is requested", async () => {
    const net = network();
    const llm = new Scripted({
      copywriter: () => ({ variants: [
        { channel: "bluesky", text: "Own a piece of the heist: weekly dividends {{LINK}}" },
        { channel: "linkedin", text: "A calm, honest note about a stealth puzzle. {{LINK}}" },
        { channel: "x", text: "Weekly returns for early players" },
      ] }),
    });
    const { rt } = build({ dryRun: false, env, f: net.f, llm });
    await rt.loop.runCycle();
    expect(byKind(rt, "bluesky.post")[0]).toMatchObject({ status: "DENIED" });
    expect(byKind(rt, "bluesky.post")[0]!.reason).toMatch(/dividend/);
    expect(byKind(rt, "postiz.create_post.now")[0]).toMatchObject({ status: "DENIED" });
    expect(rt.engine.d.state.pending()).toHaveLength(0);
    expect(net.calls.some(c => c.url.includes("createRecord"))).toBe(false);
    expect(byKind(rt, "postiz.create_post.draft")[0]!.status).toBe("EXECUTED");
  });

  it("refuses live runs with the placeholder product URL and live mode without an LLM key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "growth-e-"));
    expect(() => createGrowthRuntime({ log: () => undefined, dir, stateFile: join(dir, "a.json"), env: {}, dryRun: false })).toThrow("ANTHROPIC_API_KEY");
    const rt = createGrowthRuntime({ log: () => undefined, dir, stateFile: join(dir, "b.json"), env: {}, dryRun: false, llm: new Scripted({}), loadBrief: () => { const b=loadBrief(); return {...b,product:{...b.product,url:"https://REPLACE-ME.vercel.app"}}; } });
    await expect(rt.loop.runCycle()).rejects.toThrow("product.url");
  });

  it("the dispatcher refuses to email anyone without recorded opt-in", async () => {
    const net = network();
    const { rt } = build({ dryRun: false, env: { ...env, RESEND_API_KEY: "r", RESEND_FROM: "a@b.co" }, f: net.f, llm: new Scripted({}) });
    const rec = rt.engine.d.state.propose({ cycle: 0, kind: "resend.send.optin", summary: "x", text: "hello (DEMO / testnet)", payload: { to: "stranger@example.com", subject: "s" } }, rt.engine.d.loadPolicy());
    expect(rec.status).toBe("APPROVED");
    await expect(rt.engine.execute(rec)).rejects.toThrow("opt-in");
    expect(net.calls.some(c => c.url.includes("resend.com"))).toBe(false);
  });

  it("Instantly campaign is created paused through the dispatcher with no launch path", async () => {
    const calls: string[] = [];
    const f = (async (url: string | URL | Request) => { calls.push(String(url)); return new Response(JSON.stringify({ id: "camp1" }), { headers: { "content-type": "application/json" } }); }) as typeof fetch;
    const llm = new Scripted({ "ceo.directive": (req) => { const d = (req as unknown as { dry: () => Record<string, unknown> }).dry(); return { ...d, assets: ["email"] }; } });
    const { rt } = build({ dryRun: false, env: { INSTANTLY_API_KEY: "i" }, f, llm });
    await rt.loop.runCycle();
    const c = byKind(rt, "instantly.create_campaign_paused")[0]!;
    expect(c).toMatchObject({ status: "EXECUTED", externalId: "camp1" });
    expect(calls).toEqual(["https://api.instantly.ai/api/v2/campaigns"]);
    expect(calls.some(u => /activate|launch|resume/.test(u))).toBe(false);
  });
});

describe("at-most-once execution", () => {
  it("a concurrent approval cannot double-execute an action that is mid-flight", async () => {
    let release!: () => void;
    const hold = new Promise<void>(r => { release = r; });
    let records = 0;
    const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
    const f = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("createSession")) return json({ accessJwt: "J", did: "did:plc:z" });
      if (u.includes("createRecord")) { records++; await hold; return json({ uri: "at://did:plc:z/app.bsky.feed.post/abc" }); }
      return new Response("x", { status: 500 });
    }) as typeof fetch;
    const { rt } = build({ dryRun: false, env: { BLUESKY_HANDLE: "c.bsky.social", BLUESKY_APP_PASSWORD: "p" }, f, llm: new Scripted({}) });
    const first = rt.engine.act({ cycle: 1, kind: "bluesky.post", channel: "bluesky", summary: "s", text: "hello" });
    await new Promise(r => setTimeout(r, 20)); // first is now blocked inside createRecord
    expect(rt.engine.d.state.list()[0]!.status).toBe("EXECUTING");
    expect(await rt.engine.executeRunnable()).toEqual({ done: 0, failed: 0 }); // not APPROVED any more → untouched
    release();
    expect((await first).rec.status).toBe("EXECUTED");
    expect(records).toBe(1);
  });
  it("two executors racing for the same approved action: exactly one wins", () => {
    const { rt } = build();
    const a = rt.engine.d.state.propose({ cycle: 1, kind: "postiz.create_post.now", channel: "x", summary: "s", text: "hi" }, rt.engine.d.loadPolicy());
    rt.engine.d.state.approve(a.id, "o");
    rt.engine.d.state.begin(a.id);
    expect(() => rt.engine.d.state.begin(a.id)).toThrow("expected APPROVED");
  });
  it("an action interrupted mid-execution becomes FAILED on restart and is never retried automatically", async () => {
    const { rt, dir } = build();
    const a = rt.engine.d.state.propose({ cycle: 1, kind: "postiz.create_post.now", channel: "x", summary: "s", text: "hi" }, rt.engine.d.loadPolicy());
    rt.engine.d.state.approve(a.id, "o");
    rt.engine.d.state.begin(a.id); // process "dies" here
    // Simulate crash recovery after the previous process is confirmed gone.
    const { unlinkSync } = await import("node:fs");
    unlinkSync(join(dir, ".runtime.lock"));
    unlinkSync(join(dir, "actions.json.lock"));
    const again = createGrowthRuntime({ log: () => undefined, dir, stateFile: join(dir, "actions.json"), env: {}, dryRun: true, loadBrief: brief });
    const rec = again.engine.d.state.get(a.id)!;
    expect(rec.status).toBe("FAILED");
    expect(rec.reason).toContain("verify externally");
    expect(await again.engine.executeRunnable()).toEqual({ done: 0, failed: 0 });
  });
  it("tick respects the minimum gap between cycles", async () => {
    let t = 1_000_000;
    const { rt } = build({ now: () => t });
    await rt.loop.runCycle();
    t += 25 * 3_600_000;
    expect(await rt.loop.tick(48)).toBe("measured cycle 1");
    expect(await rt.loop.tick(48)).toBe("waiting for minimum gap between cycles");
    t += 24 * 3_600_000;
    expect(await rt.loop.tick(48)).toBe("ran cycle 2");
  });
});

describe("persistence", () => {
  it("drains an active cycle before releasing locks and refuses new work", async () => {
    const { rt, dir } = build();
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const original = rt.board.sync.bind(rt.board);
    vi.spyOn(rt.board, "sync").mockImplementationOnce(async (...args) => { await hold; return original(...args); });
    const cycle = rt.loop.runCycle();
    const stopping = rt.stop();
    expect(rt.stop()).toBe(stopping);
    await expect(rt.loop.runCycle()).rejects.toThrow("shutting down");
    expect(() => createGrowthRuntime({ log: () => {}, dir, stateFile: join(dir, "actions.json"), env: {}, dryRun: true })).toThrow("locked");
    release();
    expect((await cycle).error).toBeUndefined();
    await stopping;
    const next = createGrowthRuntime({ log: () => {}, dir, stateFile: join(dir, "actions.json"), env: {}, dryRun: true });
    expect(next.engine.d.cycles.get(1)?.finishedAt).toBeDefined();
    await next.stop();
  });
  it("excludes another runtime sharing either data directory or action file", async () => {
    const { rt, dir } = build();
    expect(() => createGrowthRuntime({ log: () => {}, dir, stateFile: join(dir, "other.json"), env: {}, dryRun: true })).toThrow("growth storage is locked");
    const other = mkdtempSync(join(tmpdir(), "growth-other-"));
    expect(() => createGrowthRuntime({ log: () => {}, dir: other, stateFile: join(dir, "actions.json"), env: {}, dryRun: true })).toThrow("growth storage is locked");
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { createGrowthRuntime } from './src/growth/runtime.ts';
      try { createGrowthRuntime({ log: () => {}, dir: process.env.TEST_GROWTH_DIR, stateFile: process.env.TEST_GROWTH_FILE, env: {}, dryRun: true }); process.exit(2); }
      catch (error) { if (!String(error).includes('growth storage is locked')) throw error; }
    `], { cwd: process.cwd(), env: { ...process.env, TEST_GROWTH_DIR: dir, TEST_GROWTH_FILE: join(dir, "actions.json") }, encoding: "utf8" });
    expect(child.status, child.stderr).toBe(0);
    await rt.stop();
    const next = createGrowthRuntime({ log: () => {}, dir, stateFile: join(dir, "actions.json"), env: {}, dryRun: true });
    expect(() => rt.engine.d.state.list()).toThrow("closed");
    await next.stop();
  });
  it("actions survive a restart and cycles are listed in order", async () => {
    const { rt, dir } = build();
    await rt.loop.runCycle();
    const n = rt.engine.d.state.list().length;
    await rt.stop();
    const again = createGrowthRuntime({ log: () => undefined, dir, stateFile: join(dir, "actions.json"), env: {}, dryRun: true, loadBrief: brief });
    expect(again.engine.d.state.list()).toHaveLength(n);
    expect(again.engine.d.cycles.list().map(c => c.cycle)).toEqual([1]);
    expect(readFileSync(join(dir, "actions.json"), "utf8")).not.toMatch(/ANTHROPIC|password/i);
  });
});
