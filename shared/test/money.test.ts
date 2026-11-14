import { describe, expect, it } from "vitest";
import { fmt, toYocto, YOCTO } from "../src/index.js";
describe("exact money", () => {
  it("rejects malformed and overflowing amounts instead of truncating", () => {
    for (const amount of ["", ".", "1.2.3", "-1", "1e2", "1.", "0." + "1".repeat(25), "9".repeat(50)]) expect(() => toYocto(amount)).toThrow();
    expect(toYocto("1.000000000000000000000001")).toBe(YOCTO + 1n);
  });
  it("formats zero, signed values, precision and rounding consistently", () => {
    expect(fmt(YOCTO, 0)).toBe("1"); expect(fmt(0n)).toBe("0.00");
    expect(fmt(-YOCTO / 2n)).toBe("-0.50"); expect(fmt(999n * YOCTO / 1000n)).toBe("1.00");
    expect(fmt(1n, 24)).toBe("0.000000000000000000000001");
    expect(() => fmt(1n, 25)).toThrow();
  });
});
