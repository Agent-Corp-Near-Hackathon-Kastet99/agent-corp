//! Agent Corp contract: product revenue, operating costs, weekly distribution by contribution units.
//!
//! Money flow (see docs/AGENT-CORP.md):
//! - Contributors donate metered AI usage. The accounting oracle records it as lifetime
//!   contribution units (`record_contribution`). Units never trigger a payout on their own.
//! - Customers buy products (`buy_pass`, `buy_smoke_grenade`). The payment is revenue of the open period.
//! - The CEO agent approves operating costs (`record_expense`); the oracle pays them
//!   (`pay_expense`). Costs are paid from period revenue first, then from the expense reserve.
//! - At period end the oracle calls `close_distribution`. Net profit
//!   `max(0, revenue - costs - expense-reserve top-up)` plus any carried remainder is split
//!   pro rata by lifetime units and credited to `claimable`. Contributors then call
//!   `withdraw_distribution`.
//! - The owner (a human) only sets constraints (`set_constraints`) and the kill switch
//!   (`set_paused`). Agents cannot change either.
//! - 1 unit = 1 micro-USD of list-price-equivalent inference.

use near_sdk::json_types::{U64, U128};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, env, near, require,
};

// Lint originates in uint's generated implementation, not handwritten arithmetic.
#[allow(clippy::manual_div_ceil)]
mod wide {
    uint::construct_uint! {
        /// 256-bit unsigned integer used for all share math.
        pub struct U256(4);
    }
}
pub use wide::U256;

pub const BPS_DENOM: u128 = 10_000;
/// Per-account cap on units in one contribution report: $5 list-price-equivalent.
pub const MAX_UNITS_PER_REPORT: u128 = 5_000_000;
/// `close_distribution` credits every contributor in one call, so the set is bounded.
pub const MAX_CONTRIBUTORS: u32 = 100;
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
const MAX_REFERENCE_LEN: usize = 200;
const MAX_OPTIONS: usize = 6;
const MAX_OPTION_LEN: usize = 160;
const MAX_TITLE_LEN: usize = 200;
const PROPOSAL_KINDS: [&str; 1] = ["Budget"];
pub const EXPENSE_CATEGORIES: [&str; 6] = [
    "hosting",
    "domain",
    "api",
    "payment_fee",
    "contractor",
    "other",
];
const NS: u64 = 1_000_000_000;

/// `a * b / c` with a 256-bit intermediate. Panics on `c == 0` or if the result exceeds u128.
pub fn mul_div(a: u128, b: u128, c: u128) -> u128 {
    require!(c != 0, "mul_div: division by zero");
    let r = U256::from(a) * U256::from(b) / U256::from(c);
    require!(r <= U256::from(u128::MAX), "mul_div: result overflows u128");
    r.as_u128()
}

/// Result of closing one period. All values in yoctoNEAR.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct CloseMath {
    /// Added to the expense reserve.
    pub reserve_top_up: u128,
    /// Taken from the expense reserve because paid costs exceeded revenue.
    pub reserve_draw: u128,
    /// `max(0, revenue - costs - reserve_top_up)`.
    pub period_net: u128,
}

/// Pure close rule. The top-up is `reserve_bps` of revenue, capped so net never goes below zero.
/// A loss (costs > revenue) is covered by the expense reserve and is not carried forward.
pub fn compute_close(revenue: u128, costs: u128, reserve_bps: u16) -> CloseMath {
    if costs >= revenue {
        return CloseMath {
            reserve_top_up: 0,
            reserve_draw: costs - revenue,
            period_net: 0,
        };
    }
    let surplus = revenue - costs;
    let top_up = mul_div(revenue, reserve_bps as u128, BPS_DENOM).min(surplus);
    CloseMath {
        reserve_top_up: top_up,
        reserve_draw: 0,
        period_net: surplus - top_up,
    }
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Contributors,
    ContributorIds,
    Claimable,
    Passes,
    Sales,
    Expenses,
    Periods,
    Allocations,
    Proposals,
    Votes,
    Refunds,
    ContributionReports,
}

/// Limits the owner sets. Agents operate inside them and cannot change them.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Constraints {
    /// Minimum (and exact) price of one pass, yoctoNEAR.
    pub pass_price: U128,
    /// Share of period revenue moved to the expense reserve at close, in bps.
    pub expense_reserve_bps: u16,
    /// Length of one distribution period, seconds.
    pub period_secs: U64,
    /// Maximum total of expenses the CEO may approve in one period, yoctoNEAR.
    pub max_expense_per_period: U128,
}

impl Constraints {
    fn assert_valid(&self) {
        require!(self.pass_price.0 > 0, "pass_price must be positive");
        require!(
            self.expense_reserve_bps as u128 <= BPS_DENOM,
            "expense_reserve_bps above 10000"
        );
        require!(self.period_secs.0 > 0, "period_secs must be positive");
        require!(
            self.period_secs.0 <= (u64::MAX - env::block_timestamp()) / NS,
            "period duration overflows timestamp"
        );
    }
}

