import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";

export type SandboxGrants = {
  /** Readable directory trees under the home directory. */
  read?: string[];
  /** Readable single files under the home directory. */
  readFiles?: string[];
  /** Writable directory trees outside the private root. Avoid; only for a provider's fixed scratch path. */
  write?: string[];
  /** Writable single files outside the private root (credential refresh only). */
  writeFiles?: string[];
  /** When set, every exec is denied except these trees and files. */
  exec?: { trees?: string[]; files?: string[] };
};

/** Claude Code's verified grants: executable, sign-in configuration and macOS keychain. */
export const claudeGrants = (home = homedir()): SandboxGrants => ({
  read: [join(home, ".local"), join(home, ".claude"), join(home, "Library", "Keychains")],
  readFiles: [join(home, ".claude.json")],
});

const q = (path: string) => JSON.stringify(path);
const real = (path: string) => { try { return realpathSync(path); } catch { return path; } };

/** macOS seatbelt: hides the home directory except explicit grants, restricts writes to the
 * private root and, when `exec` is given, restricts process creation. Network stays open: the
 * provider must reach its own API and seatbelt cannot filter by host. */
export function sandboxProfile(cwd: string, home = homedir(), grants: SandboxGrants = claudeGrants(home)): string {
  const workspace = realpathSync(cwd);
  const trees = (grants.read ?? []).map(real), files = (grants.readFiles ?? []).map(real);
  // Path resolution needs to stat (not list) each ancestor of a granted path.
  const ancestors = new Set<string>();
  for (const path of [...trees, ...files]) {
    for (let dir = dirname(path); dir.startsWith(home + sep) || dir === home; dir = dirname(dir)) ancestors.add(dir);
  }
  const read = [...trees.map(p => `(subpath ${q(p)})`), ...files.map(p => `(literal ${q(p)})`), `(subpath ${q(workspace)})`].join(" ");
  const write = [`(subpath ${q(workspace)})`, ...(grants.exec ? [`(literal "/dev/null")`] : []), ...(grants.write ?? []).map(p => `(subpath ${q(p)})`), ...(grants.writeFiles ?? []).map(p => `(literal ${q(real(p))})`)].join(" ");
  let profile = `(version 1)(allow default)(deny file-read* (subpath ${q(home)}))`;
  if (grants.exec && ancestors.size) profile += `(allow file-read-metadata ${[...ancestors].map(p => `(literal ${q(p)})`).join(" ")})`;
  profile += `(allow file-read* ${read})(deny file-write*)(allow file-write* ${write})`;
  if (grants.exec) {
    const allowed = [...(grants.exec.trees ?? []).map(p => `(subpath ${q(real(p))})`), ...(grants.exec.files ?? []).map(p => `(literal ${q(real(p))})`)].join(" ");
    profile += `(deny process-exec*)${allowed ? `(allow process-exec* ${allowed})` : ""}`;
  }
  return profile;
}
