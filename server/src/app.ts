import { GameSessions } from "./game.js";
import { readDashboard } from "./ledger.js";
import { quotePass } from "./intents.js";
import type { Role } from "./credentials.js";
/**
 * Agent Corp server.
 * - Serves the static web app (ledger, storefront, game). The pages read the ledger straight
 *   from the contract over RPC; the server is not a source of truth for money.
 * - Runs the CEO and accounting-oracle agents on a timer.
 * - Gates game levels on the on-chain pass.
 * - Exposes DEMO endpoints that sign with the testnet demo wallets.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { extname, join, resolve, relative, isAbsolute } from "node:path";
import { fmt, loadConfig, ROOT, ACCOUNT_RE, type OwnerConfig } from "./config.js";
import { reason, EXPLORER, RPC_URL } from "./near.js";
import { CompanyAgents } from "./agents.js";
import type { Ledger, ChainConfig } from "./ledger.js";
import { Store } from "./store.js";
import { HOUSE_01 } from "./levels.js";
import type { GrowthRuntime } from "./growth/runtime.js";
import { PlayerAuth } from "./player-auth.js";
import type { AccessKeyRpc } from "./auth.js";

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

export type ApplicationOptions = {
  ledger?: Ledger;
  agents?: CompanyAgents;
  store: Store;
  demoActions?: boolean;
  config?: () => OwnerConfig;
  webRoot?: string;
  gameOnly?: boolean;
  gameOrigin?: string;
  playerRpc?: AccessKeyRpc;
  /** Growth harness: Mission Control page + /api/growth/*. Absent = routes do not exist. */
  growth?: GrowthRuntime;
};

