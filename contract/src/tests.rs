use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{PromiseResult, RuntimeFeesConfig, testing_env};

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const MILLI: u128 = NEAR / 1000;
const WEEK: u64 = 7 * 24 * 3600;
const T0: u64 = 1_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(predecessor: &str, deposit: u128, ts_secs: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("agentcorp.near"))
        .predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(predecessor))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(100))
        .block_timestamp(ts_secs * 1_000_000_000);
    b
}

fn at(predecessor: &str, ts_secs: u64) {
    testing_env!(ctx(predecessor, 0, ts_secs).build());
}

fn as_(predecessor: &str) {
    at(predecessor, T0);
}

fn callback(result: PromiseResult) {
    testing_env!(
        ctx("agentcorp.near", 0, T0).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result],
    );
}

fn contract(demo_mode: bool) -> Contract {
    as_("owner.near");
    Contract::new(
        acc("owner.near"),
        acc("oracle.near"),
        acc("ceo.near"),
        None,
        Some(demo_mode),
        None,
    )
}

/// Demo-mode contract with Alice 60,000 units and Bob 40,000 units.
fn seeded() -> Contract {
    let mut c = contract(true);
    units(&mut c, "alice.near", 60_000);
    units(&mut c, "bob.near", 40_000);
    approve_budget(&mut c, 500 * MILLI);
    c
}

fn units(c: &mut Contract, who: &str, n: u128) {
    as_("oracle.near");
    c.record_contribution(acc(who), U128(n), "session".into());
}

fn buy(c: &mut Contract, who: &str, deposit: u128) -> Pass {
    testing_env!(ctx(who, deposit, T0).build());
    c.buy_pass()
}

fn buy_smoke(c: &mut Contract, who: &str, deposit: u128) -> Sale {
    testing_env!(ctx(who, deposit, T0).build());
    c.buy_smoke_grenade()
}

