import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { ROOT } from "../config.js";

export const LEVELS = ["L0", "L1", "L2", "HUMAN_TASK", "DENY"] as const;
export type Level = typeof LEVELS[number];

export type BoardPolicy = {
  /** When true, paid growth spend per cycle is bounded by the Board-approved budget (fail-closed). */
  enabled: boolean;
  /** Owner-set conversion. Testnet NEAR has no market price, so this is an explicit owner assumption. */
  usd_per_near: number;
  /** Share of the Board's per-period expense budget the growth team may use. */
  growth_share_pct: number;
  /** Small owner-granted allowance before any Board budget exists, so the CEO can plan and ask. */
  bootstrap_cycle_usd: number;
  /** Growth cycle budgets the Board chooses between (USD). Each becomes one proposal option. */
  tiers_usd: number[];
  voting_period_secs: number;
};

export type GrowthPolicy = {
  growth_paused: boolean;
  cycle_budget_usd: number;
  total_budget_usd: number;
  postiz_calls_per_hour: number;
  max_posts_per_day: Record<string, number>;
  levels: Record<string, Level>;
  board: BoardPolicy;
  content_rules: {
    require_disclosure: string;
    forbid_terms: string[];
    testnet_label: string;
    x_links: "reply_only" | "any";
    forbid: string[];
  };
};

const fail = (msg: string): never => { throw new Error(`growth/policy.yaml: ${msg}`); };
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const positive = (v: unknown, name: string) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) fail(`${name} must be a positive number`);
  return v as number;
};
const strings = (v: unknown, name: string) => {
  if (!Array.isArray(v) || !v.every(s => typeof s === "string" && s.trim())) fail(`${name} must be a list of non-empty strings`);
  return (v as string[]).map(s => s.trim());
};

/** USD amounts and rates are held as whole cents so the NEAR conversion is exact integer math. */
export const toCents = (usd: number): number => {
  const c = Math.round(usd * 100);
  if (!Number.isFinite(usd) || usd < 0 || Math.abs(usd * 100 - c) > 1e-6) throw new Error(`${usd} is not a USD amount with at most 2 decimals`);
  return c;
};
const YOCTO = 10n ** 24n;
/** NEAR (yocto) the Board budget must say so that growth gets `tierCents`. Throws unless the division is exact. */
export function yoctoForCents(tierCents: number, rateCents: number, sharePct: number): bigint {
  const num = BigInt(tierCents) * 100n * YOCTO, den = BigInt(rateCents) * BigInt(sharePct);
  if (den === 0n || num % den !== 0n) throw new Error(`a $${tierCents / 100} tier is not exactly representable at this rate and share`);
  return num / den;
}
export const centsForYocto = (yocto: bigint, rateCents: number, sharePct: number): number =>
  Number((yocto * BigInt(rateCents) * BigInt(sharePct)) / (100n * YOCTO));

function validateBoard(v: unknown, cycleCap: number, totalCap: number): BoardPolicy {
  if (v === undefined) return { enabled: false, usd_per_near: 1, growth_share_pct: 100, bootstrap_cycle_usd: 0, tiers_usd: [0, 1], voting_period_secs: 3600 };
  if (!isObject(v)) return fail("board must be a mapping");
  if (typeof v.enabled !== "boolean") fail("board.enabled must be true or false");
  let rate: number, share: number, boot: number;
  try { rate = v.usd_per_near as number; toCents(rate); if (!(rate > 0)) throw new Error("must be positive"); } catch (e) { return fail(`board.usd_per_near ${(e as Error).message}`); }
  share = v.growth_share_pct as number;
  if (!Number.isInteger(share) || share < 1 || share > 100) fail("board.growth_share_pct must be an integer 1-100");
  try { boot = v.bootstrap_cycle_usd as number; toCents(boot); } catch (e) { return fail(`board.bootstrap_cycle_usd ${(e as Error).message}`); }
  if (boot > cycleCap) fail("board.bootstrap_cycle_usd cannot exceed cycle_budget_usd");
  const tiers = v.tiers_usd;
  if (!Array.isArray(tiers) || tiers.length < 2 || tiers.length > 6) fail("board.tiers_usd needs 2-6 amounts");
  let prev = -1;
  for (const t of tiers as unknown[]) {
    let cents: number;
    try { cents = toCents(t as number); } catch (e) { return fail(`board.tiers_usd ${(e as Error).message}`); }
    if (cents <= prev) fail("board.tiers_usd must be strictly ascending");
    prev = cents;
    if ((t as number) > cycleCap || (t as number) > totalCap) fail(`board tier $${t} exceeds the owner's cycle/total budget cap (the owner is the ceiling)`);
    try { yoctoForCents(cents, toCents(rate), share); } catch (e) { return fail(`board.tiers_usd: ${(e as Error).message}`); }
  }
  const secs = v.voting_period_secs as number;
  if (!Number.isInteger(secs) || secs < 60 || secs > 30 * 86_400) fail("board.voting_period_secs must be 60 to 2592000");
  return { enabled: v.enabled as boolean, usd_per_near: rate, growth_share_pct: share, bootstrap_cycle_usd: boot, tiers_usd: tiers as number[], voting_period_secs: secs };
}

