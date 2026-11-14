import type { Ledger, Period, Expense, Budget, ChainConfig, Treasury, CallOptions } from "../src/ledger.js";
import type { Role } from "../src/credentials.js";
import type { TxResult } from "../src/near.js";
import { toYocto } from "../src/config.js";

/** Stateful contract Adapter for caller behavior; Rust tests verify actual accounting. */
export class TestLedger implements Ledger {
  contractId = "contract.testnet";
  accounts = Object.fromEntries(["owner", "oracle", "ceo", "alice", "bob", "customer", "vendor"].map(r => [r, `${r}.testnet`])) as Record<Role, string>;
  config: ChainConfig = { owner: "owner.testnet", oracle: "oracle.testnet", ceo: "ceo.testnet", paused: false, demo_mode: true, max_units_per_report: "5000000", constraints: { pass_price: toYocto("1").toString(), expense_reserve_bps: 1000, period_secs: "604800", max_expense_per_period: toYocto("0.5").toString() } };
  budget: Budget | null = { proposal_id: 0, option: "", max_expense_per_period: toYocto("0.5").toString() };
  period: Period = { id: 1, starts_at: "1000", ends_at: "0", status: "Open", revenue: toYocto("1").toString(), operating_costs: "0", expenses_approved: "0", expense_reserve_top_up: "0", expense_reserve_draw: "0", carried_in: "0", net_distributable: "0", distributed: "0", total_units_at_close: "100000", closed_at: "0", demo_close: false };
  expenses: Expense[] = [];
  passes = new Set<string>();
  calls: string[] = [];
  failPayment = false;
  async view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    const treasury: Treasury = { period_id: this.period.id, period_revenue: this.period.revenue, period_costs: this.period.operating_costs, expense_reserve: "0", distribution_reserve: "0", claimable_total: "0", distribution_carry: "0", account_balance: "0", refund_total: "0", pending_expense_payments: 0 };
    const values: Record<string, unknown> = { get_config: this.config, get_current_period: this.period, get_budget: this.budget, get_treasury: treasury,
      get_expenses: this.expenses.slice(Number(args.from_index ?? 0), Number(args.from_index ?? 0) + Number(args.limit ?? 50)), get_contributors: [{ account_id: this.accounts.alice, claimable: "0" }], get_proposals: [], get_periods: [], get_period: this.period, get_pass: null, get_expense: this.expenses.find(e => e.id === args.expense_id), has_pass: this.passes.has(String(args.account_id)) };
    if (!(method in values)) throw new Error(`unsupported fixture view ${method}`);
    return structuredClone(values[method]) as T;
  }
  async call<T = unknown>(role: Role, method: string, args: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<TxResult<T>> {
    this.calls.push(`${role}:${method}`); let value: unknown;
    if (method === "record_expense") {
      if (!this.budget) throw new Error("no active Board budget");
      const expense: Expense = { id: this.expenses.length, category: String(args.category), amount: String(args.amount), payee: String(args.payee), reference: String(args.reference), period: this.period.id, approver: this.accounts[role], status: "Approved", created_at: this.period.starts_at, paid_at: "0" };
      this.expenses.push(expense); this.period.expenses_approved = String(BigInt(this.period.expenses_approved) + BigInt(expense.amount)); value = expense.id;
    } else if (method === "pay_expense") {
      const expense = this.expenses.find(e => e.id === args.expense_id)!;
      if (!this.failPayment) { expense.status = "Paid"; this.period.operating_costs = String(BigInt(this.period.operating_costs) + BigInt(expense.amount)); }
    } else if (method === "close_distribution") {
      value = { period: { ...this.period, status: "Closed" }, allocations: [] };
      this.period = { ...this.period, id: this.period.id + 1, revenue: "0", operating_costs: "0", expenses_approved: "0" };
    } else if (method === "buy_pass") {
      this.passes.add(this.accounts[role]); this.period.revenue = String(BigInt(this.period.revenue) + (opts.depositYocto ?? 0n));
    } else throw new Error(`unsupported fixture change ${method}`);
    return { value: value as T, txHash: "fixture-hash", explorerUrl: "https://example.test/fixture" };
  }
}
