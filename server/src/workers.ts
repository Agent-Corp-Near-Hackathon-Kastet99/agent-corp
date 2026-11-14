import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { AcceptedModel, WorkerToServer } from "@agentcorp/shared";
import { DEFAULT_WORKER_POLICY, acceptOffers, settleReport, type WorkerPolicy } from "./providers.js";
import { Nep413Auth, type AccessKeyRpc } from "./auth.js";
import { RPC_URL } from "./near.js";
import type { Ledger } from "./ledger.js";
import type { Store, Task } from "./store.js";

type Dependencies = { retryIntervalMs?: number; rpc?: AccessKeyRpc; credit?: (worker: string, units: string, ref: string) => Promise<void>; policy?: WorkerPolicy };
const taskLimit = 100_000n;

/** Authenticated worker transport. Recorded reports use an idempotent contract reference. */
export function attachWorkers(server: Server, ledger: Ledger, store: Store, deps: Dependencies = {}): () => void {
  const rpc: AccessKeyRpc = deps.rpc ?? { async viewAccessKey(accountId, publicKey) {
    const response = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey } }) });
    const result = await response.json() as { result?: { permission: unknown } };
    return result.result;
  } };
  const credit = deps.credit ?? (async (worker, units, ref) => { await ledger.call("oracle", "record_contribution_once", { account_id: worker, units, reference: ref }); });
  const policy = deps.policy ?? DEFAULT_WORKER_POLICY;
  // Only a report the owner's credit policy accepted may reach the chain. Records written before
  // the policy existed carry `exact` alone.
  const creditable = (task: Task) => task.creditable ?? task.exact === true;
  const auth = new Nep413Auth(rpc);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 100_000 });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/api/worker") { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws));
  });
  const credits = new Map<string, Promise<void>>();
  function creditTask(task: Task): Promise<void> {
    if (!task.worker || !task.attemptId || !task.units || !creditable(task) || task.credited || BigInt(task.units) === 0n) return Promise.resolve();
    const ref = task.attemptId;
    const existing = credits.get(ref);
    if (existing) return existing;
    const pending = (async () => {
      try {
        await credit(task.worker!, task.units!, ref);
        const current = store.tasks().find(t => t.id === task.id && t.attemptId === ref);
        if (current && !current.credited) store.upsertTask({ ...current, credited: true });
        store.log({ ts: Date.now(), actor: "ORACLE", text: `Recorded ${task.units} contribution units for ${task.worker} (${ref})` });
      } catch (error) { store.log({ ts: Date.now(), actor: "ORACLE", text: `Contribution ${ref} pending: ${error instanceof Error ? error.message : String(error)}` }); }
    })().finally(() => credits.delete(ref));
    credits.set(ref, pending);
    return pending;
  }
  for (const task of store.tasks()) {
    if (task.status === "running") { task.status = "failed"; task.finishedAt = Date.now(); store.upsertTask(task); }
    if (task.status === "done" || task.status === "failed") void creditTask(task).catch(error => console.error("[workers] credit recovery failed", error));
  }
  wss.on("connection", ws => {
    let worker: string | undefined, active: Task | undefined, authenticating = false, deadline = Date.now() + 15_000;
    let accepted: AcceptedModel[] = [], target: AcceptedModel | undefined;
    ws.on("error", () => ws.terminate());
    let challenge: ReturnType<Nep413Auth["issue"]>;
    try { challenge = auth.issue(); ws.send(JSON.stringify({ t: "challenge", ...challenge })); }
    catch { ws.close(1013, "login capacity reached"); return; }
    const timer = setInterval(() => { if (Date.now() > deadline) ws.terminate(); }, 5_000);
    function assign() {
      if (!worker || active || ws.readyState !== WebSocket.OPEN) return;
      // Owner order decides; a worker that refused a provider model as unsupported is not offered it again.
      const choice = accepted[0];
      if (!choice) return;
      const task = store.tasks().find(t => t.status === "queued");
      if (!task) return;
      target = choice;
      active = { ...task, status: "running", worker, attemptId: randomUUID(), provider: choice.provider, model: choice.model };
      store.upsertTask(active);
      store.log({ ts: Date.now(), actor: "WORKER", text: `${worker} started ${task.title}` });
      ws.send(JSON.stringify({ t: "task", attemptId: active.attemptId, jobId: task.id, subtask: "copy", leaseGeneration: 1, maxUnits: taskLimit.toString(), prompt: task.prompt, pageText: "", model: choice.model, provider: choice.provider, price: choice.price }));
    }
    ws.on("message", raw => { void (async () => {
      let msg: WorkerToServer; try { msg = JSON.parse(raw.toString()) as WorkerToServer; } catch { ws.close(1008, "bad message"); return; }
      if (!worker) {
        if (msg.t !== "login" || authenticating || msg.nonce !== challenge.nonce) { ws.close(1008, "login required"); return; }
        authenticating = true;
        try {
          await auth.verify(msg); worker = msg.account; deadline = Date.now() + 45_000;
          accepted = acceptOffers(policy, msg.providers);
          ws.send(JSON.stringify({ t: "welcome", account: worker, session: randomUUID(), accepted })); assign();
        }
        catch { ws.close(1008, "login failed"); }
        return;
      }
      deadline = Date.now() + 45_000;
      if (msg.t === "heartbeat") { assign(); return; }
      if (!active || !("attemptId" in msg) || msg.attemptId !== active.attemptId) return;
      if (msg.t === "refused") {
        const task = { ...active }; task.status = "queued"; delete task.worker; delete task.attemptId; delete task.provider; delete task.model; active = task; store.upsertTask(task); active = undefined;
        if (msg.reason === "unsupported" && target) { const refused = target; accepted = accepted.filter(model => model !== refused); assign(); }
        return;
      }
      if (msg.t !== "result" && msg.t !== "failed") return;
      const settled = target && settleReport(policy, target, msg);
      if (msg.leaseGeneration !== 1 || !settled || (msg.t === "result" && (typeof msg.text !== "string" || msg.text.length > 50_000))
          || (msg.t === "failed" && (typeof msg.reason !== "string" || msg.reason.length > 50_000))) { ws.close(1008, "invalid report"); return; }
      const task = { ...active };
      task.status = msg.t === "result" ? "done" : "failed"; task.output = msg.t === "result" ? msg.text : msg.reason;
      task.units = settled.units; task.exact = settled.exact; task.basis = settled.basis; task.creditable = settled.creditable; task.usage = settled.usage; task.finishedAt = Date.now();
      active = task; // retain reported usage if durable completion fails
      store.upsertTask(task);
      active = undefined;
      store.log({ ts: Date.now(), actor: "WORKER", text: `${worker} ${task.status === "done" ? "completed" : "failed"} ${task.title}` });
      await creditTask(task); assign();
    })().catch(() => ws.close(1011, "worker error")); });
    ws.on("close", () => {
      clearInterval(timer);
      if (!active) return;
      const task = active;
      if (task.status === "running") {
        task.status = "failed";
        task.output = "Worker disconnected before reporting usage";
        task.finishedAt = Date.now();
      }
      try {
        store.upsertTask(task);
        void creditTask(task).catch(error => console.error("[workers] disconnected report credit failed", error));
      } catch (error) { console.error("[workers] failed to save disconnected task", error); }
    });
  });
  let retrying = false;
  let retryOffset = 0;
  const retry = setInterval(() => {
    if (retrying) return;
    retrying = true;
    void (async () => {
      const pending = store.tasks().filter(t => (t.status === "done" || t.status === "failed") && !t.credited && creditable(t) && t.units && BigInt(t.units) > 0n);
      const count = Math.min(20, pending.length);
      for (let i = 0; i < count; i++) await creditTask(pending[(retryOffset + i) % pending.length]!);
      retryOffset = pending.length ? (retryOffset + count) % pending.length : 0;
    })().catch(error => console.error("[workers] retry failed", error)).finally(() => { retrying = false; });
  }, deps.retryIntervalMs ?? 20_000);
  retry.unref();
  const stop = () => { clearInterval(retry); for (const socket of wss.clients) socket.terminate(); wss.close(); };
  server.once("close", stop);
  return stop;

}
