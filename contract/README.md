# Agent Corp contract

Donated inference earns lifetime contribution units. Product sales enter company revenue. Only weekly close allocates net profit by snapshotted units. See `../docs/AGENT-CORP.md` and `../docs/adr/0001-period-accounting.md`.

Run from `contract/` using pinned toolchain:

```sh
cargo test --lib
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo near build non-reproducible-wasm --locked
```

Copy `target/near/agent_corp.wasm` into `res/agent_corp.wasm` after building. Deploy to a **fresh account**: storage changed from job prototype and earlier period draft; no migration exists. This task does not deploy. Existing local keys may point to an incompatible old draft.

## Canonical change Interface

Amounts/units are decimal strings (`U128`); durations/timestamps are decimal strings (`U64`); IDs are JSON numbers. Failed changes panic and roll back atomically. Non-payable methods reject attached deposits. Owner, CEO and oracle must be distinct. Pausing stops purchases and agent work; withdrawals and callbacks still work.

| Method with exact arguments | Caller | Result / behavior |
|---|---|---|
| `new(owner, oracle, ceo, constraints?, demo_mode?, initially_paused?)` | init | Defaults: 1 NEAR pass, 1000 reserve bps, 604800 seconds, 0.5 NEAR expense cap. Demo flag immutable; optional initially_paused applies kill switch atomically. |
| `set_constraints(constraints)` | owner | Fields: pass_price U128, expense_reserve_bps number, period_secs U64, max_expense_per_period U128. |
| `set_paused(paused)` | owner | Kill switch. |
| `set_oracle(oracle)`, `set_ceo(ceo)` | owner | Distinct roles enforced. |
| `record_contribution(account_id, units, reference)` | oracle | 1–5,000,000 units/report; max 100 contributors; reference ≤200 bytes. No payout. |
| `record_contribution_once(account_id, units, reference)` | oracle | Returns bool. Identical retry is false/no-op; conflicting account or amount for same reference rejected. |
| `buy_pass()` | player, payable | Returns Pass; exact price is revenue; excess returned separately. Repeat buys add revenue. No purchase refunds. |
| `buy_smoke_grenade()` | player, payable | Exact-price game item sale; records period revenue and a `smoke-grenade` sales receipt without activating a pass. |
| `record_expense(category, amount, payee, reference)` | CEO | Returns numeric ID. Positive amount; nonempty reference ≤200 bytes. Categories: hosting/domain/api/payment_fee/contractor/other. Both Board and owner caps apply. |
| `pay_expense(expense_id)` | oracle | Approved → Paying → Paid or Approved after failure; cost reversed on failure. |
| `close_distribution(period_id)` | oracle | Returns PeriodReceipt; ended period or demo mode only; pending expense transfers and duplicate close rejected. |
| `withdraw_distribution()` | contributor | Returns U128; failed transfer restores claimable. |
| `withdraw_refund()` | payer | Returns U128; retries failed excess-payment return, separate from distribution. |
| `create_proposal(kind, title, options, voting_period_secs)` | CEO | Returns numeric ID. kind="Budget". Each option is JSON text `{"max_expense_per_period":"100000000000000000000000"}`. 2–6 options; title ≤200 bytes; option ≤160 bytes. |
| `vote(proposal_id, option)` | Board | Zero-based option; current unit weight; re-vote replaces prior vote. |
| `finalize(proposal_id)` | anyone | All eligible contributors voted or voting ended. Unique positive winner activates budget; tie/zero vote keeps prior budget. |

No active Board budget means no approval. Effective limit is minimum of owner and Board aggregate caps. Caps count cumulative approvals in each period; costs count in payment period. Reduced budget does not cancel approved obligations. Category budgets remain future scope.

## Views

`has_contribution_reference(reference)`, `get_config()`, `get_stats()`, `get_treasury()`, `get_pass(account_id)`, `has_pass(account_id)`, `get_contributor(account_id)`, `get_claimable(account_id)`, `get_refund(account_id)`, `get_current_period()`, `get_period(period_id)`, `get_period_receipt(period_id)`, `get_expense(expense_id)`, `get_proposal(proposal_id)`, `get_vote(proposal_id, account_id)`, `get_budget()`.

Paged views `get_sales`, `get_expenses`, `get_periods`, `get_contributors` accept optional numeric from_index/limit (default 50, capped 100). Unknown singular record returns null. Open period receipt returns null. Budget returns `{proposal_id, option, max_expense_per_period}` or null. Treasury separates revenue, costs, expense reserve, distribution reserve, claimable, carry, refund total, pending payment count and raw balance. Raw balance includes storage funds.

## Events and callbacks

Format: `EVENT_JSON:{"standard":"agentcorp","version":"2.0.0","event":"…","data":[…]}`.
Names: set_constraints, set_paused, set_oracle, set_ceo, record_contribution, buy_pass, buy_smoke_grenade, record_expense, pay_expense, expense_paid, expense_payment_failed, close_distribution, withdraw_distribution, payout_failed, withdraw_refund, refund_paid, refund_failed, create_proposal, vote, finalize. Payloads serialize ledger records/receipts or identify affected account/expense, amount and period. Initiation does not prove transfer success.

Private callbacks (self only): `on_expense_paid(expense_id, amount, period_id) -> bool`, `on_payout(account_id, amount) -> bool`, `on_refund(account_id, amount) -> bool`. Expense callback checks stored Paying state, amount and period. Withdrawals restore distribution liability; excess returns restore refund liability.

## Accounting

`net = max(0, revenue − paid costs − reserve top-up) + prior carry`. Top-up is revenue × bps capped at surplus. Loss draws reserve, never future profit. U256 allocation: `net × contributor units / total units`. Rounding and zero-unit net carry forward. Distribution reserve equals claimable plus carry; refunds excluded. Close waits for expense transfer callbacks so a failed payment cannot rewrite an immutable receipt.
