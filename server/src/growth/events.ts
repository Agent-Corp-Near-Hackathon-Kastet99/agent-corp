import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "../config.js";
import { sha256 } from "./util.js";

export const FUNNEL_EVENTS = ["page_view", "game_page_view", "wallet_connect", "pass_click"] as const;
export type FunnelEvent = typeof FUNNEL_EVENTS[number];
export type TrackedEvent = { ts: number; name: FunnelEvent; anon: string; cycle?: number; channel?: string; asset?: string };

const MAX_EVENTS = 20_000;
const TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * First-party funnel events from the landing/game page. Works with zero third parties; PostHog is an optional mirror.
 * `anon` is a salted hash of a client-supplied random id, so no raw identifiers are stored.
 */
export class EventStore {
  private events: TrackedEvent[] = [];
  constructor(
    private readonly now: () => number = Date.now,
    private readonly file = join(process.env.GROWTH_DIR ?? join(ROOT, ".data", "growth"), "events.json"),
    private readonly salt = "agentcorp-growth",
  ) {
    if (existsSync(file)) {
      const v: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(v)) throw new Error("Invalid growth events file");
      this.events = v as TrackedEvent[];
    }
  }
  /** Returns a validation error string, or undefined when recorded. */
  record(input: unknown): string | undefined {
    if (!input || typeof input !== "object") return "invalid body";
    const b = input as Record<string, unknown>;
    if (!FUNNEL_EVENTS.includes(b.name as FunnelEvent)) return "unknown event";
    if (typeof b.anon !== "string" || !TOKEN.test(b.anon)) return "invalid anon id";
    const opt = (v: unknown) => v === undefined || v === null || v === "" ? undefined : typeof v === "string" && TOKEN.test(v) ? v : null;
    const channel = opt(b.channel), asset = opt(b.asset);
    if (channel === null || asset === null) return "invalid attribution field";
    let cycle: number | undefined;
    if (b.cycle !== undefined && b.cycle !== null && b.cycle !== "") {
      cycle = Number(b.cycle);
      if (!Number.isInteger(cycle) || cycle < 0 || cycle > 100_000) return "invalid cycle";
    }
    const next = [...this.events, { ts: this.now(), name: b.name as FunnelEvent, anon: sha256(`${this.salt}:${b.anon}`).slice(0, 16), cycle, channel, asset }];
    if (next.length > MAX_EVENTS) next.splice(0, next.length - MAX_EVENTS);
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.events = next;
    return undefined;
  }
  /** Unique visitors per event; optionally restricted to a cycle and/or a start time. */
  funnel(opts: { cycle?: number; sinceTs?: number } = {}): Record<FunnelEvent, number> {
    const out = Object.fromEntries(FUNNEL_EVENTS.map(n => [n, new Set<string>()])) as Record<FunnelEvent, Set<string>>;
    for (const e of this.events) {
      if (opts.cycle !== undefined && e.cycle !== opts.cycle) continue;
      if (opts.sinceTs !== undefined && e.ts < opts.sinceTs) continue;
      out[e.name].add(e.anon);
    }
    return Object.fromEntries(FUNNEL_EVENTS.map(n => [n, out[n].size])) as Record<FunnelEvent, number>;
  }
  count() { return this.events.length; }
}
