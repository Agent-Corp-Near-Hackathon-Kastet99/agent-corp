import { attachWorkers } from "./workers.js";
/** Executable bootstrap. Import app.ts for the testable HTTP Interface. */
import { createApplication } from "./app.js";
import { CompanyAgents } from "./agents.js";
import { createLedger, reason } from "./near.js";
import { keysExist, loadKeys } from "./credentials.js";
import { loadConfig } from "./config.js";
import { workerPolicy } from "./providers.js";
import { Store } from "./store.js";
import { createGrowthRuntime } from "./growth/runtime.js";

const store = new Store();
const ledger = keysExist() ? createLedger(loadKeys()) : undefined;
const agents = ledger ? new CompanyAgents(ledger, store.log) : undefined;
const growth = process.env.GROWTH === "off" ? undefined : createGrowthRuntime({ log: store.log, ledger });
const server = createApplication({ store, ledger, agents, growth, demoActions: process.env.DEMO_ACTIONS === "on" });
const stopWorkers = ledger ? attachWorkers(server, ledger, store, { policy: workerPolicy(loadConfig().worker_policy) }) : undefined;
const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid PORT");
server.listen(port, process.env.HOST ?? "127.0.0.1", () => {
  console.log(`Agent Corp listening on ${JSON.stringify(server.address())}`);
  if (growth) console.log(`Mission Control (${growth.engine.d.dryRun ? "DRY-RUN" : "LIVE"}): http://127.0.0.1:${port}/growth#token=${growth.adminToken}`);
});
let timer: NodeJS.Timeout | undefined;
if (ledger && process.env.AGENTS !== "off") {
  const every = Number(process.env.AGENT_INTERVAL_SECS ?? 20) * 1000;
  if (!Number.isFinite(every) || every < 1000) throw new Error("Invalid AGENT_INTERVAL_SECS");
  let ticking = false;
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void Promise.resolve().then(() => agents!.tick(loadConfig())).catch(error => console.error(`[agents] ${reason(error)}`)).finally(() => { ticking = false; });
  }, every);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  if (timer) clearInterval(timer);
  stopWorkers?.();
  server.close();
  void growth?.stop().catch(error => { console.error("[growth] shutdown failed", error); process.exitCode = 1; });
});
