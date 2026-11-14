import { claudeGrants } from "../sandbox.js";
import { record, tokens } from "./common.js";
import { commandOutput, readCliVersion, resolveExecutablePath } from "./probe.js";
import type { Parsed, ProviderAdapter } from "./types.js";

export const claudeArgv = (model: string) => ["-p", "--verbose", "--output-format", "stream-json", "--tools", "", "--strict-mcp-config", "--model", model];

/** Claude stream-json: per-message usage is provisional; the result record carries the authoritative cost. */
export function parseClaude(event: Record<string, unknown>): Parsed {
  const raw = record(event.usage) ?? record(record(event.message)?.usage);
  const usage = raw ? tokens(raw.input_tokens, raw.output_tokens, raw.cache_read_input_tokens, raw.cache_creation_input_tokens) : undefined;
  const text = typeof event.text === "string" ? event.text : typeof event.result === "string" ? event.result : undefined;
  if (event.type !== "result") return { ...(usage ? { provisional: usage } : {}), ...(text !== undefined ? { text } : {}) };
  const cost = typeof event.total_cost_usd === "number" || typeof event.total_cost_usd === "string" ? Number(event.total_cost_usd) : undefined;
  return {
    ...(usage ? { total: usage } : {}), ...(text !== undefined ? { text } : {}),
    ...(cost !== undefined && Number.isFinite(cost) && cost >= 0 ? { costUsd: cost, final: true } : {}),
    ...(event.is_error ? { error: "Claude reported a failed result" } : {}),
  };
}

export const claude: ProviderAdapter = {
  id: "claude", displayName: "Claude Code", costSource: "provider-cost", confinement: "tools-disabled", verified: true,
  signInCommand: "claude auth login", installUrl: "https://docs.anthropic.com/claude-code",
  async health() {
    const executable = await resolveExecutablePath("claude");
    if (!executable) return { status: "not_installed" };
    const version = await readCliVersion("claude") ?? undefined;
    if (process.env.ANTHROPIC_API_KEY) return { status: "ready", version, executable };
    const status = await commandOutput("claude", ["auth", "status"]);
    let loggedIn: unknown;
    try { loggedIn = (JSON.parse(status ?? "") as { loggedIn?: unknown }).loggedIn; } catch { /* older CLI */ }
    if (loggedIn === false) return { status: "unauthenticated", version, executable };
    return loggedIn === true ? { status: "ready", version, executable } : { status: "unknown", version, executable, message: "sign-in could not be checked" };
  },
  async launch({ model, root, home, executable }) {
    // Claude keeps its real home: its sign-in lives in the macOS keychain and ~/.claude.
    const env: Record<string, string> = { TMPDIR: root };
    return { command: executable, args: claudeArgv(model), cwd: root, env, passEnv: ["HOME", "PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "ANTHROPIC_API_KEY"], grants: claudeGrants(home), input: "prompt" };
  },
  parser: () => ({ event: parseClaude }),
};