fn approve_budget(c: &mut Contract, cap: u128) {
    as_("ceo.near");
    let option = format!(r#"{{"max_expense_per_period":"{cap}"}}"#);
    let id = c.create_proposal(
        "Budget".into(),
        "Operating budget".into(),
        vec![option, r#"{"max_expense_per_period":"0"}"#.into()],
        U64(60),
    );
    as_("alice.near");
    c.vote(id, 0);
    as_("bob.near");
    c.vote(id, 0);
    as_("anyone.near");
    c.finalize(id);
}

fn expense(c: &mut Contract, amount: u128) -> u32 {
    as_("ceo.near");
    c.record_expense(
        "hosting".into(),
        U128(amount),
        acc("vendor.near"),
        "invoice-1".into(),
    )
}

/// Approve + pay + successful transfer callback.
fn paid_expense(c: &mut Contract, amount: u128) -> u32 {
    let id = expense(c, amount);
    as_("oracle.near");
    c.pay_expense(id);
    let period = c.current_period;
    callback(PromiseResult::Successful(vec![]));
    assert!(c.on_expense_paid(id, U128(amount), period));
    id
}

fn close(c: &mut Contract) -> PeriodReceipt {
    as_("oracle.near");
    c.close_distribution(c.current_period)
}

fn claimable(c: &Contract, a: &str) -> u128 {
    c.get_claimable(acc(a)).0
}

// ------------------------------------------------------------------ pure math

#[test]
fn mul_div_handles_values_beyond_u128_intermediate() {
    assert_eq!(mul_div(u128::MAX, 3, 3), u128::MAX);
    assert_eq!(mul_div(800 * MILLI, 60_000, 100_000), 480 * MILLI);
}

#[test]
fn compute_close_demo_numbers() {
    let m = compute_close(NEAR, 100 * MILLI, 1_000);
    assert_eq!(
        m,
        CloseMath {
            reserve_top_up: 100 * MILLI,
            reserve_draw: 0,
            period_net: 800 * MILLI
        }
    );
}

#[test]
fn compute_close_caps_top_up_at_surplus() {
    // Revenue 1.00, costs 0.95: only 0.05 is left, so the 10% top-up shrinks to 0.05.
    let m = compute_close(NEAR, 950 * MILLI, 1_000);
    assert_eq!(
        m,
        CloseMath {
            reserve_top_up: 50 * MILLI,
            reserve_draw: 0,
            period_net: 0
        }
    );
}

#[test]
fn compute_close_loss_draws_reserve_and_nets_zero() {
    let m = compute_close(100 * MILLI, 300 * MILLI, 1_000);
    assert_eq!(
        m,
        CloseMath {
            reserve_top_up: 0,
            reserve_draw: 200 * MILLI,
            period_net: 0
        }
    );
    assert_eq!(compute_close(0, 0, 1_000).period_net, 0);
}

// ------------------------------------------------------------------ init / roles

#[test]
#[should_panic(expected = "owner must differ from oracle and CEO")]
fn owner_cannot_be_oracle() {
    as_("owner.near");
    Contract::new(
        acc("owner.near"),
        acc("owner.near"),
        acc("ceo.near"),
        None,
        None,
        None,
    );
}

#[test]
#[should_panic(expected = "oracle and CEO must be different accounts")]
fn oracle_cannot_be_ceo() {
    as_("owner.near");
    Contract::new(
        acc("owner.near"),
        acc("agent.near"),
        acc("agent.near"),
        None,
        None,
        None,
    );
}

// ------------------------------------------------------------------ pass purchase

#[test]
fn pass_is_locked_until_bought_then_active() {
    let mut c = seeded();
    assert!(!c.has_pass(acc("player.near")));
    assert!(c.get_pass(acc("player.near")).is_none());
    let pass = buy(&mut c, "player.near", NEAR);
    assert_eq!(pass.purchases, 1);
    assert_eq!(pass.total_paid.0, NEAR);
    assert!(c.has_pass(acc("player.near")));
}

#[test]
fn pass_purchase_is_revenue_and_leaves_claimable_unchanged() {
    let mut c = seeded();
    buy(&mut c, "player.near", NEAR);
    let t = c.get_treasury();
    assert_eq!(t.period_revenue.0, NEAR);
    assert_eq!(t.claimable_total.0, 0);
    assert_eq!(claimable(&c, "alice.near"), 0);
    assert_eq!(claimable(&c, "bob.near"), 0);
    let sales = c.get_sales(None, None);
    assert_eq!(sales.len(), 1);
    assert_eq!(sales[0].product, "ram-heist-pass");
    assert_eq!(sales[0].amount.0, NEAR);
}

#[test]
fn smoke_grenade_purchase_is_ledger_revenue_without_a_pass() {
    let mut c = seeded();
    let sale = buy_smoke(&mut c, "player.near", NEAR);
    assert_eq!(sale.product, "smoke-grenade");
    assert_eq!(sale.amount.0, NEAR);
    assert_eq!(c.get_treasury().period_revenue.0, NEAR);
    assert!(!c.has_pass(acc("player.near")));
    assert_eq!(c.get_sales(None, None)[0].product, "smoke-grenade");
}

#[test]
#[should_panic(expected = "Smoke Grenade price must be exact")]
fn smoke_grenade_rejects_inexact_payment() {
    let mut c = seeded();
    buy_smoke(&mut c, "player.near", NEAR + 1);
}

#[test]
#[should_panic(expected = "deposit below pass price")]
fn underpayment_is_rejected() {
    let mut c = seeded();
    buy(&mut c, "player.near", NEAR - 1);
}

#[test]
fn overpayment_books_only_the_price() {
    let mut c = seeded();
    buy(&mut c, "player.near", 3 * NEAR);
    assert_eq!(c.get_treasury().period_revenue.0, NEAR);
    assert_eq!(c.get_pass(acc("player.near")).unwrap().total_paid.0, NEAR);
}

#[test]
fn second_purchase_adds_revenue_and_keeps_one_pass() {
    let mut c = seeded();
    buy(&mut c, "player.near", NEAR);
    let pass = buy(&mut c, "player.near", NEAR);
    assert_eq!(pass.purchases, 2);
    assert_eq!(c.get_treasury().period_revenue.0, 2 * NEAR);
}

// ------------------------------------------------------------------ contributions

#[test]
fn contribution_records_units_without_payout() {
    let c = seeded();
    let alice = c.get_contributor(acc("alice.near")).unwrap();
    assert_eq!(alice.units.0, 60_000);
    assert_eq!(alice.share_bps, 6_000);
    assert_eq!(alice.claimable.0, 0);
    assert_eq!(c.get_stats().total_units.0, 100_000);
}

#[test]
#[should_panic(expected = "oracle only")]
fn only_oracle_records_contribution() {
    let mut c = contract(true);
    as_("alice.near");
    c.record_contribution(acc("alice.near"), U128(1), "x".into());
}

#[test]
#[should_panic(expected = "units exceed per-report cap")]
fn contribution_report_is_capped() {
    let mut c = contract(true);
    units(&mut c, "alice.near", MAX_UNITS_PER_REPORT + 1);
}

// ------------------------------------------------------------------ expenses

#[test]
#[should_panic(expected = "only the CEO can approve expenses")]
fn oracle_cannot_approve_expense() {
    let mut c = seeded();
    as_("oracle.near");
    c.record_expense(
        "hosting".into(),
        U128(MILLI),
        acc("vendor.near"),
        "r".into(),
    );
}

#[test]
#[should_panic(expected = "unsupported expense category")]
fn reserve_is_not_an_expense_category() {
    let mut c = seeded();
    as_("ceo.near");
    c.record_expense(
        "reserve".into(),
        U128(MILLI),
        acc("vendor.near"),
        "r".into(),
    );
}

#[test]
#[should_panic(expected = "expense exceeds the owner's per-period cap")]
fn expense_cap_is_enforced() {
    let mut c = seeded();
    expense(&mut c, 300 * MILLI);
    expense(&mut c, 201 * MILLI); // default cap is 0.5 NEAR per period
}

#[test]
#[should_panic(expected = "oracle only")]
fn ceo_cannot_pay_expense() {
    let mut c = seeded();
    buy(&mut c, "player.near", NEAR);
    let id = expense(&mut c, 100 * MILLI);
    as_("ceo.near");
    c.pay_expense(id);
}

#[test]
#[should_panic(expected = "insufficient operating funds")]
fn expense_cannot_be_paid_without_revenue_or_reserve() {
    let mut c = seeded();
    let id = expense(&mut c, 100 * MILLI);
    as_("oracle.near");
    c.pay_expense(id);
}

#[test]
fn approved_unpaid_expense_does_not_reduce_net() {
    let mut c = seeded();
    buy(&mut c, "player.near", NEAR);
    expense(&mut c, 100 * MILLI);
    assert_eq!(c.get_treasury().period_costs.0, 0);
    let r = close(&mut c);
    // 1.00 - 0 costs - 0.10 reserve
    assert_eq!(r.period.net_distributable.0, 900 * MILLI);
}

#[test]
fn failed_expense_transfer_restores_unpaid_state() {
    let mut c = seeded();
    buy(&mut c, "player.near", NEAR);
    let id = expense(&mut c, 100 * MILLI);
    as_("oracle.near");
    c.pay_expense(id);
    assert_eq!(c.get_expense(id).unwrap().status, ExpenseStatus::Paying);
    assert_eq!(c.get_treasury().period_costs.0, 100 * MILLI);
    callback(PromiseResult::Failed);
    assert!(!c.on_expense_paid(id, U128(100 * MILLI), 0));
    assert_eq!(c.get_expense(id).unwrap().status, ExpenseStatus::Approved);
    assert_eq!(c.get_treasury().period_costs.0, 0);
}

#[test]
#[should_panic(expected = "expense is not awaiting payment")]
fn expense_cannot_be_paid_twice() {
    let mut c = seeded();
    buy(&mut c, "player.near", NEAR);
    let id = paid_expense(&mut c, 100 * MILLI);
    as_("oracle.near");
    c.pay_expense(id);
}

// ------------------------------------------------------------------ close

#[test]
fn demo_close_credits_048_and_032_from_080_net() {
    let mut c = seeded();
    buy(&mut c, "player.near", NEAR);
    paid_expense(&mut c, 100 * MILLI);
    assert_eq!(claimable(&c, "alice.near"), 0);

    let r = close(&mut c);
    assert_eq!(r.period.revenue.0, NEAR);
    assert_eq!(r.period.operating_costs.0, 100 * MILLI);
    assert_eq!(r.period.expense_reserve_top_up.0, 100 * MILLI);
    assert_eq!(r.period.net_distributable.0, 800 * MILLI);
    assert_eq!(r.period.total_units_at_close.0, 100_000);
    assert!(r.period.demo_close);
    assert_eq!(r.allocations.len(), 2);
    assert_eq!(claimable(&c, "alice.near"), 480 * MILLI);
    assert_eq!(claimable(&c, "bob.near"), 320 * MILLI);

    let t = c.get_treasury();
    assert_eq!(t.expense_reserve.0, 100 * MILLI);
    assert_eq!(t.distribution_reserve.0, 800 * MILLI);
    assert_eq!(t.period_id, 1);
    assert_eq!(t.period_revenue.0, 0);
    assert_eq!(
        c.get_period_receipt(0).unwrap().allocations[0].amount.0,
        480 * MILLI
    );
    assert!(c.get_period_receipt(1).is_none());
}

#[test]
#[should_panic(expected = "period already closed")]
fn double_close_is_rejected() {
    let mut c = seeded();
    buy(&mut c, "player.near", NEAR);
    close(&mut c);
    as_("oracle.near");
    c.close_distribution(0);
}

#[test]
#[should_panic(expected = "unknown period")]
fn future_period_cannot_be_closed() {
    let mut c = seeded();
    as_("oracle.near");
    c.close_distribution(5);
}

#[test]
#[should_panic(expected = "oracle only")]
fn only_oracle_closes() {
    let mut c = seeded();
    as_("ceo.near");
    c.close_distribution(0);
}

#[test]
#[should_panic(expected = "period has not ended")]
fn early_close_needs_demo_mode() {
    let mut c = contract(false);
    units(&mut c, "alice.near", 10);
    as_("oracle.near");
    c.close_distribution(0);
}

#[test]
fn production_close_after_period_end_is_not_flagged_demo() {
    let mut c = contract(false);
    units(&mut c, "alice.near", 10);
    buy(&mut c, "player.near", NEAR);
    at("oracle.near", T0 + WEEK);
    let r = c.close_distribution(0);
    assert!(!r.period.demo_close);
    assert_eq!(claimable(&c, "alice.near"), 900 * MILLI);
    assert_eq!(
        c.get_current_period().ends_at.0,
        (T0 + 2 * WEEK) * 1_000_000_000
    );
}

#[test]
fn units_recorded_after_close_cannot_claim_that_period() {
    let mut c = seeded();
    buy(&mut c, "player.near", NEAR);
    close(&mut c);
    units(&mut c, "carol.near", 100_000);
    assert_eq!(claimable(&c, "carol.near"), 0);
    assert_eq!(claimable(&c, "alice.near"), 540 * MILLI);
    // Next period: Carol now holds half of all units.
    buy(&mut c, "player.near", NEAR);
    close(&mut c);
    assert_eq!(claimable(&c, "carol.near"), 450 * MILLI);
    assert_eq!(claimable(&c, "alice.near"), 540 * MILLI + 270 * MILLI);
}

#[test]
fn zero_net_distributes_nothing() {
    let mut c = seeded();
    let r = close(&mut c);
    assert_eq!(r.period.net_distributable.0, 0);
    assert!(r.allocations.is_empty());
    assert_eq!(claimable(&c, "alice.near"), 0);
}

#[test]
fn negative_net_distributes_nothing_and_loss_is_not_carried() {
    let mut c = seeded();
    // Period 0 builds a 0.20 expense reserve (10% of 2.00).
    buy(&mut c, "p1.near", NEAR);
    buy(&mut c, "p2.near", NEAR);
    close(&mut c);
    let after_first = claimable(&c, "alice.near");
    assert_eq!(c.get_treasury().expense_reserve.0, 200 * MILLI);

    // Period 1: no revenue, 0.15 cost paid from the reserve -> loss.
    paid_expense(&mut c, 150 * MILLI);
    let r = close(&mut c);
    assert_eq!(r.period.net_distributable.0, 0);
    assert_eq!(r.period.expense_reserve_draw.0, 150 * MILLI);
    assert_eq!(claimable(&c, "alice.near"), after_first);
    assert_eq!(c.get_treasury().expense_reserve.0, 50 * MILLI);

    // Period 2: the earlier loss does not reduce this period's profit.
    buy(&mut c, "p3.near", NEAR);
    let r = close(&mut c);
    assert_eq!(r.period.net_distributable.0, 900 * MILLI);
}

#[test]
fn zero_units_carries_net_into_next_close() {
    let mut c = contract(true);
    buy(&mut c, "player.near", NEAR);
    let r = close(&mut c);
    assert_eq!(r.period.distributed.0, 0);
    assert_eq!(c.get_treasury().distribution_carry.0, 900 * MILLI);

    units(&mut c, "alice.near", 10);
    let r = close(&mut c);
    assert_eq!(r.period.carried_in.0, 900 * MILLI);
    assert_eq!(claimable(&c, "alice.near"), 900 * MILLI);
    assert_eq!(c.get_treasury().distribution_carry.0, 0);
}

#[test]
fn rounding_remainder_stays_in_distribution_reserve() {
    let mut c = contract(true);
    units(&mut c, "a.near", 1);
    units(&mut c, "b.near", 1);
    units(&mut c, "c.near", 1);
    as_("owner.near");
    c.set_constraints(Constraints {
        pass_price: U128(100),
        expense_reserve_bps: 0,
        period_secs: U64(WEEK),
        max_expense_per_period: U128(0),
    });
    buy(&mut c, "player.near", 100);
    let r = close(&mut c);
    assert_eq!(r.period.distributed.0, 99);
    assert_eq!(c.get_treasury().distribution_carry.0, 1);
    assert_eq!(c.get_treasury().distribution_reserve.0, 100);
}

// ------------------------------------------------------------------ withdraw

#[test]
fn withdraw_pays_closed_period_balance_once() {
    let mut c = seeded();
    buy(&mut c, "player.near", NEAR);
    paid_expense(&mut c, 100 * MILLI);
    close(&mut c);
    as_("alice.near");
    assert_eq!(c.withdraw_distribution().0, 480 * MILLI);
    assert_eq!(claimable(&c, "alice.near"), 0);
    assert_eq!(c.get_treasury().claimable_total.0, 320 * MILLI);
}

#[test]
#[should_panic(expected = "nothing to withdraw")]
fn withdraw_before_any_close_panics() {
    let mut c = seeded();
    buy(&mut c, "player.near", NEAR);
    as_("alice.near");
    c.withdraw_distribution();
}

#[test]
fn failed_withdrawal_restores_claimable() {
    let mut c = seeded();
    buy(&mut c, "player.near", NEAR);
    close(&mut c);
    as_("alice.near");
    let amount = c.withdraw_distribution();
    assert_eq!(claimable(&c, "alice.near"), 0);
    callback(PromiseResult::Failed);
    assert!(!c.on_payout(acc("alice.near"), amount));
    assert_eq!(claimable(&c, "alice.near"), 540 * MILLI);
    callback(PromiseResult::Successful(vec![]));
    assert!(c.on_payout(acc("alice.near"), U128(5)));
    assert_eq!(claimable(&c, "alice.near"), 540 * MILLI);
}

// ------------------------------------------------------------------ owner controls

#[test]
#[should_panic(expected = "paused by owner")]
fn kill_switch_blocks_sales() {
    let mut c = seeded();
    as_("owner.near");
    c.set_paused(true);
    buy(&mut c, "player.near", NEAR);
}

#[test]
#[should_panic(expected = "paused by owner")]
fn kill_switch_blocks_agent_close() {
    let mut c = seeded();
    as_("owner.near");
    c.set_paused(true);
    close(&mut c);
}

#[test]
fn kill_switch_still_allows_withdrawals_and_can_be_lifted() {
    let mut c = seeded();
    buy(&mut c, "player.near", NEAR);
    close(&mut c);
    as_("owner.near");
    c.set_paused(true);
    assert!(c.get_config().paused);
    as_("bob.near");
    assert_eq!(c.withdraw_distribution().0, 360 * MILLI);
    as_("owner.near");
    c.set_paused(false);
    buy(&mut c, "player.near", NEAR);
}

#[test]
#[should_panic(expected = "owner only")]
fn agents_cannot_flip_the_kill_switch() {
    let mut c = seeded();
    as_("oracle.near");
    c.set_paused(true);
}

#[test]
#[should_panic(expected = "owner only")]
fn agents_cannot_change_constraints() {
    let mut c = seeded();
    as_("ceo.near");
    c.set_constraints(Constraints::default());
}

#[test]
fn owner_constraints_change_price_and_reserve() {
    let mut c = seeded();
    as_("owner.near");
    c.set_constraints(Constraints {
        pass_price: U128(2 * NEAR),
        expense_reserve_bps: 2_500,
        period_secs: U64(WEEK),
        max_expense_per_period: U128(NEAR),
    });
    buy(&mut c, "player.near", 2 * NEAR);
    let r = close(&mut c);
    assert_eq!(r.period.expense_reserve_top_up.0, 500 * MILLI);
    assert_eq!(r.period.net_distributable.0, 1500 * MILLI);
}

// ------------------------------------------------------------------ governance

fn proposal(c: &mut Contract) -> u64 {
    as_("ceo.near");
    c.create_proposal(
        "Budget".into(),
        "Period budget".into(),
        vec![
            format!(r#"{{"max_expense_per_period":"{}"}}"#, 100 * MILLI),
            format!(r#"{{"max_expense_per_period":"{}"}}"#, 200 * MILLI),
        ],
        U64(60),
    )
}

#[test]
fn board_votes_by_units_and_sets_budget() {
    let mut c = seeded();
    let id = proposal(&mut c);
    as_("alice.near");
    c.vote(id, 0);
    as_("bob.near");
    c.vote(id, 1);
    as_("anyone.near");
    assert_eq!(c.finalize(id), ProposalStatus::Passed { option: 0 });
    assert_eq!(
        c.get_budget().unwrap().max_expense_per_period.0,
        100 * MILLI
    );
    assert_eq!(c.get_proposal(id).unwrap().tallies[0].0, 60_000);
}

#[test]
#[should_panic(expected = "only contributors with units can vote")]
fn non_contributor_cannot_vote() {
    let mut c = seeded();
    let id = proposal(&mut c);
    as_("player.near");
    c.vote(id, 0);
}

#[test]
#[should_panic(expected = "only the CEO can propose")]
fn only_ceo_proposes() {
    let mut c = seeded();
    as_("alice.near");
    c.create_proposal(
        "Budget".into(),
        "t".into(),
        vec!["a".into(), "b".into()],
        U64(60),
    );
}

#[test]
fn revote_replaces_weight_and_tie_keeps_budget() {
    let mut c = contract(true);
    units(&mut c, "alice.near", 50);
    units(&mut c, "bob.near", 50);
    let id = proposal(&mut c);
    as_("alice.near");
    c.vote(id, 1);
    c.vote(id, 0);
    as_("bob.near");
    c.vote(id, 1);
    assert_eq!(c.get_proposal(id).unwrap().voters, 2);
    as_("anyone.near");
    assert_eq!(c.finalize(id), ProposalStatus::NoChange);
    assert!(c.get_budget().is_none());
}

#[test]
#[should_panic(expected = "no active Board budget")]
fn expenses_require_board_approval() {
    let mut c = contract(true);
    expense(&mut c, MILLI);
}

#[test]
#[should_panic(expected = "expense exceeds active Board budget")]
fn board_budget_limits_cumulative_approvals() {
    let mut c = seeded();
    approve_budget(&mut c, 100 * MILLI);
    expense(&mut c, 60 * MILLI);
    expense(&mut c, 41 * MILLI);
}

#[test]
#[should_panic(expected = "expense payments pending")]
fn close_waits_for_expense_payment_result() {
    let mut c = seeded();
    buy(&mut c, "player.near", NEAR);
    let id = expense(&mut c, 100 * MILLI);
    as_("oracle.near");
    c.pay_expense(id);
    close(&mut c);
}

#[test]
fn failed_payment_then_close_uses_only_paid_costs_and_ignores_stale_callback() {
    let mut c = seeded();
    buy(&mut c, "player.near", NEAR);
    let id = expense(&mut c, 100 * MILLI);
    as_("oracle.near");
    c.pay_expense(id);
    callback(PromiseResult::Failed);
    assert!(!c.on_expense_paid(id, U128(1), 0)); // mismatched callback cannot change ledger
    assert_eq!(c.get_treasury().pending_expense_payments, 1);
    assert!(!c.on_expense_paid(id, U128(100 * MILLI), 0));
    assert!(!c.on_expense_paid(id, U128(100 * MILLI), 0)); // duplicate is ignored
    let r = close(&mut c);
    assert_eq!(r.period.operating_costs.0, 0);
    assert_eq!(r.period.net_distributable.0, 900 * MILLI);
    assert_eq!(c.get_treasury().expense_reserve.0, 100 * MILLI);
}

#[test]
fn failed_overpayment_is_refund_liability_never_distribution() {
    let mut c = seeded();
    buy(&mut c, "player.near", 3 * NEAR);
    callback(PromiseResult::Failed);
    assert!(!c.on_refund(acc("player.near"), U128(2 * NEAR)));
    assert_eq!(c.get_refund(acc("player.near")).0, 2 * NEAR);
    assert_eq!(claimable(&c, "player.near"), 0);
    assert_eq!(c.get_treasury().distribution_reserve.0, 0);
    close(&mut c);
    assert_eq!(claimable(&c, "alice.near"), 540 * MILLI);
    as_("player.near");
    let due = c.withdraw_refund();
    assert_eq!(c.get_treasury().refund_total.0, 0);
    callback(PromiseResult::Failed);
    c.on_refund(acc("player.near"), due);
    as_("player.near");
    c.withdraw_refund();
    callback(PromiseResult::Successful(vec![]));
    c.on_refund(acc("player.near"), due);
    assert_eq!(c.get_refund(acc("player.near")).0, 0);
    assert_eq!(claimable(&c, "player.near"), 0);
}

#[test]
#[should_panic(expected = "budget option must encode")]
fn budget_options_must_be_machine_readable() {
    let mut c = seeded();
    as_("ceo.near");
    c.create_proposal(
        "Budget".into(),
        "Invalid".into(),
        vec!["Spend freely".into(), "Nothing".into()],
        U64(60),
    );
}

#[test]
#[should_panic(expected = "period duration overflows timestamp")]
fn overflowing_period_duration_is_rejected() {
    let mut c = seeded();
    as_("owner.near");
    c.set_constraints(Constraints {
        period_secs: U64(u64::MAX),
        ..Constraints::default()
    });
}

#[test]
fn initial_kill_switch_is_applied_atomically() {
    as_("owner.near");
    let c = Contract::new(
        acc("owner.near"),
        acc("oracle.near"),
        acc("ceo.near"),
        None,
        Some(true),
        Some(true),
    );
    assert!(c.get_config().paused);
}

#[test]
fn contribution_report_retry_is_idempotent() {
    let mut c = contract(true);
    as_("oracle.near");
    assert!(c.record_contribution_once(acc("alice.near"), U128(100), "attempt-1".into()));
    assert!(!c.record_contribution_once(acc("alice.near"), U128(100), "attempt-1".into()));
    assert!(c.has_contribution_reference("attempt-1".into()));
    assert_eq!(c.get_contributor(acc("alice.near")).unwrap().units.0, 100);
}
#[test]
#[should_panic(expected = "contribution reference conflict")]
fn contribution_report_reference_cannot_change_payload() {
    let mut c = contract(true);
    as_("oracle.near");
    c.record_contribution_once(acc("alice.near"), U128(100), "attempt-1".into());
    c.record_contribution_once(acc("bob.near"), U128(100), "attempt-1".into());
}
