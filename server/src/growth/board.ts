/**
 * Board governance for growth spend.
 *
 * The contract already implements the Board: the CEO agent creates a "Budget" proposal, contributors vote
 * weighted by lifetime units, anyone finalizes, and the winner becomes the active Budget. This module maps
 * that budget onto growth spend:
 *
 *   growth cycle cap (USD) = min(owner cycle cap, Board budget in NEAR x usd_per_near x growth_share_pct / 100)
 *
 * It is fail-closed: with no active Board budget (or no chain connection) only the owner's small bootstrap
 * allowance is available, so the CEO can plan and ask but cannot spend freely. The owner's caps in
 * growth/policy.yaml remain the ceiling; the Board can lower growth spend or raise it up to that ceiling.
 *
 * Voting itself is done by contributors from their own wallets. The only votes this server can cast are the
 * demo wallets (alice/bob) on a demo_mode contract, and only on an explicit admin click.
 */
import type { Ledger, Log } from "../ledger.js";
import type { TxResult } from "../near.js";
import { centsForYocto, toCents, yoctoForCents, type GrowthPolicy } from "./policy.js";
import { errMsg } from "./util.js";

export type ChainProposal = {
  id: number; kind: string; title: string; options: string[]; tallies: string[]; voters: number;
  proposer: string; created_at: string; ends_at: string; status: { type: "Open" } | { type: "Passed"; option: number } | { type: "NoChange" };
};
type ChainBudget = { proposal_id: number; option: string; max_expense_per_period: string };
type ChainStats = { contributors_with_units: number };

export type BoardProposalView = {
  id: number; title: string; status: "Open" | "Passed" | "NoChange"; passedOption?: number;
  options: { capUsd: number | null; maxExpenseYocto: string; tally: string }[];
  voters: number; endsAtMs: number; votable: boolean;
};
export type BoardSnapshot = {
  enabled: boolean;
  chain: "connected" | "none" | "error";
  error?: string;
  at: number;
  budget?: { proposalId: number; maxExpenseYocto: string; capUsd: number };
  open?: BoardProposalView;
  recent: BoardProposalView[];
  contributorsWithUnits?: number;
  bootstrapUsd: number;
  ownerCycleCapUsd: number;
  effectiveCycleCapUsd: number;
  canWrite: boolean;
  demoVoting: boolean;
  /** Why the cap is what it is, in one line for the dashboard. */
  basis: string;
};

export type BoardDeps = {
  ledger?: Ledger;
  loadPolicy: () => GrowthPolicy;
  now: () => number;
  log: Log;
  /** Chain writes are off in dry-run unless GROWTH_BOARD_WRITES=on. */
  canWrite: () => boolean;
};

const NS_PER_MS = 1_000_000n;
const CAP_FRESH_MS = 15_000;

export class Board {
  private snap: BoardSnapshot | undefined;
  private lastGood: { budget?: BoardSnapshot["budget"]; contributorsWithUnits?: number } = {};
  constructor(private readonly d: BoardDeps) {}

  private rate(p: GrowthPolicy) { return toCents(p.board.usd_per_near); }

  /** One option per owner-approved tier. Option text is exactly what the contract parses. */
  tierOptions(p: GrowthPolicy = this.d.loadPolicy()) {
    return p.board.tiers_usd.map(usd => {
      const yocto = yoctoForCents(toCents(usd), this.rate(p), p.board.growth_share_pct);
      return { capUsd: usd, maxExpenseYocto: yocto.toString(), json: JSON.stringify({ max_expense_per_period: yocto.toString() }) };
    });
  }

  private capFromYocto(p: GrowthPolicy, yocto: string): number {
    return centsForYocto(BigInt(yocto), this.rate(p), p.board.growth_share_pct) / 100;
  }

  /** Owner policy with the Board-derived per-cycle cap applied. Synchronous: uses the last synced snapshot. */
  applyTo(p: GrowthPolicy): GrowthPolicy {
    if (!p.board.enabled) return p;
    const s = this.snap ?? this.initial(p);
    return { ...p, cycle_budget_usd: Math.min(p.cycle_budget_usd, this.capFor(p, s)) };
  }
  private capFor(p: GrowthPolicy, s: Pick<BoardSnapshot, "budget">) {
    return s.budget ? this.capFromYocto(p, s.budget.maxExpenseYocto) : p.board.bootstrap_cycle_usd;
  }
  effectiveCap(p: GrowthPolicy = this.d.loadPolicy()) { return this.applyTo(p).cycle_budget_usd; }

  private initial(p: GrowthPolicy): BoardSnapshot {
    return this.build(p, { chain: this.d.ledger ? "error" : "none", error: this.d.ledger ? "not synced yet" : "no chain connection", recent: [] });
  }

