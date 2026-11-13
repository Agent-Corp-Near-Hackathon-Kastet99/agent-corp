import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StreamMeter, type MeterResult } from "./meter.js";

export type ClaudeRun = { text: string; meter: MeterResult; killed: boolean };
export const claudeArgv = (model: string) => ["-p", "--verbose", "--output-format", "stream-json", "--tools", "", "--strict-mcp-config", "--model", model];

export async function runClaude(
  prompt: string,
  model: string,
  onUsage: (meter: MeterResult) => Promise<boolean> | boolean,
  create = (cwd: string) => spawn("claude", claudeArgv(model), { cwd, stdio: ["pipe", "pipe", "pipe"] }),
): Promise<ClaudeRun> {
  const cwd = await mkdtemp(join(tmpdir(), "agent-corp-worker-"));
  try {
    const child = create(cwd);
    const meter = new StreamMeter(model);
    let output = "";
    let buffer = "";
    let killed = false;
    let processing = Promise.resolve();
    const consume = async (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const result = meter.add(event);
        if (typeof event.result === "string") output = event.result;
        if (typeof event.text === "string") output = event.text;
        if (!(await onUsage(result))) { killed = true; child.kill("SIGTERM"); }
      } catch { /* Claude stderr/noise is not protocol data. */ }
    };
    child.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
      for (const line of lines) processing = processing.then(() => consume(line));
    });
    child.stdin.end(prompt);
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });
    await processing;
    await consume(buffer);
    return { text: output, meter: meter.result(), killed };
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

export type SpawnFn = (cwd: string) => ChildProcessWithoutNullStreams;
