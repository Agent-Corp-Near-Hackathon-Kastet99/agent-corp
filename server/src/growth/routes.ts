import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { hasPlaceholderUrl } from "./brief.js";
import { mimeFor } from "./engine.js";
import { OptInStore } from "./optin.js";
import { PAGE_HTML } from "./page.js";
import type { GrowthRuntime } from "./runtime.js";
import { errMsg, safeEqual } from "./util.js";

function send(res: ServerResponse, code: number, body: unknown, extra: Record<string, string> = {}) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 20_000) throw new Error("request too large"); }
  if (!raw) return {};
  const v: unknown = JSON.parse(raw);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("expected JSON object");
  return v as Record<string, unknown>;
}

/** Sliding-window limiter for the two public endpoints. Global, in-memory, deliberately simple. */
function limiter(max: number, windowMs: number) {
  const hits: number[] = [];
  return (now: number) => {
    while (hits.length && now - hits[0]! > windowMs) hits.shift();
    if (hits.length >= max) return false;
    hits.push(now);
    return true;
  };
}
const eventLimit = limiter(240, 60_000);
const waitlistLimit = limiter(10, 60_000);

/** Public endpoints accept cross-origin POSTs from the landing page. They carry no credentials and no admin power. */
const PUBLIC_CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };

const str = (v: unknown, name: string, max = 200) => {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error(`${name} required (max ${max} chars)`);
  return v.trim();
};

