use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const MILLI: u128 = NEAR / 1000;

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

fn as_(predecessor: &str) {
    testing_env!(ctx(predecessor, 0, 1_000).build());
}

fn new_contract() -> Contract {
    as_("owner.near");
    let mut c = Contract::new(
        acc("owner.near"),
        acc("oracle.near"),
        acc("ceo.near"),
        acc("platform.near"),
        None,
        None,
    );
    as_("oracle.near");
    c.register_contributor(acc("alice.near"));
    c.register_contributor(acc("bob.near"));
    c
}

fn paid_job(c: &mut Contract, id: &str, price: u128) {
    as_("oracle.near");
    c.create_job(id.into(), U128(price));
    testing_env!(ctx("customer.near", price, 1_000).build());
    c.pay(id.into());
}

fn usages(v: &[(&str, u128)]) -> Vec<(AccountId, U128)> {
    v.iter().map(|(a, u)| (acc(a), U128(*u))).collect()
}

fn claimable(c: &Contract, a: &str) -> u128 {
    c.get_claimable(acc(a)).0
}

// ------------------------------------------------------------------ mul_div / split

#[test]
fn mul_div_exact_at_u128_max_scale() {
    assert_eq!(mul_div(u128::MAX, u128::MAX, u128::MAX), u128::MAX);
    assert_eq!(mul_div(u128::MAX, 2, 4), u128::MAX / 2);
    assert_eq!(mul_div(u128::MAX, 7_000, 10_000), u128::MAX / 10_000 * 7_000 + (u128::MAX % 10_000) * 7_000 / 10_000);
    // accumulator-scale intermediate (1e24 * 1e24) does not overflow
    assert_eq!(mul_div(NEAR, ACC_SCALE, ACC_SCALE), NEAR);
    assert_eq!(mul_div(10, 3, 4), 7);
}

#[test]
#[should_panic(expected = "mul_div: result overflows u128")]
fn mul_div_overflow_panics() {
    mul_div(u128::MAX, 2, 1);
}

#[test]
#[should_panic(expected = "mul_div: division by zero")]
fn mul_div_zero_div_panics() {
    mul_div(1, 1, 0);
}

#[test]
fn split_worked_example() {
    let s = compute_split(NEAR, &Split::default(), 100_000);
    assert_eq!(s, SaleSplit { contributor_pool: 700 * MILLI, treasury: 200 * MILLI, platform: 100 * MILLI });
}

#[test]
fn split_rounding_dust_goes_to_treasury() {
    let price = NEAR + 7;
    let s = compute_split(price, &Split::default(), 1);
    assert_eq!(s.platform, 100 * MILLI); // 0.7 yocto floored
    assert_eq!(s.contributor_pool, 700 * MILLI + 4); // 4.9 yocto floored
    assert_eq!(s.treasury, 200 * MILLI + 3); // 1.4 + dust
    assert_eq!(s.platform + s.contributor_pool + s.treasury, price);
}

#[test]
fn split_zero_lifetime_units_pool_to_treasury() {
    let s = compute_split(NEAR, &Split::default(), 0);
    assert_eq!(s.contributor_pool, 0);
    assert_eq!(s.treasury, 900 * MILLI);
    assert_eq!(s.platform, 100 * MILLI);
}

// ------------------------------------------------------------------ accumulator

#[test]
fn worked_example_fresh_contract() {
    let mut c = new_contract();
    paid_job(&mut c, "job-1", NEAR);
    as_("oracle.near");
    let r = c.settle("job-1".into(), usages(&[("alice.near", 62_000), ("bob.near", 38_000)]));
    assert_eq!(r.contributor_pool.0, 700 * MILLI);
    assert_eq!(r.treasury_share.0, 200 * MILLI);
    assert_eq!(r.platform_share.0, 100 * MILLI);
    assert_eq!(claimable(&c, "alice.near"), 434 * MILLI);
    assert_eq!(claimable(&c, "bob.near"), 266 * MILLI);
    assert_eq!(c.overhead_outstanding, 700 * MILLI);
    assert_eq!(c.escrow_total, 0);
    assert_eq!(c.get_job("job-1".into()).unwrap().status, JobStatus::Settled);
}

