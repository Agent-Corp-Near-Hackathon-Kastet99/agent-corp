import { randomUUID } from "node:crypto";

export type ChainJobState = "created" | "paid" | "settled" | "refunded";
export type ChainJob = { jobId: string; state: ChainJobState; price: string; paidAt?: number; receipt?: Receipt };
export type Receipt = { txHash: string; explorerUrl: string; amountYocto: string; contributorPoolYocto: string; treasuryYocto: string; platformYocto: string; shares: { account: string; yocto: string; servedThisJob: boolean }[] };

/** Boundary for contract calls. Real adapter belongs here when testnet credentials are supplied. */
export interface Chain {
  registerContributor(account: string): Promise<boolean>;
  createJob(jobId: string, price: string): Promise<void>;
  getJob(jobId: string): Promise<ChainJob | undefined>;
  getReceipt(jobId: string): Promise<Receipt | undefined>;
  settle(jobId: string, usages: readonly [string, string][], idempotencyKey?: string): Promise<Receipt>;
  refund(jobId: string): Promise<void>;
  createProposal(input: { title: string; options: { label: string; pct: number }[]; votingPeriodSecs: string }): Promise<number>;
}

/** Demo-only chain. All methods above are faked until a near-api-js adapter is configured. */
export class FakeChain implements Chain {
  readonly jobs = new Map<string, ChainJob>();
  readonly contributors = new Set<string>();
  readonly settlements = new Map<string, Receipt>();
  async registerContributor(account: string) { const had = this.contributors.has(account); this.contributors.add(account); return !had; }
  async createJob(jobId: string, price: string) { if (!this.jobs.has(jobId)) this.jobs.set(jobId, { jobId, price, state: "created" }); }
  async getJob(jobId: string) { return this.jobs.get(jobId); }
  async getReceipt(jobId: string) { return this.jobs.get(jobId)?.receipt; }
  async pay(jobId: string) { const j = this.must(jobId); j.state = "paid"; j.paidAt = Date.now(); }
  async settle(jobId: string, usages: readonly [string, string][], key = jobId) {
    const old = this.settlements.get(key); if (old) return old;
    const job = this.must(jobId); if (job.state === "refunded") throw new Error("job refunded");
    const amount = job.price === "0" ? "0" : job.price;
    const receipt: Receipt = { txHash: `fake-${randomUUID()}`, explorerUrl: "https://explorer.testnet.near.org", amountYocto: amount, contributorPoolYocto: "0", treasuryYocto: "0", platformYocto: "0", shares: usages.map(([account]) => ({ account, yocto: "0", servedThisJob: true })) };
    this.settlements.set(key, receipt); if (job.price !== "0") { job.state = "settled"; job.receipt = receipt; } return receipt;
  }
  async refund(jobId: string) { this.must(jobId).state = "refunded"; }
  async createProposal(_input: { title: string; options: { label: string; pct: number }[]; votingPeriodSecs: string }) { return 1; }
  private must(id: string) { const v = this.jobs.get(id); if (!v) throw new Error(`unknown job ${id}`); return v; }
}
