import { describe, expect, it } from "vitest";
import { isPublicAddress } from "../src/fetch.js";
describe("SSRF address guard", () => {
  it.each(["127.0.0.1","169.254.169.254","10.0.0.1","192.168.1.1","::1"])("rejects %s", ip => expect(isPublicAddress(ip)).toBe(false));
  it("allows public address", () => expect(isPublicAddress("93.184.216.34")).toBe(true));
});
