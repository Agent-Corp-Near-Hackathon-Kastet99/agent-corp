//! Agent Corp contract: job escrow, revenue split by metered units, board votes.
//!
//! Money flow for a paid job (see docs/design-hackathon-mvp.md, Eng Review D3/D4/D5/D10/D12/D14/D24):
//! - `create_job` (oracle) -> `pay` (customer, escrow) -> `settle` (oracle) or `refund` (payer, after timeout).
//! - On settle the price is split by basis points into:
//!   - contributor pool: distributed to ALL contributors pro-rata to lifetime units through a
//!     reward-per-unit accumulator (O(payees of this job)); shares become claimable via `withdraw()`.
//!   - platform: pushed with a `#[private]` failure callback that credits claimable on failure.
//!   - treasury: never transferred; it is derived from the contract balance minus storage and
//!     tracked liabilities, and receives all rounding dust from the bps split.
//! - 1 unit = 1 micro-USD of list-price-equivalent inference.

use near_sdk::json_types::{U128, U64};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
};

uint::construct_uint! {
    /// 256-bit unsigned integer used for all share math (D14).
    pub struct U256(4);
}

/// Accumulator scale (1e24).
pub const ACC_SCALE: u128 = 1_000_000_000_000_000_000_000_000;
pub const BPS_DENOM: u16 = 10_000;
/// Per-account cap on units in one settle report (D12): $5 list-price-equivalent.
pub const MAX_UNITS_PER_REPORT: u128 = 5_000_000;
/// Bound on usage entries per settle so gas stays bounded.
pub const MAX_USAGES_PER_SETTLE: usize = 20;
pub const DEFAULT_REFUND_TIMEOUT_SECS: u64 = 600;
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
const MAX_JOB_ID_LEN: usize = 64;
const MAX_OPTIONS: usize = 6;
const MAX_OPTION_LEN: usize = 160;
const MAX_TITLE_LEN: usize = 200;
const PROPOSAL_KINDS: [&str; 1] = ["BudgetSplit"];

/// `a * b / c` with a 256-bit intermediate. Panics on `c == 0` or if the result exceeds u128.
pub fn mul_div(a: u128, b: u128, c: u128) -> u128 {
    require!(c != 0, "mul_div: division by zero");
    let r = U256::from(a) * U256::from(b) / U256::from(c);
    require!(r <= U256::from(u128::MAX), "mul_div: result overflows u128");
    r.as_u128()
}

fn u256_to_words(v: U256) -> [u64; 4] {
    v.0
}

fn words_to_u256(w: [u64; 4]) -> U256 {
    U256(w)
}

/// Split of a sale price. All values in yoctoNEAR.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct SaleSplit {
    pub contributor_pool: u128,
    pub treasury: u128,
    pub platform: u128,
}

