/**
 * The two on-chain agents. Both are deterministic policy agents: they read chain state and
 * config.yaml, then act with a function-call key that can only call their own contract methods.
 *
 * - CEO agent: procurement. Approves the standing costs listed in config.yaml, inside the
 *   owner's per-period cap. Cannot move funds.
 * - Accounting oracle: records contribution units, pays approved expenses, closes periods.
 *   Cannot approve expenses or change constraints.
 */
import { reason, type TxResult } from "./near.js";
import type { Ledger, Period, Expense, Treasury, ChainConfig, PeriodReceipt, Log, Actor, Budget } from "./ledger.js";
import { fmt, toYocto, type OwnerConfig } from "./config.js";

const note = (log: Log, actor: Actor, text: string, tx?: TxResult<unknown>) =>
  log({ ts: Date.now(), actor, text, txHash: tx?.txHash, explorerUrl: tx?.explorerUrl });

async function allExpenses(chain: Ledger): Promise<Expense[]> {
  const out: Expense[] = [];
  for (let from = 0; ; from += 100) {
    const page = await chain.view<Expense[]>("get_expenses", { from_index: from, limit: 100 });
    out.push(...page);
    if (page.length < 100) return out;
  }
}

/** Owns procurement and accounting policy; chain Adapter owns signing and nonce order. */
export class CompanyAgents {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly chain: Ledger, private readonly log: Log) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.pending.then(work);
    this.pending = next.catch(() => undefined);
    return next;
  }
  ceoTick(config: OwnerConfig) { return this.serial(() => this.approveExpenses(config)); }
  oraclePayExpenses() { return this.serial(() => this.payExpenses()); }
  oracleRecordUnits(accountId: string, units: bigint, reference: string) { return this.serial(() => this.recordUnits(accountId, units, reference)); }
  oracleClose(opts: { demo?: boolean } = {}) { return this.serial(() => this.close(opts)); }
  tick(config: OwnerConfig) { return this.serial(async () => { await this.approveExpenses(config); await this.payExpenses(); await this.close(); }); }

/** CEO agent: approve each configured standing cost once per period, after revenue exists. */
private async approveExpenses(config: OwnerConfig): Promise<number> {
  const chain = this.chain;
  const log = this.log;
  const configOnChain = await chain.view<ChainConfig>("get_config");
  if (configOnChain.paused) return 0;
  const period = await chain.view<Period>("get_current_period");
  if (BigInt(period.revenue) === 0n) return 0;
  const expenses = await allExpenses(chain);
  const budget = await this.chain.view<Budget | null>("get_budget");
  if (!budget) { note(log, "CEO", "No active Board budget; expense approvals skipped"); return 0; }
  const ownerCap = BigInt(configOnChain.constraints.max_expense_per_period);
  const boardCap = BigInt(budget.max_expense_per_period);
  const cap = ownerCap < boardCap ? ownerCap : boardCap;
  let approved = BigInt(period.expenses_approved);
  let count = 0;
  for (const vendor of config.vendors) {
    const amount = toYocto(vendor.amount_near);
    const payee = chain.accounts[vendor.payee as keyof typeof chain.accounts] ?? vendor.payee;
    const done = expenses.some(e => e.category === vendor.category && e.payee === payee && e.reference === vendor.reference
      && (e.status === "Approved" || e.status === "Paying" || e.period === period.id));
    if (done) continue;
    if (approved + amount > cap) {
      note(log, "CEO", `Skipped ${vendor.category} ${fmt(amount)} NEAR: over the effective Board/owner per-period cap`);
      continue;
    }
    const tx = await chain.call<number>("ceo", "record_expense", {
      category: vendor.category, amount: amount.toString(), payee, reference: vendor.reference,
    });
    approved += amount;
    count++;
    note(log, "CEO", `Approved ${vendor.category} cost ${fmt(amount)} NEAR → ${payee} (expense #${tx.value})`, tx);
  }
  return count;
}

/** Oracle: pay approved expenses that operating funds can cover. */
private async payExpenses(): Promise<number> {
  const chain = this.chain;
  const log = this.log;
  if ((await chain.view<ChainConfig>("get_config")).paused) return 0;
  let count = 0;
  for (const expense of (await allExpenses(chain)).filter(e => e.status === "Approved")) {
    const t = await chain.view<Treasury>("get_treasury");
    if (BigInt(t.period_costs) + BigInt(expense.amount) > BigInt(t.period_revenue) + BigInt(t.expense_reserve)) continue;
    try {
      const tx = await chain.call("oracle", "pay_expense", { expense_id: expense.id });
      const after = await chain.view<Expense>("get_expense", { expense_id: expense.id });
      note(log, "ORACLE", after.status === "Paid"
        ? `Paid ${expense.category} cost ${fmt(expense.amount)} NEAR → ${expense.payee} (expense #${expense.id})`
        : `Payment of expense #${expense.id} failed; it stays approved and unpaid`, tx);
      if (after.status === "Paid") count++;
    } catch (error) { note(log, "ORACLE", `Could not pay expense #${expense.id}: ${reason(error)}`); }
  }
  return count;
}

private async recordUnits(accountId: string, units: bigint, reference: string) {
  const chain = this.chain;
  const log = this.log;
  const tx = await chain.call("oracle", "record_contribution", {
    account_id: accountId, units: units.toString(), reference: reference.slice(0, 200),
  });
  note(log, "ORACLE", `Recorded ${units.toLocaleString("en-US")} contribution units for ${accountId} (${reference})`, tx);
  return tx;
}

/**
 * Oracle: close the open period. Without `demo`, it only closes a period that has ended.
 * With `demo`, it closes early; the contract allows that in demo mode only and flags the receipt.
 */
private async close(opts: { demo?: boolean } = {}): Promise<TxResult<PeriodReceipt> | undefined> {
  const chain = this.chain;
  const log = this.log;
  const configOnChain = await chain.view<ChainConfig>("get_config");
  if (configOnChain.paused) return undefined;
  const period = await chain.view<Period>("get_current_period");
  const ended = BigInt(Date.now()) * 1_000_000n >= BigInt(period.ends_at);
  if (!ended && !(opts.demo && configOnChain.demo_mode)) return undefined;
  const tx = await chain.call<PeriodReceipt>("oracle", "close_distribution", { period_id: period.id }, { tgas: 100 });
  const p = tx.value.period;
  note(log, "ORACLE", `Closed period ${p.id}${p.demo_close ? " (DEMO early close)" : ""}: revenue ${fmt(p.revenue)} − costs ${fmt(p.operating_costs)} − expense reserve ${fmt(p.expense_reserve_top_up)} = ${fmt(p.net_distributable)} NEAR distributed across ${tx.value.allocations.length} contributors`, tx);
  return tx;
}

}
