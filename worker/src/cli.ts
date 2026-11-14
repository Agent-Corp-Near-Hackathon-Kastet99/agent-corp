#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { KeyPair } from "@near-js/crypto";
import { DAILY_CAP_DEFAULT_USD, ACCOUNT_RE, PROVIDER_ID_RE, loginPayload, type ServerToWorker, type WorkerToServer } from "@agentcorp/shared";
import { DailyCap } from "./cap.js";
import { WorkerSession, type EnabledProvider } from "./session.js";
import { DEFAULT_PROVIDERS, describe, discover, loadAdapters, offerOf, selectProviders } from "./providers/registry.js";
import { loadLocalPrices } from "./prices.js";

type Opts = { capUsd: number; capTokens?: number; server: string; account?: string; credentialPath?: string; providers: string[]; allowUnverified: boolean };
export function parseArgs(argv: string[]): Opts | "help" | "providers" {
  let capUsd = DAILY_CAP_DEFAULT_USD, server = "ws://localhost:8787/api/worker", account: string | undefined, credentialPath: string | undefined;
  let capTokens: number | undefined, providers = DEFAULT_PROVIDERS, allowUnverified = false;
  if (argv[0] === "providers" && argv.length === 1) return "providers";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--help" || argv[i] === "-h") return "help";
    if (argv[i] === "--providers") providers = [...new Set((argv[++i] ?? "").split(",").map(id => id.trim()).filter(Boolean))];
    else if (argv[i] === "--allow-unverified") allowUnverified = true;
    else if (argv[i] === "--cap-usd") capUsd = Number(argv[++i]);
    else if (argv[i] === "--cap-tokens") capTokens = Number(argv[++i]);
    else if (argv[i] === "--server") server = argv[++i] ?? "";
    else if (argv[i] === "--account") account = argv[++i];
    else if (argv[i] === "--credential") credentialPath = argv[++i];
    else throw new Error(`unknown option: ${argv[i]}`);
  }
  if (!Number.isFinite(capUsd) || capUsd < 0 || capTokens !== undefined && (!Number.isSafeInteger(capTokens) || capTokens < 0) || !server || !providers.length || !providers.every(id => PROVIDER_ID_RE.test(id))) throw new Error("invalid worker options");
  if (account && !ACCOUNT_RE.test(account)) throw new Error("invalid account");
  const url = new URL(server);
  if (!["ws:", "wss:"].includes(url.protocol)) throw new Error("server must use ws or wss");
  return { capUsd, capTokens, server, account, credentialPath, providers, allowUnverified };
}
export const help = `Usage: agent-corp-worker [--providers claude,codex] [--allow-unverified] [--cap-tokens 100000] [--cap-usd 2.00] [--server ws://localhost:8787/api/worker] [--account alice.testnet | --credential path]
       agent-corp-worker providers    list providers found on this machine, their sign-in state and how to sign in

--providers names the AI subscriptions this worker may spend (default: claude). Providers that report
token counts instead of a cost (everything except claude) also require --cap-tokens.`;

/** Discovery and local policy. Fails before connecting when a named provider cannot run here. */
export async function enableProviders(opts: Pick<Opts, "providers" | "allowUnverified" | "capTokens">): Promise<Map<string, EnabledProvider>> {
  const { adapters, problems: configProblems } = await loadAdapters();
  const { enabled, problems } = selectProviders(await discover(adapters.filter(adapter => opts.providers.includes(adapter.id))), opts.providers, opts.allowUnverified);
  for (const item of enabled) if (item.adapter.costSource === "list-price" && opts.capTokens === undefined) problems.push(`${item.adapter.id}: reports tokens, not cost; set --cap-tokens`);
  if (configProblems.length || problems.length) throw new Error(`cannot enable providers:\n  ${[...configProblems, ...problems].join("\n  ")}\nRun \`agent-corp-worker providers\` to see what is installed and signed in.`);
  return new Map(enabled.map(item => [item.adapter.id, { adapter: item.adapter, executable: item.health.executable, ...(item.models ? { models: item.models } : {}), health: item.health }]));
}

