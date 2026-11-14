import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { LOCALE_ENV, installGrants, mergeGrants, privateEnv, record, tokens } from "./common.js";
import { commandOutput, isScript, linkCredential, readCliVersion, resolveExecutablePath, restoreCredential } from "./probe.js";
import type { Parsed, ProviderAdapter } from "./types.js";

/** Pi message usage as bb's Pi bridge records it. Pi's `cost` is computed from its own model
 * catalogue, not billed by a provider, so only the token counts are used. */
export function parsePi(event: Record<string, unknown>): Parsed {
  if (event.type !== "agent_end" || !Array.isArray(event.messages)) return {};
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let text: string | undefined, seen = false;
  for (const message of event.messages.map(record)) {
    if (message?.role !== "assistant") continue;
    const raw = record(message.usage), usage = raw ? tokens(raw.input, raw.output, raw.cacheRead, raw.cacheWrite) : undefined;
    if (!usage) return { error: "Pi reported malformed usage" };
    seen = true;
    for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += usage[key];
    const parts = Array.isArray(message.content) ? message.content.map(record).filter(part => part?.type === "text" && typeof part.text === "string").map(part => part!.text as string) : [];
    if (parts.length) text = parts.join("");
  }
  return seen ? { total, final: true, ...(text !== undefined ? { text } : {}) } : { error: "Pi finished without usage" };
}

const FLAGS = ["--no-tools", "--no-mcp", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"];
export const piArgv = (model: string, prompt: string) => ["--print", "--mode", "json", "--no-session", ...FLAGS, "--model", model, "--", prompt];
const authPath = (home = homedir()) => join(process.env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"), "auth.json");

export async function piInstall(executable: string) {
  if (!await isScript(executable)) return { command: executable, prefix: [] as string[], root: dirname(executable) };
  const root = dirname(dirname(executable));
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { name?: string };
  if (!["@mariozechner/pi-coding-agent", "@earendil-works/pi-coding-agent"].includes(pkg.name ?? "") || executable !== join(root, "dist", "cli.js")) throw new Error("Unsupported Pi launcher; install the official CLI");
  return { command: await realpath(process.execPath), prefix: [executable], root };
}

/** Opt-in one-shot adapter. Private config carries auth only; extensions/tools/context discovery stay off. */
export const pi: ProviderAdapter = {
  id: "pi", displayName: "Pi", costSource: "list-price", confinement: "tools-disabled", verified: false,
  signInCommand: "pi (then /login)", installUrl: "https://github.com/earendil-works/pi",
  async health() {
    const executable = await resolveExecutablePath("pi");
    if (!executable) return { status: "not_installed" };
    const version = await readCliVersion("pi") ?? undefined;
    try { await piInstall(executable); } catch { return { status: "unsupported_install", version, executable, message: "Use an official Pi native or npm install" }; }
    const help = await commandOutput(executable, ["--help"]);
    if (!help || FLAGS.some(flag => !help.includes(flag))) return { status: "unsupported_version", version, executable, message: "Pi must support all tool/resource/context disabling flags" };
    try { await access(authPath()); } catch { return { status: "unauthenticated", version, executable }; }
    return { status: "ready", version, executable, message: "Experimental; live usage and sign-in need verification" };
  },
  async launch({ model, root, home, executable }) {
    const install = await piInstall(executable), agentDir = join(root, "agent"), cwd = join(root, "w");
    const help = await commandOutput(executable, ["--help"]);
    if (!help || FLAGS.some(flag => !help.includes(flag))) throw new Error("Pi lacks required confinement flags");
    for (const dir of [agentDir, cwd, join(root, "home")]) await mkdir(dir, { recursive: true });
    const auth = authPath(home), link = join(agentDir, "auth.json");
    await linkCredential(auth, link);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [], extensions: [], skills: [], promptTemplates: [], themes: [], enableSkillCommands: false }), { mode: 0o600 });
    return {
      command: install.command, args: [...install.prefix, ...piArgv(model, "")], cwd, input: "argv", passEnv: LOCALE_ENV,
      env: privateEnv(root, { PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: "1" }),
      grants: mergeGrants(installGrants(executable, home, install.root), { readFiles: [auth, install.command], writeFiles: [auth], exec: { files: [install.command] } }),
      settle: async () => { await restoreCredential(auth, link); },
    };
  },
  parser: () => ({ event: parsePi }),
};
