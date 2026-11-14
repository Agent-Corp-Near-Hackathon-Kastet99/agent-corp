import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROVIDER_ID_RE, type ProviderOffer } from "@agentcorp/shared";
import { customAcpAdapter, parseCustomAcpAgents } from "./acp.js";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { cursor } from "./cursor.js";
import { opencode } from "./opencode.js";
import { pi } from "./pi.js";
import type { Health, ProviderAdapter } from "./types.js";

export const BUILT_IN: readonly ProviderAdapter[] = [claude, codex, opencode, cursor, pi];
export const DEFAULT_PROVIDERS = ["claude"];

/** Open provider set: built-ins plus hash-pinned custom ACP agents from `<home>/acp-agents.json`. */
export async function loadAdapters(configHome = process.env.AGENT_CORP_HOME ?? join(homedir(), ".agent-corp")): Promise<{ adapters: ProviderAdapter[]; problems: string[] }> {
  const adapters = [...BUILT_IN];
  let raw: string;
  try { raw = await readFile(join(configHome, "acp-agents.json"), "utf8"); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { adapters, problems: [] } : { adapters, problems: [`acp-agents.json: ${(error as Error).message}`] }; }
  let entries: unknown;
  try { entries = JSON.parse(raw); } catch { return { adapters, problems: ["acp-agents.json is not valid JSON"] }; }
  const parsed = parseCustomAcpAgents(entries, new Set(BUILT_IN.map(adapter => adapter.id)));
  return { adapters: [...adapters, ...parsed.agents.map(customAcpAdapter)], problems: parsed.problems.map(problem => `acp-agents.json ${problem}`) };
}

export type Discovered = { adapter: ProviderAdapter; health: Health; models?: string[] };
export async function discover(adapters: readonly ProviderAdapter[]): Promise<Discovered[]> {
  return Promise.all(adapters.map(async adapter => {
    let health: Health;
    try { health = await adapter.health(); } catch (error) { health = { status: "unknown", message: error instanceof Error ? error.message : String(error) }; }
    let models: string[] | undefined;
    if (health.status === "ready") { try { models = await adapter.models?.(); } catch { /* not enumerable */ } }
    return { adapter, health, ...(models ? { models } : {}) };
  }));
}

/** Providers the contributor named, restricted to those that are installed, signed in and runnable here. */
export function selectProviders(found: readonly Discovered[], wanted: readonly string[], allowUnverified: boolean): { enabled: Discovered[]; problems: string[] } {
  const enabled: Discovered[] = [], problems: string[] = [];
  for (const id of wanted) {
    const hit = found.find(item => item.adapter.id === id);
    if (!PROVIDER_ID_RE.test(id) || !hit) problems.push(`${id}: unknown provider`);
    else if (process.platform !== "darwin") problems.push(`${id}: the worker sandbox is only configured for macOS`);
    else if (hit.health.status !== "ready") problems.push(`${id}: ${hit.health.status}${hit.health.message ? ` (${hit.health.message})` : ""}${hit.health.status === "unauthenticated" || hit.health.status === "expired" ? `; sign in with: ${hit.adapter.signInCommand}` : ""}`);
    else if (!hit.adapter.verified && !allowUnverified) problems.push(`${id}: adapter is unverified; pass --allow-unverified to offer it`);
    else enabled.push(hit);
  }
  return { enabled, problems };
}

export const offerOf = ({ adapter, health, models }: Discovered): ProviderOffer => ({
  id: adapter.id, costSource: adapter.costSource, confinement: adapter.confinement, verified: adapter.verified,
  ...(health.version ? { version: health.version.slice(0, 40) } : {}), ...(models ? { models: models.slice(0, 200) } : {}),
});

export function describe(found: readonly Discovered[]): string {
  const rows = found.map(({ adapter, health, models }) => {
    const hint = health.status === "not_installed" ? adapter.installUrl && `install: ${adapter.installUrl}`
      : health.status === "unauthenticated" || health.status === "expired" ? `sign in: ${adapter.signInCommand}` : health.message;
    return [adapter.id, adapter.displayName, health.status, health.version ?? "-", adapter.costSource, adapter.confinement, adapter.verified ? "verified" : "unverified", `${models ? `${models.length} models. ` : ""}${hint ?? ""}`.trim()];
  });
  const head = ["ID", "PROVIDER", "STATUS", "VERSION", "UNITS FROM", "CONFINEMENT", "ADAPTER", "NOTE"];
  const width = head.map((_, column) => Math.max(head[column]!.length, ...rows.map(row => row[column]!.length)));
  return [head, ...rows].map(row => row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(width[column]!)).join("  ").trimEnd()).join("\n");
}
