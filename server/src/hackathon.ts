/**
 * Hackathon demo engine: one shared data model for the landing popup, Investor Dashboard,
 * Kanban, the automatic marketing job, payments and withdrawals.
 *
 * Real vs mock is explicit in every snapshot:
 *  - real: company account balance (testnet RPC) and payments verified on-chain by transaction hash.
 *  - real: also the Claude Code connection (worker connection test).
 *  - mock: the 253,000 token baseline, Alice/Bob split, governance votes.
 *  - simulated: withdrawals (no company key signs anything here).
 * Nothing in this file invents a transaction hash or an X post URL.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "./config.js";
import { EXPLORER, RPC_URL } from "./near.js";
import { seedTasks, LAUNCH_POST_TASK, type KanbanTask } from "./hackathon-tasks.js";
import type { Task } from "./store.js";
import { loadGrowthEnv } from "./growth/env.js";
import { postiz } from "./growth/tools/postiz.js";
import type { Log } from "./ledger.js";

export const TOKEN_BASELINE = 253_000;
export const CONNECT_GRANT = 5_000;
export const PREMIUM_PRICE_YOCTO = 10n ** 24n;
const INVESTOR_A_ACCOUNT = process.env.HACKATHON_INVESTOR_A_ACCOUNT ?? "alice.testnet";
const INVESTOR_B_ACCOUNT = process.env.HACKATHON_INVESTOR_B_ACCOUNT ?? "bob.testnet";
export const STAGES = ["budget_allocated", "agent_started", "generating", "publishing", "completed"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABEL: Record<Stage, string> = { budget_allocated: "Budget Allocated", agent_started: "Agent Started", generating: "Generating Content", publishing: "Publishing to X", completed: "Completed" };

export type Post = { text: string; url: string; publishedAt: number; tokensUsed: number; basis: "provider" | "estimate" };
export type Job = { id: string; stage: Stage; startedAt: number; stageAt: Partial<Record<Stage, number>>; error?: string; post?: Post };
export type Payment = { txHash: string; account: string; amountYocto: string; at: number; explorerUrl: string };
export type Withdrawal = { id: string; account: string; amountYocto: string; at: number; simulated: true };
export type Activity = { id: number; ts: number; kind: "real" | "simulated" | "mock"; text: string; url?: string };
export type Notice = { id: number; ts: number; title: string; body: string };
type State = { rev: number; seq: number; account?: string; connectedAt?: number; job?: Job; payments: Payment[]; withdrawals: Withdrawal[]; activity: Activity[]; notices: Notice[]; votes?: Record<string, "for" | "against">; smokesUsed?: Record<string, number> };

export type Publisher = (text?: string) => Promise<Post>;
export type HackathonOptions = {
  file: string; explorer: string; companyAccount: string;
  publisher?: Publisher; stepMs?: number; now?: () => number;
  /** Company account balance in yocto from testnet RPC; undefined when unreachable. */
  getBalance?: () => Promise<string | undefined>;
  /** Throws unless `txHash` is a successful Smoke Grenade purchase from `account`. */
  verifyPayment?: (txHash: string, account: string) => Promise<{ amountYocto: string }>;
  macDownload?: () => boolean;
  /** Queue the generated-copy task on a connected contributor worker. */
  requestLaunchCopy?: (jobId: string) => void;
  /** Mirror newly verified game sales into the shared Company Operations activity log. */
  paymentLog?: Log;
};