export function validatePolicy(value: unknown): GrowthPolicy {
  if (!isObject(value)) return fail("expected mapping");
  if (typeof value.growth_paused !== "boolean") fail("growth_paused must be true or false");
  const cycle = positive(value.cycle_budget_usd, "cycle_budget_usd");
  const total = positive(value.total_budget_usd, "total_budget_usd");
  if (cycle > total) fail("cycle_budget_usd cannot exceed total_budget_usd");
  const calls = positive(value.postiz_calls_per_hour, "postiz_calls_per_hour");
  if (!Number.isInteger(calls)) fail("postiz_calls_per_hour must be an integer");

  const posts = value.max_posts_per_day ?? {};
  if (!isObject(posts)) fail("max_posts_per_day must be a mapping");
  const maxPosts: Record<string, number> = {};
  for (const [channel, n] of Object.entries(posts as Record<string, unknown>)) {
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) fail(`max_posts_per_day.${channel} must be a non-negative integer`);
    maxPosts[channel] = n as number;
  }

  if (!isObject(value.levels)) return fail("levels must be a mapping");
  const levels: Record<string, Level> = {};
  for (const [kind, level] of Object.entries(value.levels as Record<string, unknown>)) {
    if (!LEVELS.includes(level as Level)) fail(`levels.${kind}: unknown level ${String(level)}`);
    levels[kind] = level as Level;
  }

  const board = validateBoard(value.board, cycle, total);

  const r = value.content_rules;
  if (!isObject(r)) return fail("content_rules must be a mapping");
  if (typeof r.require_disclosure !== "string" || !r.require_disclosure.trim()) fail("content_rules.require_disclosure required");
  if (typeof r.testnet_label !== "string" || !r.testnet_label.trim()) fail("content_rules.testnet_label required");
  if (r.x_links !== "reply_only" && r.x_links !== "any") fail("content_rules.x_links must be reply_only or any");

  return {
    growth_paused: value.growth_paused as boolean,
    cycle_budget_usd: cycle,
    total_budget_usd: total,
    postiz_calls_per_hour: calls,
    max_posts_per_day: maxPosts,
    levels,
    board,
    content_rules: {
      require_disclosure: (r.require_disclosure as string).trim(),
      forbid_terms: strings(r.forbid_terms, "content_rules.forbid_terms"),
      testnet_label: (r.testnet_label as string).trim(),
      x_links: r.x_links as "reply_only" | "any",
      forbid: r.forbid === undefined ? [] : strings(r.forbid, "content_rules.forbid"),
    },
  };
}

export function loadPolicy(file = join(ROOT, "growth", "policy.yaml")): GrowthPolicy {
  return validatePolicy(parse(readFileSync(file, "utf8")));
}

/** policy.yaml plus the optional gitignored growth/policy.local.yaml, whose `levels` entries override. */
export function loadOwnerPolicy(file = join(ROOT, "growth", "policy.yaml"), local = join(ROOT, "growth", "policy.local.yaml")): GrowthPolicy {
  const base = parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  if (existsSync(local)) {
    const extra = parse(readFileSync(local, "utf8")) as { levels?: Record<string, unknown> } | null;
    if (extra?.levels !== undefined && !isObject(extra.levels)) fail("policy.local.yaml: levels must be a mapping");
    base.levels = { ...(base.levels as Record<string, unknown>), ...(extra?.levels ?? {}) };
  }
  return validatePolicy(base);
}

/** Exact match wins; else the longest `prefix.*` wildcard; else undefined (caller denies). */
export function levelFor(policy: GrowthPolicy, kind: string): Level | undefined {
  const exact = policy.levels[kind];
  if (exact) return exact;
  let best: { len: number; level: Level } | undefined;
  for (const [pattern, level] of Object.entries(policy.levels)) {
    if (!pattern.endsWith(".*")) continue;
    const prefix = pattern.slice(0, -1); // keep the trailing dot
    if (kind.startsWith(prefix) && (!best || prefix.length > best.len)) best = { len: prefix.length, level };
  }
  return best?.level;
}
