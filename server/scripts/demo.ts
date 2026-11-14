/**
 * Demo mode: one full business loop on NEAR testnet, from sale to payout.
 *
 *   pnpm demo
 *
 * contribution units → pass sale → operating cost → period close → both withdrawals.
 * Every step is a real testnet transaction; every check below is read back from the contract.
 * Exits non-zero if any check fails.
 */
import { NEAR } from "near-api-js/tokens";
import { account, call, reason, view, EXPLORER, createLedger } from "../src/near.js";
import { loadKeys, type KeyFile, type Role } from "../src/credentials.js";
import { fmt, loadConfig, toYocto } from "../src/config.js";
import { CompanyAgents } from "../src/agents.js";
import type { Activity, ChainConfig, Expense, Treasury, Budget } from "../src/ledger.js";

const started = Date.now();
let step = 0;
let failed = 0;
const head = (title: string) => console.log(`\n[${++step}] ${title}`);
const log = (a: Activity) => console.log(`    ${a.actor.padEnd(8)} ${a.text}${a.explorerUrl ? `\n             ${a.explorerUrl}` : ""}`);
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`    ${ok ? "✓" : "✗ FAILED"} ${label}${detail ? ` — ${detail}` : ""}`);
}

const claimable = async (keys: KeyFile, role: Role) => BigInt(await view<string>(keys.contractId, "get_claimable", { account_id: keys.accounts[role].accountId }));
const balance = (keys: KeyFile, role: Role) => account(keys, role, { fullAccess: true }).getBalance();

/** Demo wallets send spare testnet NEAR back to the demo customer so the loop can be re-run. */
async function recycle(keys: KeyFile, price: bigint) {
  const need = price + toYocto("0.2");
  if (await balance(keys, "customer") >= need) return;
  for (const role of ["alice", "bob", "vendor"] as Role[]) {
    const spare = await balance(keys, role) - toYocto("0.15");
    if (spare > toYocto("0.05")) {
      await account(keys, role, { fullAccess: true }).transfer({ receiverId: keys.accounts.customer.accountId, amount: spare, token: NEAR });
      console.log(`    DEMO     ${role} returned ${fmt(spare)} NEAR of earlier demo funds to the demo customer`);
    }
  }
  if (await balance(keys, "customer") < need) throw new Error(`Demo customer has under ${fmt(need)} testnet NEAR. Fund ${keys.accounts.customer.accountId} or run: pnpm setup:testnet --force`);
}