impl Default for Constraints {
    /// 1 NEAR pass, 10% expense reserve, weekly period, 0.5 NEAR expense cap per period.
    fn default() -> Self {
        Self {
            pass_price: U128(NearToken::from_near(1).as_yoctonear()),
            expense_reserve_bps: 1_000,
            period_secs: U64(7 * 24 * 3600),
            max_expense_per_period: U128(NearToken::from_millinear(500).as_yoctonear()),
        }
    }
}

#[near(serializers = [borsh])]
pub struct Contributor {
    units: u128,
    registered_at: u64,
}

#[near(serializers = [json])]
pub struct ContributorView {
    pub account_id: AccountId,
    pub units: U128,
    /// Claimable from closed periods only.
    pub claimable: U128,
    /// Share of all lifetime units, in bps.
    pub share_bps: u32,
    pub registered_at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Pass {
    pub account_id: AccountId,
    pub purchases: u32,
    pub total_paid: U128,
    pub first_paid_at: U64,
    pub last_paid_at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Sale {
    pub id: u32,
    pub account_id: AccountId,
    pub product: String,
    pub amount: U128,
    pub period: u64,
    pub paid_at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExpenseStatus {
    Approved,
    Paying,
    Paid,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Expense {
    pub id: u32,
    pub category: String,
    pub amount: U128,
    /// Period in which the expense was approved; replaced by the paying period once paid.
    pub period: u64,
    pub reference: String,
    pub payee: AccountId,
    pub approver: AccountId,
    pub status: ExpenseStatus,
    pub created_at: U64,
    pub paid_at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PeriodStatus {
    Open,
    Closed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Period {
    pub id: u64,
    pub starts_at: U64,
    pub ends_at: U64,
    pub status: PeriodStatus,
    pub revenue: U128,
    /// Paid operating costs.
    pub operating_costs: U128,
    /// Total of expenses approved in this period (checked against the owner's cap).
    pub expenses_approved: U128,
    pub expense_reserve_top_up: U128,
    pub expense_reserve_draw: U128,
    /// Undistributed remainder carried in from earlier closes.
    pub carried_in: U128,
    pub net_distributable: U128,
    pub distributed: U128,
    pub total_units_at_close: U128,
    pub closed_at: U64,
    /// True when the period was closed before `ends_at` (demo mode only).
    pub demo_close: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Allocation {
    pub account_id: AccountId,
    pub units: U128,
    pub amount: U128,
}

#[near(serializers = [json])]
pub struct PeriodReceipt {
    pub period: Period,
    pub allocations: Vec<Allocation>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum ProposalStatus {
    Open,
    Passed { option: u32 },
    NoChange,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Proposal {
    pub id: u64,
    pub kind: String,
    pub title: String,
    pub options: Vec<String>,
    /// Weighted tally per option (weight = voter's lifetime units at vote time).
    pub tallies: Vec<U128>,
    pub voters: u32,
    pub proposer: AccountId,
    pub created_at: U64,
    pub ends_at: U64,
    pub status: ProposalStatus,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Vote {
    pub option: u32,
    pub weight: U128,
}

#[near(serializers = [json])]
pub struct Budget {
    pub proposal_id: u64,
    pub option: String,
    pub max_expense_per_period: U128,
}

#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
pub struct BudgetOption {
    pub max_expense_per_period: U128,
}

fn parse_budget(option: &str) -> BudgetOption {
    near_sdk::serde_json::from_str(option).unwrap_or_else(|_| {
        env::panic_str("budget option must encode max_expense_per_period as U128")
    })
}

#[near(serializers = [json])]
pub struct Config {
    pub owner: AccountId,
    pub oracle: AccountId,
    pub ceo: AccountId,
    pub constraints: Constraints,
    pub paused: bool,
    pub demo_mode: bool,
    pub max_units_per_report: U128,
}

#[near(serializers = [json])]
pub struct Treasury {
    pub period_id: u64,
    pub period_revenue: U128,
    pub period_costs: U128,
    /// Held back for future company expenses.
    pub expense_reserve: U128,
    /// Set aside for contributors: claimable balances + undistributed remainder.
    pub distribution_reserve: U128,
    pub claimable_total: U128,
    pub distribution_carry: U128,
    pub account_balance: U128,
    pub refund_total: U128,
    pub pending_expense_payments: u32,
}

#[near(serializers = [json])]
pub struct Stats {
    pub contributors: u32,
    pub contributors_with_units: u32,
    pub total_units: U128,
    pub sales: u32,
    pub expenses: u32,
    pub periods: u64,
    pub proposals: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    oracle: AccountId,
    ceo: AccountId,
    constraints: Constraints,
    paused: bool,
    demo_mode: bool,

    contribution_reports: LookupMap<String, (AccountId, u128)>,
    contributors: LookupMap<AccountId, Contributor>,
    contributor_ids: Vector<AccountId>,
    contributors_with_units: u32,
    total_units: u128,

    claimable: LookupMap<AccountId, u128>,
    claimable_total: u128,
    refunds: LookupMap<AccountId, u128>,
    refund_total: u128,
    pending_expense_payments: u32,
    expense_reserve: u128,
    distribution_carry: u128,

    passes: LookupMap<AccountId, Pass>,
    sales: Vector<Sale>,
    expenses: Vector<Expense>,

    periods: LookupMap<u64, Period>,
    current_period: u64,
    allocations: LookupMap<u64, Vec<Allocation>>,

    proposals: LookupMap<u64, Proposal>,
    next_proposal_id: u64,
    votes: LookupMap<(u64, AccountId), Vote>,
    budget: Option<(u64, String)>,
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        near_sdk::serde_json::json!({
            "standard": "agentcorp",
            "version": "2.0.0",
            "event": event,
            "data": [data],
        })
    ));
}

fn new_period(id: u64, starts_at: u64, period_secs: u64) -> Period {
    Period {
        id,
        starts_at: U64(starts_at),
        ends_at: U64(starts_at + period_secs * NS),
        status: PeriodStatus::Open,
        revenue: U128(0),
        operating_costs: U128(0),
        expenses_approved: U128(0),
        expense_reserve_top_up: U128(0),
        expense_reserve_draw: U128(0),
        carried_in: U128(0),
        net_distributable: U128(0),
        distributed: U128(0),
        total_units_at_close: U128(0),
        closed_at: U64(0),
        demo_close: false,
    }
}

#[near]
impl Contract {
    /// `demo_mode` allows closing a period before it ends; such closes are flagged `demo_close`.
    /// It can only be set here, so a production deployment cannot be switched into it.
    #[init]
    pub fn new(
        owner: AccountId,
        oracle: AccountId,
        ceo: AccountId,
        constraints: Option<Constraints>,
        demo_mode: Option<bool>,
        initially_paused: Option<bool>,
    ) -> Self {
        require!(
            owner != oracle && owner != ceo,
            "owner must differ from oracle and CEO"
        );
        require!(oracle != ceo, "oracle and CEO must be different accounts");
        let constraints = constraints.unwrap_or_default();
        constraints.assert_valid();
        let mut periods = LookupMap::new(StorageKey::Periods);
        periods.insert(
            0,
            new_period(0, env::block_timestamp(), constraints.period_secs.0),
        );
        Self {
            owner,
            oracle,
            ceo,
            constraints,
            paused: initially_paused.unwrap_or(false),
            demo_mode: demo_mode.unwrap_or(false),
            contribution_reports: LookupMap::new(StorageKey::ContributionReports),
            contributors: LookupMap::new(StorageKey::Contributors),
            contributor_ids: Vector::new(StorageKey::ContributorIds),
            contributors_with_units: 0,
            total_units: 0,
            claimable: LookupMap::new(StorageKey::Claimable),
            claimable_total: 0,
            refunds: LookupMap::new(StorageKey::Refunds),
            refund_total: 0,
            pending_expense_payments: 0,
            expense_reserve: 0,
            distribution_carry: 0,
            passes: LookupMap::new(StorageKey::Passes),
            sales: Vector::new(StorageKey::Sales),
            expenses: Vector::new(StorageKey::Expenses),
            periods,
            current_period: 0,
            allocations: LookupMap::new(StorageKey::Allocations),
            proposals: LookupMap::new(StorageKey::Proposals),
            next_proposal_id: 0,
            votes: LookupMap::new(StorageKey::Votes),
            budget: None,
        }
    }

    // ---------------------------------------------------------------- owner (human) controls

    /// Kill switch. While paused, sales and every agent action are rejected.
    /// Contributors can still withdraw balances from closed periods.
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
        emit(
            "set_paused",
            near_sdk::serde_json::json!({ "paused": paused }),
        );
    }

    /// Applies to the next sale, the next expense approval and the next period.
    pub fn set_constraints(&mut self, constraints: Constraints) {
        self.assert_owner();
        constraints.assert_valid();
        emit(
            "set_constraints",
            near_sdk::serde_json::to_value(&constraints).unwrap(),
        );
        self.constraints = constraints;
    }

    pub fn set_oracle(&mut self, oracle: AccountId) {
        self.assert_owner();
        require!(
            oracle != self.owner && oracle != self.ceo,
            "oracle must be a separate account"
        );
        emit(
            "set_oracle",
            near_sdk::serde_json::json!({ "oracle": oracle }),
        );
        self.oracle = oracle;
    }

    pub fn set_ceo(&mut self, ceo: AccountId) {
        self.assert_owner();
        require!(
            ceo != self.owner && ceo != self.oracle,
            "CEO must be a separate account"
        );
        emit("set_ceo", near_sdk::serde_json::json!({ "ceo": ceo }));
        self.ceo = ceo;
    }

    // ---------------------------------------------------------------- contributors (oracle)

    /// Oracle-only. Adds metered units for company work; registers the contributor on first
    /// report. Never changes any claimable balance.
    pub fn record_contribution(&mut self, account_id: AccountId, units: U128, reference: String) {
        self.assert_live();
        self.assert_oracle();
        require!(units.0 > 0, "units must be positive");
        require!(
            units.0 <= MAX_UNITS_PER_REPORT,
            "units exceed per-report cap"
        );
        require!(reference.len() <= MAX_REFERENCE_LEN, "reference too long");
        if !self.contributors.contains_key(&account_id) {
            require!(
                self.contributor_ids.len() < MAX_CONTRIBUTORS,
                "contributor limit reached"
            );
            self.contributors.insert(
                account_id.clone(),
                Contributor {
                    units: 0,
                    registered_at: env::block_timestamp(),
                },
            );
            self.contributor_ids.push(account_id.clone());
        }
        let c = self.contributors.get_mut(&account_id).unwrap();
        if c.units == 0 {
            self.contributors_with_units += 1;
        }
        c.units += units.0;
        let total = c.units;
        self.total_units += units.0;
        emit(
            "record_contribution",
            near_sdk::serde_json::json!({
                "account_id": account_id, "units": units, "lifetime_units": U128(total),
                "total_units": U128(self.total_units), "reference": reference,
            }),
        );
    }

    /// Idempotent report: identical retry is a no-op; conflicting replay is rejected.
    pub fn record_contribution_once(
        &mut self,
        account_id: AccountId,
        units: U128,
        reference: String,
    ) -> bool {
        self.assert_live();
        self.assert_oracle();
        require!(!reference.is_empty(), "report reference required");
        if let Some((recorded_account, recorded_units)) = self.contribution_reports.get(&reference)
        {
            require!(
                recorded_account == &account_id && *recorded_units == units.0,
                "contribution reference conflict"
            );
            return false;
        }
        self.record_contribution(account_id.clone(), units, reference.clone());
        self.contribution_reports
            .insert(reference, (account_id, units.0));
        true
    }

    pub fn has_contribution_reference(&self, reference: String) -> bool {
        self.contribution_reports.contains_key(&reference)
    }

    // ---------------------------------------------------------------- product sales (customer)

    /// Customer buys the RAM HEIST pass. The price becomes revenue of the open period and the
    /// pass is active for the caller at once. Any deposit above the price is returned.
    /// No contributor balance changes here.
    #[payable]
    pub fn buy_pass(&mut self) -> Pass {
        self.assert_live();
        let deposit = env::attached_deposit().as_yoctonear();
        let price = self.constraints.pass_price.0;
        require!(deposit >= price, "deposit below pass price");
        let buyer = env::predecessor_account_id();
        let now = env::block_timestamp();
        let period_id = self.current_period;

        let period = self.periods.get_mut(&period_id).unwrap();
        period.revenue.0 += price;

        let pass = match self.passes.get_mut(&buyer) {
            Some(p) => {
                p.purchases += 1;
                p.total_paid.0 += price;
                p.last_paid_at = U64(now);
                p.clone()
            }
            None => {
                let p = Pass {
                    account_id: buyer.clone(),
                    purchases: 1,
                    total_paid: U128(price),
                    first_paid_at: U64(now),
                    last_paid_at: U64(now),
                };
                self.passes.insert(buyer.clone(), p.clone());
                p
            }
        };
        let sale = Sale {
            id: self.sales.len(),
            account_id: buyer.clone(),
            product: "ram-heist-pass".to_string(),
            amount: U128(price),
            period: period_id,
            paid_at: U64(now),
        };
        emit("buy_pass", near_sdk::serde_json::to_value(&sale).unwrap());
        self.sales.push(sale);

        let excess = deposit - price;
        if excess > 0 {
            self.push_refund(buyer, excess);
        }
        pass
    }

    /// Customer buys one Smoke Grenade for the RAM HEIST game. This is a product sale, not a
    /// pass purchase: it records revenue and a receipt but does not change pass entitlement.
    #[payable]
    pub fn buy_smoke_grenade(&mut self) -> Sale {
        self.assert_live();
        let deposit = env::attached_deposit().as_yoctonear();
        let price = self.constraints.pass_price.0;
        require!(deposit == price, "Smoke Grenade price must be exact");
        let sale = Sale {
            id: self.sales.len(),
            account_id: env::predecessor_account_id(),
            product: "smoke-grenade".to_string(),
            amount: U128(price),
            period: self.current_period,
            paid_at: U64(env::block_timestamp()),
        };
        self.periods
            .get_mut(&self.current_period)
            .unwrap()
            .revenue
            .0 += price;
        emit(
            "buy_smoke_grenade",
            near_sdk::serde_json::to_value(&sale).unwrap(),
        );
        self.sales.push(sale.clone());
        sale
    }

    // ---------------------------------------------------------------- expenses (CEO + oracle)

    /// CEO-agent only. Approves one operating cost inside the owner's per-period cap.
    pub fn record_expense(
        &mut self,
        category: String,
        amount: U128,
        payee: AccountId,
        reference: String,
    ) -> u32 {
        self.assert_live();
        require!(
            env::predecessor_account_id() == self.ceo,
            "only the CEO can approve expenses"
        );
        require!(
            EXPENSE_CATEGORIES.contains(&category.as_str()),
            "unsupported expense category"
        );
        require!(amount.0 > 0, "amount must be positive");
        require!(
            !reference.is_empty() && reference.len() <= MAX_REFERENCE_LEN,
            "reference required (max 200 chars)"
        );
        let cap = self.constraints.max_expense_per_period.0;
        let period_id = self.current_period;
        let period = self.periods.get_mut(&period_id).unwrap();
        require!(
            period.expenses_approved.0 + amount.0 <= cap,
            "expense exceeds the owner's per-period cap"
        );
        let (_, selected) = self
            .budget
            .as_ref()
            .unwrap_or_else(|| env::panic_str("no active Board budget"));
        require!(
            period.expenses_approved.0 + amount.0
                <= parse_budget(selected).max_expense_per_period.0,
            "expense exceeds active Board budget"
        );
        period.expenses_approved.0 += amount.0;
        let id = self.expenses.len();
        let expense = Expense {
            id,
            category,
            amount,
            period: period_id,
            reference,
            payee,
            approver: env::predecessor_account_id(),
            status: ExpenseStatus::Approved,
            created_at: U64(env::block_timestamp()),
            paid_at: U64(0),
        };
        emit(
            "record_expense",
            near_sdk::serde_json::to_value(&expense).unwrap(),
        );
        self.expenses.push(expense);
        id
    }

    /// Oracle-only. Pays an approved expense from period revenue, then from the expense reserve.
    pub fn pay_expense(&mut self, expense_id: u32) {
        self.assert_live();
        self.assert_oracle();
        let period_id = self.current_period;
        let reserve = self.expense_reserve;
        let (payee, amount) = {
            let e = self
                .expenses
                .get(expense_id)
                .unwrap_or_else(|| env::panic_str("unknown expense"));
            require!(
                e.status == ExpenseStatus::Approved,
                "expense is not awaiting payment"
            );
            (e.payee.clone(), e.amount.0)
        };
        let period = self.periods.get_mut(&period_id).unwrap();
        require!(
            period.operating_costs.0 + amount <= period.revenue.0 + reserve,
            "insufficient operating funds"
        );
        period.operating_costs.0 += amount;
        let e = self.expenses.get_mut(expense_id).unwrap();
        e.status = ExpenseStatus::Paying;
        e.period = period_id;
        self.pending_expense_payments += 1;
        emit(
            "pay_expense",
            near_sdk::serde_json::json!({
                "expense_id": expense_id, "payee": payee, "amount": U128(amount), "period": period_id,
            }),
        );
        Promise::new(payee)
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_expense_paid(expense_id, U128(amount), period_id),
            )
            .detach();
    }

    /// Never panics. On a failed transfer the expense returns to `Approved` and the cost is
    /// reversed (or returned to the expense reserve if that period has closed meanwhile).
    #[private]
    pub fn on_expense_paid(&mut self, expense_id: u32, amount: U128, period_id: u64) -> bool {
        // Ignore stale or mismatched callbacks; derive accounting from the stored payment.
        let Some(e) = self.expenses.get_mut(expense_id) else {
            return false;
        };
        if e.status != ExpenseStatus::Paying || e.amount != amount || e.period != period_id {
            return false;
        }
        let ok = env::promise_results_count() == 1 && env::promise_result_checked(0, 64).is_ok();
        e.status = if ok {
            ExpenseStatus::Paid
        } else {
            ExpenseStatus::Approved
        };
        if ok {
            e.paid_at = U64(env::block_timestamp());
        }
        self.pending_expense_payments -= 1;
        if !ok {
            // Close cannot run while a payment is in flight, so this period is still open.
            let p = self.periods.get_mut(&period_id).unwrap();
            p.operating_costs.0 -= amount.0;
        }
        emit(
            if ok {
                "expense_paid"
            } else {
                "expense_payment_failed"
            },
            near_sdk::serde_json::json!({ "expense_id": expense_id, "amount": amount, "period": period_id }),
        );
        ok
    }

    // ---------------------------------------------------------------- weekly close (oracle)

    /// Oracle-only, once per period. Tops up the expense reserve, then credits positive net
    /// profit to contributors pro rata by lifetime units at this moment. Units recorded later
    /// cannot claim this period. Opens the next period.
    pub fn close_distribution(&mut self, period_id: u64) -> PeriodReceipt {
        self.assert_live();
        self.assert_oracle();
        require!(period_id <= self.current_period, "unknown period");
        require!(period_id == self.current_period, "period already closed");
        require!(
            self.pending_expense_payments == 0,
            "expense payments pending"
        );
        let now = env::block_timestamp();
        let mut period = self.periods.get(&period_id).unwrap().clone();
        let ended = now >= period.ends_at.0;
        require!(ended || self.demo_mode, "period has not ended");

        let math = compute_close(
            period.revenue.0,
            period.operating_costs.0,
            self.constraints.expense_reserve_bps,
        );
        self.expense_reserve = self.expense_reserve + math.reserve_top_up - math.reserve_draw;

        let carried_in = self.distribution_carry;
        let net = math.period_net + carried_in;
        let total_units = self.total_units;
        let mut allocations: Vec<Allocation> = Vec::new();
        let mut distributed: u128 = 0;
        if net > 0 && total_units > 0 {
            for i in 0..self.contributor_ids.len() {
                let id = self.contributor_ids.get(i).unwrap().clone();
                let units = self.contributors.get(&id).map(|c| c.units).unwrap_or(0);
                if units == 0 {
                    continue;
                }
                let amount = mul_div(net, units, total_units);
                if amount > 0 {
                    *self.claimable.entry(id.clone()).or_insert(0) += amount;
                    distributed += amount;
                }
                allocations.push(Allocation {
                    account_id: id,
                    units: U128(units),
                    amount: U128(amount),
                });
            }
        }
        self.claimable_total += distributed;
        // Rounding remainder, or the whole net when nobody holds units, rolls into the next close.
        self.distribution_carry = net - distributed;

        period.status = PeriodStatus::Closed;
        period.expense_reserve_top_up = U128(math.reserve_top_up);
        period.expense_reserve_draw = U128(math.reserve_draw);
        period.carried_in = U128(carried_in);
        period.net_distributable = U128(net);
        period.distributed = U128(distributed);
        period.total_units_at_close = U128(total_units);
        period.closed_at = U64(now);
        period.demo_close = !ended;
        self.periods.insert(period_id, period.clone());
        self.allocations.insert(period_id, allocations.clone());

        let next = period_id + 1;
        self.periods
            .insert(next, new_period(next, now, self.constraints.period_secs.0));
        self.current_period = next;

        let receipt = PeriodReceipt {
            period,
            allocations,
        };
        emit(
            "close_distribution",
            near_sdk::serde_json::to_value(&receipt).unwrap(),
        );
        receipt
    }

    /// Pays out the caller's claimable balance from closed periods. Works while paused.
    pub fn withdraw_distribution(&mut self) -> U128 {
        let caller = env::predecessor_account_id();
        let amount = self.claimable.remove(&caller).unwrap_or(0);
        require!(amount > 0, "nothing to withdraw");
        self.claimable_total -= amount;
        emit(
            "withdraw_distribution",
            near_sdk::serde_json::json!({ "account_id": caller, "amount": U128(amount) }),
        );
        self.push_payout(caller, amount);
        U128(amount)
    }

    /// Callback for contributor withdrawals only. Never panics: on failure the amount is
    /// credited back to the account's claimable balance.
    #[private]
    pub fn on_payout(&mut self, account_id: AccountId, amount: U128) -> bool {
        let ok = env::promise_results_count() == 1 && env::promise_result_checked(0, 64).is_ok();
        if !ok {
            let entry = self.claimable.entry(account_id.clone()).or_insert(0);
            *entry = entry.saturating_add(amount.0);
            self.claimable_total = self.claimable_total.saturating_add(amount.0);
            emit(
                "payout_failed",
                near_sdk::serde_json::json!({ "account_id": account_id, "amount": amount }),
            );
        }
        ok
    }

    pub fn get_refund(&self, account_id: AccountId) -> U128 {
        U128(self.refunds.get(&account_id).copied().unwrap_or(0))
    }

    /// Retry a failed excess-payment return. This never touches contributor claimable.
    pub fn withdraw_refund(&mut self) -> U128 {
        let caller = env::predecessor_account_id();
        let amount = self.refunds.remove(&caller).unwrap_or(0);
        require!(amount > 0, "no refund to withdraw");
        self.refund_total -= amount;
        emit(
            "withdraw_refund",
            near_sdk::serde_json::json!({ "account_id": caller, "amount": U128(amount) }),
        );
        self.push_refund(caller, amount);
        U128(amount)
    }

    #[private]
    pub fn on_refund(&mut self, account_id: AccountId, amount: U128) -> bool {
        let ok = env::promise_results_count() == 1 && env::promise_result_checked(0, 64).is_ok();
        if !ok {
            *self.refunds.entry(account_id.clone()).or_insert(0) += amount.0;
            self.refund_total += amount.0;
        }
        emit(
            if ok { "refund_paid" } else { "refund_failed" },
            near_sdk::serde_json::json!({ "account_id": account_id, "amount": amount }),
        );
        ok
    }

    // ---------------------------------------------------------------- governance (Board)

    /// CEO agent account only.
    pub fn create_proposal(
        &mut self,
        kind: String,
        title: String,
        options: Vec<String>,
        voting_period_secs: U64,
    ) -> u64 {
        self.assert_live();
        require!(
            env::predecessor_account_id() == self.ceo,
            "only the CEO can propose"
        );
        require!(
            PROPOSAL_KINDS.contains(&kind.as_str()),
            "unsupported proposal kind"
        );
        require!(title.len() <= MAX_TITLE_LEN, "title too long");
        require!(
            options.len() >= 2 && options.len() <= MAX_OPTIONS,
            "need 2-6 options"
        );
        require!(
            options
                .iter()
                .all(|o| !o.is_empty() && o.len() <= MAX_OPTION_LEN),
            "invalid option"
        );
        require!(voting_period_secs.0 > 0, "voting period must be positive");
        require!(
            voting_period_secs.0 <= (u64::MAX - env::block_timestamp()) / NS,
            "voting duration overflows timestamp"
        );
        for option in &options {
            parse_budget(option);
        }
        let id = self.next_proposal_id;
        self.next_proposal_id += 1;
        let now = env::block_timestamp();
        let proposal = Proposal {
            id,
            kind,
            title,
            tallies: vec![U128(0); options.len()],
            options,
            voters: 0,
            proposer: env::predecessor_account_id(),
            created_at: U64(now),
            ends_at: U64(now + voting_period_secs.0 * NS),
            status: ProposalStatus::Open,
        };
        emit(
            "create_proposal",
            near_sdk::serde_json::to_value(&proposal).unwrap(),
        );
        self.proposals.insert(id, proposal);
        id
    }

    /// Board vote. Weight = caller's lifetime units now. Re-voting replaces the earlier vote.
    pub fn vote(&mut self, proposal_id: u64, option: u32) {
        let voter = env::predecessor_account_id();
        let weight = self.contributors.get(&voter).map(|c| c.units).unwrap_or(0);
        require!(weight > 0, "only contributors with units can vote");
        let key = (proposal_id, voter.clone());
        let previous = self.votes.get(&key).cloned();
        let proposal = self
            .proposals
            .get_mut(&proposal_id)
            .unwrap_or_else(|| env::panic_str("unknown proposal"));
        require!(
            proposal.status == ProposalStatus::Open,
            "proposal is closed"
        );
        require!(
            env::block_timestamp() < proposal.ends_at.0,
            "voting period ended"
        );
        require!((option as usize) < proposal.options.len(), "invalid option");
        match previous {
            Some(prev) => {
                let t = &mut proposal.tallies[prev.option as usize];
                t.0 -= prev.weight.0;
            }
            None => proposal.voters += 1,
        }
        proposal.tallies[option as usize].0 += weight;
        self.votes.insert(
            key,
            Vote {
                option,
                weight: U128(weight),
            },
        );
        emit(
            "vote",
            near_sdk::serde_json::json!({
                "proposal_id": proposal_id, "voter": voter, "option": option, "weight": U128(weight)
            }),
        );
    }

    /// Anyone, once every contributor with units > 0 has voted or the period has elapsed.
    /// Most weight wins; a tie or zero participation keeps the previous budget.
    pub fn finalize(&mut self, proposal_id: u64) -> ProposalStatus {
        let with_units = self.contributors_with_units;
        let proposal = self
            .proposals
            .get_mut(&proposal_id)
            .unwrap_or_else(|| env::panic_str("unknown proposal"));
        require!(
            proposal.status == ProposalStatus::Open,
            "proposal is closed"
        );
        let all_voted = proposal.voters > 0 && proposal.voters >= with_units;
        require!(
            all_voted || env::block_timestamp() >= proposal.ends_at.0,
            "voting still open"
        );
        let max = proposal.tallies.iter().map(|t| t.0).max().unwrap_or(0);
        let winners: Vec<usize> = proposal
            .tallies
            .iter()
            .enumerate()
            .filter(|(_, t)| t.0 == max)
            .map(|(i, _)| i)
            .collect();
        proposal.status = if max == 0 || winners.len() != 1 {
            ProposalStatus::NoChange
        } else {
            ProposalStatus::Passed {
                option: winners[0] as u32,
            }
        };
        let status = proposal.status.clone();
        if let ProposalStatus::Passed { option } = status {
            self.budget = Some((proposal_id, proposal.options[option as usize].clone()));
        }
        emit(
            "finalize",
            near_sdk::serde_json::json!({ "proposal_id": proposal_id, "status": status }),
        );
        status
    }

    // ---------------------------------------------------------------- views

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            oracle: self.oracle.clone(),
            ceo: self.ceo.clone(),
            constraints: self.constraints.clone(),
            paused: self.paused,
            demo_mode: self.demo_mode,
            max_units_per_report: U128(MAX_UNITS_PER_REPORT),
        }
    }

    pub fn get_treasury(&self) -> Treasury {
        let p = self.periods.get(&self.current_period).unwrap();
        Treasury {
            period_id: p.id,
            period_revenue: p.revenue,
            period_costs: p.operating_costs,
            expense_reserve: U128(self.expense_reserve),
            distribution_reserve: U128(self.claimable_total + self.distribution_carry),
            claimable_total: U128(self.claimable_total),
            distribution_carry: U128(self.distribution_carry),
            account_balance: U128(env::account_balance().as_yoctonear()),
            refund_total: U128(self.refund_total),
            pending_expense_payments: self.pending_expense_payments,
        }
    }

    pub fn get_stats(&self) -> Stats {
        Stats {
            contributors: self.contributor_ids.len(),
            contributors_with_units: self.contributors_with_units,
            total_units: U128(self.total_units),
            sales: self.sales.len(),
            expenses: self.expenses.len(),
            periods: self.current_period + 1,
            proposals: self.next_proposal_id,
        }
    }

    /// `None` means the pass is locked for this account.
    pub fn get_pass(&self, account_id: AccountId) -> Option<Pass> {
        self.passes.get(&account_id).cloned()
    }

    pub fn has_pass(&self, account_id: AccountId) -> bool {
        self.passes.contains_key(&account_id)
    }

    pub fn get_sales(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Sale> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100);
        (from..self.sales.len().min(from.saturating_add(limit)))
            .filter_map(|i| self.sales.get(i).cloned())
            .collect()
    }

    pub fn get_expense(&self, expense_id: u32) -> Option<Expense> {
        self.expenses.get(expense_id).cloned()
    }

    pub fn get_expenses(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Expense> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100);
        (from..self.expenses.len().min(from.saturating_add(limit)))
            .filter_map(|i| self.expenses.get(i).cloned())
            .collect()
    }

    pub fn get_current_period(&self) -> Period {
        self.periods.get(&self.current_period).unwrap().clone()
    }

    pub fn get_period(&self, period_id: u64) -> Option<Period> {
        self.periods.get(&period_id).cloned()
    }

    pub fn get_periods(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Period> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100);
        (from..(self.current_period + 1).min(from.saturating_add(limit)))
            .filter_map(|i| self.periods.get(&i).cloned())
            .collect()
    }

    /// Closed-period receipt: ledger plus the unit snapshot and each contributor's allocation.
    pub fn get_period_receipt(&self, period_id: u64) -> Option<PeriodReceipt> {
        let period = self.periods.get(&period_id)?.clone();
        if period.status != PeriodStatus::Closed {
            return None;
        }
        Some(PeriodReceipt {
            period,
            allocations: self
                .allocations
                .get(&period_id)
                .cloned()
                .unwrap_or_default(),
        })
    }

    pub fn get_contributor(&self, account_id: AccountId) -> Option<ContributorView> {
        self.contributors
            .get(&account_id)
            .map(|c| self.contributor_view(&account_id, c))
    }

    pub fn get_contributors(
        &self,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<ContributorView> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100);
        (from..self.contributor_ids.len().min(from.saturating_add(limit)))
            .filter_map(|i| {
                let id = self.contributor_ids.get(i)?;
                self.contributors
                    .get(id)
                    .map(|c| self.contributor_view(id, c))
            })
            .collect()
    }

