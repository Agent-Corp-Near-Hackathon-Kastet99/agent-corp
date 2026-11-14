// Custom ACP agents. Schema patterns (slug ids, environment names, `acp-<slug>` provider ids and
// reserved built-in ids) are adapted from get-bb/bb (MIT, Copyright (c) 2026 Michael Yong):
// plugins/provider-acp/src/agents.ts. See worker/THIRD_PARTY_NOTICES.md.
// bb trusts a configured agent as a coding agent with tools. This worker does not: the executable
// is pinned by hash, every permission request is refused, no client filesystem or terminal is
// offered, and a run without reported token usage is a failed run.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { MODEL_ID_RE } from "@agentcorp/shared";
import { LOCALE_ENV, installGrants, mergeGrants, privateEnv, record, tokens } from "./common.js";
import { isScript, linkCredential, restoreCredential } from "./probe.js";
import type { Parsed, Parser, ProviderAdapter } from "./types.js";

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/u;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const DENIED_ENV = /^(HOME|PATH|TMPDIR|DYLD_.*|LD_.*|NODE_OPTIONS)$/u;

export type CustomAcpAgent = {
  id: string; displayName: string; command: string; args: string[]; env: Record<string, string>;
  /** Hex SHA-256 of the executable. The agent is refused when the file changes. */
  sha256: string;
  /** The only models this agent may be offered for. */
  models: string[];
  /** Appended as `<modelFlag> <model>`; without it the agent must serve exactly one model. */
  modelFlag?: string;
  /** Sign-in files under the home directory, exposed read/write at the same relative path. */
  credentialFiles: string[];
  signInCommand?: string;
};
export const formatCustomAcpProviderId = (slug: string) => `acp-${slug}`;

export function parseCustomAcpAgents(entries: unknown, reserved: ReadonlySet<string>, home = homedir()): { agents: CustomAcpAgent[]; problems: string[] } {
  const agents: CustomAcpAgent[] = [], problems: string[] = [], seen = new Set<string>();
  if (!Array.isArray(entries)) return { agents, problems: ["agent list must be an array"] };
  entries.forEach((entry, index) => {
    const e = record(entry), strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === "string");
    const fail = (why: string) => { problems.push(`entry ${index}${typeof e?.id === "string" ? ` (${e.id})` : ""}: ${why}`); };
    if (!e || typeof e.id !== "string" || !SLUG_PATTERN.test(e.id)) return fail("id must be a lowercase slug");
    const known = new Set(["id", "displayName", "command", "args", "env", "sha256", "models", "modelFlag", "credentialFiles", "signInCommand"]);
    const unknown = Object.keys(e).filter(key => !known.has(key));
    if (unknown.length) return fail(`unknown field ${unknown[0]}`);
    const id = formatCustomAcpProviderId(e.id);
    if (reserved.has(id) || reserved.has(e.id)) return fail("id collides with a built-in provider");
    if (seen.has(id)) return fail("configured more than once");
    if (typeof e.displayName !== "string" || !e.displayName.trim() || e.displayName.length > 60) return fail("displayName required");
    if (typeof e.command !== "string" || !isAbsolute(e.command)) return fail("command must be an absolute path");
    if (e.args !== undefined && !strings(e.args)) return fail("args must be strings");
    const env = e.env === undefined ? {} : record(e.env);
    if (!env || !Object.entries(env).every(([name, value]) => ENV_NAME_PATTERN.test(name) && !DENIED_ENV.test(name) && typeof value === "string")) return fail("env must map allowed variable names to strings");
    if (typeof e.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(e.sha256)) return fail("sha256 of the executable required");
    if (!strings(e.models) || !e.models.length || !e.models.every(model => MODEL_ID_RE.test(model))) return fail("models must list at least one valid model id");
    if (e.modelFlag !== undefined && (typeof e.modelFlag !== "string" || !/^--?[A-Za-z][A-Za-z0-9-]*$/u.test(e.modelFlag))) return fail("modelFlag must be a flag name");
    if (e.modelFlag === undefined && e.models.length !== 1) return fail("an agent without modelFlag serves exactly one model");
    const files = e.credentialFiles ?? [];
    if (!strings(files) || !files.every(file => isAbsolute(file) && file.startsWith(home + sep) && !relative(home, file).split(sep).includes(".."))) return fail("credentialFiles must be absolute paths inside the home directory");
    if (e.signInCommand !== undefined && typeof e.signInCommand !== "string") return fail("signInCommand must be a string");
    seen.add(id);
    agents.push({ id: e.id, displayName: e.displayName.trim(), command: e.command, args: e.args ?? [], env: env as Record<string, string>, sha256: e.sha256, models: e.models, ...(e.modelFlag ? { modelFlag: e.modelFlag } : {}), credentialFiles: files, ...(e.signInCommand ? { signInCommand: e.signInCommand } : {}) });
  });
  return { agents, problems };
}

/** Executable validation: a regular native file the user (or root) owns, not writable by others,
 * in a directory that is not writable by others, with the pinned hash. */
