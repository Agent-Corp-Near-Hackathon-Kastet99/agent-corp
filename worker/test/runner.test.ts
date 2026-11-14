import { describe, expect, it } from "vitest";
import { claudeArgv } from "../src/runner.js";
describe("Claude argv", () => it("keeps restricted stream-json flags", () => {
  expect(claudeArgv("sonnet")).toEqual(["-p", "--verbose", "--output-format", "stream-json", "--tools", "", "--strict-mcp-config", "--model", "sonnet"]);
}));

import { spawn } from "node:child_process";
import { runClaude } from "../src/runner.js";
const child = (script: string) => (cwd: string) => spawn(process.execPath, ["-e", script], { cwd, stdio: ["pipe", "pipe", "pipe"] });
it("drains stderr and preserves measured usage on failed process exit", async () => {
  const run = await runClaude("test", "sonnet", () => true, child(`process.stderr.write('x'.repeat(200000)); console.log(JSON.stringify({type:'assistant',usage:{input_tokens:10,output_tokens:1}})); process.stdin.resume(); process.stdin.on('end',()=>process.exit(7));`));
  expect(run.meter.units).toBe("45"); expect(run.error).toContain("7"); expect(run.killed).toBe(false);
});
it("treats cap-write errors as failures and stops process", async () => {
  const run = await runClaude("test", "sonnet", () => { throw new Error("disk failed"); }, child(`console.log(JSON.stringify({type:'assistant',usage:{input_tokens:10,output_tokens:1}})); setInterval(()=>{},1000);`));
  expect(run.killed).toBe(true); expect(run.error).toBe("disk failed"); expect(run.meter.units).toBe("45");
});
it("cancels running process and preserves final cost replacement", async () => {
  const cancel = new AbortController();
  const run = await runClaude("test", "sonnet", () => { cancel.abort(); return true; }, child(`console.log(JSON.stringify({type:'result',total_cost_usd:0.001234,result:'partial'})); setInterval(()=>{},1000);`), { signal: cancel.signal });
  expect(run.killed).toBe(true); expect(run.meter).toEqual({ units: "1234", exact: true, basis: "provider-cost", tokens: "0", tokensExact: false });
});
it("rejects successful exit without authoritative final result", async () => {
  const run = await runClaude("test", "sonnet", () => true, child(`process.stdin.resume();`));
  expect(run.error).toContain("without a final");
});

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { sandboxProfile } from "../src/runner.js";
it.skipIf(process.platform !== "darwin")("sandbox blocks home reads and outside writes while allowing workspace", async () => {
  const work = await mkdtemp(join(tmpdir(), "agentcorp-seatbelt-"));
  const secret = join(homedir(), `.agentcorp-seatbelt-test-${process.pid}`);
  const outside = `${secret}-outside`;
  await writeFile(secret, "secret");
  try {
    const script = `cat "$1" >/dev/null 2>&1; r=$?; echo blocked > "$2" 2>/dev/null; w=$?; echo allowed > "$3"; test "$r" -ne 0 -a "$w" -ne 0`;
    const child = spawn("/usr/bin/sandbox-exec", ["-p", sandboxProfile(work), "/bin/sh", "-c", script, "sh", secret, outside, join(work, "ok")], { stdio: ["ignore", "pipe", "pipe"] });
    const code = await new Promise<number | null>(resolve => child.on("close", resolve));
    expect(code).toBe(0); expect(await readFile(join(work, "ok"), "utf8")).toContain("allowed");
  } finally { await rm(work, { recursive: true, force: true }); await rm(secret, { force: true }); await rm(outside, { force: true }); }
});