/// Pure split rule: bps legs rounded down, all dust to treasury. If no contributor holds any
/// lifetime units, the contributor pool also goes to treasury.
pub fn compute_split(price: u128, split: &Split, total_units_after: u128) -> SaleSplit {
    let platform = mul_div(price, split.platform_bps as u128, BPS_DENOM as u128);
    let mut pool = mul_div(price, split.contributor_bps as u128, BPS_DENOM as u128);
    if total_units_after == 0 {
        pool = 0;
    }
    let treasury = price - platform - pool;
    SaleSplit { contributor_pool: pool, treasury, platform }
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Contributors,
    ContributorIds,
    Claimable,
    Jobs,
    Receipts,
    Proposals,
    Votes,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Split {
    pub contributor_bps: u16,
    pub treasury_bps: u16,
    pub platform_bps: u16,
}

impl Split {
    fn assert_valid(&self) {
        require!(
            self.contributor_bps as u32 + self.treasury_bps as u32 + self.platform_bps as u32
                == BPS_DENOM as u32,
            "split must sum to 10000 bps"
        );
    }
}

impl Default for Split {
    /// Placeholder split (Open Question 2): 70% contributors / 20% treasury / 10% platform.
    fn default() -> Self {
        Self { contributor_bps: 7_000, treasury_bps: 2_000, platform_bps: 1_000 }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobStatus {
    Created,
    Paid,
    Settled,
    Refunded,
}

#[near(serializers = [borsh])]
pub struct Job {
    price: u128,
    status: JobStatus,
    payer: Option<AccountId>,
    created_at: u64,
    paid_at: u64,
}

#[near(serializers = [json])]
pub struct JobView {
    pub job_id: String,
    pub price: U128,
    pub status: JobStatus,
    pub payer: Option<AccountId>,
    pub created_at: U64,
    pub paid_at: U64,
    /// Earliest timestamp (ns) at which the payer may refund, when Paid.
    pub refundable_at: Option<U64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Receipt {
    pub job_id: String,
    pub price: U128,
    pub payer: Option<AccountId>,
    /// Workers that served this job (attribution) and their metered units.
    pub usages: Vec<(AccountId, U128)>,
    pub job_units: U128,
    pub contributor_pool: U128,
    pub treasury_share: U128,
    pub platform_share: U128,
    pub platform: AccountId,
    pub total_units_after: U128,
    pub settled_at: U64,
}

#[near(serializers = [borsh])]
pub struct Contributor {
    units: u128,
    /// Accumulator value at this contributor's last checkpoint (U256 words).
    acc_snapshot: [u64; 4],
    registered_at: u64,
}

#[near(serializers = [json])]
pub struct ContributorView {
    pub account_id: AccountId,
    pub units: U128,
    /// Claimable now, including overhead share not yet checkpointed.
    pub claimable: U128,
    /// Share of all lifetime units, in bps.
    pub share_bps: u32,
    pub registered_at: U64,
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
    /// Weighted tally per option (weight = voter's lifetime units at vote time, D6).
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
}

#[near(serializers = [json])]
pub struct Config {
    pub owner: AccountId,
    pub oracle: AccountId,
    pub ceo: AccountId,
    pub platform: AccountId,
    pub split: Split,
    pub refund_timeout_secs: U64,
    pub max_units_per_report: U128,
}

#[near(serializers = [json])]
pub struct Stats {
    pub contributors: u32,
    pub contributors_with_units: u32,
    pub total_units: U128,
    pub escrow_total: U128,
    pub claimable_total: U128,
    pub overhead_outstanding: U128,
    pub acc_per_unit: String,
    pub storage_usage: U64,
    pub storage_byte_cost: U128,
    pub account_balance: U128,
    pub treasury: U128,
    pub jobs: u64,
    pub proposals: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    oracle: AccountId,
    ceo: AccountId,
    platform: AccountId,
    split: Split,
    refund_timeout_ns: u64,

    contributors: LookupMap<AccountId, Contributor>,
    contributor_ids: Vector<AccountId>,
    contributors_with_units: u32,
    total_units: u128,
    acc_per_unit: [u64; 4],

    claimable: LookupMap<AccountId, u128>,
    /// Liabilities excluded from the derived treasury (D5).
    escrow_total: u128,
    claimable_total: u128,
    /// Contributor-pool funds credited to the accumulator but not yet checkpointed into
    /// claimable. Rounding residue stays here forever (D24).
    overhead_outstanding: u128,

    jobs: LookupMap<String, Job>,
    job_count: u64,
    receipts: LookupMap<String, Receipt>,

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
            "version": "1.0.0",
            "event": event,
            "data": [data],
        })
    ));
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        owner: AccountId,
        oracle: AccountId,
        ceo: AccountId,
        platform: AccountId,
        split: Option<Split>,
        refund_timeout_secs: Option<U64>,
    ) -> Self {
        require!(owner != oracle, "owner and oracle must be different accounts");
        let split = split.unwrap_or_default();
        split.assert_valid();
        let timeout = refund_timeout_secs.map(|t| t.0).unwrap_or(DEFAULT_REFUND_TIMEOUT_SECS);
        Self {
            owner,
            oracle,
            ceo,
            platform,
            split,
            refund_timeout_ns: timeout * 1_000_000_000,
            contributors: LookupMap::new(StorageKey::Contributors),
            contributor_ids: Vector::new(StorageKey::ContributorIds),
            contributors_with_units: 0,
            total_units: 0,
            acc_per_unit: [0; 4],
            claimable: LookupMap::new(StorageKey::Claimable),
            escrow_total: 0,
            claimable_total: 0,
            overhead_outstanding: 0,
            jobs: LookupMap::new(StorageKey::Jobs),
            job_count: 0,
            receipts: LookupMap::new(StorageKey::Receipts),
            proposals: LookupMap::new(StorageKey::Proposals),
            next_proposal_id: 0,
            votes: LookupMap::new(StorageKey::Votes),
            budget: None,
        }
    }

    // ---------------------------------------------------------------- admin (owner)

    pub fn set_split(&mut self, split: Split) {
        self.assert_owner();
        split.assert_valid();
        self.split = split;
        emit("set_split", near_sdk::serde_json::to_value(split).unwrap());
    }

    pub fn set_oracle(&mut self, oracle: AccountId) {
        self.assert_owner();
        require!(oracle != self.owner, "owner and oracle must be different accounts");
        self.oracle = oracle;
    }

    pub fn set_ceo(&mut self, ceo: AccountId) {
        self.assert_owner();
        self.ceo = ceo;
    }

    pub fn set_platform(&mut self, platform: AccountId) {
        self.assert_owner();
        self.platform = platform;
    }

    // ---------------------------------------------------------------- contributors (oracle)

    /// Oracle-only, after NEP-413 verification off-chain. Returns false if already registered.
    pub fn register_contributor(&mut self, account_id: AccountId) -> bool {
        self.assert_oracle();
        if self.contributors.contains_key(&account_id) {
            return false;
        }
        self.contributors.insert(
            account_id.clone(),
            Contributor {
                units: 0,
                acc_snapshot: self.acc_per_unit,
                registered_at: env::block_timestamp(),
            },
        );
        self.contributor_ids.push(account_id.clone());
        emit("register_contributor", near_sdk::serde_json::json!({ "account_id": account_id }));
        true
    }

    // ---------------------------------------------------------------- jobs

    /// Oracle-only. `price` = 0 marks an internal overhead job (CEO research, build, ...).
    pub fn create_job(&mut self, job_id: String, price: U128) {
        self.assert_oracle();
        require!(!job_id.is_empty() && job_id.len() <= MAX_JOB_ID_LEN, "invalid job_id");
        require!(!self.jobs.contains_key(&job_id), "job already exists");
        self.jobs.insert(
            job_id.clone(),
            Job {
                price: price.0,
                status: JobStatus::Created,
                payer: None,
                created_at: env::block_timestamp(),
                paid_at: 0,
            },
        );
        self.job_count += 1;
        emit("create_job", near_sdk::serde_json::json!({ "job_id": job_id, "price": price }));
    }

    /// Customer escrows the job price. Any deposit above the price is refunded in the same call.
    #[payable]
    pub fn pay(&mut self, job_id: String) {
        let deposit = env::attached_deposit().as_yoctonear();
        let payer = env::predecessor_account_id();
        let job = self.jobs.get_mut(&job_id).unwrap_or_else(|| env::panic_str("unknown job"));
        require!(job.price > 0, "job has no price");
        require!(job.status == JobStatus::Created, "job is not awaiting payment");
        require!(deposit >= job.price, "deposit below job price");
        let price = job.price;
        job.status = JobStatus::Paid;
        job.payer = Some(payer.clone());
        job.paid_at = env::block_timestamp();
        self.escrow_total += price;
        emit(
            "pay",
            near_sdk::serde_json::json!({ "job_id": job_id, "payer": payer, "amount": U128(price) }),
        );
        let excess = deposit - price;
        if excess > 0 {
            self.push_payout(payer, excess);
        }
    }

    /// Oracle-only. Writes the receipt, adds units to lifetime totals and splits the escrow.
    pub fn settle(&mut self, job_id: String, usages: Vec<(AccountId, U128)>) -> Receipt {
        self.assert_oracle();
        require!(usages.len() <= MAX_USAGES_PER_SETTLE, "too many usage entries");
        let (price, payer) = {
            let job = self.jobs.get(&job_id).unwrap_or_else(|| env::panic_str("unknown job"));
            match job.status {
                JobStatus::Created => require!(job.price == 0, "job is not paid"),
                JobStatus::Paid => {}
                JobStatus::Settled => env::panic_str("job already settled"),
                JobStatus::Refunded => env::panic_str("job was refunded"),
            }
            (job.price, job.payer.clone())
        };

        let mut job_units: u128 = 0;
        for (account_id, units) in usages.iter() {
            require!(self.contributors.contains_key(account_id), "unregistered contributor");
            require!(units.0 <= MAX_UNITS_PER_REPORT, "units exceed per-report cap");
            job_units += units.0;
        }
        require!(price == 0 || job_units > 0, "paid job needs non-zero units");

        // Units first, so this job's contributors share in this sale (pre-pool update order).
        for (account_id, units) in usages.iter() {
            self.add_units(account_id, units.0);
        }

        let split = compute_split(price, &self.split, self.total_units);
        if split.contributor_pool > 0 {
            let inc = U256::from(split.contributor_pool) * U256::from(ACC_SCALE)
                / U256::from(self.total_units);
            let acc = words_to_u256(self.acc_per_unit) + inc;
            self.acc_per_unit = u256_to_words(acc);
            self.overhead_outstanding += split.contributor_pool;
        }

        let job = self.jobs.get_mut(&job_id).unwrap();
        job.status = JobStatus::Settled;
        self.escrow_total -= price;

        let receipt = Receipt {
            job_id: job_id.clone(),
            price: U128(price),
            payer,
            usages,
            job_units: U128(job_units),
            contributor_pool: U128(split.contributor_pool),
            treasury_share: U128(split.treasury),
            platform_share: U128(split.platform),
            platform: self.platform.clone(),
            total_units_after: U128(self.total_units),
            settled_at: U64(env::block_timestamp()),
        };
        self.receipts.insert(job_id, receipt.clone());
        emit("settle", near_sdk::serde_json::to_value(&receipt).unwrap());

        if split.platform > 0 {
            self.push_payout(self.platform.clone(), split.platform);
        }
        receipt
    }

    /// Stored payer only, after the refund timeout, while the job is still Paid.
    pub fn refund(&mut self, job_id: String) {
        let caller = env::predecessor_account_id();
        let job = self.jobs.get_mut(&job_id).unwrap_or_else(|| env::panic_str("unknown job"));
        require!(job.status == JobStatus::Paid, "job is not refundable");
        require!(job.payer.as_ref() == Some(&caller), "only the payer can refund");
        require!(
            env::block_timestamp() >= job.paid_at + self.refund_timeout_ns,
            "refund timeout not reached"
        );
        job.status = JobStatus::Refunded;
        let price = job.price;
        self.escrow_total -= price;
        emit(
            "refund",
            near_sdk::serde_json::json!({ "job_id": job_id, "payer": caller, "amount": U128(price) }),
        );
        self.push_payout(caller, price);
    }

    /// Pays out the caller's claimable balance (failed payouts + contributor-pool share).
    pub fn withdraw(&mut self) -> U128 {
        let caller = env::predecessor_account_id();
        if self.contributors.contains_key(&caller) {
            self.checkpoint(&caller);
        }
        let amount = self.claimable.remove(&caller).unwrap_or(0);
        require!(amount > 0, "nothing to withdraw");
        self.claimable_total -= amount;
        emit(
            "withdraw",
            near_sdk::serde_json::json!({ "account_id": caller, "amount": U128(amount) }),
        );
        self.push_payout(caller, amount);
        U128(amount)
    }

    /// Callback for every outgoing transfer. Never panics: on failure the amount is credited to
    /// the account's claimable balance (the transfer's refund returns the funds to this contract).
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

    // ---------------------------------------------------------------- governance

    /// CEO agent account only.
    pub fn create_proposal(
        &mut self,
        kind: String,
        title: String,
        options: Vec<String>,
        voting_period_secs: U64,
    ) -> u64 {
        require!(env::predecessor_account_id() == self.ceo, "only the CEO can propose");
        require!(PROPOSAL_KINDS.contains(&kind.as_str()), "unsupported proposal kind");
        require!(title.len() <= MAX_TITLE_LEN, "title too long");
        require!(options.len() >= 2 && options.len() <= MAX_OPTIONS, "need 2-6 options");
        require!(
            options.iter().all(|o| !o.is_empty() && o.len() <= MAX_OPTION_LEN),
            "invalid option"
        );
        require!(voting_period_secs.0 > 0, "voting period must be positive");
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
            ends_at: U64(now + voting_period_secs.0 * 1_000_000_000),
            status: ProposalStatus::Open,
        };
        emit("create_proposal", near_sdk::serde_json::to_value(&proposal).unwrap());
        self.proposals.insert(id, proposal);
        id
    }

    /// Weight = caller's lifetime units now (D6). Re-voting replaces the vote and re-reads weight.
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
        require!(proposal.status == ProposalStatus::Open, "proposal is closed");
        require!(env::block_timestamp() < proposal.ends_at.0, "voting period ended");
        require!((option as usize) < proposal.options.len(), "invalid option");
        match previous {
            Some(prev) => {
                let t = &mut proposal.tallies[prev.option as usize];
                t.0 -= prev.weight.0;
            }
            None => proposal.voters += 1,
        }
        proposal.tallies[option as usize].0 += weight;
        self.votes.insert(key, Vote { option, weight: U128(weight) });
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
        require!(proposal.status == ProposalStatus::Open, "proposal is closed");
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
            ProposalStatus::Passed { option: winners[0] as u32 }
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
            platform: self.platform.clone(),
            split: self.split,
            refund_timeout_secs: U64(self.refund_timeout_ns / 1_000_000_000),
            max_units_per_report: U128(MAX_UNITS_PER_REPORT),
        }
    }

    /// Derived treasury (D5/D24): balance − storage stake − escrow − claimable − outstanding.
    pub fn get_treasury(&self) -> U128 {
        U128(self.treasury())
    }

    pub fn get_stats(&self) -> Stats {
        Stats {
            contributors: self.contributor_ids.len(),
            contributors_with_units: self.contributors_with_units,
            total_units: U128(self.total_units),
            escrow_total: U128(self.escrow_total),
            claimable_total: U128(self.claimable_total),
            overhead_outstanding: U128(self.overhead_outstanding),
            acc_per_unit: words_to_u256(self.acc_per_unit).to_string(),
            storage_usage: U64(env::storage_usage()),
            storage_byte_cost: U128(env::storage_byte_cost().as_yoctonear()),
            account_balance: U128(env::account_balance().as_yoctonear()),
            treasury: U128(self.treasury()),
            jobs: self.job_count,
            proposals: self.next_proposal_id,
        }
    }

    pub fn get_job(&self, job_id: String) -> Option<JobView> {
        self.jobs.get(&job_id).map(|j| JobView {
            job_id: job_id.clone(),
            price: U128(j.price),
            status: j.status,
            payer: j.payer.clone(),
            created_at: U64(j.created_at),
            paid_at: U64(j.paid_at),
            refundable_at: (j.status == JobStatus::Paid)
                .then(|| U64(j.paid_at + self.refund_timeout_ns)),
        })
    }

    pub fn get_receipt(&self, job_id: String) -> Option<Receipt> {
        self.receipts.get(&job_id).cloned()
    }

    pub fn get_contributor(&self, account_id: AccountId) -> Option<ContributorView> {
        self.contributors.get(&account_id).map(|c| self.contributor_view(&account_id, c))
    }

    pub fn get_contributors(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<ContributorView> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100);
        (from..self.contributor_ids.len().min(from.saturating_add(limit)))
            .filter_map(|i| {
                let id = self.contributor_ids.get(i)?;
                self.contributors.get(id).map(|c| self.contributor_view(id, c))
            })
            .collect()
    }

    /// Claimable for any account (contributor or not), including un-checkpointed overhead share.
    pub fn get_claimable(&self, account_id: AccountId) -> U128 {
        let base = self.claimable.get(&account_id).copied().unwrap_or(0);
        let pending = self.contributors.get(&account_id).map(|c| self.pending(c)).unwrap_or(0);
        U128(base + pending)
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
        self.budget.as_ref().map(|(id, o)| Budget { proposal_id: *id, option: o.clone() })
    }
}