async function main() {
  const keys = loadKeys();
  const config = loadConfig();
  const ledger = createLedger(keys);
  const agents = new CompanyAgents(ledger, log);
  const id = keys.contractId;
  const chain = await view<ChainConfig>(id, "get_config");
  const price = BigInt(chain.constraints.pass_price);
  console.log(`AGENT CORP — DEMO LOOP (TESTNET)\ncontract ${id}\nledger   ${EXPLORER}/address/${id}`);
  if (chain.paused) throw new Error("Kill switch is ON (contract paused). Set kill_switch: false in config.yaml and run: pnpm constraints");
  if (!chain.demo_mode) throw new Error("Contract is not in demo mode; early close is not allowed.");

  head("Contributors donate AI usage → oracle records contribution units (no payout)");
  await recycle(keys, price);
  await agents.oracleRecordUnits(keys.accounts.alice.accountId, 60_000n, "DEMO seeded session: House 01 build");
  await agents.oracleRecordUnits(keys.accounts.bob.accountId, 40_000n, "DEMO seeded session: marketing + QA");
  const aliceBefore = await claimable(keys, "alice");
  const bobBefore = await claimable(keys, "bob");

  head("Customer buys RAM HEIST Pass → company revenue");
  const buy = await call(account(keys, "customer"), id, "buy_pass", {}, { depositYocto: price });
  log({ ts: Date.now(), actor: "CUSTOMER", text: `${keys.accounts.customer.accountId} paid ${fmt(price)} NEAR for RAM HEIST Pass`, ...buy });
  check("pass is active for the customer", await view<boolean>(id, "has_pass", { account_id: keys.accounts.customer.accountId }));
  check("sale did not change any contributor balance", await claimable(keys, "alice") === aliceBefore && await claimable(keys, "bob") === bobBefore);

  head("Board approves aggregate budget; CEO approves cost; oracle pays treasury expense");
  if (!await ledger.view<Budget | null>("get_budget")) {
    const proposal = await ledger.call<number>("ceo", "create_proposal", {
      kind: "Budget", title: "DEMO operating budget",
      options: [JSON.stringify({ max_expense_per_period: chain.constraints.max_expense_per_period }), JSON.stringify({ max_expense_per_period: "0" })],
      voting_period_secs: "60",
    });
    for (const role of ["alice", "bob"] as const) await ledger.call(role, "vote", { proposal_id: proposal.value, option: 0 });
    await ledger.call("customer", "finalize", { proposal_id: proposal.value });
  }
  await agents.ceoTick(config);
  await agents.oraclePayExpenses();
  const paid = (await view<Expense[]>(id, "get_expenses", { from_index: 0, limit: 100 })).filter(e => e.status === "Paid");
  check("at least one expense is paid on-chain", paid.length > 0);
  check("paying a cost did not change any contributor balance", await claimable(keys, "alice") === aliceBefore && await claimable(keys, "bob") === bobBefore);

  head("Oracle closes the period (DEMO early close) → net profit allocated by units");
  const close = await agents.oracleClose({ demo: true });
  if (!close) throw new Error("Period was not closed.");
  const p = close.value.period;
  const net = BigInt(p.net_distributable);
  const total = BigInt(p.total_units_at_close);
  const expectedNet = BigInt(p.revenue) - BigInt(p.operating_costs) - BigInt(p.expense_reserve_top_up) + BigInt(p.carried_in);
  check("net = revenue − costs − expense reserve (+ carried remainder)", net === expectedNet,
    `${fmt(p.revenue)} − ${fmt(p.operating_costs)} − ${fmt(p.expense_reserve_top_up)} = ${fmt(net)} NEAR`);
  const aliceGain = await claimable(keys, "alice") - aliceBefore;
  const bobGain = await claimable(keys, "bob") - bobBefore;
  const share = (role: Role) => BigInt(close.value.allocations.find(a => a.account_id === keys.accounts[role].accountId)?.units ?? "0");
  check("Alice credited net × her units ÷ total units", aliceGain === net * share("alice") / total, `+${fmt(aliceGain)} NEAR (${Number(share("alice") * 10000n / total) / 100}%)`);
  check("Bob credited net × his units ÷ total units", bobGain === net * share("bob") / total, `+${fmt(bobGain)} NEAR (${Number(share("bob") * 10000n / total) / 100}%)`);
  if (BigInt(p.revenue) === price && BigInt(p.carried_in) === 0n && close.value.allocations.length === 2
      && total > 0n && share("alice") * 5n === total * 3n && share("bob") * 5n === total * 2n) {
    check("canonical demo numbers: 1.00 − 0.10 − 0.10 = 0.80 → 0.48 / 0.32", fmt(net) === "0.80" && fmt(aliceGain) === "0.48" && fmt(bobGain) === "0.32");
  }
  try {
    await call(account(keys, "oracle"), id, "close_distribution", { period_id: p.id });
    check("closing the same period twice is rejected", false);
  } catch (error) { check("closing the same period twice is rejected", /already closed/.test(reason(error)), reason(error)); }

  head("Contributors withdraw their closed-period distribution");
  for (const role of ["alice", "bob"] as Role[]) {
    const due = await claimable(keys, role);
    const before = await balance(keys, role);
    const tx = await call<string>(account(keys, role), id, "withdraw_distribution");
    log({ ts: Date.now(), actor: "WORKER", text: `${keys.accounts[role].accountId} withdrew ${fmt(tx.value)} NEAR`, ...tx });
    const gained = await balance(keys, role) - before;
    check(`${role}'s wallet balance rose by the withdrawn amount (minus testnet gas)`, BigInt(tx.value) === due && gained > due - toYocto("0.05") && gained <= due, `+${fmt(gained, 4)} NEAR`);
    check(`${role}'s claimable balance is now zero`, await claimable(keys, role) === 0n);
  }

  const t = await view<Treasury>(id, "get_treasury");
  console.log(`\nTreasury now: expense reserve ${fmt(t.expense_reserve)} NEAR · distribution reserve ${fmt(t.distribution_reserve)} NEAR · open period ${t.period_id}`);
  console.log(`Receipt:      near view ${id} get_period_receipt '{"period_id":${p.id}}'   (or the ledger page: pnpm start → http://localhost:8787/)`);
  console.log(`\n${failed ? `DEMO FAILED: ${failed} check(s) failed` : "DEMO PASSED: all checks green"} in ${((Date.now() - started) / 1000).toFixed(0)}s — all values are TESTNET / DEMO.`);
  process.exit(failed ? 1 : 0);
}

main().catch(error => { console.error(`\nDemo failed: ${reason(error)}`); process.exit(1); });
