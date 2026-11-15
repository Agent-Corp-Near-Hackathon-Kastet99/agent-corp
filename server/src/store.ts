import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, ACCOUNT_RE } from "./config.js";
import type { TokenUsage } from "@agentcorp/shared";
import type { Activity } from "./ledger.js";

export type Score = { account: string; level: string; ms: number; at: number };
export type Task = {
  id: string; kind: "marketing" | "qa" | "build"; title: string; prompt: string;
  status: "queued" | "running" | "done" | "failed"; worker?: string; output?: string; units?: string; finishedAt?: number; attemptId?: string; credited?: boolean; exact?: boolean;
  /** Provider model the attempt ran on, how its units were derived, and whether owner policy lets them be credited. */
  provider?: string; model?: string; basis?: "provider-cost" | "list-price" | "estimate"; creditable?: boolean; usage?: TokenUsage;
};
type State = { activity: Activity[]; scores: Score[]; tasks: Task[] };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function validState(value: unknown): asserts value is State {
  if (!object(value) || !Array.isArray(value.activity) || !Array.isArray(value.scores) || !Array.isArray(value.tasks)
      || !value.activity.every(a => object(a) && Number.isFinite(a.ts) && ["CEO", "ORACLE", "WORKER", "CONTRACT", "CUSTOMER", "OWNER", "MARKETING", "BIZDEV"].includes(String(a.actor)) && typeof a.text === "string" && (a.txHash === undefined || typeof a.txHash === "string") && (a.explorerUrl === undefined || typeof a.explorerUrl === "string"))
      || !value.scores.every(s => object(s) && typeof s.account === "string" && ACCOUNT_RE.test(s.account) && typeof s.level === "string" && Number.isSafeInteger(s.ms) && Number(s.ms) > 0 && Number.isFinite(s.at))
      || !value.tasks.every(t => object(t) && typeof t.id === "string" && typeof t.title === "string" && typeof t.prompt === "string" && ["marketing", "qa", "build"].includes(String(t.kind)) && ["queued", "running", "done", "failed"].includes(String(t.status)) && (t.units === undefined || typeof t.units === "string" && /^\d+$/.test(t.units)) && (t.worker === undefined || typeof t.worker === "string") && (t.output === undefined || typeof t.output === "string") && (t.finishedAt === undefined || Number.isFinite(t.finishedAt)))) {
    throw new Error("Invalid off-chain state");
  }
}

/** Durable snapshots: no mutation becomes visible until atomic persistence succeeds. */
export class Store {
  private state: State = { activity: [], scores: [], tasks: [] };
  constructor(private readonly file = process.env.AGENTCORP_STATE ?? join(ROOT, ".data", "state.json")) {
    if (existsSync(file)) {
      const value: unknown = JSON.parse(readFileSync(file, "utf8"));
      validState(value);
      this.state = value;
    }
  }
  private update(change: (next: State) => void) {
    const next = structuredClone(this.state);
    change(next);
    validState(next);
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
    this.state = next;
  }
  log = (entry: Activity) => {
    this.update(next => {
      // Receipts can be replayed after a restart. A chain transaction is one activity record.
      if (entry.txHash && next.activity.some(item => item.txHash === entry.txHash)) return;
      next.activity.unshift(structuredClone(entry)); next.activity.length = Math.min(next.activity.length, 200);
    });
    console.log(`[${entry.actor}] ${entry.text}${entry.txHash ? ` (${entry.txHash})` : ""}`);
  };
  activity(limit = 50) { return structuredClone(this.state.activity.slice(0, limit)); }
  addScore(score: Score) {
    this.update(next => {
      const i = next.scores.findIndex(s => s.account === score.account && s.level === score.level);
      if (i < 0) next.scores.push(structuredClone(score));
      else if (score.ms < next.scores[i]!.ms) next.scores[i] = structuredClone(score);
    });
  }
  bestScore(account: string, level: string) {
    return structuredClone(this.state.scores.filter(s => s.account === account && s.level === level).sort((a, b) => a.ms - b.ms)[0]);
  }
  tasks() { return structuredClone(this.state.tasks); }
  upsertTask(task: Task) {
    this.update(next => {
      const i = next.tasks.findIndex(t => t.id === task.id);
      if (i >= 0) next.tasks[i] = structuredClone(task); else next.tasks.push(structuredClone(task));
    });
  }
}