    pub fn get_claimable(&self, account_id: AccountId) -> U128 {
        U128(self.claimable.get(&account_id).copied().unwrap_or(0))
    }

    pub fn get_proposal(&self, proposal_id: u64) -> Option<Proposal> {
        self.proposals.get(&proposal_id).cloned()
    }

    pub fn get_proposals(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Proposal> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(20).min(50);
        (from..self.next_proposal_id.min(from.saturating_add(limit)))
            .filter_map(|i| self.proposals.get(&i).cloned())
            .collect()
    }

    pub fn get_vote(&self, proposal_id: u64, account_id: AccountId) -> Option<Vote> {
        self.votes.get(&(proposal_id, account_id)).cloned()
    }

    pub fn get_budget(&self) -> Option<Budget> {
        self.budget.as_ref().map(|(id, o)| Budget {
            proposal_id: *id,
            option: o.clone(),
            max_expense_per_period: parse_budget(o).max_expense_per_period,
        })
    }
}

impl Contract {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    fn assert_oracle(&self) {
        require!(env::predecessor_account_id() == self.oracle, "oracle only");
    }

    fn assert_live(&self) {
        require!(!self.paused, "paused by owner");
    }

    fn contributor_view(&self, account_id: &AccountId, c: &Contributor) -> ContributorView {
        ContributorView {
            account_id: account_id.clone(),
            units: U128(c.units),
            claimable: U128(self.claimable.get(account_id).copied().unwrap_or(0)),
            share_bps: if self.total_units == 0 {
                0
            } else {
                mul_div(c.units, BPS_DENOM, self.total_units) as u32
            },
            registered_at: U64(c.registered_at),
        }
    }

    fn push_refund(&self, to: AccountId, amount: u128) {
        Promise::new(to.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_refund(to, U128(amount)),
            )
            .detach();
    }

    /// The liability is debited by the caller before this; a failure re-credits claimable.
    fn push_payout(&self, to: AccountId, amount: u128) {
        Promise::new(to.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_payout(to, U128(amount)),
            )
            .detach();
    }
}

#[cfg(test)]
mod tests;
