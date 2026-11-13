import { estimateUnits, type Units } from "@agentcorp/shared";

export type MeterResult = { units: Units; exact: boolean };
type Usage = Parameters<typeof estimateUnits>[1];

function usageFrom(value: unknown): Usage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const usage = (source.usage ?? (source.message as Record<string, unknown> | undefined)?.usage) as Record<string, unknown> | undefined;
  if (!usage || typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number") return undefined;
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_input_tokens: typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : undefined,
    cache_creation_input_tokens: typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : undefined,
  };
}

/** Sum reported per-message usage. A result's total_cost_usd is authoritative and replaces this. */
export class StreamMeter {
  #estimate = 0n;
  #final?: bigint;
  constructor(readonly model: string) {}

  add(event: unknown): MeterResult {
    const object = event as Record<string, unknown>;
    if (object?.type === "result" && (typeof object.total_cost_usd === "number" || typeof object.total_cost_usd === "string")) {
      const cost = Number(object.total_cost_usd);
      if (!Number.isFinite(cost) || cost < 0) return this.result();
      this.#final = BigInt(Math.round(cost * 1_000_000));
      return this.result();
    }
    const usage = usageFrom(event);
    if (usage) this.#estimate += BigInt(estimateUnits(this.model, usage));
    return this.result();
  }

  result(): MeterResult {
    return { units: (this.#final ?? this.#estimate).toString(), exact: this.#final !== undefined };
  }
}