#[test]
fn second_sale_after_more_bob_usage_shifts_shares() {
    let mut c = new_contract();
    paid_job(&mut c, "job-1", NEAR);
    as_("oracle.near");
    c.settle("job-1".into(), usages(&[("alice.near", 62_000), ("bob.near", 38_000)]));
    // overhead job: Bob +100k units, no money
    c.create_job("ovh-1".into(), U128(0));
    c.settle("ovh-1".into(), usages(&[("bob.near", 100_000)]));
    assert_eq!(claimable(&c, "alice.near"), 434 * MILLI);
    assert_eq!(claimable(&c, "bob.near"), 266 * MILLI);
    // second sale served by Bob 50k: totals alice 62k, bob 188k => 250k
    paid_job(&mut c, "job-2", NEAR);
    as_("oracle.near");
    c.settle("job-2".into(), usages(&[("bob.near", 50_000)]));
    assert_eq!(claimable(&c, "alice.near"), 434 * MILLI + 173_600_000_000_000_000_000_000);
    assert_eq!(claimable(&c, "bob.near"), 266 * MILLI + 526_400_000_000_000_000_000_000);
    assert_eq!(c.overhead_outstanding + c.claimable_total, 1_400 * MILLI);
}

#[test]
fn accumulator_residue_stays_outstanding() {
    let mut c = new_contract();
    paid_job(&mut c, "job-1", NEAR);
    as_("oracle.near");
    c.settle("job-1".into(), usages(&[("alice.near", 1), ("bob.near", 2)]));
    let a = claimable(&c, "alice.near");
    let b = claimable(&c, "bob.near");
    assert!(a + b <= 700 * MILLI);
    assert!(c.overhead_outstanding >= a + b);
    assert!(700 * MILLI - (a + b) < 3); // at most 1 yocto lost per payee
}

#[test]
fn withdraw_zeroes_pending_and_moves_to_payout() {
    let mut c = new_contract();
    paid_job(&mut c, "job-1", NEAR);
    as_("oracle.near");
    c.settle("job-1".into(), usages(&[("alice.near", 62_000), ("bob.near", 38_000)]));
    as_("alice.near");
    assert_eq!(c.withdraw().0, 434 * MILLI);
    assert_eq!(claimable(&c, "alice.near"), 0);
    assert_eq!(c.claimable_total, 0);
    assert_eq!(c.overhead_outstanding, 266 * MILLI);
}

#[test]
#[should_panic(expected = "nothing to withdraw")]
fn withdraw_nothing_panics() {
    let mut c = new_contract();
    as_("alice.near");
    c.withdraw();
}

#[test]
fn failed_payout_callback_credits_claimable() {
    let mut c = new_contract();
    testing_env!(
        ctx("agentcorp.near", 0, 1_000).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed],
    );
    assert!(!c.on_payout(acc("platform.near"), U128(100 * MILLI)));
    assert_eq!(claimable(&c, "platform.near"), 100 * MILLI);
    assert_eq!(c.claimable_total, 100 * MILLI);
    testing_env!(
        ctx("agentcorp.near", 0, 1_000).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(vec![])],
    );
    assert!(c.on_payout(acc("platform.near"), U128(5)));
    assert_eq!(claimable(&c, "platform.near"), 100 * MILLI);
}

// ------------------------------------------------------------------ state machine

#[test]
#[should_panic(expected = "job is not paid")]
fn settle_before_pay_rejected() {
    let mut c = new_contract();
    as_("oracle.near");
    c.create_job("job-1".into(), U128(NEAR));
    c.settle("job-1".into(), usages(&[("alice.near", 1)]));
}

#[test]
#[should_panic(expected = "paid job needs non-zero units")]
fn zero_usage_settle_rejected() {
    let mut c = new_contract();
    paid_job(&mut c, "job-1", NEAR);
    as_("oracle.near");
    c.settle("job-1".into(), usages(&[("alice.near", 0)]));
}

#[test]
#[should_panic(expected = "job has no price")]
fn pay_price_zero_rejected() {
    let mut c = new_contract();
    as_("oracle.near");
    c.create_job("ovh".into(), U128(0));
    testing_env!(ctx("customer.near", NEAR, 1_000).build());
    c.pay("ovh".into());
}

#[test]
#[should_panic(expected = "units exceed per-report cap")]
fn over_cap_rejected() {
    let mut c = new_contract();
    paid_job(&mut c, "job-1", NEAR);
    as_("oracle.near");
    c.settle("job-1".into(), usages(&[("alice.near", MAX_UNITS_PER_REPORT + 1)]));
}

