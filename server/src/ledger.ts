import type { TxResult } from "./near.js";

export type Period = {
  id: number; starts_at: string; ends_at: string; status: "Open" | "Closed";
  revenue: string; operating_costs: string; expenses_approved: string;
  expense_reserve_top_up: string; expense_reserve_draw: string; carried_in: string;
  net_distributable: string; distributed: string; total_units_at_close: string; closed_at: string; demo_close: boolean;
};
export type Expense = {
  id: number; category: string; amount: string; period: number; reference: string; payee: string;
  approver: string; status: "Approved" | "Paying" | "Paid"; created_at: string; paid_at: string;
};
export type Allocation = { account_id: string; units: string; amount: string };
export type PeriodReceipt = { period: Period; allocations: Allocation[] };
export type Treasury = {
  period_id: number; period_revenue: string; period_costs: string; expense_reserve: string;
  distribution_reserve: string; claimable_total: string; distribution_carry: string; account_balance: string; refund_total: string; pending_expense_payments: number;
};
export type ChainConfig = {
  owner: string; oracle: string; ceo: string; paused: boolean; demo_mode: boolean; max_units_per_report: string;
  constraints: { pass_price: string; expense_reserve_bps: number; period_secs: string; max_expense_per_period: string };
};
export type Actor = "CEO" | "ORACLE" | "WORKER" | "CONTRACT" | "CUSTOMER" | "OWNER" | "MARKETING" | "BIZDEV";
export type Activity = { ts: number; actor: Actor; text: string; txHash?: string; explorerUrl?: string };
export type Log = (entry: Activity) => void;

export type Budget = { proposal_id: number; option: string; max_expense_per_period: string };
export type CallOptions = { depositYocto?: bigint; tgas?: number };
export interface Ledger {
  readonly contractId: string;
  readonly accounts: Record<import("./credentials.js").Role, string>;
  view<T>(method: string, args?: Record<string, unknown>): Promise<T>;
  call<T = unknown>(role: import("./credentials.js").Role, method: string, args?: Record<string, unknown>, opts?: CallOptions): Promise<TxResult<T>>;
}

/** Contract ledger reads, including the contract's different page limits. */
export type LedgerView = <T>(method: string, args?: Record<string, unknown>) => Promise<T>;

async function pages<T>(view: LedgerView, method: string, limit: number): Promise<T[]> {
  const result: T[] = [];
  for (let from = 0; ; from += limit) {
    const page = await view<T[]>(method, { from_index: from, limit });
    result.push(...page);
    if (page.length < limit) return result;
  }
}

export async function readDashboard(view: LedgerView) {
  const [treasury, currentPeriod, contributors, expenses, proposals, periods] = await Promise.all([
    view("get_treasury"), view("get_current_period"),
    pages(view, "get_contributors", 100), pages(view, "get_expenses", 100),
    pages(view, "get_proposals", 50), pages(view, "get_periods", 100),
  ]);
  return { treasury, currentPeriod, contributors, expenses, proposals, periods };
}
