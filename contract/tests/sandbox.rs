//! Sandbox integration suite (near-sandbox + near-api, the successor stack to near-workspaces).
//! Covers the contract test list in docs/design-hackathon-mvp.md (Eng Review T4 + test plan).

use std::sync::{Arc, OnceLock};

use near_api::{AccountId, NearGas, NearToken, NetworkConfig, Signer};
use near_api::types::transaction::result::TransactionResult;
use near_sdk::serde_json::{json, Value};

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const MILLI: u128 = NEAR / 1000;

static WASM: OnceLock<Vec<u8>> = OnceLock::new();

fn wasm() -> Vec<u8> {
    WASM.get_or_init(|| {
        let path = cargo_near_build::build_with_cli(Default::default()).expect("build wasm");
        std::fs::read(path).expect("read wasm")
    })
    .clone()
}

struct Env {
    sandbox: near_sandbox::Sandbox,
    net: NetworkConfig,
    signer: Arc<Signer>,
    contract: AccountId,
}

fn id(name: &str) -> AccountId {
    format!("{name}.sandbox").parse().unwrap()
}

fn u(v: &Value) -> u128 {
    v.as_str().expect("u128 string").parse().unwrap()
}

impl Env {
    /// Fresh sandbox + contract. `platform_exists = false` leaves the platform account missing so
    /// the platform push fails and must land in claimable.
    async fn new(refund_timeout_secs: u64, platform_exists: bool) -> Self {
        let sandbox = near_sandbox::Sandbox::start_sandbox().await.unwrap();
        let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse().unwrap());
        let signer = Signer::from_secret_key(
            near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse().unwrap(),
        )
        .unwrap();
        let mut names = vec!["owner", "oracle", "ceo", "alice", "bob", "customer", "mallory"];
        if platform_exists {
            names.push("platform");
        }
        for n in names {
            sandbox
                .create_account(id(n).as_str().parse().unwrap())
                .initial_balance(NearToken::from_near(20))
                .send()
                .await
                .unwrap();
        }
        let contract = id("agentcorp");
        sandbox
            .create_account(contract.as_str().parse().unwrap())
            .initial_balance(NearToken::from_near(10))
            .send()
            .await
            .unwrap();
        near_api::Contract::deploy(contract.clone())
            .use_code(wasm())
            .with_init_call(
                "new",
                json!({
                    "owner": id("owner"), "oracle": id("oracle"), "ceo": id("ceo"),
                    "platform": id("platform"),
                    "refund_timeout_secs": refund_timeout_secs.to_string(),
                }),
            )
            .unwrap()
            .with_signer(signer.clone())
            .send_to(&net)
            .await
            .unwrap()
            .assert_success();
        let env = Self { sandbox, net, signer, contract };
        env.ok("oracle", "register_contributor", json!({"account_id": id("alice")})).await;
        env.ok("oracle", "register_contributor", json!({"account_id": id("bob")})).await;
        env
    }

    async fn call(&self, who: &str, method: &str, args: Value, deposit: u128) -> TransactionResult {
        near_api::Contract(self.contract.clone())
            .call_function(method, args)
            .transaction()
            .deposit(NearToken::from_yoctonear(deposit))
            .gas(NearGas::from_tgas(300))
            .with_signer(id(who), self.signer.clone())
            .send_to(&self.net)
            .await
            .unwrap()
    }

    async fn ok(&self, who: &str, method: &str, args: Value) -> Value {
        self.ok_dep(who, method, args, 0).await
    }

    async fn ok_dep(&self, who: &str, method: &str, args: Value, deposit: u128) -> Value {
        let r = self.call(who, method, args, deposit).await.assert_success();
        r.json::<Value>().unwrap_or(Value::Null)
    }

    async fn fails(&self, who: &str, method: &str, args: Value, deposit: u128, msg: &str) {
        let r = self.call(who, method, args, deposit).await;
        let f = format!("{:?}", r.assert_failure());
        assert!(f.contains(msg), "expected failure containing {msg:?}, got {f}");
    }

    async fn view(&self, method: &str, args: Value) -> Value {
        near_api::Contract(self.contract.clone())
            .call_function(method, args)
            .read_only()
            .fetch_from(&self.net)
            .await
            .unwrap()
            .data
    }

    async fn balance(&self, name: &str) -> u128 {
        near_api::Account(id(name))
            .tokens()
            .near_balance()
            .fetch_from(&self.net)
            .await
            .unwrap()
            .total
            .as_yoctonear()
    }

    async fn claimable(&self, name: &str) -> u128 {
        u(&self.view("get_claimable", json!({"account_id": id(name)})).await)
    }

    async fn stats(&self) -> Value {
        self.view("get_stats", json!({})).await
    }

    async fn job_status(&self, job: &str) -> String {
        self.view("get_job", json!({"job_id": job})).await["status"].as_str().unwrap().to_string()
    }

    async fn create_and_pay(&self, job: &str, price: u128, deposit: u128) {
        self.ok("oracle", "create_job", json!({"job_id": job, "price": price.to_string()})).await;
        self.ok_dep("customer", "pay", json!({"job_id": job}), deposit).await;
    }

    async fn settle(&self, job: &str, usages: &[(&str, u128)]) -> TransactionResult {
        let usages: Vec<Value> =
            usages.iter().map(|(a, n)| json!([id(a), n.to_string()])).collect();
        self.call("oracle", "settle", json!({"job_id": job, "usages": usages}), 0).await
    }
}

