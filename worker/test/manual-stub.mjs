// Tiny manual protocol harness: `node worker/test/manual-stub.mjs <account>`.
import http from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const account = process.argv[2];
if (!account) throw new Error("account argument required");
const frame = value => {
  const body = Buffer.from(JSON.stringify(value));
  const header = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
  return Buffer.concat([header, body]);
};
const server = http.createServer();
server.on("upgrade", (req, socket) => {
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")}\r\n\r\n`);
  socket.write(frame({ t: "challenge", nonce: "manual-stub", recipient: "agentcorp" }));
  socket.on("data", data => {
    let size = data[1] & 127, offset = 2;
    if (size === 126) { size = data.readUInt16BE(offset); offset += 2; }
    else if (size === 127) { throw new Error("stub frame too large"); }
    const key = data.subarray(offset, offset + 4), payload = data.subarray(offset + 4, offset + 4 + size);
    for (let i = 0; i < payload.length; i++) payload[i] ^= key[i % 4];
    const message = JSON.parse(payload.toString());
    if (message.t === "login") socket.write(frame({ t: "task", attemptId: "attempt-1", jobId: "job-1", subtask: "copy", leaseGeneration: 1, maxUnits: "5000", prompt: "Review", pageText: "Example landing page", model: "sonnet" }));
    if (message.t === "result") { console.log(JSON.stringify(message)); socket.end(); server.close(); }
  });
});
const bin = await mkdtemp(join(tmpdir(), "agent-corp-stub-bin-"));
const claude = join(bin, "claude");
await writeFile(claude, "#!/bin/sh\nprintf '%s\\n' '{\"type\":\"result\",\"total_cost_usd\":0.001234,\"result\":\"stub teardown\"}'\n"); await chmod(claude, 0o755);
await new Promise(resolve => server.listen(18787, "127.0.0.1", resolve));
const child = spawn("pnpm", ["--filter", "@agentcorp/worker", "exec", "tsx", "src/cli.ts", "--server", "ws://127.0.0.1:18787/api/worker", "--account", account], { cwd: process.cwd(), env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, AGENT_CORP_HOME: await mkdtemp(join(tmpdir(), "agent-corp-stub-cap-")) }, stdio: "inherit" });
child.once("exit", code => process.exitCode = code ?? 1);
