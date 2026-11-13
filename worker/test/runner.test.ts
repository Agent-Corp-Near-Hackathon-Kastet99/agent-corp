import { describe, expect, it } from "vitest";
import { claudeArgv } from "../src/runner.js";
describe("Claude argv", () => it("keeps restricted stream-json flags", () => {
  expect(claudeArgv("sonnet")).toEqual(["-p", "--verbose", "--output-format", "stream-json", "--tools", "", "--strict-mcp-config", "--model", "sonnet"]);
}));