#[test]
#[should_panic(expected = "unregistered contributor")]
fn unregistered_rejected() {
    let mut c = new_contract();
    paid_job(&mut c, "job-1", NEAR);
    as_("oracle.near");
    c.settle("job-1".into(), usages(&[("mallory.near", 10)]));
}

#[test]
#[should_panic(expected = "owner only")]
fn oracle_cannot_set_split() {
    let mut c = new_contract();
    as_("oracle.near");
    c.set_split(Split { contributor_bps: 10_000, treasury_bps: 0, platform_bps: 0 });
}

#[test]
#[should_panic(expected = "refund timeout not reached")]
fn refund_before_timeout_rejected() {
    let mut c = new_contract();
    paid_job(&mut c, "job-1", NEAR);
    testing_env!(ctx("customer.near", 0, 1_000 + 599).build());
    c.refund("job-1".into());
}

#[test]
fn refund_after_timeout() {
    let mut c = new_contract();
    paid_job(&mut c, "job-1", NEAR);
    testing_env!(ctx("customer.near", 0, 1_000 + 600).build());
    c.refund("job-1".into());
    assert_eq!(c.get_job("job-1".into()).unwrap().status, JobStatus::Refunded);
    assert_eq!(c.escrow_total, 0);
}

// ------------------------------------------------------------------ voting

fn voting_contract(alice: u128, bob: u128) -> Contract {
    let mut c = new_contract();
    as_("oracle.near");
    c.create_job("ovh".into(), U128(0));
    c.settle("ovh".into(), usages(&[("alice.near", alice), ("bob.near", bob)]));
    as_("ceo.near");
    c.create_proposal(
        "BudgetSplit".into(),
        "Q1 budget".into(),
        vec!["60/20/10/10".into(), "40/40/10/10".into()],
        U64(60),
    );
    c
}

#[test]
fn vote_weight_rewrite_and_instant_finalize() {
    let mut c = voting_contract(62_000, 38_000);
    as_("alice.near");
    c.vote(0, 0);
    as_("bob.near");
    c.vote(0, 1);
    let p = c.get_proposal(0).unwrap();
    assert_eq!(p.tallies, vec![U128(62_000), U128(38_000)]);
    // Bob earns more units, re-votes: weight re-read, old vote replaced
    as_("oracle.near");
    c.create_job("ovh2".into(), U128(0));
    c.settle("ovh2".into(), usages(&[("bob.near", 40_000)]));
    as_("bob.near");
    c.vote(0, 1);
    let p = c.get_proposal(0).unwrap();
    assert_eq!(p.tallies, vec![U128(62_000), U128(78_000)]);
    assert_eq!(p.voters, 2);
    assert_eq!(c.finalize(0), ProposalStatus::Passed { option: 1 });
    assert_eq!(c.get_budget().unwrap().option, "40/40/10/10");
}

#[test]
#[should_panic(expected = "voting still open")]
fn early_finalize_rejected() {
    let mut c = voting_contract(62_000, 38_000);
    as_("alice.near");
    c.vote(0, 0);
    c.finalize(0);
}

#[test]
fn finalize_after_period_and_tie_keeps_status_quo() {
    let mut c = voting_contract(50_000, 50_000);
    as_("alice.near");
    c.vote(0, 0);
    as_("bob.near");
    c.vote(0, 1);
    assert_eq!(c.finalize(0), ProposalStatus::NoChange);
    assert!(c.get_budget().is_none());
}

#[test]
fn zero_participation_after_period_no_change() {
    let mut c = voting_contract(1, 1);
    testing_env!(ctx("anyone.near", 0, 1_000 + 61).build());
    assert_eq!(c.finalize(0), ProposalStatus::NoChange);
}

#[test]
#[should_panic(expected = "only the CEO can propose")]
fn non_ceo_cannot_propose() {
    let mut c = new_contract();
    as_("alice.near");
    c.create_proposal("BudgetSplit".into(), "x".into(), vec!["a".into(), "b".into()], U64(60));
}

#[test]
#[should_panic(expected = "only contributors with units can vote")]
fn zero_unit_account_cannot_vote() {
    let mut c = voting_contract(1, 1);
    as_("mallory.near");
    c.vote(0, 0);
}
