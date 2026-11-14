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

it("retains reservation after interruption and actual spend beyond cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-corp-cap-"));
  const cap = new DailyCap(100n, root); await cap.acquire();
  expect(await cap.reserve(80n)).toBe(true);
  expect(await cap.reserve(1n)).toBe(false);
  await cap.checkpoint(30n); await cap.abandon(); expect(cap.usedUnits).toBe(80n);
  expect(await cap.reserve(20n)).toBe(true);
  expect(await cap.checkpoint(30n)).toBe(false);
  await cap.commit(30n); expect(cap.usedUnits).toBe(110n);
  expect(await cap.reserve(1n)).toBe(false); await cap.release();
});

it("charges crash-pending reservation before accepting new tasks", async () => {
  const { writeFile, rm } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "agent-corp-cap-"));
  const cap = new DailyCap(100n, root);
  await writeFile(cap.file, JSON.stringify({ date: new Date().toISOString().slice(0, 10), usedUnits: "10", pendingUnits: "80", updatedAt: "" }));
  await cap.acquire(); expect(cap.usedUnits).toBe(90n); expect(await cap.reserve(11n)).toBe(false);
  await cap.release(); await rm(root, { recursive: true, force: true });
});

it("does not publish failed commit or double charge conservative retry", async () => {
  const { mkdir, rm } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "agent-corp-cap-"));
  const cap = new DailyCap(100n, root); await cap.acquire(); await cap.reserve(80n); await cap.checkpoint(30n);
  const temp = `${cap.file}.${process.pid}.tmp`; await mkdir(temp);
  await expect(cap.commit(30n)).rejects.toThrow(); expect(cap.usedUnits).toBe(0n);
  await rm(temp, { recursive: true }); await cap.abandon(); expect(cap.usedUnits).toBe(80n);
  await cap.release(); await rm(root, { recursive: true, force: true });
});