async function credential(account?: string, credentialPath?: string) {
  const base = join(homedir(), ".near-credentials", "testnet");
  if (!account && !credentialPath) throw new Error("--account required (selects ~/.near-credentials/testnet/<account>.json)");
  const json = JSON.parse(await readFile(credentialPath ?? join(base, `${account}.json`), "utf8")) as { account_id: string; public_key: string; private_key: string };
  if ((account && json.account_id !== account) || !ACCOUNT_RE.test(json.account_id)) throw new Error("credential account mismatch");
  return { account: json.account_id, publicKey: json.public_key, key: KeyPair.fromString(json.private_key) };
}
function send(ws: WebSocket, message: WorkerToServer) { ws.send(JSON.stringify(message)); }

export async function start(opts: Opts): Promise<void> {
  const id = await credential(opts.account, opts.credentialPath);
  const providers = await enableProviders(opts);
  const prices = await loadLocalPrices(join(process.env.AGENT_CORP_HOME ?? join(homedir(), ".agent-corp"), "prices.json"));
  const offers = [...providers.values()].map(provider => offerOf({ adapter: provider.adapter, health: { status: "ready" }, ...(provider.models ? { models: provider.models } : {}) }));
  const cap = new DailyCap(BigInt(Math.round(opts.capUsd * 1_000_000)), join(process.env.AGENT_CORP_HOME ?? join(homedir(), ".agent-corp"), id.account));
  await cap.acquire();
  const tokenCap = opts.capTokens === undefined ? undefined : new DailyCap(BigInt(opts.capTokens), join(process.env.AGENT_CORP_HOME ?? join(homedir(), ".agent-corp"), id.account, "tokens"));
  try { await tokenCap?.acquire(); } catch (error) { await cap.release(); throw error; }
  let ws: WebSocket;
  try { ws = new WebSocket(opts.server); } catch (error) { await tokenCap?.release(); await cap.release(); throw error; }
  const session = new WorkerSession(cap, message => { if (ws.readyState === WebSocket.OPEN) send(ws, message); }, undefined, tokenCap, providers, prices);
  const heartbeat = setInterval(() => { if (ws.readyState === WebSocket.OPEN) send(ws, { t: "heartbeat", attemptId: session.activeAttempt }); }, 10_000);
  let closing: Promise<void> | undefined;
  let authenticated = false;
  const close = () => closing ??= (async () => {
    clearInterval(heartbeat);
    await session.disconnect(); // child stops before releasing cross-process cap lock
    await tokenCap?.release();
    await cap.release();
  })();
  const shutdown = () => { ws.close(); void close().catch(error => { console.error(error); process.exitCode = 1; }); };
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
  ws.addEventListener("close", () => {
    process.removeListener("SIGINT", shutdown); process.removeListener("SIGTERM", shutdown);
    void close().catch(error => { console.error(error); process.exitCode = 1; });
  });
  ws.addEventListener("error", shutdown);
  ws.addEventListener("message", ({ data }) => {
    void (async () => {
      const msg = JSON.parse(String(data)) as ServerToWorker;
      if (msg.t === "challenge") {
        if (msg.recipient !== "agentcorp") throw new Error("wrong login recipient");
        const signed = id.key.sign(loginPayload({ account: id.account, nonce: msg.nonce }));
        send(ws, { t: "login", account: id.account, publicKey: id.publicKey, signature: Buffer.from(signed.signature).toString("base64"), nonce: msg.nonce, providers: offers });
      } else if (msg.t === "welcome") {
        if (msg.account !== id.account) throw new Error("welcome account mismatch");
        authenticated = true;
        // Handshake result: which of the offered provider models this server will assign.
        if (Array.isArray(msg.accepted)) console.error(msg.accepted.length ? `Server accepts: ${msg.accepted.map(a => `${a.provider}/${a.model}`).join(", ")}` : `Server accepts none of: ${offers.map(o => o.id).join(", ")}. No tasks will be assigned.`);
      } else {
        if (!authenticated) throw new Error("task before authenticated welcome");
        await session.handle(msg);
      }
    })().catch(error => { console.error(error instanceof Error ? error.message : error); shutdown(); });
  });
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  try { const options = parseArgs(process.argv.slice(2)); if (options === "help") console.log(help);
    else if (options === "providers") { const { adapters, problems } = await loadAdapters(); console.log(describe(await discover(adapters))); for (const problem of problems) console.error(problem); }
    else await start(options); }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