const blank = (): State => ({ rev: 0, seq: 0, payments: [], withdrawals: [], activity: [], notices: [] });
const POST_URL = /^https:\/\/(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d{5,25}$/;

/** Publishes nothing itself: reports a post that already exists on X, configured by the operator. */
export function envPublisher(env: NodeJS.ProcessEnv = process.env): Publisher {
  return async () => {
    const url = env.HACKATHON_X_POST_URL ?? "", text = env.HACKATHON_X_POST_TEXT ?? "", at = Date.parse(env.HACKATHON_X_POSTED_AT ?? "");
    if (!POST_URL.test(url) || !text || !Number.isFinite(at)) throw new Error("X publishing is not configured: set HACKATHON_X_POST_URL, HACKATHON_X_POST_TEXT and HACKATHON_X_POSTED_AT to the real published post");
    const reported = Number(env.HACKATHON_X_POST_TOKENS);
    return Number.isSafeInteger(reported) && reported > 0
      ? { text, url, publishedAt: at, tokensUsed: reported, basis: "provider" }
      : { text, url, publishedAt: at, tokensUsed: Math.ceil(text.length / 4) + 600, basis: "estimate" };
  };
}

/** Live Postiz publisher. Only called after a wallet payment was verified and a worker returned copy. */
export function postizPublisher(env: NodeJS.ProcessEnv = process.env): Publisher {
  const config = loadGrowthEnv(env);
  return async text => {
    const copy = text?.trim() ?? "";
    if (!copy || copy.length > 280) throw new Error("Worker copy must be 1–280 characters");
    const client = postiz(config);
    const pinned = config.POSTIZ_X_INTEGRATION_ID;
    const integration = pinned
      ? (await client.listIntegrations()).find(item => item.id === pinned && !item.disabled)
      : (await client.listIntegrations()).find(item => item.identifier === "x" && !item.disabled);
    if (!integration) throw new Error("No connected X channel in Postiz");
    const created = await client.createPost({ type: "now", integrationId: integration.id, provider: "x", parts: [copy] });
    const raw = JSON.stringify(created.raw);
    const url = raw.match(/https:\/\/(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d{5,25}/)?.[0];
    if (!url) throw new Error("Postiz published but returned no public X URL; check Postiz before retrying");
    return { text: copy, url, publishedAt: Date.now(), tokensUsed: 0, basis: "provider" };
  };
}

export async function rpcBalance(rpcUrl: string, account: string, f: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const r = await f(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: account } }), signal: AbortSignal.timeout(5000) });
    const data = await r.json() as { result?: { amount?: string } };
    return typeof data.result?.amount === "string" && /^\d+$/.test(data.result.amount) ? data.result.amount : undefined;
  } catch { return undefined; }
}

