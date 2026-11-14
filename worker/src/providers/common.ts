import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { TokenUsage } from "@agentcorp/shared";
import type { SandboxGrants } from "../sandbox.js";

const count = (value: unknown): number | undefined => value === undefined || value === null ? 0 : Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;

/** Normalized usage, or undefined when any counter is not a non-negative integer. */
export function tokens(input: unknown, output: unknown, cacheRead?: unknown, cacheWrite?: unknown): TokenUsage | undefined {
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  const usage = { input: count(input), output: count(output), cacheRead: count(cacheRead), cacheWrite: count(cacheWrite) };
  return Object.values(usage).every(n => n !== undefined) ? usage as TokenUsage : undefined;
}
export const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Environment for a provider that runs with a private home: nothing inherited except locale and identity. */
export function privateEnv(root: string, extra: Record<string, string> = {}): Record<string, string> {
  return { HOME: join(root, "home"), PATH: "/usr/bin:/bin", TMPDIR: root, ...extra };
}
export const LOCALE_ENV = ["USER", "LOGNAME", "LANG", "LC_ALL", "TERM"];

/** Read and exec grants for a provider's own install. A shared directory (the home directory,
 * ~/.local, ~/bin and similar) is never granted as a tree: only the executable itself is. */
export function installGrants(executable: string, home = homedir(), root = dirname(executable)): SandboxGrants {
  const shared = new Set([home, join(home, ".local"), join(home, ".local", "bin"), join(home, ".local", "share"), join(home, "bin"), "/", "/usr", "/usr/bin", "/usr/local", "/usr/local/bin", "/opt/homebrew", "/opt/homebrew/bin"]);
  if (shared.has(root)) return { readFiles: [executable], exec: { files: [executable] } };
  return { read: [root], exec: { trees: [root] } };
}
/** `<release>/bin/<name>` installs keep helpers beside `bin`; grant the release, not just `bin`. */
export const releaseRoot = (executable: string) => basename(dirname(executable)) === "bin" ? dirname(dirname(executable)) : dirname(executable);
export const mergeGrants = (a: SandboxGrants, b: SandboxGrants): SandboxGrants => ({
  read: [...(a.read ?? []), ...(b.read ?? [])], write: [...(a.write ?? []), ...(b.write ?? [])], readFiles: [...(a.readFiles ?? []), ...(b.readFiles ?? [])], writeFiles: [...(a.writeFiles ?? []), ...(b.writeFiles ?? [])],
  exec: a.exec || b.exec ? { trees: [...(a.exec?.trees ?? []), ...(b.exec?.trees ?? [])], files: [...(a.exec?.files ?? []), ...(b.exec?.files ?? [])] } : undefined,
});