  private build(p: GrowthPolicy, x: { chain: BoardSnapshot["chain"]; error?: string; recent: BoardProposalView[]; open?: BoardProposalView; budget?: BoardSnapshot["budget"]; contributorsWithUnits?: number; demo?: boolean }): BoardSnapshot {
    const budget = x.budget ?? (x.chain === "error" ? this.lastGood.budget : undefined);
    const ownerCap = p.cycle_budget_usd;
    const cap = !p.board.enabled ? ownerCap : Math.min(ownerCap, this.capFor(p, { budget }));
    const basis = !p.board.enabled ? "Board disabled: owner cap applies"
      : budget ? `Board budget from proposal #${budget.proposalId}${budget.capUsd > ownerCap ? ` (owner cap $${ownerCap} is the ceiling)` : ""}`
      : x.chain === "none" ? `no chain connection: bootstrap allowance only`
      : x.chain === "error" ? `chain unreachable (${x.error ?? "error"}) and no known Board budget: bootstrap allowance only`
      : `no active Board budget: bootstrap allowance only until a proposal passes`;
    return { enabled: p.board.enabled, chain: x.chain, error: x.error, at: this.d.now(), budget, open: x.open, recent: x.recent,
      contributorsWithUnits: x.contributorsWithUnits ?? this.lastGood.contributorsWithUnits, bootstrapUsd: p.board.bootstrap_cycle_usd, ownerCycleCapUsd: ownerCap, effectiveCycleCapUsd: cap,
      canWrite: this.d.canWrite(), demoVoting: x.demo ?? this.snap?.demoVoting ?? false, basis };
  }

  snapshot(): BoardSnapshot { return this.snap ?? this.initial(this.d.loadPolicy()); }
  isStale() { return !this.snap || this.d.now() - this.snap.at > CAP_FRESH_MS; }

  private view(p: GrowthPolicy, c: ChainProposal): BoardProposalView {
    const open = c.status.type === "Open";
    return {
      id: c.id, title: c.title, status: c.status.type, passedOption: c.status.type === "Passed" ? c.status.option : undefined,
      options: c.options.map((o, i) => {
        let max = "0";
        try { max = String(JSON.parse(o).max_expense_per_period ?? "0"); BigInt(max); } catch { max = "0"; }
        return { maxExpenseYocto: max, capUsd: this.capFromYocto(p, max), tally: c.tallies[i] ?? "0" };
      }),
      voters: c.voters, endsAtMs: Number(BigInt(c.ends_at) / NS_PER_MS), votable: open && BigInt(c.ends_at) > BigInt(this.d.now()) * NS_PER_MS,
    };
  }

  private async proposals(ledger: Ledger): Promise<ChainProposal[]> {
    const all: ChainProposal[] = [];
    for (let from = 0; ; from += 50) {
      const page = await ledger.view<ChainProposal[]>("get_proposals", { from_index: from, limit: 50 });
      all.push(...page);
      if (page.length < 50) return all;
    }
  }

  /**
   * Read the chain. With `finalize`, also finalize any open proposal whose voting is over or whose electorate
   * has fully voted (permissionless call) when chain writes are allowed. Never throws: a chain failure keeps
   * the last known budget and is reported in the snapshot.
   */
  async sync(opts: { finalize?: boolean } = {}): Promise<BoardSnapshot> {
    const p = this.d.loadPolicy();
    const ledger = this.d.ledger;
    if (!ledger) { this.snap = this.build(p, { chain: "none", recent: [] }); return this.snap; }
    try {
      const [budget, stats, cfg, list] = await Promise.all([
        ledger.view<ChainBudget | null>("get_budget"),
        ledger.view<ChainStats>("get_stats"),
        ledger.view<{ demo_mode: boolean }>("get_config"),
        this.proposals(ledger),
      ]);
      let proposals = list.filter(x => x.kind === "Budget");
      if (opts.finalize && this.d.canWrite()) {
        for (const pr of proposals.filter(x => x.status.type === "Open")) {
          const ended = BigInt(pr.ends_at) <= BigInt(this.d.now()) * NS_PER_MS;
          const allVoted = pr.voters > 0 && pr.voters >= stats.contributors_with_units;
          if (!ended && !allVoted) continue;
          try { await this.finalize(pr.id); } catch (e) { this.d.log({ ts: this.d.now(), actor: "CEO", text: `Board proposal #${pr.id} could not be finalized: ${errMsg(e)}` }); }
        }
        proposals = (await this.proposals(ledger)).filter(x => x.kind === "Budget");
        const b2 = await ledger.view<ChainBudget | null>("get_budget");
        return this.finish(p, b2, stats, proposals, cfg.demo_mode);
      }
      return this.finish(p, budget, stats, proposals, cfg.demo_mode);
    } catch (e) {
      this.snap = this.build(p, { chain: "error", error: errMsg(e), recent: this.snap?.recent ?? [], open: this.snap?.open });
      return this.snap;
    }
  }
  private finish(p: GrowthPolicy, budget: ChainBudget | null, stats: ChainStats, proposals: ChainProposal[], demo: boolean) {
    const b = budget ? { proposalId: budget.proposal_id, maxExpenseYocto: budget.max_expense_per_period, capUsd: this.capFromYocto(p, budget.max_expense_per_period) } : undefined;
    this.lastGood = { budget: b, contributorsWithUnits: stats.contributors_with_units };
    const views = proposals.map(x => this.view(p, x)).reverse();
    this.snap = this.build(p, { chain: "connected", budget: b, open: views.find(v => v.status === "Open"), recent: views.slice(0, 5), contributorsWithUnits: stats.contributors_with_units, demo });
    return this.snap;
  }

