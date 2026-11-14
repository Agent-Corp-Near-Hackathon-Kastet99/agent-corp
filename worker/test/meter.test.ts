import { describe, expect, it } from "vitest";
import { StreamMeter } from "../src/meter.js";

describe("stream meter", () => {
  it("uses replay estimate until final cost replaces it", () => {
    const meter = new StreamMeter("sonnet");
    expect(meter.add({ type: "assistant", message: { usage: { input_tokens: 100, output_tokens: 10 } } })).toEqual({ units: "450", exact: false, basis: "estimate", tokens: "110", tokensExact: false });
    expect(meter.add({ type: "result", total_cost_usd: 0.001234 })).toEqual({ units: "1234", exact: true, basis: "provider-cost", tokens: "110", tokensExact: false });
  });
  it("uses final token totals without double counting stream events", () => {
    const meter = new StreamMeter("sonnet");
    meter.add({ type: "assistant", usage: { input_tokens: 10, output_tokens: 2 } });
    expect(meter.add({ type: "result", total_cost_usd: 0.001, usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } })).toMatchObject({ tokens: "37", tokensExact: true });
  });
  it("reports provisional value after killed/incomplete stream", () => {
    const meter = new StreamMeter("sonnet");
    meter.add({ type: "assistant", usage: { input_tokens: 10, output_tokens: 1 } });
    expect(meter.result()).toEqual({ units: "45", exact: false, basis: "estimate", tokens: "11", tokensExact: false });
  });
});
