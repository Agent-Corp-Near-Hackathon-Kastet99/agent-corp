import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ROOT } from "../config.js";
import type { Log } from "../ledger.js";
import { consumesQuota, decide, type ActionRecord, type ActionStatus, type Proposal } from "./gate.js";
import type { GrowthPolicy } from "./policy.js";

const STATUSES: ActionStatus[] = ["APPROVED", "EXECUTING", "PENDING_APPROVAL", "HUMAN_TASK", "DEFERRED", "DENIED", "REJECTED", "EXECUTED", "FAILED"];
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function validActions(value: unknown): asserts value is ActionRecord[] {
  if (!Array.isArray(value) || !value.every(a => isObject(a) && typeof a.id === "string" && typeof a.kind === "string"
      && typeof a.summary === "string" && Number.isInteger(a.cycle) && Number.isFinite(a.costUsd) && Number(a.costUsd) >= 0
      && STATUSES.includes(a.status as ActionStatus) && Number.isFinite(a.createdAt) && Number.isFinite(a.updatedAt) && isObject(a.payload))) {
    throw new Error("Invalid growth action log");
  }
}

const SHORT = (s: string, n = 140) => s.length > n ? `${s.slice(0, n - 1)}…` : s;

/**
 * Durable action table. Every external effect of the growth harness is a row here with a status
 * machine; the dashboard feed and approval inbox are views over it. Persistence is an atomic
 * snapshot (same pattern as Store): a mutation is invisible until it is written.
 */
export class GrowthState {
  private actions: ActionRecord[] = [];
  private closed = false;
  close() { this.closed = true; }
  private assertOpen() { if (this.closed) throw new Error("growth state is closed"); }
  constructor(
    private readonly log: Log,
    private readonly now: () => number = Date.now,
    private readonly file = process.env.GROWTH_STATE ?? join(ROOT, ".data", "growth", "actions.json"),
  ) {
    if (existsSync(file)) {
      const value: unknown = JSON.parse(readFileSync(file, "utf8"));
      validActions(value);
      this.actions = value;
      // At-most-once: an action that was mid-execution when the process died may or may not have gone out.
      // Never retry it automatically; surface it for a human to verify.
      if (value.some(a => a.status === "EXECUTING")) {
        const t = this.now();
        this.commit(value.map(a => a.status === "EXECUTING" ? { ...a, status: "FAILED" as const, reason: "interrupted before completion; verify externally before retrying", updatedAt: t } : a));
      }
    }
  }

  private commit(next: ActionRecord[]) {
    validActions(next);
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
    this.actions = next;
  }

  private feed(a: ActionRecord, verb: string) {
    this.log({ ts: this.now(), actor: "MARKETING", text: `${verb} ${a.kind}: ${SHORT(a.summary)}${a.reason ? ` — ${a.reason}` : ""}${a.url ? ` → ${a.url}` : ""}` });
  }

  list(filter?: { status?: ActionStatus; cycle?: number }) {
    this.assertOpen();
    return structuredClone(this.actions.filter(a => (!filter?.status || a.status === filter.status) && (filter?.cycle === undefined || a.cycle === filter.cycle)));
  }
  get(id: string) { this.assertOpen(); const a = this.actions.find(x => x.id === id); return a ? structuredClone(a) : undefined; }
  pending() { return this.list({ status: "PENDING_APPROVAL" }); }
  /** Approved but not yet executed: the executors' work queue. */
  runnable() { return this.list({ status: "APPROVED" }); }
  spentUsd(cycle?: number) {
    this.assertOpen();
    return this.actions.filter(a => consumesQuota(a) && (cycle === undefined || a.cycle === cycle))
      .reduce((s, a) => s + a.costUsd, 0);
  }

  /** Run the gate and record the outcome. Never throws for a policy refusal: refusals are recorded and returned. */
  propose(p: Proposal, policy: GrowthPolicy): ActionRecord {
    this.assertOpen();
    const t = this.now();
    const d = decide(p, policy, this.actions, t);
    const record: ActionRecord = {
      id: randomUUID(), cycle: p.cycle, kind: p.kind, summary: p.summary, payload: structuredClone(p.payload ?? {}),
      text: p.text, parts: p.parts ? structuredClone(p.parts) : undefined, channel: p.channel, isReply: p.isReply, costUsd: p.costUsd ?? 0,
      level: d.level, status: d.status, reason: d.reason, decidedBy: d.decidedBy, createdAt: t, updatedAt: t,
    };
    this.commit([...this.actions, record]);
    this.feed(record, ({ APPROVED: "cleared", PENDING_APPROVAL: "awaiting approval:", HUMAN_TASK: "handed to human:", DEFERRED: "deferred:", DENIED: "blocked:" } as Record<string, string>)[d.status] ?? d.status);
    return structuredClone(record);
  }

  private transition(id: string, from: ActionStatus[], change: Partial<ActionRecord>, verb: string) {
    this.assertOpen();
    const quiet = verb === "executing";
    const i = this.actions.findIndex(a => a.id === id);
    if (i < 0) throw new Error(`unknown growth action ${id}`);
    const current = this.actions[i]!;
    if (!from.includes(current.status)) throw new Error(`action ${id} is ${current.status}; expected ${from.join(" or ")}`);
    const updated: ActionRecord = { ...current, ...change, updatedAt: this.now() };
    const next = this.actions.slice();
    next[i] = updated;
    this.commit(next);
    if (!quiet) this.feed(updated, verb);
    return structuredClone(updated);
  }

  approve(id: string, by: string) {
    if (!by.trim()) throw new Error("approver required");
    return this.transition(id, ["PENDING_APPROVAL"], { status: "APPROVED", decidedBy: `human:${by.trim()}`, reason: undefined }, "approved");
  }
  reject(id: string, by: string, reason: string) {
    if (!by.trim()) throw new Error("approver required");
    return this.transition(id, ["PENDING_APPROVAL", "HUMAN_TASK"], { status: "REJECTED", decidedBy: `human:${by.trim()}`, reason }, "rejected");
  }
  /** Atomically claim an APPROVED action for execution. Throws if anyone else already did, so two executors can never both run it. */
  begin(id: string) {
    return this.transition(id, ["APPROVED"], { status: "EXECUTING" }, "executing");
  }
  /** The executor reports the real external id and URL. */
  executed(id: string, result: { externalId?: string; url?: string; costUsd?: number }) {
    if (result.costUsd !== undefined && (!Number.isFinite(result.costUsd) || result.costUsd < 0)) throw new Error("invalid costUsd");
    return this.transition(id, ["APPROVED", "EXECUTING"], { status: "EXECUTED", externalId: result.externalId, url: result.url, ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}) }, "executed");
  }
  /** A human reports completing a HUMAN_TASK (e.g. posted to Reddit); URL is the proof. */
  humanDone(id: string, by: string, url: string) {
    if (!by.trim() || !url.trim()) throw new Error("completer and proof URL required");
    return this.transition(id, ["HUMAN_TASK"], { status: "EXECUTED", decidedBy: `human:${by.trim()}`, url: url.trim() }, "completed by human");
  }
  failed(id: string, reason: string) {
    return this.transition(id, ["APPROVED", "EXECUTING"], { status: "FAILED", reason }, "failed");
  }
}