/// Treasury delta = expected − storage-cost delta (D24). The contract also earns a share of the
/// gas it burns, which can only add a little; allow that much on the upside.
fn assert_treasury_delta(before: &Value, after: &Value, expected: i128) {
    let cost = u(&after["storage_byte_cost"]) as i128;
    let s0 = before["storage_usage"].as_str().unwrap().parse::<i128>().unwrap();
    let s1 = after["storage_usage"].as_str().unwrap().parse::<i128>().unwrap();
    let want = expected - (s1 - s0) * cost;
    let got = u(&after["treasury"]) as i128 - u(&before["treasury"]) as i128;
    let gas_reward_slack = MILLI as i128; // 0.001 NEAR
    assert!(
        got >= want && got - want <= gas_reward_slack,
        "treasury delta {got} vs expected {want} (storage delta {} bytes)",
        s1 - s0
    );
}

// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn worked_example_and_withdraw() {
    let e = Env::new(600, true).await;
    let platform0 = e.balance("platform").await;
    let st0 = e.stats().await;

    // pay escrows: treasury unchanged apart from storage
    e.create_and_pay("job-1", NEAR, NEAR).await;
    let st1 = e.stats().await;
    assert_eq!(u(&st1["escrow_total"]), NEAR);
    assert_treasury_delta(&st0, &st1, 0);
    assert_eq!(e.job_status("job-1").await, "Paid");

    let receipt = e.settle("job-1", &[("alice", 62_000), ("bob", 38_000)]).await.assert_success();
    let receipt: Value = receipt.json().unwrap();
    assert_eq!(u(&receipt["contributor_pool"]), 700 * MILLI);
    assert_eq!(u(&receipt["treasury_share"]), 200 * MILLI);
    assert_eq!(u(&receipt["platform_share"]), 100 * MILLI);
    assert_eq!(u(&receipt["job_units"]), 100_000);

    assert_eq!(e.claimable("alice").await, 434 * MILLI);
    assert_eq!(e.claimable("bob").await, 266 * MILLI);
    assert_eq!(e.balance("platform").await - platform0, 100 * MILLI);
    let st2 = e.stats().await;
    assert_eq!(u(&st2["escrow_total"]), 0);
    assert_treasury_delta(&st1, &st2, (200 * MILLI) as i128);
    assert_eq!(e.job_status("job-1").await, "Settled");
    let stored = e.view("get_receipt", json!({"job_id": "job-1"})).await;
    assert_eq!(stored["usages"][0][0], json!(id("alice")));

    // contributor view
    let c = e.view("get_contributor", json!({"account_id": id("alice")})).await;
    assert_eq!(c["share_bps"], json!(6200));

    // withdraw moves the wallet; treasury unchanged apart from storage
    let alice0 = e.balance("alice").await;
    let paid = u(&e.ok("alice", "withdraw", json!({})).await);
    assert_eq!(paid, 434 * MILLI);
    let delta = e.balance("alice").await - alice0;
    assert!(delta > 430 * MILLI && delta < 434 * MILLI, "alice wallet delta {delta}");
    assert_eq!(e.claimable("alice").await, 0);
    let st3 = e.stats().await;
    assert_treasury_delta(&st2, &st3, 0);
    e.fails("alice", "withdraw", json!({}), 0, "nothing to withdraw").await;

    // double settle rejected
    let f = format!("{:?}", e.settle("job-1", &[("alice", 1)]).await.assert_failure());
    assert!(f.contains("job already settled"));
    // refund after settle rejected
    e.fails("customer", "refund", json!({"job_id": "job-1"}), 0, "job is not refundable").await;

    // stray deposit increases treasury
    let st4 = e.stats().await;
    near_api::Account(id("mallory"))
        .tokens()
        .send_to(e.contract.clone())
        .near(NearToken::from_near(1))
        .with_signer(e.signer.clone())
        .send_to(&e.net)
        .await
        .unwrap()
        .assert_success();
    let st5 = e.stats().await;
    assert_treasury_delta(&st4, &st5, NEAR as i128);
    let _ = &e.sandbox;
}