  private need(): Ledger { if (!this.d.ledger) throw new Error("no chain connection"); return this.d.ledger; }
  private guardWrite() { if (!this.d.canWrite()) throw new Error("chain writes are off in dry-run (set GROWTH_BOARD_WRITES=on to use the testnet contract)"); }

  /** CEO creates a Budget proposal with one option per owner-approved tier. */
  async propose(title: string, votingPeriodSecs?: number): Promise<{ id: number; txHash: string; explorerUrl: string }> {
    this.guardWrite();
    const p = this.d.loadPolicy();
    if (!p.board.enabled) throw new Error("board governance is disabled in policy");
    if ((await this.sync()).open) throw new Error("a Board vote is already open");
    const secs = votingPeriodSecs ?? p.board.voting_period_secs;
    const tx = await this.need().call<number>("ceo", "create_proposal", {
      kind: "Budget", title: title.slice(0, 190), options: this.tierOptions(p).map(o => o.json), voting_period_secs: String(secs),
    });
    await this.sync();
    return { id: tx.value, txHash: tx.txHash, explorerUrl: tx.explorerUrl };
  }

  /** Demo wallets only, on a demo_mode contract, on an explicit admin click. Real contributors vote from their own wallets. */
  async vote(wallet: "alice" | "bob", proposalId: number, option: number): Promise<TxResult<unknown>> {
    this.guardWrite();
    const ledger = this.need();
    if (wallet !== "alice" && wallet !== "bob") throw new Error("wallet must be alice or bob");
    if (!(await ledger.view<{ demo_mode: boolean }>("get_config")).demo_mode) throw new Error("demo wallet voting requires a demo_mode contract");
    if (!Number.isSafeInteger(proposalId) || proposalId < 0 || !Number.isSafeInteger(option) || option < 0) throw new Error("invalid proposal or option");
    const tx = await ledger.call(wallet, "vote", { proposal_id: proposalId, option });
    this.d.log({ ts: this.d.now(), actor: "WORKER", text: `${ledger.accounts[wallet]} voted option ${option} on Board proposal #${proposalId} (DEMO wallet)`, txHash: tx.txHash, explorerUrl: tx.explorerUrl });
    await this.sync();
    return tx;
  }

  /** `finalize` is permissionless on-chain. Prefer the oracle agent's scoped key; fall back to a demo wallet on a demo contract. */
  async finalize(proposalId: number): Promise<TxResult<unknown>> {
    this.guardWrite();
    const ledger = this.need();
    let tx: TxResult<unknown>;
    try { tx = await ledger.call("oracle", "finalize", { proposal_id: proposalId }); }
    catch (e) {
      const demo = (await ledger.view<{ demo_mode: boolean }>("get_config")).demo_mode;
      if (!demo || /voting still open|unknown proposal|closed/i.test(errMsg(e))) throw e;
      tx = await ledger.call("alice", "finalize", { proposal_id: proposalId }); // oracle key predates the finalize allowance (re-key to fix)
    }
    const after = await ledger.view<ChainProposal | null>("get_proposal", { proposal_id: proposalId });
    const outcome = after?.status.type === "Passed" ? `passed with option ${after.status.option}` : after?.status.type === "NoChange" ? "ended with no change" : "finalized";
    this.d.log({ ts: this.d.now(), actor: "CEO", text: `Board proposal #${proposalId} ${outcome}`, txHash: tx.txHash, explorerUrl: tx.explorerUrl });
    await this.sync();
    return tx;
  }
}
