// Adapted from get-bb/bb (MIT, Copyright (c) 2026 Michael Yong):
// packages/provider-bridge-protocol/src/bridge-kit/provider-maintenance-kit.ts
// See worker/THIRD_PARTY_NOTICES.md. Changes: no semver/zod dependency, absolute-path resolution
// with realpath, and a credential link helper for sandboxed runs.
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, lstat, mkdir, open, realpath, rename, symlink } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";

const CLI_PROBE_TIMEOUT_MS = 5_000;

/** Absolute, symlink-free path of a command on PATH, or null. */
export async function resolveExecutablePath(command: string, searchPath = process.env.PATH ?? ""): Promise<string | null> {
  const candidates = isAbsolute(command) ? [command] : searchPath.split(delimiter).filter(isAbsolute).map(dir => join(dir, command));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch { /* next */ }
  }
  return null;
}

export function commandOutput(command: string, args: readonly string[], timeout = CLI_PROBE_TIMEOUT_MS): Promise<string | null> {
  return new Promise(resolve => {
    execFile(command, [...args], { timeout, maxBuffer: 1024 * 1024, env: process.env }, (error, stdout, stderr) => resolve(error ? null : `${stdout}\n${stderr}`.trim()));
  });
}

export function versionFrom(value: string | null): string | null {
  return value?.match(/\bv?(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/u)?.[1] ?? null;
}

export async function readCliVersion(command: string): Promise<string | null> {
  return versionFrom(await commandOutput(command, ["--version"]));
}

/** Numeric comparison of dotted release numbers; pre-release suffixes are ignored. */
export function compareVersions(left: string, right: string): number {
  const parts = (v: string) => v.split(/[-+]/u)[0]!.split(".").map(n => Number.parseInt(n, 10) || 0);
  const a = parts(left), b = parts(right);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** True when the file starts with "#!": a launcher script that would need an interpreter exec grant. */
export async function isScript(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try { const { buffer } = await handle.read(Buffer.alloc(2), 0, 2, 0); return buffer.toString("latin1") === "#!"; }
  finally { await handle.close(); }
}

/** Expose one real credential file inside a private home without copying the secret. */
export async function linkCredential(realFile: string, link: string): Promise<void> {
  await mkdir(dirname(link), { recursive: true });
  await symlink(realFile, link);
}

/** A CLI that refreshed its token by replacing the link left the only valid copy in the private
 * home. Move it back before the private home is deleted, or the user's own login would break. */
export async function restoreCredential(realFile: string, link: string): Promise<boolean> {
  let stat; try { stat = await lstat(link); } catch { return false; }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) return false;
  const temp = `${realFile}.agent-corp-${process.pid}.tmp`;
  await copyFile(link, temp); // copyFile keeps the 0600 mode of the refreshed file
  await rename(temp, realFile);
  return true;
}