impl Contract {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    fn assert_oracle(&self) {
        require!(env::predecessor_account_id() == self.oracle, "oracle only");
    }

    fn treasury(&self) -> u128 {
        let storage = env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear();
        env::account_balance()
            .as_yoctonear()
            .saturating_sub(storage)
            .saturating_sub(self.escrow_total)
            .saturating_sub(self.claimable_total)
            .saturating_sub(self.overhead_outstanding)
    }

    fn pending(&self, c: &Contributor) -> u128 {
        let delta = words_to_u256(self.acc_per_unit) - words_to_u256(c.acc_snapshot);
        let v = U256::from(c.units)
            .checked_mul(delta)
            .unwrap_or_else(|| env::panic_str("pending overflow"))
            / U256::from(ACC_SCALE);
        require!(v <= U256::from(u128::MAX), "pending overflow");
        v.as_u128()
    }

    /// Moves the contributor's accrued overhead share from outstanding into claimable.
    fn checkpoint(&mut self, account_id: &AccountId) {
        let acc = self.acc_per_unit;
        let pending = {
            let c = self.contributors.get(account_id).unwrap();
            self.pending(c)
        };
        self.contributors.get_mut(account_id).unwrap().acc_snapshot = acc;
        if pending > 0 {
            self.overhead_outstanding -= pending;
            *self.claimable.entry(account_id.clone()).or_insert(0) += pending;
            self.claimable_total += pending;
        }
    }

    fn add_units(&mut self, account_id: &AccountId, units: u128) {
        if units == 0 {
            return;
        }
        self.checkpoint(account_id);
        let c = self.contributors.get_mut(account_id).unwrap();
        if c.units == 0 {
            self.contributors_with_units += 1;
        }
        c.units += units;
        self.total_units += units;
    }

    fn contributor_view(&self, account_id: &AccountId, c: &Contributor) -> ContributorView {
        let base = self.claimable.get(account_id).copied().unwrap_or(0);
        ContributorView {
            account_id: account_id.clone(),
            units: U128(c.units),
            claimable: U128(base + self.pending(c)),
            share_bps: if self.total_units == 0 {
                0
            } else {
                mul_div(c.units, BPS_DENOM as u128, self.total_units) as u32
            },
            registered_at: U64(c.registered_at),
        }
    }

    /// Liabilities are debited by the caller before this; a failure re-credits claimable.
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