#[tokio::test]
async fn payment_rules() {
    let e = Env::new(600, true).await;

    // excess deposit refunded in the same call
    let c0 = e.balance("customer").await;
    e.create_and_pay("job-x", NEAR, 1_500 * MILLI).await;
    let spent = c0 - e.balance("customer").await;
    assert!(spent > NEAR && spent < NEAR + 10 * MILLI, "customer spent {spent}");
    assert_eq!(u(&e.stats().await["escrow_total"]), NEAR);

    // double pay
    e.fails("customer", "pay", json!({"job_id": "job-x"}), NEAR, "job is not awaiting payment").await;
    // unknown job
    e.fails("customer", "pay", json!({"job_id": "nope"}), NEAR, "unknown job").await;
    // deposit below price
    e.ok("oracle", "create_job", json!({"job_id": "job-low", "price": NEAR.to_string()})).await;
    e.fails("customer", "pay", json!({"job_id": "job-low"}), NEAR / 2, "deposit below job price").await;
    // settle before pay
    let f = format!("{:?}", e.settle("job-low", &[("alice", 10)]).await.assert_failure());
    assert!(f.contains("job is not paid"));
    // pay on price-0 job
    e.ok("oracle", "create_job", json!({"job_id": "ovh-1", "price": "0"})).await;
    e.fails("customer", "pay", json!({"job_id": "ovh-1"}), NEAR, "job has no price").await;
    // only oracle creates jobs
    e.fails("mallory", "create_job", json!({"job_id": "m", "price": "1"}), 0, "oracle only").await;
    // duplicate job id
    e.fails("oracle", "create_job", json!({"job_id": "job-x", "price": "1"}), 0, "job already exists").await;
}

#[tokio::test]
async fn overhead_settle_and_share_shift() {
    let e = Env::new(600, true).await;
    let platform0 = e.balance("platform").await;
    let st0 = e.stats().await;

    // price-0 overhead job settles without pay; units recorded, no money moves
    e.ok("oracle", "create_job", json!({"job_id": "ovh-ceo", "price": "0"})).await;
    let r: Value = e.settle("ovh-ceo", &[("bob", 100_000)]).await.assert_success().json().unwrap();
    assert_eq!(u(&r["price"]), 0);
    assert_eq!(u(&r["contributor_pool"]), 0);
    assert_eq!(e.job_status("ovh-ceo").await, "Settled");
    assert_eq!(e.balance("platform").await, platform0);
    let st1 = e.stats().await;
    assert_eq!(u(&st1["total_units"]), 100_000);
    assert_treasury_delta(&st0, &st1, 0);

    // sale served by alice 62k + bob 38k: lifetime alice 62k, bob 138k => 200k
    e.create_and_pay("job-1", NEAR, NEAR).await;
    e.settle("job-1", &[("alice", 62_000), ("bob", 38_000)]).await.assert_success();
    assert_eq!(e.claimable("alice").await, 217 * MILLI); // 0.7 * 62/200
    assert_eq!(e.claimable("bob").await, 483 * MILLI); // 0.7 * 138/200

    // second sale after more Bob usage shifts shares: alice 62k, bob 188k => 250k
    e.create_and_pay("job-2", NEAR, NEAR).await;
    e.settle("job-2", &[("bob", 50_000)]).await.assert_success();
    assert_eq!(e.claimable("alice").await, 217 * MILLI + 173_600_000_000_000_000_000_000);
    assert_eq!(e.claimable("bob").await, 483 * MILLI + 526_400_000_000_000_000_000_000);
    let st = e.stats().await;
    assert!(u(&st["overhead_outstanding"]) + u(&st["claimable_total"]) >= e.claimable("alice").await + e.claimable("bob").await);

    // rounding: 1 + 2 units, outstanding covers everything claimable
    e.create_and_pay("job-3", NEAR + 7, NEAR + 7).await;
    let r: Value = e.settle("job-3", &[("alice", 1), ("bob", 2)]).await.assert_success().json().unwrap();
    assert_eq!(u(&r["treasury_share"]), 200 * MILLI + 3); // bps dust to treasury
    let st = e.stats().await;
    let claim = e.claimable("alice").await + e.claimable("bob").await;
    assert!(u(&st["overhead_outstanding"]) + u(&st["claimable_total"]) >= claim);
}

