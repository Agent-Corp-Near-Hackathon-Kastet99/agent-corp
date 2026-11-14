import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { LOCALE_ENV, installGrants, mergeGrants, privateEnv, record, releaseRoot, tokens } from "./common.js";
import { readCodexAuthState, resolveCodexHome } from "./codex-auth.js";
import { compareVersions, isScript, linkCredential, readCliVersion, resolveExecutablePath, restoreCredential } from "./probe.js";
import type { Parsed, ProviderAdapter } from "./types.js";

/** Lowest version whose flags below were exercised. Older builds reject unknown feature names. */
export const CODEX_MINIMUM_VERIFIED_VERSION = "0.169.0";
/** Every model-callable capability beyond plain text. The seatbelt profile also denies exec. */
const DISABLED_FEATURES = ["shell_tool", "unified_exec", "apps", "plugins", "remote_plugin", "browser_use", "browser_use_external", "computer_use", "image_generation", "multi_agent", "hooks", "view_image", "skill_search", "goals", "tool_suggest", "sleep_tool"];

export const codexArgv = (model: string) => [
  "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never",
  ...DISABLED_FEATURES.flatMap(feature => ["--disable", feature]), "-c", 'web_search="disabled"', "--model", model, "-",
];

/** `codex exec --json`: token counts only, reported once per finished turn. Codex never reports cost.
 * input_tokens includes cached and cache-write tokens; output_tokens includes reasoning tokens. */
export function parseCodex(event: Record<string, unknown>): Parsed {
  if (event.type === "item.completed") {
    const item = record(event.item);
    return item?.type === "agent_message" && typeof item.text === "string" ? { text: item.text } : {};
  }
  if (event.type === "turn.completed") {
    const raw = record(event.usage);
    const all = raw ? tokens(raw.input_tokens, raw.output_tokens, raw.cached_input_tokens, raw.cache_write_input_tokens) : undefined;
    if (!all || all.cacheRead + all.cacheWrite > all.input) return { error: "Codex reported malformed usage" };
    return { step: { ...all, input: all.input - all.cacheRead - all.cacheWrite }, final: true };
  }
  if (event.type === "turn.failed" || event.type === "error") {
    const message = record(event.error)?.message ?? event.message;
    return { error: `Codex failed: ${typeof message === "string" ? message.slice(0, 500) : "unknown error"}` };
  }
  return {};
}

export const codex: ProviderAdapter = {
  id: "codex", displayName: "Codex", costSource: "list-price", confinement: "tools-disabled", verified: true,
  signInCommand: "codex login", installUrl: "https://developers.openai.com/codex/cli",
  async health() {
    const executable = await resolveExecutablePath("codex");
    if (!executable) return { status: "not_installed" };
    const version = await readCliVersion("codex") ?? undefined;
    if (await isScript(executable)) return { status: "unsupported_install", version, executable, message: "npm launcher installs need an interpreter grant; install the standalone Codex binary" };
    if (!version || compareVersions(version, CODEX_MINIMUM_VERIFIED_VERSION) < 0) return { status: "unsupported_version", version, executable, message: `needs Codex ${CODEX_MINIMUM_VERIFIED_VERSION} or newer` };
    const auth = await readCodexAuthState();
    if (auth.state === "missing") return { status: "unauthenticated", version, executable, message: "no auth.json (keyring-only sign-in is not supported by the sandbox)" };
    if (auth.state !== "ok") return { status: auth.state === "unusable" ? "unauthenticated" : "unknown", version, executable, message: `auth file is ${auth.state}` };
    return { status: auth.expired ? "expired" : "ready", version, executable };
  },
  async launch({ model, root, home, executable }) {
    // A private CODEX_HOME keeps the user's config, AGENTS.md, memories, plugins, skills and MCP
    // servers out of the run. Only auth.json is linked in.
    const auth = join(resolveCodexHome(home), "auth.json"), codexHome = join(root, "codex"), link = join(codexHome, "auth.json"), cwd = join(root, "w");
    await mkdir(cwd, { recursive: true }); await mkdir(join(root, "home"), { recursive: true });
    await linkCredential(auth, link);
    return {
      command: executable, args: codexArgv(model), cwd, env: privateEnv(root, { CODEX_HOME: codexHome }), passEnv: LOCALE_ENV, input: "prompt",
      grants: mergeGrants(installGrants(executable, home, releaseRoot(executable)), { readFiles: [auth], writeFiles: [auth] }),
      settle: async () => { await restoreCredential(auth, link); },
    };
  },
  parser: () => ({ event: parseCodex }),
};
