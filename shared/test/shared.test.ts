import { describe, expect, it } from "vitest";
import { estimateUnits } from "../src/index.js";

describe("estimateUnits", () => {
  it("returns integer micro-USD without number overflow", () => {
    expect(estimateUnits("sonnet", { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 })).toBe("23");
    expect(estimateUnits("sonnet", { input_tokens: 9_000_000_000_000_000, output_tokens: 0 })).toBe("27000000000000000");
  });
});
