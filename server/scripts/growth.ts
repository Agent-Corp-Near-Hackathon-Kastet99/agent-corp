/**
 * Standalone growth server: Mission Control + /api/growth/* with NO chain keys and NO testnet access.
 * Dry-run unless .env.growth sets GROWTH_DRY_RUN=off.   pnpm growth
 */
import { createApplication } from "../src/app.js";
import { Store } from "../src/store.js";
import { createGrowthRuntime } from "../src/growth/runtime.js";
import { createLedger } from "../src/near.js";
import { keysExist, loadKeys } from "../src/credentials.js";

const store = new Store();
// With testnet keys present the Board is real (reads the contract; chain WRITES stay off in dry-run unless GROWTH_BOARD_WRITES=on).
// GROWTH_CHAIN=off forces a no-chain run, where Board governance is fail-closed to the bootstrap allowance.
const ledger = process.env.GROWTH_CHAIN !== "off" && keysExist() ? createLedger(loadKeys()) : undefined;
const growth = createGrowthRuntime({ log: store.log, ledger });
const server = createApplication({ store, growth });
const port = Number(process.env.PORT ?? 8788);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid PORT");
server.listen(port, process.env.HOST ?? "127.0.0.1", () => {
  const mode = growth.engine.d.dryRun ? "DRY-RUN (nothing leaves this machine)" : "LIVE";
  console.log(`Growth harness ${mode}; chain: ${ledger ? ledger.contractId : "none"}`);
  console.log(`Growth harness API on http://127.0.0.1:${port}/api/growth/ (admin token ${growth.adminToken})`);
});
for (const s of ["SIGINT", "SIGTERM"] as const) process.once(s, () => {
  server.close();
  void growth.stop().catch(error => { console.error("[growth] shutdown failed", error); process.exitCode = 1; });
});
