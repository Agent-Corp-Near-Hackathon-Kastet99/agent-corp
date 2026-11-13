import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DailyCap } from "../src/cap.js";

describe("daily cap", () => {
  it("refuses task at cap and second process", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-corp-cap-"));
    const first = new DailyCap(100n, root); await first.acquire();
    await first.commit(100n); expect(await first.reserve(1n)).toBe(false);
    const second = new DailyCap(100n, root); await expect(second.acquire()).rejects.toThrow("already running");
    await first.release();
  });
  it("rolls file at UTC midnight", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-corp-cap-"));
    let now = new Date("2026-11-13T23:59:59Z");
    const cap = new DailyCap(100n, root, () => now); await cap.acquire(); await cap.commit(99n);
    now = new Date("2026-11-14T00:00:01Z"); expect(await cap.reserve(100n)).toBe(true); expect(cap.usedUnits).toBe(0n); await cap.release();
  });
});