export async function handleGrowthRequest(rt: GrowthRuntime, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? "GET";
  if (path !== "/growth" && !path.startsWith("/api/growth/")) return false;
  const e = rt.engine;
  const { state, cycles, events, optin, tools, llm, dryRun, now } = e.d;

  if (path === "/growth" && method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; connect-src 'self'; base-uri 'none'; form-action 'none'" });
    res.end(PAGE_HTML);
    return true;
  }

  try {
    // ---- public endpoints
    if (path === "/api/growth/event" || path === "/api/growth/waitlist") {
      if (method === "OPTIONS") { res.writeHead(204, PUBLIC_CORS); res.end(); return true; }
      if (method !== "POST") { send(res, 405, { error: "method not allowed" }); return true; }
      const ok = path.endsWith("event") ? eventLimit(now()) : waitlistLimit(now());
      if (!ok) { send(res, 429, { error: "rate limited" }, PUBLIC_CORS); return true; }
      const b = await readBody(req);
      if (path.endsWith("event")) {
        const err = events.record(b);
        if (err) send(res, 400, { error: err }, PUBLIC_CORS); else send(res, 202, { ok: true }, PUBLIC_CORS);
        return true;
      }
      if (b.consent !== true) { send(res, 400, { error: "consent must be true" }, PUBLIC_CORS); return true; }
      if (!OptInStore.valid(b.email)) { send(res, 400, { error: "invalid email" }, PUBLIC_CORS); return true; }
      try { const r = await rt.loop.waitlistSignup(b.email as string); send(res, 200, r, PUBLIC_CORS); }
      catch (err) { send(res, 400, { error: errMsg(err) }, PUBLIC_CORS); }
      return true;
    }

    // ---- admin endpoints
    const given = req.headers["x-growth-admin"];
    if (typeof given !== "string" || !safeEqual(given, rt.adminToken)) { send(res, 401, { error: "admin token required" }); return true; }

    if (method === "GET" && path === "/api/growth/state") {
      if (rt.board.isStale()) await rt.board.sync(); // read-only refresh; finalizing is never done by polling
      const policy = e.d.loadPolicy(), brief = e.d.loadBrief();
      const boardSnap = rt.board.snapshot();
      const all = state.list();
      send(res, 200, {
        mode: { dryRun, llmLive: llm.live, model: llm.model, paused: policy.growth_paused, busy: rt.loop.busy, urlIsPlaceholder: hasPlaceholderUrl(brief),
          tools: Object.keys(tools), productUrl: brief.product.url },
        budget: { spentUsd: state.spentUsd(), totalCapUsd: policy.total_budget_usd, cycleCapUsd: policy.cycle_budget_usd, effectiveCycleCapUsd: boardSnap.effectiveCycleCapUsd },
        board: boardSnap,
        cycles: cycles.list().slice(-5),
        actions: all.slice(-120).reverse(),
        pending: state.pending(),
        humanTasks: state.list({ status: "HUMAN_TASK" }),
        funnel: events.funnel({ sinceTs: now() - 7 * 86_400_000 }),
        counts: { events: events.count(), waitlist: optin.count() },
        learnings: cycles.learnings().slice(-3000),
      });
      return true;
    }

    const asset = /^\/api\/growth\/assets\/(.+)$/.exec(path);
    if (method === "GET" && asset) {
      let file: string;
      try { file = e.assetPath(decodeURIComponent(asset[1]!)); } catch { send(res, 400, { error: "invalid asset" }); return true; }
      try {
        const data = await readFile(file);
        res.writeHead(200, { "content-type": mimeFor(file), "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "sandbox" });
        res.end(data);
      } catch { send(res, 404, { error: "not found" }); }
      return true;
    }

    if (method !== "POST") { send(res, 405, { error: "method not allowed" }); return true; }
    const b = await readBody(req);

    if (path === "/api/growth/run") {
      if (rt.loop.busy) { send(res, 409, { error: "a cycle is already running" }); return true; }
      if (e.d.loadPolicy().growth_paused) { send(res, 409, { error: "growth is paused" }); return true; }
      if (!dryRun && hasPlaceholderUrl(e.d.loadBrief())) { send(res, 409, { error: "set product.url in growth/brief.yaml before running live" }); return true; }
      void rt.loop.runCycle().catch(err => console.error(`[growth] ${errMsg(err)}`));
      send(res, 202, { started: true, dryRun });
      return true;
    }
    if (path === "/api/growth/measure") {
      const n = Number(b.cycle);
      if (!Number.isInteger(n) || n < 1) { send(res, 400, { error: "cycle must be a positive integer" }); return true; }
      const rec = await rt.loop.measureCycle(n);
      send(res, 200, rec.measurement ?? {});
      return true;
    }
    if (path === "/api/growth/board/sync") { send(res, 200, await rt.board.sync({ finalize: true })); return true; }
    if (path === "/api/growth/board/vote") {
      const wallet = b.wallet;
      if (wallet !== "alice" && wallet !== "bob") { send(res, 400, { error: "wallet must be alice or bob" }); return true; }
      const snap = rt.board.snapshot();
      const id = b.proposalId === undefined ? snap.open?.id : Number(b.proposalId);
      if (id === undefined) { send(res, 409, { error: "no open Board proposal" }); return true; }
      const tx = await rt.board.vote(wallet, id, Number(b.option));
      send(res, 200, { txHash: tx.txHash, explorerUrl: tx.explorerUrl, board: rt.board.snapshot() });
      return true;
    }
    if (path === "/api/growth/board/finalize") {
      const id = b.proposalId === undefined ? rt.board.snapshot().open?.id : Number(b.proposalId);
      if (id === undefined || !Number.isSafeInteger(id)) { send(res, 409, { error: "no open Board proposal" }); return true; }
      const tx = await rt.board.finalize(id);
      send(res, 200, { txHash: tx.txHash, explorerUrl: tx.explorerUrl, board: rt.board.snapshot() });
      return true;
    }
    if (path === "/api/growth/probe") { send(res, 200, rt.loop.probeGuardrail()); return true; }
    if (path === "/api/growth/seed") { send(res, 200, rt.loop.seed()); return true; }

    const act = /^\/api\/growth\/approvals\/([0-9a-f-]{36})\/(approve|reject)$/.exec(path);
    if (act) {
      const by = str(b.by, "by", 60);
      if (act[2] === "approve") {
        state.approve(act[1]!, by);
        const r = await e.executeRunnable();
        send(res, 200, { action: state.get(act[1]!), executed: r });
      } else {
        send(res, 200, { action: state.reject(act[1]!, by, str(b.reason ?? "rejected", "reason", 300)) });
      }
      return true;
    }
    const done = /^\/api\/growth\/tasks\/([0-9a-f-]{36})\/done$/.exec(path);
    if (done) {
      const proof = str(b.url, "url", 500);
      if (!/^https:\/\//i.test(proof)) { send(res, 400, { error: "proof url must be https" }); return true; }
      send(res, 200, { action: state.humanDone(done[1]!, str(b.by, "by", 60), proof) });
      return true;
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 400, { error: errMsg(err) }, path.endsWith("/event") || path.endsWith("/waitlist") ? PUBLIC_CORS : {});
  }
  return true;
}