#[tokio::test]
async fn settle_guards() {
    let e = Env::new(600, true).await;
    e.create_and_pay("job-1", NEAR, NEAR).await;
    let f = |r: TransactionResult| format!("{:?}", r.assert_failure());
    assert!(f(e.settle("job-1", &[("mallory", 10)]).await).contains("unregistered contributor"));
    assert!(f(e.settle("job-1", &[("alice", 5_000_001)]).await).contains("units exceed per-report cap"));
    let r = near_api::Contract(e.contract.clone())
        .call_function("settle", json!({"job_id": "job-1", "usages": [[id("alice"), "10"]]}))
        .transaction()
        .gas(NearGas::from_tgas(300))
        .with_signer(id("mallory"), e.signer.clone())
        .send_to(&e.net)
        .await
        .unwrap();
    assert!(f(r).contains("oracle only"));
    // the cap itself is allowed
    e.settle("job-1", &[("alice", 5_000_000)]).await.assert_success();
    // oracle cannot set the split; owner can; invalid sums rejected
    let split = json!({"split": {"contributor_bps": 8000, "treasury_bps": 1000, "platform_bps": 1000}});
    e.fails("oracle", "set_split", split.clone(), 0, "owner only").await;
    e.fails(
        "owner",
        "set_split",
        json!({"split": {"contributor_bps": 8000, "treasury_bps": 1000, "platform_bps": 999}}),
        0,
        "split must sum to 10000 bps",
    )
    .await;
    e.ok("owner", "set_split", split).await;
    assert_eq!(e.view("get_config", json!({})).await["split"]["contributor_bps"], json!(8000));
    // registering is oracle-only
    e.fails("mallory", "register_contributor", json!({"account_id": id("mallory")}), 0, "oracle only").await;
}

#[tokio::test]
async fn refund_paths() {
    let timeout = 60; // generous so slow CI never crosses it by wall clock
    let e = Env::new(timeout, true).await;
    e.create_and_pay("job-r", NEAR, NEAR).await;
    let platform0 = e.balance("platform").await;

    // zero-usage settle on a paid job is rejected; nothing moves, job stays Paid
    let f = format!("{:?}", e.settle("job-r", &[("alice", 0)]).await.assert_failure());
    assert!(f.contains("paid job needs non-zero units"));
    assert_eq!(e.job_status("job-r").await, "Paid");
    assert_eq!(e.balance("platform").await, platform0);
    assert_eq!(e.claimable("alice").await, 0);

    // before the timeout: rejected; non-payer: rejected
    e.fails("customer", "refund", json!({"job_id": "job-r"}), 0, "refund timeout not reached").await;
    e.sandbox.fast_forward(400).await.unwrap(); // block time, not wall clock
    e.fails("mallory", "refund", json!({"job_id": "job-r"}), 0, "only the payer can refund").await;

    let st0 = e.stats().await;
    let c0 = e.balance("customer").await;
    e.ok("customer", "refund", json!({"job_id": "job-r"})).await;
    let got = e.balance("customer").await - c0;
    assert!(got > NEAR - 10 * MILLI && got < NEAR, "customer refund delta {got}");
    assert_eq!(e.job_status("job-r").await, "Refunded");
    let st1 = e.stats().await;
    assert_eq!(u(&st1["escrow_total"]), 0);
    assert_treasury_delta(&st0, &st1, 0);

    // settle after refund and double refund rejected
    let f = format!("{:?}", e.settle("job-r", &[("alice", 10)]).await.assert_failure());
    assert!(f.contains("job was refunded"));
    e.fails("customer", "refund", json!({"job_id": "job-r"}), 0, "job is not refundable").await;
}

#[tokio::test]
async fn failed_platform_payout_becomes_claimable() {
    // platform account does not exist, so the push fails and the callback credits claimable
    let e = Env::new(600, false).await;
    e.create_and_pay("job-1", NEAR, NEAR).await;
    let st0 = e.stats().await;
    let r = e.settle("job-1", &[("alice", 62_000), ("bob", 38_000)]).await.assert_success();
    assert!(r.logs().iter().any(|l| l.contains("payout_failed")), "logs: {:?}", r.logs());
    assert_eq!(e.claimable("platform").await, 100 * MILLI);
    assert_eq!(e.claimable("alice").await, 434 * MILLI);
    let st1 = e.stats().await;
    assert_eq!(u(&st1["claimable_total"]), 100 * MILLI);
    // treasury still +0.20 (failed payout does not leak into treasury)
    assert_treasury_delta(&st0, &st1, (200 * MILLI) as i128);

    // platform account appears later and withdraws
    e.sandbox
        .create_account(id("platform").as_str().parse().unwrap())
        .initial_balance(NearToken::from_near(5))
        .send()
        .await
        .unwrap();
    let p0 = e.balance("platform").await;
    assert_eq!(u(&e.ok("platform", "withdraw", json!({})).await), 100 * MILLI);
    let d = e.balance("platform").await - p0;
    assert!(d > 95 * MILLI && d < 100 * MILLI, "platform delta {d}");
    assert_eq!(e.claimable("platform").await, 0);
    let st2 = e.stats().await;
    assert_eq!(u(&st2["claimable_total"]), 0);
    assert_treasury_delta(&st1, &st2, 0);
}

