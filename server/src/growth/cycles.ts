import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../config.js";
import type { Directive } from "./types.js";

export type StepName = "sense" | "decide" | "research" | "create" | "gate" | "publish" | "measure" | "learn";
export type StepRecord = { name: StepName; status: "running" | "done" | "skipped" | "error"; ts: number; note?: string };
export type AssetRecord = { file: string; kind: "image" | "clip"; prompt?: string; model?: string; sha256: string; costUsd: number; createdAt: number; selected?: boolean };
export type Target = { name: string; url: string; why: string };
export type Measurement = {
  at: number;
  funnel: Record<string, number>;
  funnelSource: "posthog" | "local" | "none";
  chainRevenueYocto?: string;
  posts: { actionId: string; channel?: string; url?: string; metrics?: { label: string; total: number }[] }[];
  metric: string; value: number; target: number;
  outcome: "hit" | "miss" | "no_data";
};
export type CycleRecord = {
  cycle: number;
  seeded?: boolean;
  dryRun: boolean;
  startedAt: number;
  finishedAt?: number;
  directive?: Directive;
  steps: StepRecord[];
  targets: Target[];
  assets: AssetRecord[];
  copy: { channel: string; text: string; reply?: string }[];
  actionIds: string[];
  measurement?: Measurement;
  learning?: string;
  error?: string;
};

/** One JSON file per cycle plus an append-only learnings.md the CEO reads next cycle. */
export class CycleStore {
  constructor(readonly dir = process.env.GROWTH_DIR ?? join(ROOT, ".data", "growth")) {
    mkdirSync(join(dir, "cycles"), { recursive: true });
    mkdirSync(join(dir, "assets"), { recursive: true });
  }
  get assetsDir() { return join(this.dir, "assets"); }
  private path(n: number) { return join(this.dir, "cycles", `${String(n).padStart(3, "0")}.json`); }
  list(): CycleRecord[] {
    return readdirSync(join(this.dir, "cycles")).filter(f => /^\d{3,}\.json$/.test(f)).sort()
      .map(f => JSON.parse(readFileSync(join(this.dir, "cycles", f), "utf8")) as CycleRecord);
  }
  get(n: number): CycleRecord | undefined { return existsSync(this.path(n)) ? JSON.parse(readFileSync(this.path(n), "utf8")) as CycleRecord : undefined; }
  /** Cycle 0 is reserved for the clearly-labelled seeded example. */
  nextNumber() { return Math.max(0, ...this.list().filter(c => !c.seeded).map(c => c.cycle)) + 1; }
  save(c: CycleRecord) {
    const tmp = `${this.path(c.cycle)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path(c.cycle));
  }
  learnings(): string { const f = join(this.dir, "learnings.md"); return existsSync(f) ? readFileSync(f, "utf8") : ""; }
  addLearning(cycle: number, text: string, ts: number) {
    appendFileSync(join(this.dir, "learnings.md"), `\n## Cycle ${cycle} (${new Date(ts).toISOString()})\n${text.trim()}\n`, { mode: 0o600 });
  }
}