/** Import-safe application Interface: tests and executable provide concrete Adapters. */
export function createApplication(options: ApplicationOptions) {
const { ledger, store } = options;
const games = new GameSessions(store);
const players = ledger ? new PlayerAuth(ledger.contractId, options.playerRpc) : undefined;
const cookie = (req: IncomingMessage, name: string) => req.headers.cookie?.split(/;\s*/).find(c => c.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
const setCookie = (name: string, value: string, seconds = 43200) => `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${seconds}${options.gameOnly ? "; Secure" : ""}`;
const agents = options.agents ?? (ledger ? new CompanyAgents(ledger, store.log) : undefined);
const WEB = options.webRoot ?? join(ROOT, "server", "web");

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage, limit = 10_000): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > limit) throw new Error("request too large"); }
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}
function need(): Ledger {
  if (!ledger) throw new Error("Server has no testnet deployment. Run: pnpm setup:testnet");
  return ledger;
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname;
  const method = req.method ?? "GET";

  const playerPaths = ["/api/player/challenge", "/api/player/verify", "/api/player/logout", "/api/player/me", "/api/player/session", "/api/player/checkout"];
  if (options.gameOnly && !["/api/deployment", "/api/game/levels/house-01", "/api/game/levels/founder-house", "/api/game/run", "/api/game/step", "/api/demo/session", "/api/demo/buy", "/api/intents/quote", ...playerPaths].includes(path)) return json(res, 404, { error: "not found" });

  if (playerPaths.includes(path)) {
    const origin = options.gameOrigin ?? `http://${req.headers.host}`;
    if (method === "POST" && (req.headers.origin !== origin || !req.headers["content-type"]?.startsWith("application/json"))) return json(res, 403, { error: "Same-origin JSON required" });
    const auth = players;
    if (!auth) return json(res, 503, { error: "Wallet login unavailable" });
    if (path === "/api/player/challenge" && method === "POST") {
      const b = await body(req); const issued = auth.issue(String(b.account ?? ""), origin);
      res.setHeader("set-cookie", setCookie("heist-login", issued.browser, 300));
      return json(res, 200, issued.challenge);
    }
    if (path === "/api/player/verify" && method === "POST") {
      const session = await auth.verify(await body(req), cookie(req, "heist-login"), origin);
      games.remove(cookie(req, "heist"));
      res.setHeader("set-cookie", [setCookie("heist-player", session.token), setCookie("heist-login", "", 0), setCookie("heist", "", 0)]);
      return json(res, 200, { account: session.account });
    }
    if (path === "/api/player/logout" && method === "POST") {
      auth.logout(cookie(req, "heist-player")); games.remove(cookie(req, "heist"));
      res.setHeader("set-cookie", [setCookie("heist-player", "", 0), setCookie("heist", "", 0)]);
      return json(res, 200, { ok: true });
    }
    const player = auth.account(cookie(req, "heist-player"));
    if (!player) return json(res, 401, { error: "Connect and verify your testnet wallet" });
    if (path === "/api/player/me" && method === "GET") return json(res, 200, { account: player, hasPass: await need().view<boolean>("has_pass", { account_id: player }) });
    if (path === "/api/player/session" && method === "POST") {
      if (!await need().view<boolean>("has_pass", { account_id: player })) return json(res, 402, { error: "Buy a pass with your wallet first" });
      games.remove(cookie(req, "heist"));
      res.setHeader("set-cookie", setCookie("heist", games.create(player)));
      return json(res, 200, { account: player });
    }
    if (path === "/api/player/checkout" && method === "POST") {
      if (await need().view<boolean>("has_pass", { account_id: player })) return json(res, 409, { error: "Your pass is already active" });
      const c = await need().view<ChainConfig>("get_config");
      if (c.paused) return json(res, 409, { error: "Pass sales are paused" });
      return json(res, 200, { signerId: player, receiverId: need().contractId,
        actions: [{ type: "FunctionCall", params: { methodName: "buy_pass", args: {}, gas: "30000000000000", deposit: c.constraints.pass_price } }] });
    }
    return json(res, 405, { error: "method not allowed" });
  }

  if (method === "GET" && path === "/api/deployment") {
    return json(res, 200, ledger
      ? {
          network: "testnet", contractId: ledger.contractId, rpcUrl: RPC_URL, explorer: EXPLORER,
          // The public game backend has only the minimally-funded buyer key.
          // Do not present that wallet as a contributor or expose unavailable roles.
          demoWallets: options.gameOnly
            ? { customer: ledger.accounts.customer }
            : { alice: ledger.accounts.alice, bob: ledger.accounts.bob, customer: ledger.accounts.customer },
          server: true, demoActions: !!options.demoActions,
        }
      : { error: "not set up" });
  }
  if (method === "GET" && path === "/api/activity") return json(res, 200, store.activity());
  if (method === "GET" && path === "/api/tasks") return json(res, 200, store.tasks());

  if (method === "GET" && path === "/api/dashboard") {
    const dashboard = await readDashboard(<T>(method: string, args?: Record<string, unknown>) => need().view<T>(method, args));
    return json(res, 200, { network: "testnet", ...dashboard, activity: store.activity() });
  }
  const periodMatch = path.match(/^\/api\/periods\/(\d+)$/);
  if (method === "GET" && periodMatch) {
    const period = await need().view("get_period", { period_id: Number(periodMatch[1]) });
    return json(res, period ? 200 : 404, period ?? { error: "period not found" });
  }
  const passMatch = path.match(/^\/api\/passes\/([a-z0-9._-]+)$/);
  if (method === "GET" && passMatch) {
    const accountId = passMatch[1]!;
    if (!ACCOUNT_RE.test(accountId)) return json(res, 400, { error: "invalid account" });
    const pass = await need().view("get_pass", { account_id: accountId });
    return json(res, 200, { account: accountId, state: pass ? "active" : "locked", pass });
  }

  // Demo sessions use the server-controlled customer wallet, not arbitrary account IDs.
  if (path === "/api/game/levels/house-01" && method === "GET") {
    const token = req.headers.cookie?.split("; ").find(c => c.startsWith("heist="))?.slice(6) ?? "";
    try { return json(res, 200, { id: "house-01", ...games.current(token) }); }
    catch { return json(res, 401, { error: "Open the demo pass to start a game session" }); }
  }
  if (path === "/api/game/levels/founder-house" && method === "GET") {
    const token = req.headers.cookie?.split("; ").find(c => c.startsWith("heist="))?.slice(6) ?? "";
    try { return json(res, 200, games.level3d(token)); }
    catch { return json(res, 401, { error: "Open the demo pass to start a game session" }); }
  }
  if (path === "/api/game/run" && method === "POST") {
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}` && req.headers.origin !== options.gameOrigin) return json(res, 403, { error: "same origin required" });
    if (!req.headers["content-type"]?.startsWith("application/json")) return json(res, 403, { error: "JSON required" });
    const token = req.headers.cookie?.split("; ").find(c => c.startsWith("heist="))?.slice(6) ?? "";
    try { return json(res, 200, games.submitRun(token, await body(req, 400_000))); }
    catch (error) { return json(res, 400, { error: reason(error) }); }
  }
  if (path === "/api/game/step" && method === "POST") {
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}` && req.headers.origin !== options.gameOrigin) return json(res, 403, { error: "same origin required" });
    if (!req.headers["content-type"]?.startsWith("application/json")) return json(res, 403, { error: "JSON required" });
    const token = req.headers.cookie?.split("; ").find(c => c.startsWith("heist="))?.slice(6) ?? "";
    const b = await body(req);
    if (options.gameOnly && b.action !== "restart" && (!b.action || typeof b.action !== "object" || Array.isArray(b.action))) return json(res, 400, { error: "real-time control required" });
    try { return json(res, 200, b.action === "restart" ? games.restart(token) : games.move(token, b.action)); }
    catch (error) { return json(res, 400, { error: reason(error) }); }
  }

  // NEAR Intents: read-only price preview. Nothing is signed or sent.
  if (method === "GET" && path === "/api/intents/quote") {
    const chain = await need().view<ChainConfig>("get_config");
    return json(res, 200, await quotePass(url.searchParams.get("asset") ?? "", chain.constraints.pass_price));
  }

  if (path.startsWith("/api/demo/") && method === "POST") {
    const origin = req.headers.origin;
    if (!options.demoActions || !req.headers["content-type"]?.startsWith("application/json") || (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}` && origin !== options.gameOrigin)) {
      return json(res, 403, { error: "Demo actions disabled or origin rejected" });
    }
    if (!(await need().view<ChainConfig>("get_config")).demo_mode) return json(res, 403, { error: "Demo actions require demo_mode contract" });
  }

  if (method === "POST" && path === "/api/demo/seed-tasks") {
    const tasks = [
      { id: "demo-qa-house-01-v2", kind: "qa" as const, title: "House 01 QA", prompt: "Create a concise proposed QA checklist from this description only; do not claim to have played or inspected the game and do not request files. House 01 is a turn-based fictional stealth puzzle with keyboard and on-screen movement, two patrolling residents with vision cones, walls and closed doors blocking sight, a flowerpot distraction, two RAM collectibles, an exit that requires both collectibles, and detection that ends the run. Cover controls, accessibility, gameplay and edge cases.", status: "queued" as const },
      { id: "demo-marketing-house-01", kind: "marketing" as const, title: "Trailer captions", prompt: "Draft original short trailer captions for Alt-Ram Sam, a fictional stealth puzzle game. Do not claim unverified features.", status: "queued" as const },
    ];
    for (const task of tasks) if (!store.tasks().some(t => t.id === task.id)) store.upsertTask(task);
    return json(res, 200, { tasks: store.tasks() });
  }
  if (method === "POST" && path === "/api/demo/test-worker") {
    const task = { id: `worker-test-${crypto.randomUUID()}`, kind: "qa" as const, title: "Worker connection test", prompt: "Reply with one short sentence confirming this test task reached you.", status: "queued" as const };
    store.upsertTask(task);
    return json(res, 200, task);
  }
  if (method === "POST" && path === "/api/demo/session") {
    const k = need(); const customer = k.accounts.customer;
    if (!(await k.view<boolean>( "has_pass", { account_id: customer }))) return json(res, 402, { error: "Demo wallet has no pass" });
    const token = games.create(customer);
    res.setHeader("set-cookie", `heist=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${options.gameOnly ? "; Secure" : ""}`);
    return json(res, 200, { account: customer });
  }
  // ---- DEMO endpoints: sign with the testnet demo wallets created by setup.
  if (method === "POST" && path === "/api/demo/buy") {
    const k = need();
    const chain = await k.view<ChainConfig>("get_config");
    const tx = await k.call("customer", "buy_pass", {}, { depositYocto: BigInt(chain.constraints.pass_price) });
    store.log({ ts: Date.now(), actor: "CUSTOMER", text: `${k.accounts.customer} paid ${fmt(chain.constraints.pass_price)} NEAR for Alt-Ram Sam Pass (DEMO wallet)`, txHash: tx.txHash, explorerUrl: tx.explorerUrl });
    return json(res, 201, { account: k.accounts.customer, txHash: tx.txHash, explorerUrl: tx.explorerUrl });
  }
  if (method === "POST" && path === "/api/demo/agents") {
    const k = need();
    const config = (options.config ?? loadConfig)();
    await agents!.ceoTick(config);
    await agents!.oraclePayExpenses();
    return json(res, 200, { ok: true });
  }
  if (method === "POST" && path === "/api/demo/close") {
    const k = need();
    const tx = await agents!.oracleClose({ demo: true });
    return tx ? json(res, 200, { receipt: tx.value, txHash: tx.txHash, explorerUrl: tx.explorerUrl }) : json(res, 409, { error: "Period not closed (paused, or not in demo mode)" });
  }
  if (method === "POST" && path === "/api/demo/withdraw") {
    const k = need();
    const role = String((await body(req)).wallet ?? "") as Role;
    if (role !== "alice" && role !== "bob") return json(res, 400, { error: "wallet must be alice or bob" });
    const tx = await k.call<string>(role, "withdraw_distribution");
    store.log({ ts: Date.now(), actor: "WORKER", text: `${k.accounts[role]} withdrew ${fmt(tx.value)} NEAR (DEMO wallet)`, txHash: tx.txHash, explorerUrl: tx.explorerUrl });
    return json(res, 200, { amountYocto: tx.value, txHash: tx.txHash, explorerUrl: tx.explorerUrl });
  }
  if (method === "POST" && path === "/api/demo/vote") {
    const k = need();
    const b = await body(req);
    const role = String(b.wallet ?? "") as Role;
    if (role !== "alice" && role !== "bob") return json(res, 400, { error: "wallet must be alice or bob" });
    if (!Number.isSafeInteger(b.proposalId) || Number(b.proposalId) < 0 || !Number.isSafeInteger(b.option) || Number(b.option) < 0) return json(res, 400, { error: "invalid proposal or option" });
    const tx = await k.call(role, "vote", { proposal_id: Number(b.proposalId), option: Number(b.option) });
    store.log({ ts: Date.now(), actor: "WORKER", text: `${k.accounts[role]} voted on proposal #${Number(b.proposalId)} (DEMO wallet)`, txHash: tx.txHash, explorerUrl: tx.explorerUrl });
    return json(res, 200, { txHash: tx.txHash, explorerUrl: tx.explorerUrl });
  }
  json(res, 404, { error: "not found" });
}

