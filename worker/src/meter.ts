import { PRICE_TABLE, priceUnits, type Price, type TokenUsage, type Units, type UsageBasis } from "@agentcorp/shared";
import { parseClaude } from "./providers/claude.js";
import type { Parsed } from "./providers/types.js";

/** `exact` is true only for a provider's own authoritative cost. A list-price figure is settled
 * (`basis: "list-price"`, authoritative token counts) but inferred, so it is never `exact`. */
export type MeterResult = { units: Units; exact: boolean; basis?: UsageBasis; tokens?: string; tokensExact?: boolean; usage?: TokenUsage };

const ZERO: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const sum = (a: TokenUsage, b: TokenUsage): TokenUsage => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite });
const count = (u: TokenUsage) => BigInt(u.input) + BigInt(u.output) + BigInt(u.cacheRead) + BigInt(u.cacheWrite);

/** Provider-neutral usage accounting. Provisional usage is an estimate; finished steps and totals
 * are authoritative token counts; only a provider-reported cost is an exact cost. */
export class UsageMeter {
  #estimate = 0n;
  #provisional = ZERO;
  #steps = ZERO;
  #stepCount = 0;
  #total?: TokenUsage;
  #cost?: bigint;
  #final = false;
  constructor(private readonly price: Price | undefined, private readonly costSource: "provider-cost" | "list-price") {}

  add(signal: Parsed): MeterResult {
    if (signal.provisional) {
      this.#provisional = sum(this.#provisional, signal.provisional);
      if (this.price) this.#estimate += BigInt(priceUnits(this.price, signal.provisional));
    }
    if (signal.step) { this.#steps = sum(this.#steps, signal.step); this.#stepCount++; }
    if (signal.total) this.#total = signal.total;
    if (this.costSource === "provider-cost" && typeof signal.costUsd === "number" && Number.isFinite(signal.costUsd) && signal.costUsd >= 0) {
      this.#cost = BigInt(Math.round(signal.costUsd * 1_000_000));
    }
    if (signal.final) this.#final = true;
    return this.result();
  }

  /** Authoritative token counts, present once the provider reported them. */
  #authoritative(): TokenUsage | undefined { return this.#total ?? (this.#final && this.#stepCount ? this.#steps : undefined); }

  result(): MeterResult {
    const settled = this.#authoritative();
    const observed = this.#total ?? (this.#stepCount ? this.#steps : this.#provisional);
    const shared = { tokens: count(observed).toString(), tokensExact: settled !== undefined, ...(settled ? { usage: settled } : {}) };
    if (this.#cost !== undefined) return { units: this.#cost.toString(), exact: true, basis: "provider-cost", ...shared };
    if (settled && this.#final && this.price && this.costSource === "list-price") return { units: priceUnits(this.price, settled), exact: false, basis: "list-price", ...shared };
    const priced = !this.price ? 0n : this.#total ? BigInt(priceUnits(this.price, this.#total)) : this.#estimate + (this.#stepCount ? BigInt(priceUnits(this.price, this.#steps)) : 0n);
    return { units: priced.toString(), exact: false, basis: "estimate", ...shared };
  }
  /** True when the run's units need no conservative fallback: an exact cost or a list-price figure. */
  get settled(): boolean { const basis = this.result().basis; return basis === "provider-cost" || basis === "list-price"; }
}

/** Claude stream meter: sums per-message usage; a result's total_cost_usd is authoritative and replaces it. */
export class StreamMeter {
  readonly #meter: UsageMeter;
  constructor(readonly model: string) {
    const price = PRICE_TABLE[model];
    if (!price) throw new Error(`unknown model price: ${model}`);
    this.#meter = new UsageMeter(price, "provider-cost");
  }
  add(event: unknown): MeterResult { return this.#meter.add(event && typeof event === "object" ? parseClaude(event as Record<string, unknown>) : {}); }
  result(): MeterResult { return this.#meter.result(); }
}
