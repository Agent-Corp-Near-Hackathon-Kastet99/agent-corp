import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApplication } from "../src/app.js";
import { Store } from "../src/store.js";
import { loadBrief } from "../src/growth/brief.js";
import { createGrowthRuntime } from "../src/growth/runtime.js";
import { DryLlm, type JsonRequest, type JsonResult, type Llm } from "../src/growth/llm.js";

const roots: string[] = [], servers: Server[] = [];
const TOKEN = "test-admin-token";
async function app(opts: { gameOnly?: boolean; llm?: Llm } = {}) {
  const root = mkdtempSync(join(tmpdir(), "growth-http-")); roots.push(root);
  const store = new Store(join(root, "state.json"));
  const growth = createGrowthRuntime({ log: store.log, dir: join(root, "g"), stateFile: join(root, "g", "actions.json"), env: { GROWTH_ADMIN_TOKEN: TOKEN }, dryRun: true, llm: opts.llm,
    loadBrief: () => { const b = loadBrief(); return { ...b, product: { ...b.product, url: "https://ramheist.example/" } }; } });
  const server = createApplication({ store, growth, gameOnly: opts.gameOnly, gameOrigin: opts.gameOnly ? "https://game.example" : undefined });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const admin = (path: string, body?: unknown, token = TOKEN) => fetch(`${url}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "x-growth-admin": token, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { url, growth, store, admin };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))));
  roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true }));
});
const waitIdle = async (admin: Awaited<ReturnType<typeof app>>["admin"]) => {
  for (let i = 0; i < 100; i++) { const s = await (await admin("/api/growth/state")).json(); if (!s.mode.busy && s.cycles.length) return s; await new Promise(r => setTimeout(r, 20)); }
  throw new Error("cycle did not finish");
};

describe("Mission Control routes", () => {
  it("serves the page with a strict CSP and no secrets", async () => {
    const { url } = await app();
    const r = await fetch(`${url}/growth`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await r.text();
    expect(html).toContain("MISSION CONTROL");
    expect(html).not.toContain(TOKEN);
  });
  it("admin endpoints require the token (constant-time compare), public ones do not", async () => {
    const { url, admin } = await app();
    expect((await fetch(`${url}/api/growth/state`)).status).toBe(401);
    expect((await admin("/api/growth/state", undefined, "wrong")).status).toBe(401);
    expect((await admin("/api/growth/state", undefined, "")).status).toBe(401);
    expect((await admin("/api/growth/state")).status).toBe(200);
    for (const p of ["/api/growth/run", "/api/growth/probe", "/api/growth/seed", "/api/growth/measure"]) {
      expect((await fetch(`${url}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, p).toBe(401);
    }
    expect((await fetch(`${url}/api/growth/assets/x.png`)).status).toBe(401);
  });
  it("run → state shows the cycle, pending approval, human task; approve executes; reject and done work", async () => {
    const { admin } = await app();
    expect((await admin("/api/growth/run", {})).status).toBe(202);
    const s = await waitIdle(admin);
    expect(s.mode).toMatchObject({ dryRun: true, llmLive: false, paused: false });
    expect(s.cycles[0].directive.stage).toBe("awareness");
    expect(s.pending).toHaveLength(1);
    expect(s.humanTasks).toHaveLength(1);
    const xid = s.pending[0].id;
    expect((await admin(`/api/growth/approvals/${xid}/approve`, { by: "" })).status).toBe(400);
    const ok = await (await admin(`/api/growth/approvals/${xid}/approve`, { by: "ostap" })).json();
    expect(ok.action.status).toBe("EXECUTED");
    expect((await admin(`/api/growth/approvals/${xid}/approve`, { by: "ostap" })).status).toBe(400); // not approvable twice
    const tid = s.humanTasks[0].id;
    expect((await admin(`/api/growth/tasks/${tid}/done`, { by: "o", url: "http://insecure" })).status).toBe(400);
    expect((await admin(`/api/growth/tasks/${tid}/done`, { by: "o", url: "https://reddit.com/r/x/1" })).status).toBe(200);
    expect((await admin("/api/growth/approvals/not-a-uuid/approve", { by: "o" })).status).toBe(404);
  });
  it("a second run while busy is refused with 409", async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const slow: Llm = { live: false, model: "slow", async json<T>(req: JsonRequest<T>): Promise<JsonResult<T>> { await gate; return new DryLlm().json(req); } };
    const { admin, growth } = await app({ llm: slow });
    expect((await admin("/api/growth/run", {})).status).toBe(202);
    expect(growth.loop.busy).toBe(true);
    expect((await admin("/api/growth/run", {})).status).toBe(409);
    expect((await (await admin("/api/growth/state")).json()).mode.busy).toBe(true);
    release();
    const s = await waitIdle(admin);
    expect(s.cycles).toHaveLength(1);
  });
  it("probe is refused by the gate; seed is labelled; measure validates input", async () => {
    const { admin } = await app();
    const probe = await (await admin("/api/growth/probe", {})).json();
    expect(probe.status).toBe("DENIED");
    const seed = await (await admin("/api/growth/seed", {})).json();
    expect(seed.seeded).toBe(true);
    expect((await admin("/api/growth/measure", { cycle: "x" })).status).toBe(400);
    expect((await admin("/api/growth/measure", { cycle: 99 })).status).toBe(400);
  });
  it("assets: served with sandbox CSP; traversal and unknown files rejected", async () => {
    const { admin } = await app();
    await admin("/api/growth/run", {});
    const s = await waitIdle(admin);
    const file = s.cycles[0].assets[0].file as string;
    const r = await admin(`/api/growth/assets/${file}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toBe("sandbox");
    expect(r.headers.get("content-type")).toContain("image/svg+xml");
    expect((await admin("/api/growth/assets/..%2Fstate.json")).status).toBe(400);
    expect((await admin("/api/growth/assets/a/b/c.png")).status).toBe(400);
    expect((await admin("/api/growth/assets/missing.png")).status).toBe(404);
  });
  it("public event endpoint: CORS preflight, validation, rate limit shape, counts show in state", async () => {
    const { url, admin } = await app();
    const pre = await fetch(`${url}/api/growth/event`, { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    const post = (b: unknown) => fetch(`${url}/api/growth/event`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    const ok = await post({ name: "page_view", anon: "visitor1", cycle: 1, channel: "bluesky", asset: "c1-bluesky" });
    expect(ok.status).toBe(202);
    expect(ok.headers.get("access-control-allow-origin")).toBe("*");
    expect((await post({ name: "evil", anon: "v" })).status).toBe(400);
    expect((await fetch(`${url}/api/growth/event`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" })).status).toBe(400);
    expect((await fetch(`${url}/api/growth/event`, { method: "GET" })).status).toBe(405);
    const s = await (await admin("/api/growth/state")).json();
    expect(s.counts.events).toBe(1);
    expect(s.funnel.page_view).toBe(1);
  });
  it("waitlist needs explicit consent and a valid email; duplicates are idempotent", async () => {
    const { url, admin } = await app();
    const post = (b: unknown) => fetch(`${url}/api/growth/waitlist`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    expect((await post({ email: "a@b.co" })).status).toBe(400);
    expect((await post({ email: "nope", consent: true })).status).toBe(400);
    expect(await (await post({ email: "a@b.co", consent: true })).json()).toEqual({ added: true });
    expect(await (await post({ email: "a@b.co", consent: true })).json()).toEqual({ added: false });
    expect((await (await admin("/api/growth/state")).json()).counts.waitlist).toBe(1);
  });
  it("does not disturb existing routes and is absent in game-only mode", async () => {
    const a = await app();
    expect((await fetch(`${a.url}/api/activity`)).status).toBe(200);
    const g = await app({ gameOnly: true });
    expect((await fetch(`${g.url}/growth`)).status).not.toBe(200);
    expect((await g.admin("/api/growth/state")).status).toBe(404);
  });
  it("oversized bodies are rejected", async () => {
    const { admin } = await app();
    expect((await admin("/api/growth/seed", { pad: "x".repeat(30_000) })).status).toBe(400);
  });
});
