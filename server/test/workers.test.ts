import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyPair } from "near-api-js";
import { loginPayload } from "@agentcorp/shared";
import { WebSocket } from "ws";
import { expect, it, vi } from "vitest";
import { attachWorkers } from "../src/workers.js";
import { Store } from "../src/store.js";
import { TestLedger } from "./ledger-fixture.js";

it.each([false, true])("authenticates worker and retains exact usage despite transient report-write failure=%s", async (failSave) => {
  const dir = await mkdtemp(join(tmpdir(), "agentcorp-worker-test-"));
  const store = new Store(join(dir, "state.json"));
  store.upsertTask({ id: "qa", kind: "qa", title: "QA", prompt: "Review", status: "queued" });
  const persist = store.upsertTask.bind(store);
  let failedWrite = false;
  vi.spyOn(store, "upsertTask").mockImplementation(task => {
    if (failSave && !failedWrite && task.status === "done") { failedWrite = true; throw new Error("transient disk failure"); }
    persist(task);
  });
  const credits: string[] = []; const server = createServer();
  attachWorkers(server, new TestLedger(), store, { rpc: { viewAccessKey: async () => ({ permission: "FullAccess" }) }, credit: async (_who, _units, ref) => { credits.push(ref); } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address(); if (!addr || typeof addr === "string") throw new Error("no port");
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/api/worker`); const key = KeyPair.fromRandom("ed25519");
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 5000);
      ws.on("error", reject);
      ws.on("message", raw => {
        const m = JSON.parse(raw.toString());
        if (m.t === "challenge") ws.send(JSON.stringify({ t: "login", account: "alice.testnet", publicKey: key.getPublicKey().toString(), nonce: m.nonce, signature: Buffer.from(key.sign(loginPayload({ account: "alice.testnet", nonce: m.nonce })).signature).toString("base64") }));
        if (m.t === "task") {
          const report = JSON.stringify({ t: "result", attemptId: m.attemptId, leaseGeneration: 1, text: "QA complete", units: "123", exact: true });
          ws.send(report); if (!failSave) ws.send(report);
          setTimeout(() => { clearTimeout(timer); resolve(); }, 100);
        }
      });
    });
    expect(store.tasks()[0]).toMatchObject({ status: "done", worker: "alice.testnet", units: "123", credited: true });
    expect(credits).toHaveLength(1);
    expect(failedWrite).toBe(failSave);
  } finally {
    ws.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it("retries exact uncredited reports without restarting server", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentcorp-credit-retry-"));
  const store = new Store(join(dir, "state.json"));
  store.upsertTask({ id: "qa", kind: "qa", title: "QA", prompt: "Review", status: "done", worker: "alice.testnet", attemptId: "attempt-persisted", units: "123", exact: true });
  let attempts = 0; const references: string[] = []; const server = createServer();
  const stop = attachWorkers(server, new TestLedger(), store, { retryIntervalMs: 10, credit: async (_who, _units, ref) => { references.push(ref); if (++attempts === 1) throw new Error("RPC unavailable"); } });
  try {
    await expect.poll(() => store.tasks()[0]?.credited, { timeout: 2000 }).toBe(true);
    expect(references).toEqual(["attempt-persisted", "attempt-persisted"]);
  } finally { stop(); await rm(dir, { recursive: true, force: true }); }
});

it("coalesces recovery and retry credits without overwriting newer task data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentcorp-credit-inflight-"));
  const store = new Store(join(dir, "state.json"));
  store.upsertTask({ id: "qa", kind: "qa", title: "QA", prompt: "Review", status: "done", worker: "alice.testnet", attemptId: "attempt", units: "123", exact: true });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const stop = attachWorkers(createServer(), new TestLedger(), store, { retryIntervalMs: 10, credit: async () => { calls++; await pending; } });
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(calls).toBe(1);
    store.upsertTask({ ...store.tasks()[0]!, output: "new output" });
    release();
    await expect.poll(() => store.tasks()[0]?.credited).toBe(true);
    expect(store.tasks()[0]?.output).toBe("new output");
  } finally { release(); stop(); await rm(dir, { recursive: true, force: true }); }
});

it("survives invalid UTF-8 frames and disposes upgraded clients", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentcorp-ws-errors-"));
  const server = createServer(); const stop = attachWorkers(server, new TestLedger(), new Store(join(dir, "state.json")));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const first = new WebSocket(`ws://127.0.0.1:${port}/api/worker`);
  try {
    await new Promise<void>((resolve, reject) => { first.once("open", () => resolve()); first.once("error", reject); });
    const closed = new Promise<void>(resolve => first.once("close", () => resolve()));
    first.send(Buffer.from([0xff]), { binary: false }); await closed;
    const second = new WebSocket(`ws://127.0.0.1:${port}/api/worker`);
    await new Promise<void>((resolve, reject) => { second.once("message", () => resolve()); second.once("error", reject); });
    const stopped = new Promise<void>(resolve => second.once("close", () => resolve()));
    stop(); await stopped;
  } finally { first.terminate(); stop(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

it("rejects malformed result fields without losing active task or crediting units", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentcorp-invalid-report-"));
  const store = new Store(join(dir, "state.json"));
  store.upsertTask({ id: "qa", kind: "qa", title: "QA", prompt: "Review", status: "queued" });
  const credits: string[] = []; const server = createServer();
  const stop = attachWorkers(server, new TestLedger(), store, { rpc: { viewAccessKey: async () => ({ permission: "FullAccess" }) }, credit: async (_who, _units, ref) => { credits.push(ref); } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/worker`); const key = KeyPair.fromRandom("ed25519");
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 5000);
      ws.once("error", reject); ws.once("close", () => { clearTimeout(timer); resolve(); });
      ws.on("message", raw => {
        const m = JSON.parse(raw.toString());
        if (m.t === "challenge") ws.send(JSON.stringify({ t: "login", account: "alice.testnet", publicKey: key.getPublicKey().toString(), nonce: m.nonce, signature: Buffer.from(key.sign(loginPayload({ account: "alice.testnet", nonce: m.nonce })).signature).toString("base64") }));
        if (m.t === "task") ws.send(JSON.stringify({ t: "result", attemptId: m.attemptId, leaseGeneration: 1, text: "QA complete", units: 123, exact: true }));
      });
    });
    expect(credits).toEqual([]);
    await expect.poll(() => store.tasks()[0]).toMatchObject({ status: "failed", output: "Worker disconnected before reporting usage" });
  } finally { ws.terminate(); stop(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

it("zero-usage and persistently failing reports do not starve later contribution credits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentcorp-credit-batch-"));
  const store = new Store(join(dir, "state.json"));
  const task = (id: string, units: string) => ({ id, kind: "qa" as const, title: "QA", prompt: "Review", status: "done" as const, worker: "alice.testnet", attemptId: id, units, exact: true });
  for (let i = 0; i < 20; i++) store.upsertTask(task(`zero-${i}`, "0"));
  const server = createServer();
  for (let i = 0; i < 20; i++) store.upsertTask(task(`blocked-${i}`, "123"));
  const stop = attachWorkers(server, new TestLedger(), store, { retryIntervalMs: 10, credit: async (_who, _units, ref) => {
    if (ref.startsWith("blocked-")) throw new Error("persistent RPC rejection");
  } });
  try {
    // Add after startup recovery: this record must be reached by the retry batch.
    store.upsertTask(task("paid-usage", "123"));
    await expect.poll(() => store.tasks().find(t => t.id === "paid-usage")?.credited, { timeout: 2000 }).toBe(true);
  } finally { stop(); await rm(dir, { recursive: true, force: true }); }
});
