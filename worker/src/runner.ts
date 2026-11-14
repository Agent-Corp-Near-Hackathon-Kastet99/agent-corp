import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PRICE_TABLE, type Price } from "@agentcorp/shared";
import { UsageMeter, type MeterResult } from "./meter.js";
import { claude, claudeArgv } from "./providers/claude.js";
import type { Launch, ProviderAdapter } from "./providers/types.js";
import { sandboxProfile } from "./sandbox.js";

export { sandboxProfile } from "./sandbox.js";
export { claudeArgv };

export type ProviderRun = { text: string; meter: MeterResult; killed: boolean; error?: string };
export type ClaudeRun = ProviderRun;
/** Test seam: receives the private root and the adapter's launch, returns the child. */
export type SpawnFn = (cwd: string, launch?: Launch) => ChildProcessWithoutNullStreams;
export type RunOptions = { signal?: AbortSignal; timeoutMs?: number; price?: Price; executable?: string };

/** Every provider runs under the macOS seatbelt with the adapter's grants. Other platforms fail closed. */
function sandboxed(root: string, launch: Launch): ChildProcessWithoutNullStreams {
  if (process.platform !== "darwin") throw new Error("Worker sandbox is only configured for macOS; refusing to run unsandboxed");
  const env: NodeJS.ProcessEnv = {};
  for (const key of launch.passEnv) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, launch.env);
  return spawn("/usr/bin/sandbox-exec", ["-p", sandboxProfile(root, homedir(), launch.grants), launch.command, ...launch.args], { cwd: launch.cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
}

/** Owns child completion, stream metering and cancellation; never drops measured usage on failure. */
export async function runProvider(
  adapter: ProviderAdapter,
  prompt: string,
  model: string,
  onUsage: (meter: MeterResult) => Promise<boolean> | boolean,
  create?: SpawnFn,
  options: RunOptions = {},
): Promise<ProviderRun> {
  const name = adapter.displayName;
  const meter = new UsageMeter(options.price ?? PRICE_TABLE[model], adapter.costSource);
  let output = "", buffer = "", diagnostics = "", error: string | undefined;
  let killed = false, stopping = false, finished = false;
  let child: ChildProcessWithoutNullStreams | undefined;
  let force: NodeJS.Timeout | undefined, timeout: NodeJS.Timeout | undefined, linger: NodeJS.Timeout | undefined;
  let root: string | undefined, launch: Launch | undefined;
  let write = (_messages: unknown[]) => {};
  let cancel: (() => unknown[]) | undefined;
  const kill = (signal: NodeJS.Signals) => {
    if (!child) return;
    // Production children own a process group: helpers cannot survive cancellation.
    if (!create && child.pid) { try { process.kill(-child.pid, signal); } catch { /* already exited */ } }
    else child.kill(signal);
  };
  const stop = () => {
    killed = true;
    if (!child || stopping) return;
    stopping = true;
    try { if (cancel) write(cancel()); } catch { /* the kill below still applies */ }
    kill("SIGTERM");
    force = setTimeout(() => kill("SIGKILL"), 1000);
    force.unref();
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  try {
    if (options.signal?.aborted) return { text: "", meter: meter.result(), killed: true };
    root = await realpath(await mkdtemp(join(tmpdir(), "agent-corp-worker-")));
    if (create && create.length < 2) child = create(root);
    else {
      const executable = options.executable ?? (await adapter.health()).executable;
      if (!executable) throw new Error(`${name} is not installed`);
      launch = await adapter.launch({ model, root, home: homedir(), executable });
      if (launch.input === "argv") launch.args[launch.args.length - 1] = prompt;
      child = create ? create(root, launch) : sandboxed(root, launch);
    }
    const running = child, parser = adapter.parser({ model, cwd: launch?.cwd ?? root });
    cancel = parser.cancel?.bind(parser);
    write = messages => { for (const message of messages) if (running.stdin.writable) running.stdin.write(`${JSON.stringify(message)}\n`); };
    let processing = Promise.resolve();
    const consume = async (line: string) => {
      if (!line.trim()) return;
      let event: Record<string, unknown>;
      try { event = JSON.parse(line) as Record<string, unknown>; } catch { return; }
      if (!event || typeof event !== "object") return;
      try {
        const parsed = parser.event(event);
        const result = meter.add(parsed);
        if (parsed.text !== undefined) output = parsed.text;
        if (parsed.textDelta !== undefined) output += parsed.textDelta;
        if (output.length > 2_000_000) { error = `${name} output too large`; stop(); return; }
        if (parsed.error) error ??= parsed.error;
        if (parsed.send && !stopping) write(parsed.send);
        if (parsed.done && !finished) {
          // The exchange is complete: close stdin and give the agent a moment to exit by itself.
          finished = true; running.stdin.end();
          linger = setTimeout(() => {
            kill("SIGTERM");
            force = setTimeout(() => kill("SIGKILL"), 1000);
            force.unref();
          }, 2000); linger.unref();
        }
        if (!(await onUsage(result))) stop();
      } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); stop(); }
    };
    // Provider diagnostics stay in this machine's log; they are never sent to the server.
    running.stderr.setEncoding("utf8");
    running.stderr.on("data", (data: string) => { diagnostics = (diagnostics + data).slice(-2000); });
    running.stdout.setEncoding("utf8");
    running.stdout.on("data", (data: string) => {
      running.stdout.pause();
      buffer += data;
      if (buffer.length > 2_000_000) { error = `${name} stream record too large`; buffer = ""; stop(); return; }
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
      processing = processing.then(async () => { for (const line of lines) await consume(line); }).finally(() => running.stdout.resume());
    });
    const done = new Promise<void>(resolve => {
      running.once("error", cause => { error = cause.message; });
      running.stdin.on("error", cause => { if ((cause as NodeJS.ErrnoException).code !== "EPIPE") { error = cause.message; stop(); } });
      running.once("close", (code, signal) => {
        if (!killed && !finished && (code !== 0 || signal)) error ??= `${name} exited with ${signal ?? code}`;
        resolve();
      });
    });
    timeout = setTimeout(() => { error = `${name} timed out`; stop(); }, options.timeoutMs ?? 300_000);
    if (parser.start) write(parser.start(prompt));
    else if (launch?.input === "argv") running.stdin.end();
    else running.stdin.end(prompt);
    if (options.signal?.aborted) stop();
    await done;
    await processing;
    await consume(buffer);
    if (!killed && !error && !meter.settled) error = `${name} exited without a final usage result`;
    if (error && diagnostics.trim()) console.error(`[worker] ${name}: ${error}\n${diagnostics.trim()}`);
    return { text: output, meter: meter.result(), killed, ...(error ? { error } : {}) };
  } catch (cause) {
    return { text: output, meter: meter.result(), killed, error: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    options.signal?.removeEventListener("abort", stop);
    for (const timer of [timeout, force, linger]) if (timer) clearTimeout(timer);
    // Credential write-back must happen before the private root disappears, on every exit path.
    try { await launch?.settle?.(); } catch (cause) { console.error(`[worker] ${name} credential write-back failed: ${cause instanceof Error ? cause.message : cause}`); }
    if (root) await rm(root, { recursive: true, force: true });
  }
}

export function runClaude(prompt: string, model: string, onUsage: (meter: MeterResult) => Promise<boolean> | boolean, create?: SpawnFn, options: RunOptions = {}): Promise<ProviderRun> {
  return runProvider(claude, prompt, model, onUsage, create, options);
}
