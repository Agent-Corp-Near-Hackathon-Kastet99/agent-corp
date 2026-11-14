import { expect, it } from "vitest";
import { parseCodex } from "../src/providers/codex.js";
import { parseOpencode } from "../src/providers/opencode.js";
import { parseCursor } from "../src/providers/cursor.js";
import { parsePi } from "../src/providers/pi.js";
import { acpParser, parseCustomAcpAgents } from "../src/providers/acp.js";
import { UsageMeter } from "../src/meter.js";
const price = { inPerMTok: 2, outPerMTok: 10, cacheReadPerMTok: 0.5, cacheWritePerMTok: 2 };
it("normalizes Codex cache usage and keeps inferred dollars inexact", () => {
  const meter = new UsageMeter(price, "list-price");
  const parsed = parseCodex({ type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 10 } });
  expect(meter.add(parsed)).toMatchObject({ units: "310", exact: false, basis: "list-price", tokens: "130", tokensExact: true });
  expect(parseCodex({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 2, output_tokens: 0 } }).error).toContain("malformed");
  expect(parseCodex({ type: "turn.completed" }).final).toBeUndefined();
});
it("sums opencode steps and includes reasoning without trusting catalogue cost", () => {
  const meter = new UsageMeter(price, "list-price");
  const step = (reason: string) => parseOpencode({ type: "step_finish", part: { reason, cost: 999, tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 4, write: 0 } } } });
  expect(meter.add(step("tool-calls"))).toMatchObject({ basis: "estimate", tokensExact: false });
  expect(meter.add(step("stop"))).toMatchObject({ units: "144", basis: "list-price", exact: false, tokens: "38" });
});
it("refuses missing usage across providers", () => {
  expect(parseCursor({ type: "result", result: "ok" }).final).toBeUndefined();
  expect(parsePi({ type: "agent_end", messages: [] }).error).toContain("without usage");
  const parser = acpParser("/tmp/work");
  expect(parser.event({ id: 3, result: { stopReason: "end_turn" } })).toMatchObject({ done: true, error: expect.stringContaining("no token usage") });
});
it("ACP refuses permission, filesystem and terminal requests", () => {
  const parser = acpParser("/tmp/work");
  expect(parser.event({ id: 5, method: "session/request_permission", params: { options: [{ kind: "allow_once", optionId: "yes" }] } }).send).toEqual([{ jsonrpc: "2.0", id: 5, result: { outcome: { outcome: "cancelled" } } }]);
  for (const method of ["fs/read_text_file", "terminal/create"]) expect(parser.event({ id: 6, method }).send).toEqual([{ jsonrpc: "2.0", id: 6, error: { code: -32601, message: "not available" } }]);
});
it("custom ACP config rejects unpinned executables and environment injection", () => {
  const entry = { id: "local", displayName: "Local", command: "/opt/agent", models: ["model"], sha256: "0".repeat(64) };
  expect(parseCustomAcpAgents([entry], new Set()).agents).toHaveLength(1);
  for (const patch of [{ sha256: "" }, { env: { NODE_OPTIONS: "--require=evil" } }, { command: "agent" }, { credentialFiles: ["/etc/passwd"] }]) expect(parseCustomAcpAgents([{ ...entry, ...patch }], new Set()).agents).toEqual([]);
});
