import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadBrief } from "./brief.js";
import { Board } from "./board.js";
import { CycleStore } from "./cycles.js";
import { Engine, type ChainSnapshot } from "./engine.js";
import { isDryRun, loadGrowthEnv, type GrowthEnv } from "./env.js";
import { EventStore } from "./events.js";
import { AnthropicLlm, DryLlm, type Llm } from "./llm.js";
import { GrowthLoop } from "./loop.js";
import { OptInStore } from "./optin.js";
import { loadPolicy } from "./policy.js";
import { handleGrowthRequest } from "./routes.js";
import { GrowthState } from "./state.js";
import { acquireGrowthLocks } from "./lock.js";
import { GrowthLifecycle } from "./lifecycle.js";
import { ROOT } from "../config.js";
import { makeTools, type Tools } from "./tools/index.js";
import type { Brief } from "./brief.js";
import type { GrowthPolicy } from "./policy.js";
import type { Ledger, Log, Treasury, ChainConfig } from "../ledger.js";
import type { Fetch } from "./http.js";

export type GrowthRuntime = {
  engine: Engine;
  board: Board;
  loop: GrowthLoop;
  adminToken: string;
  /** Returns true when the request was handled. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  stop(): Promise<void>;
};

export type RuntimeOptions = {
  log: Log;
  ledger?: Ledger;
  env?: GrowthEnv;
  fetchImpl?: Fetch;
  dir?: string;
  stateFile?: string;
  now?: () => number;
  tools?: Tools;
  llm?: Llm;
  dryRun?: boolean;
  loadBrief?: () => Brief;
  loadPolicy?: () => GrowthPolicy;
};

/** Wires state, stores, tools and roles. Live LLM only with a key AND live mode; otherwise a deterministic dry LLM. */
export function createGrowthRuntime(o: RuntimeOptions): GrowthRuntime {
  const env = o.env ?? loadGrowthEnv();
  const now = o.now ?? Date.now;
  const dryRun = o.dryRun ?? isDryRun(env);
  const dir = o.dir ?? process.env.GROWTH_DIR ?? join(ROOT, ".data", "growth");
  const stateFile = o.stateFile ?? process.env.GROWTH_STATE ?? join(ROOT, ".data", "growth", "actions.json");
  const unlock = acquireGrowthLocks([join(dir, ".runtime.lock"), `${stateFile}.lock`]);
  try {
  const cycles = new CycleStore(dir);
  const state = new GrowthState(o.log, now, stateFile);
  const events = new EventStore(now, o.dir ? `${o.dir}/events.json` : undefined);
  const optin = new OptInStore(now, o.dir ? `${o.dir}/optin.json` : undefined);
  const tools = o.tools ?? makeTools(env, o.fetchImpl);
  const llm: Llm = o.llm ?? (!dryRun && env.ANTHROPIC_API_KEY ? new AnthropicLlm(env, o.fetchImpl) : new DryLlm());
  if (!dryRun && !o.llm && !llm.live) throw new Error("live mode needs ANTHROPIC_API_KEY (or set GROWTH_DRY_RUN=on)");

  const readChain = o.ledger ? async (): Promise<ChainSnapshot | undefined> => {
    const [t, c] = await Promise.all([o.ledger!.view<Treasury>("get_treasury"), o.ledger!.view<ChainConfig>("get_config")]);
    return { revenueYocto: t.period_revenue, passPriceYocto: c.constraints.pass_price };
  } : undefined;

  const policyLoader = o.loadPolicy ?? loadPolicy;
  const board = new Board({ ledger: o.ledger, loadPolicy: policyLoader, now, log: o.log, canWrite: () => !dryRun || env.GROWTH_BOARD_WRITES === "on" });
  const engine = new Engine({ state, cycles, events, optin, tools, llm, env, dryRun, loadBrief: o.loadBrief ?? loadBrief, loadPolicy: policyLoader, readChain, board, log: o.log, now });
  const loop = new GrowthLoop(engine);
  const lifecycle = new GrowthLifecycle();
  const act = engine.act.bind(engine), executeRunnable = engine.executeRunnable.bind(engine), execute = engine.execute.bind(engine);
  engine.act = (p, run) => lifecycle.run(() => act(p, run));
  engine.executeRunnable = () => lifecycle.run(() => executeRunnable());
  engine.execute = rec => lifecycle.run(() => execute(rec));
  const runCycle = loop.runCycle.bind(loop), measureCycle = loop.measureCycle.bind(loop), tick = loop.tick.bind(loop), signup = loop.waitlistSignup.bind(loop);
  loop.runCycle = () => lifecycle.run(() => runCycle());
  loop.measureCycle = n => lifecycle.run(() => measureCycle(n));
  loop.tick = hours => lifecycle.run(() => tick(hours));
  loop.waitlistSignup = email => lifecycle.run(() => signup(email));
  const adminToken = env.GROWTH_ADMIN_TOKEN ?? randomBytes(16).toString("hex");
  let timer: NodeJS.Timeout | undefined;
  let stopping: Promise<void> | undefined;
  // GROWTH_AUTO_HOURS = minimum hours between cycle starts. Checked every 5 minutes: measures due cycles, then starts the next.
  const hours = Number(env.GROWTH_AUTO_HOURS ?? "0");
  if (Number.isFinite(hours) && hours > 0) {
    let ticking = false;
    timer = setInterval(() => {
      if (ticking) return;
      ticking = true;
      void loop.tick(hours).catch(e => console.error(`[growth] ${e instanceof Error ? e.message : e}`)).finally(() => { ticking = false; });
    }, 5 * 60_000);
    timer.unref();
  }
  const rt: GrowthRuntime = {
    engine, board, loop, adminToken,
    handle: (req, res, url) => {
      if (url.pathname !== "/growth" && !url.pathname.startsWith("/api/growth/")) return Promise.resolve(false);
      if (stopping) { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "growth is shutting down" })); return Promise.resolve(true); }
      return lifecycle.run(() => handleGrowthRequest(rt, req, res, url));
    },
    stop: () => {
      if (stopping) return stopping;
      if (timer) clearInterval(timer);
      stopping = lifecycle.drain().then(() => {
        if (state.list({ status: "EXECUTING" }).length) throw new Error("growth still has an untracked executing action; lock retained");
        state.close(); unlock();
      });
      return stopping;
    },
  };
  return rt;
  } catch (error) { unlock(); throw error; }
}
