import { access, mkdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LOCALE_ENV, privateEnv, record, tokens } from "./common.js";
import { commandOutput, resolveExecutablePath } from "./probe.js";
import type { Parsed, ProviderAdapter } from "./types.js";

/** Ask mode is Cursor's read-only mode. Cursor has no switch that removes its read tools, so the
 * seatbelt profile is the boundary: private home, no exec outside its own install. */
export const cursorArgv = (entry: string, model: string, prompt: string) => [entry, "--print", "--trust", "--output-format", "stream-json", "--mode", "ask", "--model", model, "--", prompt];

/** Cursor stream-json: the result record carries token counts and no cost. Cache counters are
 * treated as separate from inputTokens; Cursor does not document whether they overlap. */
export function parseCursor(event: Record<string, unknown>): Parsed {
  if (event.type !== "result") return {};
  const raw = record(event.usage);
  const usage = raw ? tokens(raw.inputTokens, raw.outputTokens, raw.cacheReadTokens, raw.cacheWriteTokens) : undefined;
  return {
    ...(typeof event.result === "string" ? { text: event.result } : {}),
    ...(usage ? { total: usage, final: true } : {}),
    ...(event.is_error ? { error: "Cursor reported a failed result" } : {}),
  };
}

async function install(): Promise<{ dir: string; launcher: string } | null> {
  const launcher = await resolveExecutablePath("cursor-agent") ?? await resolveExecutablePath("agent");
  if (!launcher) return null;
  const dir = dirname(launcher);
  // The launcher is a bash script that execs the bundled node; running node directly avoids granting a shell.
  try { await access(join(dir, "node")); await access(join(dir, "index.js")); return { dir, launcher }; } catch { return { dir: "", launcher }; }
}

export const cursor: ProviderAdapter = {
  id: "cursor", displayName: "Cursor", costSource: "list-price", confinement: "read-only-mode", verified: false,
  signInCommand: "cursor-agent login", installUrl: "https://cursor.com/docs/cli/installation",
  async health() {
    const found = await install();
    if (!found) return { status: "not_installed" };
    const version = (await commandOutput(found.launcher, ["--version"]))?.split(/\s/u)[0];
    if (!found.dir) return { status: "unsupported_install", version, executable: found.launcher, message: "expected the bundled node and index.js beside the launcher" };
    const status = await commandOutput(found.launcher, ["status"], 15_000);
    if (status === null) return { status: "unknown", version, executable: found.launcher };
    return { status: /Logged in/u.test(status) && !/Not logged in/iu.test(status) ? "ready" : "unauthenticated", version, executable: found.launcher };
  },
  async launch({ model, root, home, executable }) {
    const dir = dirname(executable), cwd = join(root, "w"), keychains = join(home, "Library", "Keychains");
    await mkdir(cwd, { recursive: true }); await mkdir(join(root, "home", "Library"), { recursive: true });
    await symlink(keychains, join(root, "home", "Library", "Keychains")); // Cursor's sign-in is a keychain item
    return {
      command: join(dir, "node"), args: cursorArgv(join(dir, "index.js"), model, ""), cwd, passEnv: LOCALE_ENV, input: "argv",
      env: privateEnv(root, { CURSOR_INVOKED_AS: "cursor-agent" }),
      // Cursor keeps per-workspace sockets under /tmp/.cursor regardless of TMPDIR.
      grants: { read: [dir, keychains], write: ["/private/tmp/.cursor"], exec: { trees: [dir], files: ["/usr/bin/security"] } },
    };
  },
  parser: () => ({ event: parseCursor }),
};