async function statics(res: ServerResponse, url: URL): Promise<void> {
  if (url.pathname === "/shared/money.js") {
    const data = await readFile(join(ROOT, "shared", "src", "money.js"));
    res.writeHead(200, { "content-type": MIME[".js"]!, "cache-control": "no-store" });
    res.end(data); return;
  }
  const routes: Record<string, string> = { "/": "/index.html", "/store": "/store.html", "/game": "/game.html" };
  const rel = decodeURIComponent(routes[url.pathname] ?? url.pathname);
  if (rel.includes("\0")) return json(res, 400, { error: "invalid path" });
  const root = await realpath(WEB);
  let file: string;
  try { file = await realpath(resolve(root, `.${rel}`)); } catch { return json(res, 404, { error: "not found" }); }
  const relativeFile = relative(root, file);
  if (relativeFile.startsWith("..") || isAbsolute(relativeFile)) return json(res, 403, { error: "forbidden" });
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  } catch { json(res, 404, { error: "not found" }); }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!options.gameOnly && options.growth && await options.growth.handle(req, res, url)) return;
    if (url.pathname.startsWith("/api/")) await api(req, res, url);
    else if (req.method === "GET") await statics(res, url);
    else json(res, 405, { error: "method not allowed" });
  } catch (error) { json(res, 400, { error: reason(error) }); }
});

return server;
}
