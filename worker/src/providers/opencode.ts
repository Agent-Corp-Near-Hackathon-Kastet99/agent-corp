import { access, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { LOCALE_ENV, installGrants, mergeGrants, privateEnv, record, tokens } from "./common.js";
import { commandOutput, isScript, linkCredential, readCliVersion, resolveExecutablePath, restoreCredential } from "./probe.js";
import type { Parsed, ProviderAdapter } from "./types.js";

/** Every tool permission denied, no MCP servers, no sharing, no self-update. */
export const OPENCODE_CONFIG = JSON.stringify({ permission: { "*": "deny" }, mcp: {}, share: "disabled", autoupdate: false, snapshot: false });
export const opencodeArgv = (model: string, prompt: string) => ["run", "--pure", "--format", "json", "--model", model, "--", prompt];
const authFile = (home = homedir()) => join(process.env.XDG_DATA_HOME?.trim() || join(home, ".local", "share"), "opencode", "auth.json");

/** `opencode run --format json`: each finished step reports tokens. `input` excludes cached tokens
 * and `output` excludes reasoning tokens. Its `cost` comes from opencode's own price catalogue and
 * is zero on subscription sign-ins, so it is never used as a provider cost. */
export function parseOpencode(event: Record<string, unknown>): Parsed {
  const part = record(event.part);
  if (event.type === "text") return typeof part?.text === "string" ? { textDelta: part.text } : {};
  if (event.type === "step_finish") {
    const raw = record(part?.tokens), cache = record(raw?.cache);
    const reasoning = raw?.reasoning ?? 0;
    const usage = raw && typeof raw.output === "number" && typeof reasoning === "number" ? tokens(raw.input, raw.output + reasoning, cache?.read, cache?.write) : undefined;
    if (!usage) return { error: "opencode reported malformed usage" };
    return { step: usage, ...(part?.reason === "tool-calls" ? {} : { final: true }) };
  }
  if (event.type === "error") {
    const message = record(record(event.error)?.data)?.message ?? record(event.error)?.name;
    return { error: `opencode failed: ${typeof message === "string" ? message.slice(0, 500) : "unknown error"}` };
  }
  return {};
}

export const opencode: ProviderAdapter = {
  id: "opencode", displayName: "opencode", costSource: "list-price", confinement: "permission-denied", verified: false,
  signInCommand: "opencode auth login", installUrl: "https://opencode.ai/docs",
  async health() {
    const executable = await resolveExecutablePath("opencode");
    if (!executable) return { status: "not_installed" };
    const version = await readCliVersion("opencode") ?? undefined;
    if (await isScript(executable)) return { status: "unsupported_install", version, executable, message: "script launcher installs need an interpreter grant; install the opencode binary" };
    let stored = 0;
    try { stored = Object.keys(JSON.parse(await readFile(authFile(), "utf8")) as object).length; } catch { /* none */ }
    if (!stored) return { status: "unauthenticated", version, executable };
    return { status: "ready", version, executable, message: "stored credentials are not validated until a run; a stale sign-in fails the task" };
  },
  async models() {
    const out = await commandOutput("opencode", ["models"], 15_000);
    const list = out?.split(/\r?\n/u).map(line => line.trim()).filter(line => /^[A-Za-z0-9][\w.:-]*\/[\w.:/-]+$/u.test(line));
    return list?.length ? list : undefined;
  },
  async launch({ model, root, home, executable }) {
    const auth = authFile(home), link = join(root, "data", "opencode", "auth.json"), cwd = join(root, "w");
    for (const dir of ["w", "home", "config", "cache", "state"]) await mkdir(join(root, dir), { recursive: true });
    let linked = false;
    try { await access(auth); await linkCredential(auth, link); linked = true; } catch { /* free models need no sign-in */ }
    return {
      command: executable, args: opencodeArgv(model, ""), cwd, passEnv: LOCALE_ENV, input: "argv",
      env: privateEnv(root, { XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), OPENCODE_CONFIG_CONTENT: OPENCODE_CONFIG, OPENCODE_DISABLE_AUTOUPDATE: "1" }),
      grants: mergeGrants(installGrants(executable, home), linked ? { readFiles: [auth], writeFiles: [auth] } : {}),
      settle: async () => { if (linked) await restoreCredential(auth, link); },
    };
  },
  parser: () => ({ event: parseOpencode }),
};