export async function validateAcpExecutable(agent: Pick<CustomAcpAgent, "command" | "sha256">): Promise<string | undefined> {
  try {
    await access(agent.command, constants.X_OK);
    const file = await stat(agent.command), dir = await stat(dirname(agent.command));
    const uid = process.getuid?.() ?? -1;
    if (!file.isFile()) return "not a regular file";
    if (file.uid !== uid && file.uid !== 0) return "owned by another user";
    if (file.mode & 0o022 || dir.mode & 0o022) return "executable or its directory is writable by group or others";
    if (await isScript(agent.command)) return "script launchers are not supported; point at the native binary";
    if (createHash("sha256").update(await readFile(agent.command)).digest("hex") !== agent.sha256) return "sha256 does not match the pinned executable";
    return undefined;
  } catch (error) { return error instanceof Error ? error.message : String(error); }
}

/** Minimal ACP client for one refused-permissions text turn. */
export function acpParser(cwd: string): Parser {
  let sessionId: string | undefined, promptText = "";
  const request = (id: number, method: string, params: unknown) => ({ jsonrpc: "2.0", id, method, params });
  return {
    start: prompt => { promptText = prompt; return [request(1, "initialize", { protocolVersion: 1, clientInfo: { name: "agent-corp-worker", version: "0.1.0" }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })]; },
    cancel: () => sessionId ? [{ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }] : [],
    event(message): Parsed {
      const id = message.id, method = message.method;
      if (typeof method === "string" && id !== undefined) {
        // Agent-to-client request. Permission requests are refused; nothing else is offered.
        if (method !== "session/request_permission") return { send: [{ jsonrpc: "2.0", id, error: { code: -32601, message: "not available" } }] };
        const options = Array.isArray(record(message.params)?.options) ? (record(message.params)!.options as unknown[]).map(record) : [];
        const reject = options.find(option => typeof option?.kind === "string" && option.kind.startsWith("reject") && typeof option.optionId === "string");
        return { send: [{ jsonrpc: "2.0", id, result: { outcome: reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" } } }] };
      }
      if (method === "session/update") {
        const update = record(record(message.params)?.update), content = record(update?.content);
        return update?.sessionUpdate === "agent_message_chunk" && content?.type === "text" && typeof content.text === "string" ? { textDelta: content.text } : {};
      }
      if (typeof id !== "number") return {};
      if (message.error !== undefined) {
        const text = record(message.error)?.message;
        return { error: `ACP agent failed: ${typeof text === "string" ? text.slice(0, 500) : "request rejected"}`, done: true };
      }
      const result = record(message.result) ?? {};
      if (id === 1) return { send: [request(2, "session/new", { cwd, mcpServers: [] })] };
      if (id === 2) {
        if (typeof result.sessionId !== "string") return { error: "ACP agent returned no session", done: true };
        sessionId = result.sessionId;
        return { send: [request(3, "session/prompt", { sessionId, prompt: [{ type: "text", text: promptText }] })] };
      }
      if (id !== 3) return {};
      // Context-window `usage_update` notifications and self-reported cost are not billable usage.
      const raw = record(result.usage), thought = raw?.thoughtTokens ?? 0;
      const usage = raw && typeof raw.outputTokens === "number" && typeof thought === "number" ? tokens(raw.inputTokens, raw.outputTokens + thought, raw.cachedReadTokens, raw.cachedWriteTokens) : undefined;
      if (result.stopReason === "cancelled") return { error: "ACP agent cancelled the turn", done: true };
      return usage ? { total: usage, final: true, done: true } : { error: "ACP agent reported no token usage", done: true };
    },
  };
}

export function customAcpAdapter(agent: CustomAcpAgent): ProviderAdapter {
  return {
    id: formatCustomAcpProviderId(agent.id), displayName: agent.displayName, costSource: "list-price", confinement: "permission-denied", verified: false,
    signInCommand: agent.signInCommand ?? "see the agent's own documentation", installUrl: "",
    async health() {
      const problem = await validateAcpExecutable(agent);
      if (problem) return { status: (problem.includes("ENOENT") ? "not_installed" : "unsupported_install"), executable: agent.command, message: problem };
      for (const file of agent.credentialFiles) { try { await access(file); } catch { return { status: "unauthenticated", executable: agent.command, message: `missing ${file}` }; } }
      return { status: "ready", executable: agent.command, message: "sign-in is not validated until a run" };
    },
    models: async () => agent.models,
    async launch({ model, root, home }) {
      const problem = await validateAcpExecutable(agent); // re-checked at every launch, not only at discovery
      if (problem) throw new Error(`${agent.displayName}: ${problem}`);
      if (!agent.models.includes(model)) throw new Error(`${agent.displayName} is not configured for model ${model}`);
      const cwd = join(root, "w"); await mkdir(cwd, { recursive: true }); await mkdir(join(root, "home"), { recursive: true });
      const links = agent.credentialFiles.map(file => ({ file, link: join(root, "home", relative(home, file)) }));
      for (const { file, link } of links) await linkCredential(file, link);
      return {
        command: agent.command, args: [...agent.args, ...(agent.modelFlag ? [agent.modelFlag, model] : [])], cwd, passEnv: LOCALE_ENV, input: "protocol",
        env: { ...agent.env, ...privateEnv(root) },
        grants: mergeGrants(installGrants(agent.command, home), { readFiles: agent.credentialFiles, writeFiles: agent.credentialFiles }),
        settle: async () => { for (const { file, link } of links) await restoreCredential(file, link); },
      };
    },
    parser: ({ cwd }) => acpParser(cwd),
  };
}
