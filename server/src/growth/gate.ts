import { contentLint, type LintInput } from "./lint.js";
import { levelFor, type GrowthPolicy, type Level } from "./policy.js";

export type ActionStatus =
  | "APPROVED"          // cleared to execute (auto by policy, or by a human)
  | "EXECUTING"         // claimed by exactly one executor; crash while here => FAILED on restart (at-most-once)
  | "PENDING_APPROVAL"  // L2: waiting in the approval inbox
  | "HUMAN_TASK"        // agent drafted, a human performs it outside the system
  | "DEFERRED"          // temporarily blocked (rate limit); safe to re-propose later
  | "DENIED"            // policy or lint refused it
  | "REJECTED"          // a human refused it
  | "EXECUTED"
  | "FAILED";

export type ActionRecord = {
  id: string;
  cycle: number;
  kind: string;                 // e.g. "postiz.create_post.now"
  summary: string;
  payload: Record<string, unknown>;
  text?: string;                // outgoing text, linted
  parts?: { text: string; isReply?: boolean }[]; // extra thread parts, each linted
  channel?: string;
  isReply?: boolean;
  costUsd: number;
  level?: Level;
  status: ActionStatus;
  reason?: string;
  decidedBy?: string;           // "policy:L0" | "human:<name>"
  externalId?: string;
  url?: string;
  createdAt: number;
  updatedAt: number;
};

export type Proposal = {
  cycle: number;
  kind: string;
  summary: string;
  payload?: Record<string, unknown>;
  text?: string;
  parts?: { text: string; isReply?: boolean }[];
  channel?: string;
  isReply?: boolean;
  costUsd?: number;
};

export type Decision = { status: ActionStatus; level?: Level; reason?: string; decidedBy?: string };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Actions that never consumed budget, quota or rate. */
const INERT: ActionStatus[] = ["DENIED", "REJECTED", "DEFERRED"];
// A failed execution may already have spent money or produced an external effect.
export const consumesQuota = (a: ActionRecord) => !INERT.includes(a.status);

/**
 * Pure decision function: no I/O, no clock, so it is exhaustively testable.
 * Default-deny: a kind absent from policy.levels is refused. Order matters:
 * pause → unknown kind → DENY level → lint → budget → quota/rate → level routing.
 */
export function decide(p: Proposal, policy: GrowthPolicy, history: ActionRecord[], now: number): Decision {
  if (policy.growth_paused) return { status: "DENIED", reason: "growth is paused (policy.growth_paused)" };

  const level = levelFor(policy, p.kind);
  if (!level) return { status: "DENIED", reason: `no policy level for "${p.kind}" (default-deny)` };
  if (level === "DENY") return { status: "DENIED", level, reason: `"${p.kind}" is denied by policy` };

  if (p.text !== undefined) {
    const input: LintInput = { text: p.text, channel: p.channel, isReply: p.isReply };
    const lint = contentLint(input, policy);
    if (!lint.ok) return { status: "DENIED", level, reason: `lint: ${lint.violations.join("; ")}` };
  }
  for (const part of p.parts ?? []) {
    const lint = contentLint({ text: part.text, channel: p.channel, isReply: part.isReply }, policy);
    if (!lint.ok) return { status: "DENIED", level, reason: `lint (thread part): ${lint.violations.join("; ")}` };
  }

  const cost = p.costUsd ?? 0;
  if (!Number.isFinite(cost) || cost < 0) return { status: "DENIED", level, reason: "invalid costUsd" };
  if (cost > 0) {
    const spent = history.filter(consumesQuota);
    const cycleSpent = spent.filter(a => a.cycle === p.cycle).reduce((s, a) => s + a.costUsd, 0);
    const totalSpent = spent.reduce((s, a) => s + a.costUsd, 0);
    if (cycleSpent + cost > policy.cycle_budget_usd) {
      return { status: "DENIED", level, reason: `over cycle budget: $${(cycleSpent + cost).toFixed(2)} > $${policy.cycle_budget_usd}` };
    }
    if (totalSpent + cost > policy.total_budget_usd) {
      return { status: "DENIED", level, reason: `over total budget: $${(totalSpent + cost).toFixed(2)} > $${policy.total_budget_usd}` };
    }
  }

  if (p.kind.startsWith("postiz.")) {
    const calls = history.filter(a => a.kind.startsWith("postiz.") && consumesQuota(a) && now - a.createdAt < HOUR).length;
    if (calls >= policy.postiz_calls_per_hour) {
      return { status: "DEFERRED", level, reason: `postiz rate limit: ${calls}/${policy.postiz_calls_per_hour} calls in the last hour` };
    }
  }

  // Daily caps bound *automatic* public posting (L1). Human-gated levels have a person as the limiter.
  const postChannel = level === "L1" ? /^(\w+)\.post$/.exec(p.kind)?.[1] : undefined;
  if (postChannel) {
    const cap = policy.max_posts_per_day[postChannel];
    if (cap === undefined) return { status: "DENIED", level, reason: `no daily post cap configured for ${postChannel} (default-deny)` };
    const posted = history.filter(a => a.kind === p.kind && consumesQuota(a) && now - a.createdAt < DAY).length;
    if (posted >= cap) return { status: "DENIED", level, reason: `daily cap reached for ${postChannel}: ${posted}/${cap}` };
  }

  switch (level) {
    case "L0":
    case "L1": return { status: "APPROVED", level, decidedBy: `policy:${level}` };
    case "L2": return { status: "PENDING_APPROVAL", level, reason: "needs human approval" };
    case "HUMAN_TASK": return { status: "HUMAN_TASK", level, reason: "a human performs this outside the system" };
  }
}