#[tokio::test]
async fn voting() {
    let e = Env::new(600, true).await;
    e.ok("oracle", "create_job", json!({"job_id": "ovh", "price": "0"})).await;
    e.settle("ovh", &[("alice", 62_000), ("bob", 38_000)]).await.assert_success();

    let propose = |title: &str, secs: u64| {
        json!({
            "kind": "BudgetSplit", "title": title,
            "options": ["product 60 / marketing 20 / self 10 / reserve 10",
                        "product 40 / marketing 40 / self 10 / reserve 10"],
            "voting_period_secs": secs.to_string(),
        })
    };
    e.fails("alice", "create_proposal", propose("x", 60), 0, "only the CEO can propose").await;
    let pid = e.ok("ceo", "create_proposal", propose("Q1 budget", 60)).await;
    assert_eq!(pid, json!(0));

    e.fails("mallory", "vote", json!({"proposal_id": 0, "option": 0}), 0, "only contributors with units can vote").await;
    e.ok("alice", "vote", json!({"proposal_id": 0, "option": 0})).await;
    // early finalize rejected (bob has not voted, period not over)
    e.fails("mallory", "finalize", json!({"proposal_id": 0}), 0, "voting still open").await;
    e.ok("bob", "vote", json!({"proposal_id": 0, "option": 1})).await;
    let p = e.view("get_proposal", json!({"proposal_id": 0})).await;
    assert_eq!(p["tallies"], json!(["62000", "38000"]));

    // weight = units at vote time; re-vote replaces and re-reads weight
    e.ok("oracle", "create_job", json!({"job_id": "ovh2", "price": "0"})).await;
    e.settle("ovh2", &[("bob", 40_000)]).await.assert_success();
    e.ok("bob", "vote", json!({"proposal_id": 0, "option": 1})).await;
    let p = e.view("get_proposal", json!({"proposal_id": 0})).await;
    assert_eq!(p["tallies"], json!(["62000", "78000"]));
    assert_eq!(p["voters"], json!(2));
    let v = e.view("get_vote", json!({"proposal_id": 0, "account_id": id("bob")})).await;
    assert_eq!(v["weight"], json!("78000"));

    // everyone voted => instant finalize by anyone
    let s = e.ok("mallory", "finalize", json!({"proposal_id": 0})).await;
    assert_eq!(s, json!({"type": "Passed", "option": 1}));
    let budget = e.view("get_budget", json!({})).await;
    assert_eq!(budget["option"], json!("product 40 / marketing 40 / self 10 / reserve 10"));
    e.fails("alice", "vote", json!({"proposal_id": 0, "option": 0}), 0, "proposal is closed").await;

    // tie keeps the status quo: alice 62k vs bob re-weighted... make weights equal first
    e.ok("oracle", "create_job", json!({"job_id": "ovh3", "price": "0"})).await;
    e.settle("ovh3", &[("alice", 16_000)]).await.assert_success(); // alice 78k == bob 78k
    e.ok("ceo", "create_proposal", propose("Q2 budget", 60)).await;
    e.ok("alice", "vote", json!({"proposal_id": 1, "option": 0})).await;
    e.ok("bob", "vote", json!({"proposal_id": 1, "option": 1})).await;
    let s = e.ok("mallory", "finalize", json!({"proposal_id": 1})).await;
    assert_eq!(s, json!({"type": "NoChange"}));
    let budget = e.view("get_budget", json!({})).await;
    assert_eq!(budget["proposal_id"], json!(0));

    // zero participation after the period => no change
    e.ok("ceo", "create_proposal", propose("Q3 budget", 30)).await;
    e.sandbox.fast_forward(400).await.unwrap();
    let s = e.ok("mallory", "finalize", json!({"proposal_id": 2})).await;
    assert_eq!(s, json!({"type": "NoChange"}));
}
