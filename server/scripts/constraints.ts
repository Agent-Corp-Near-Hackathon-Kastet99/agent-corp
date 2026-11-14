/**
 * Owner applies config.yaml on-chain: constraints and the kill switch.
 * Signed with the owner's key; the contract rejects these calls from any agent.
 *
 *   pnpm constraints
 */
import { account, call, view } from "../src/near.js";
import { loadKeys } from "../src/credentials.js";
import { constraintsFromConfig, fmt, loadConfig } from "../src/config.js";
import type { ChainConfig } from "../src/ledger.js";

async function main() {
  const keys = loadKeys();
  const config = loadConfig();
  const wanted = constraintsFromConfig(config);
  const owner = account(keys, "owner");
  const before = await view<ChainConfig>(keys.contractId, "get_config");

  if (JSON.stringify(before.constraints) !== JSON.stringify(wanted)) {
    const tx = await call(owner, keys.contractId, "set_constraints", { constraints: wanted });
    console.log(`• set_constraints  ${tx.explorerUrl}`);
  } else console.log("• constraints already match config.yaml");

  if (before.paused !== config.kill_switch) {
    const tx = await call(owner, keys.contractId, "set_paused", { paused: config.kill_switch });
    console.log(`• set_paused(${config.kill_switch})  ${tx.explorerUrl}`);
  } else console.log(`• kill switch already ${config.kill_switch ? "ON" : "off"}`);

  const now = await view<ChainConfig>(keys.contractId, "get_config");
  console.log(`\nOn-chain now (${keys.contractId}):
  paused (kill switch):     ${now.paused}
  pass price:               ${fmt(now.constraints.pass_price)} NEAR
  expense reserve:          ${now.constraints.expense_reserve_bps / 100}% of period revenue
  period length:            ${Number(now.constraints.period_secs) / 86400} days
  expense cap per period:   ${fmt(now.constraints.max_expense_per_period)} NEAR`);
}

main().catch(error => { console.error(`constraints failed: ${error instanceof Error ? error.message : error}`); process.exit(1); });
