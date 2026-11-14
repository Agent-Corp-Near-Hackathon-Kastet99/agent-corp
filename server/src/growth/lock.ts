import { closeSync, mkdirSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, basename, join, resolve } from "node:path";

/** Exclusive ownership, deliberately not auto-recovered after a crash. */
export function acquireGrowthLocks(paths: string[]): () => void {
  const locks: { path: string; fd: number }[] = [];
  try {
    const canonical = paths.map(path => {
      const absolute = resolve(path);
      mkdirSync(dirname(absolute), { recursive: true });
      return join(realpathSync(dirname(absolute)), basename(absolute));
    });
    for (const path of [...new Set(canonical)].sort()) {
      let fd: number;
      try { fd = openSync(path, "wx", 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`growth storage is locked: ${path}; after a crash remove only after confirming the prior process stopped`);
        throw error;
      }
      locks.push({ path, fd });
      writeFileSync(fd, `${process.pid}\n`);
    }
  } catch (error) {
    for (const lock of locks.reverse()) { closeSync(lock.fd); unlinkSync(lock.path); }
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const lock of locks.reverse()) { closeSync(lock.fd); unlinkSync(lock.path); }
  };
}