export function rpcVerifier(rpcUrl: string, company: string, f: typeof fetch = fetch) {
  return async (txHash: string, account: string): Promise<{ amountYocto: string }> => {
    const r = await f(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tx", params: { tx_hash: txHash, sender_account_id: account, wait_until: "FINAL" } }), signal: AbortSignal.timeout(15000) });
    const d = await r.json() as { result?: { status?: { SuccessValue?: string; Failure?: unknown }; transaction?: { signer_id: string; receiver_id: string; actions: unknown[] } }; error?: unknown };
    const t = d.result?.transaction;
    if (!t || !d.result?.status || "Failure" in d.result.status || !("SuccessValue" in d.result.status)) throw new Error("Transaction not found or not successful on testnet");
    if (t.signer_id !== account || t.receiver_id !== company) throw new Error("Transaction is not a purchase from your wallet to the company contract");
    const purchase = t.actions.find(a => {
      const call = (a as { FunctionCall?: { method_name?: string; deposit?: string } }).FunctionCall;
      return call?.method_name === "buy_smoke_grenade" && call.deposit === PREMIUM_PRICE_YOCTO.toString();
    });
    if (!purchase) throw new Error("Transaction is not an exact 1 NEAR Smoke Grenade purchase");
    return { amountYocto: PREMIUM_PRICE_YOCTO.toString() };
  };
}

export class HackathonDemo {
  private state: State = blank();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private readonly now: () => number;
  private readonly stepMs: number;
  constructor(private readonly o: HackathonOptions) {
    this.now = o.now ?? Date.now; this.stepMs = o.stepMs ?? 2500;
    if (existsSync(o.file)) { try { this.state = { ...blank(), ...JSON.parse(readFileSync(o.file, "utf8")) as State }; } catch { this.state = blank(); } }
    for (const payment of this.state.payments) this.mirrorPayment(payment);
    const job = this.state.job;
    if (job && !job.error && job.stage !== "completed") {
      // A restart mid-publish may or may not have posted. Never repeat it blindly.
      if (job.stage === "publishing") this.fail(job, "Interrupted while publishing; check X for the post before retrying");
      else this.schedule(job);
    }
  }
  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); }

  private save() {
    this.state.rev++;
    mkdirSync(dirname(this.o.file), { recursive: true });
    const tmp = `${this.o.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.o.file);
  }
  private log(kind: Activity["kind"], text: string, url?: string) {
    this.state.activity.unshift({ id: ++this.state.seq, ts: this.now(), kind, text, url }); this.state.activity.length = Math.min(this.state.activity.length, 60);
  }
  private mirrorPayment(payment: Payment) {
    this.o.paymentLog?.({
      ts: payment.at, actor: "CUSTOMER",
      text: `${payment.account} bought Smoke Grenade · ${payment.amountYocto} yoctoNEAR`,
      txHash: payment.txHash, explorerUrl: payment.explorerUrl,
    });
  }
  private notify(title: string, body: string) { this.state.notices.push({ id: ++this.state.seq, ts: this.now(), title, body }); this.state.notices = this.state.notices.slice(-20); }

  /** Simulated Claude Code connection: grants the demo AI budget and starts the marketing job once. */
  connectAi(account: string): { started: boolean } {
    const job = this.state.job;
    if (this.state.connectedAt && job && !job.error) return { started: false };
    if (!this.state.connectedAt) {
      this.state.account = account; this.state.connectedAt = this.now();
      this.log("simulated", `${account} connected Claude Code · ${CONNECT_GRANT.toLocaleString("en-US")} AI tokens granted`);
      this.notify("New AI Resources Connected", "Claude Code"); this.notify("Budget appeared. New task started", "Generate and Publish Game Launch Post"); this.notify(`${CONNECT_GRANT.toLocaleString("en-US")} AI Tokens Available`, "Available AI Budget updated");
    } else this.log("simulated", "Retrying marketing job");
    const next: Job = { id: `job-${this.now()}`, stage: "budget_allocated", startedAt: this.now(), stageAt: { budget_allocated: this.now() } };
    this.state.job = next; this.log("simulated", "Budget allocated to Generate and Publish Game Launch Post");
    this.save(); this.schedule(next);
    return { started: true };
  }
  /** A verified local worker test unlocks the dashboard connection state without starting a demo job. */
  recordWorkerConnection(account: string) {
    if (this.state.connectedAt) return;
    this.state.account = account; this.state.connectedAt = this.now();
    this.log("real", `${account} completed a worker connection test`);
    this.notify("Worker Connection Verified", "Your tokens are now available to Foundry Stack.");
    this.notify(`${CONNECT_GRANT.toLocaleString("en-US")} AI Tokens Available`, "Available AI Budget updated");
    this.save();
  }
  private schedule(job: Job) {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.advance(job.id), this.stepMs);
    this.timer.unref?.();
  }
  private async advance(id: string) {
    const job = this.state.job;
    if (!job || job.id !== id || job.error) return;
    const next = STAGES[STAGES.indexOf(job.stage) + 1];
    if (!next) return;
    job.stage = next; job.stageAt[next] = this.now();
    if (next === "generating" && this.o.requestLaunchCopy) {
      this.log("simulated", "Worker generating X post copy"); this.save(); this.o.requestLaunchCopy(job.id); return;
    }
    if (next === "publishing") {
      this.log("simulated", "Publishing to X"); this.save();
      try { job.post = await (this.o.publisher ?? envPublisher())(""); }
      catch (error) { if (this.state.job?.id === id) this.fail(job, error instanceof Error ? error.message : String(error)); return; }
      if (this.state.job?.id !== id) return;
      job.stage = "completed"; job.stageAt.completed = this.now();
      this.log("real", `Launch post published to X · ${job.post.tokensUsed.toLocaleString("en-US")} tokens (${job.post.basis})`, job.post.url);
      this.notify("Launch post published", "Generate and Publish Game Launch Post is Done");
      this.save(); return;
    }
    this.log("simulated", STAGE_LABEL[next]); this.save(); this.schedule(job);
  }
  private fail(job: Job, message: string) { job.error = message; this.log("real", `Marketing job stopped: ${message}`); this.save(); }

  /** Accept only current job's completed worker copy, then make one Postiz publish call. */
  async completeLaunchCopy(jobId: string, task: Task): Promise<void> {
    const job = this.state.job;
    if (!job || job.id !== jobId || job.error || job.post || task.status !== "done" || !task.output) return;
    const text = task.output.trim();
    if (!text || text.length > 280) { this.fail(job, "Worker did not return a single X post of 280 characters or less"); return; }
    job.stage = "publishing"; job.stageAt.publishing = this.now();
    this.log("simulated", "Publishing to X"); this.save();
    try {
      const published = await (this.o.publisher ?? postizPublisher())(text);
      job.post = { ...published, tokensUsed: task.usage ? task.usage.input + task.usage.output + task.usage.cacheRead + task.usage.cacheWrite : published.tokensUsed };
      job.stage = "completed"; job.stageAt.completed = this.now();
      this.log("real", `Launch post published to X · ${job.post.tokensUsed.toLocaleString("en-US")} tokens (${job.post.basis})`, job.post.url);
      this.notify("Launch post published", "Generate and Publish Game Launch Post is Done"); this.save();
    } catch (error) { this.fail(job, error instanceof Error ? error.message : String(error)); }
  }

  /** Records a payment only after chain verification. A hash is never accepted on faith. */
  async recordPayment(txHash: string, account: string): Promise<Payment> {
    if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(txHash)) throw new Error("Invalid transaction hash");
    const known = this.state.payments.find(p => p.txHash === txHash);
    if (known) return known;
    if (!this.o.verifyPayment) throw new Error("Payment verification unavailable");
    const { amountYocto } = await this.o.verifyPayment(txHash, account);
    const again = this.state.payments.find(p => p.txHash === txHash);
    if (again) return again;
    const payment: Payment = { txHash, account, amountYocto, at: this.now(), explorerUrl: `${this.o.explorer}/txns/${txHash}` };
    this.state.payments.push(payment);
    this.log("real", `${account} unlocked Premium (testnet payment verified)`, payment.explorerUrl);
    this.save();
    this.mirrorPayment(payment);
    // A verified balance top-up funds the launch workflow. Never start it from an unverified hash.
    this.connectAi(account);
    return payment;
  }

  /** Withdrawals are simulated: the company holds no key this UI can sign with. */
  withdraw(account: string): Withdrawal {
    const view = this.figures();
    const available = BigInt(view.availableYocto);
    if (available <= 0n) throw new Error("Nothing available to withdraw");
    const w: Withdrawal = { id: `w-${this.now()}`, account, amountYocto: available.toString(), at: this.now(), simulated: true };
    this.state.withdrawals.push(w);
    this.log("simulated", `${account} withdrew their revenue share`);
    this.save(); return w;
  }

  vote(account: string, vote: "for" | "against") {
    this.state.votes ??= {};
    this.state.votes[account] = vote;
    this.log("mock", `${account} voted ${vote} on AI Resource Allocation`);
    this.save();
    return { vote };
  }

  reset(opts: { payments?: boolean } = {}) {
    if (this.timer) clearTimeout(this.timer);
    const keep = opts.payments ? [] : this.state.payments;
    this.state = { ...blank(), rev: this.state.rev, seq: this.state.seq, payments: keep };
    this.log("mock", "Demo reset"); this.save();
  }
  availableSmokes(account: string) {
    const bought = this.state.payments.filter(p => p.account === account).reduce((count, p) => count + Number(BigInt(p.amountYocto) / PREMIUM_PRICE_YOCTO), 0);
    return Math.max(0, bought - (this.state.smokesUsed?.[account] ?? 0));
  }
  hasPremium(account: string) { return this.availableSmokes(account) > 0; }
  consumeSmokes(account: string, count: number) {
    if (!Number.isSafeInteger(count) || count < 1 || count > this.availableSmokes(account)) throw new Error("Smoke Grenade payment required");
    this.state.smokesUsed ??= {};
    this.state.smokesUsed[account] = (this.state.smokesUsed[account] ?? 0) + count;
    this.save();
  }

  /** Only finished reports with provider token counts become visible as contributed tokens. */
  private workerTokens(tasks: Task[], account?: string) {
    const count = (task: Task) => {
      if (task.status !== "done" || !task.usage) return 0;
      const { input, output, cacheRead, cacheWrite } = task.usage;
      return input + output + cacheRead + cacheWrite;
    };
    const total = tasks.reduce((sum, task) => sum + count(task), 0);
    const owner = account ?? this.state.account;
    const mine = owner ? tasks.filter(task => task.worker === owner).reduce((sum, task) => sum + count(task), 0) : 0;
    return { total, mine };
  }

  /** Vote weight = revenue-share bps. Alice votes for, Bob against; you count only once you vote. */
  private tally(userBps: number, account?: string) {
    const a = Math.floor(4000 * (10_000 - userBps) / 10_000), b = Math.floor(6000 * (10_000 - userBps) / 10_000);
    const mine = account ? this.state.votes?.[account] : undefined;
    const f = Math.round((a + (mine === "for" ? userBps : 0)) / 100), g = Math.round((b + (mine === "against" ? userBps : 0)) / 100);
    return { for: f, against: g, abstain: Math.max(0, 100 - f - g) };
  }

  private figures(tasks: Task[] = [], account?: string) {
    const post = this.state.job?.post, used = post?.tokensUsed ?? 0;
    const workers = this.workerTokens(tasks, account);
    const reserved = this.state.job && !post && !this.state.job.error ? 2000 : 0;
    const available = this.state.connectedAt ? CONNECT_GRANT - used - reserved : 0;
    const pool = this.state.payments.reduce((s, p) => s + BigInt(p.amountYocto), 0n);
    const contribution = used + workers.mine;
    const totalUsed = TOKEN_BASELINE + used + workers.total;
    const shareBps = Math.floor((contribution * 10_000) / totalUsed);
    const earned = (pool * BigInt(shareBps)) / 10_000n;
    const withdrawn = this.state.withdrawals.reduce((s, w) => s + BigInt(w.amountYocto), 0n);
    return { used, contribution, totalUsed, available, pool, shareBps, availableYocto: (earned > withdrawn ? earned - withdrawn : 0n).toString(), withdrawn };
  }
  private kanban(workerTasks: Task[]): KanbanTask[] {
    const job = this.state.job, post = job?.post;
    const tasks = seedTasks().map(t => {
      if (t.id !== LAUNCH_POST_TASK || !job) return t;
      if (job.error) return { ...t, status: "in-progress" as const, stage: STAGE_LABEL[job.stage], failed: job.error };
      if (post) return { ...t, status: "done" as const, stage: "Completed", usedTokens: post.tokensUsed, result: post.text, links: [{ label: "View on X", url: post.url }] };
      return { ...t, status: "in-progress" as const, stage: STAGE_LABEL[job.stage] };
    });
    for (const w of workerTasks) tasks.push({
      id: `worker-${w.id}`, title: w.title, description: w.prompt, department: w.kind === "marketing" ? "marketing" : "product", agent: w.worker ?? "Worker", source: "worker",
      status: w.status === "queued" ? "todo" : w.status === "running" ? "in-progress" : "done", budgetTokens: null,
      usedTokens: w.status === "done" && w.usage ? w.usage.input + w.usage.output + w.usage.cacheRead + w.usage.cacheWrite : null,
      result: w.output, links: [], ...(w.status === "failed" ? { failed: "Worker reported failure" } : {}),
    });
    return tasks;
  }

  async snapshot(workerTasks: Task[] = [], account?: string) {
    const f = this.figures(workerTasks, account), balance = await this.o.getBalance?.();
    const userBps = f.shareBps;
    return {
      rev: this.state.rev, now: this.now(), network: "testnet", explorer: this.o.explorer,
      company: { account: this.o.companyAccount, balanceYocto: balance ?? null, balanceSource: balance === undefined ? "unavailable" : "testnet-rpc", verifiedPaymentsYocto: f.pool.toString() },
      tokens: { baselineMock: TOKEN_BASELINE, totalUsed: f.totalUsed, availableBudget: f.available, grant: CONNECT_GRANT, connected: !!this.state.connectedAt },
      investor: { account: account ?? this.state.account ?? null, contributionTokens: f.contribution, shareBps: userBps, availableYocto: f.availableYocto, withdrawnYocto: f.withdrawn.toString(), simulated: true },
      distribution: {
        mock: true,
        investors: [{ name: INVESTOR_A_ACCOUNT, bps: Math.floor(4000 * (10_000 - userBps) / 10_000) }, { name: INVESTOR_B_ACCOUNT, bps: Math.floor(6000 * (10_000 - userBps) / 10_000) }, { name: "You", you: true, bps: userBps }],
        aiResources: [{ name: "Product Development", pct: 50 }, { name: "Self-Improvement", pct: 30 }, { name: "Marketing & Growth", pct: 20 }],
      },
      proposal: { ...PROPOSAL, votes: this.tally(userBps, account), myVote: account ? this.state.votes?.[account] ?? null : null },
      tasks: this.kanban(workerTasks), job: this.state.job ?? null, stages: STAGES.map(s => ({ id: s, label: STAGE_LABEL[s] })),
      activity: this.state.activity.slice(0, 30), notices: this.state.notices, payments: this.state.payments, withdrawals: this.state.withdrawals,
      downloads: { macos: !!this.o.macDownload?.(), windows: false, linux: false },
      me: account ? { account, smokes: this.availableSmokes(account) } : null,
    };
  }
}

const PROPOSAL = {
  id: "alloc-1", title: "Change AI Resource Allocation", status: "Active", mock: true,
  description: "Adjust how the company allocates its AI resources between product development, self-improvement, and marketing.",
  current: [{ name: "Development", pct: 50 }, { name: "Self-Improvement", pct: 30 }, { name: "Marketing", pct: 20 }],
  proposed: [{ name: "Development", pct: 40 }, { name: "Self-Improvement", pct: 20 }, { name: "Marketing", pct: 40 }],
  votes: { for: 62, against: 18, abstain: 20 },
};

/** Production wiring: testnet RPC for balance and payment verification, operator-configured X post. */
export function createHackathon(contractId: string | undefined, file?: string, requestLaunchCopy?: (jobId: string) => void, paymentLog?: Log): { demo: HackathonDemo; macZip: string } | undefined {
  const company = process.env.HACKATHON_COMPANY_ACCOUNT ?? contractId;
  if (!company || !company.endsWith(".testnet")) return undefined;
  const macZip = join(ROOT, "artifacts", "Agent-Corp-macOS-arm64.zip");
  const demo = new HackathonDemo({ file: file ?? process.env.AGENTCORP_HACKATHON ?? join(ROOT, ".data", "hackathon.json"), explorer: EXPLORER, companyAccount: company, getBalance: () => rpcBalance(RPC_URL, company), verifyPayment: rpcVerifier(RPC_URL, company), macDownload: () => existsSync(macZip), requestLaunchCopy, paymentLog });
  return { demo, macZip };
}
