import type { CycleRecord, StepName } from "./cycles.js";
import { hasPlaceholderUrl } from "./brief.js";
import type { Engine } from "./engine.js";
import { ceoDecide, design, finalizeVariant, learn, measure, publish, research, sense, writeCopy } from "./roles.js";
import { contentLint } from "./lint.js";
import { errMsg } from "./util.js";

const HOUR = 3_600_000;

/** Orchestrates one growth cycle: sense → decide → research → create → gate → publish, then later measure → learn. */
export class GrowthLoop {
  private running = false;
  private ticking = false;
  constructor(readonly e: Engine) {}
  get busy() { return this.running; }

  private async step<T>(rec: CycleRecord, name: StepName, fn: () => Promise<T>, note?: (v: T) => string | undefined): Promise<T> {
    const s = { name, status: "running" as const, ts: this.e.d.now() } as CycleRecord["steps"][number];
    rec.steps.push(s);
    this.e.d.cycles.save(rec);
    try {
      const v = await fn();
      s.status = "done"; s.note = note?.(v);
      this.e.d.cycles.save(rec);
      return v;
    } catch (err) {
      s.status = "error"; s.note = errMsg(err);
      this.e.d.cycles.save(rec);
      throw err;
    }
  }

  async runCycle(): Promise<CycleRecord> {
    const { cycles, state, dryRun, now, log, board } = this.e.d;
    if (this.e.d.loadPolicy().growth_paused) throw new Error("growth is paused (policy.growth_paused)");
    if (this.running) throw new Error("a cycle is already running");
    if (!dryRun && hasPlaceholderUrl(this.e.d.loadBrief())) throw new Error("set product.url in growth/brief.yaml before running live");
    this.running = true;
    try {
    await board.sync({ finalize: true }); // never throws; a chain failure keeps the last known Board budget
    const policy = this.e.policy(); // owner policy with the Board-derived per-cycle cap
    const rec: CycleRecord = { cycle: cycles.nextNumber(), dryRun, startedAt: now(), steps: [], targets: [], assets: [], copy: [], actionIds: [] };
    cycles.save(rec);
    const say = (text: string, actor: "CEO" | "MARKETING" = "MARKETING") => log({ ts: now(), actor, text: dryRun ? `[DRY] ${text}` : text });
    try {
      say(`Cycle ${rec.cycle} started`, "CEO");
      const snap = await this.step(rec, "sense", () => sense(this.e, rec.cycle), s => `funnel source: ${s.funnelSource}; spent $${s.spentUsd.toFixed(2)}`);
      let directive = await this.step(rec, "decide", () => ceoDecide(this.e, snap), d => `${d.stage}: ${d.bet.channel}/${d.bet.metric}≥${d.bet.target}`);
      const asked = directive.budget_usd;
      if (asked > policy.cycle_budget_usd) directive = { ...directive, budget_usd: policy.cycle_budget_usd };
      await this.requestBoard(rec.cycle, asked, policy.cycle_budget_usd);
      rec.directive = directive;
      cycles.save(rec);
      say(`Cycle ${rec.cycle} diagnosis: ${directive.diagnosis}`, "CEO");
      say(`Cycle ${rec.cycle} bet: ${directive.bet.hypothesis} (target ${directive.bet.metric} ≥ ${directive.bet.target} in ${directive.bet.hours}h, budget $${directive.budget_usd})`, "CEO");

      const r = await this.step(rec, "research", () => research(this.e, directive), x => x.note);
      rec.targets = r.targets; cycles.save(rec);

      await this.step(rec, "create", async () => {
        rec.copy = await writeCopy(this.e, directive, rec.targets); cycles.save(rec);
        rec.assets = await design(this.e, directive, rec.copy); cycles.save(rec);
      }, () => `${rec.copy.length} copy variants, ${rec.assets.length} assets`);

      const brief = this.e.d.loadBrief();
      await this.step(rec, "gate", async () => {
        const bad = rec.copy.flatMap(v => { const f = finalizeVariant(v, brief, rec.cycle); const l = contentLint({ text: f.text, channel: v.channel }, policy); return l.ok ? [] : [`${v.channel}: ${l.violations.join("; ")}`]; });
        return bad;
      }, bad => bad.length ? `preview lint would block: ${bad.join(" | ")}` : "preview lint clean");

      const plan = await this.step(rec, "publish", () => publish(this.e, directive, rec.copy, rec.assets, rec.targets), p => `${p.actionIds.length} actions${p.notes.length ? `; ${p.notes.join("; ")}` : ""}`);
      rec.actionIds = plan.actionIds;
      const counts = state.list({ cycle: rec.cycle }).reduce<Record<string, number>>((m, a) => { m[a.status] = (m[a.status] ?? 0) + 1; return m; }, {});
      say(`Cycle ${rec.cycle} published: ${Object.entries(counts).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(", ")}`);
    } catch (err) {
      rec.error = errMsg(err);
      say(`Cycle ${rec.cycle} stopped: ${rec.error}`, "CEO");
    } finally {
      rec.finishedAt = now();
      cycles.save(rec);
    }
    return rec;
    } finally {
      this.running = false;
    }
  }

  /**
   * The CEO asks the Board for money it cannot spend on its own: when it wants more than the current cap, or when
   * no Board budget exists yet. With a chain connection that is an on-chain Budget proposal (contributors vote by
   * units); otherwise it becomes a human task. At most one vote is open at a time.
   */
  private async requestBoard(cycle: number, askedUsd: number, capUsd: number) {
    const owner = this.e.d.loadPolicy();
    const snap = this.e.d.board.snapshot();
    const needsFirst = owner.board.enabled && !snap.budget && snap.chain === "connected";
    const wantsMore = askedUsd > capUsd;
    if (!wantsMore && !needsFirst) return;
    if (!owner.board.enabled || snap.chain === "none") {
      if (wantsMore) await this.e.act({ cycle, kind: "board.proposal", summary: `Request Board vote: CEO wants $${askedUsd} growth budget, cap is $${capUsd}` });
      return;
    }
    if (snap.open) {
      this.e.d.log({ ts: this.e.d.now(), actor: "CEO", text: `Board vote #${snap.open.id} is already open; waiting for it instead of proposing again` });
      return;
    }
    const title = wantsMore ? `Growth budget: CEO requests up to $${Math.min(askedUsd, owner.cycle_budget_usd)} per cycle (cap now $${capUsd})` : `Set the growth budget per cycle (no Board budget yet; bootstrap cap $${capUsd})`;
    await this.e.act({ cycle, kind: "board.propose", summary: title, payload: { title, votingPeriodSecs: owner.board.voting_period_secs } });
  }

  async measureCycle(n: number): Promise<CycleRecord> {
    const { cycles, now, log, dryRun } = this.e.d;
    const rec = cycles.get(n);
    if (!rec) throw new Error(`unknown cycle ${n}`);
    if (rec.seeded) throw new Error("seeded example cycle cannot be measured");
    if (!rec.directive) throw new Error("cycle has no directive");
    if (this.running) throw new Error("a cycle is already running");
    this.running = true;
    try {
      const m = await this.step(rec, "measure", () => measure(this.e, rec), x => `${x.metric}=${x.value} vs ${x.target} → ${x.outcome} (${x.funnelSource})`);
      rec.measurement = m; cycles.save(rec);
      const text = await this.step(rec, "learn", () => learn(this.e, rec, m));
      rec.learning = text;
      cycles.addLearning(rec.cycle, `${dryRun ? "[DRY] " : ""}${text}`, now());
      cycles.save(rec);
      log({ ts: now(), actor: "CEO", text: `${dryRun ? "[DRY] " : ""}Cycle ${rec.cycle} learning: ${text}` });
    } catch (err) {
      rec.error = errMsg(err); cycles.save(rec);
      throw err;
    } finally { this.running = false; }
    return rec;
  }

  /** Auto mode: measure cycles whose window has elapsed; otherwise start the next cycle once the last is measured. */
  async tick(minGapHours = 0): Promise<string> {
    const { cycles, now } = this.e.d;
    if (this.running || this.ticking) return "busy";
    this.ticking = true;
    try {
    await this.e.d.board.sync({ finalize: true });
    const real = cycles.list().filter(c => !c.seeded);
    const due = real.find(c => c.directive && !c.measurement && !c.error && now() >= c.startedAt + c.directive.bet.hours * HOUR);
    if (due) { await this.measureCycle(due.cycle); return `measured cycle ${due.cycle}`; }
    const last = real.at(-1);
    if (last && now() < last.startedAt + minGapHours * HOUR) return "waiting for minimum gap between cycles";
    if (!last || last.measurement || last.error) { const r = await this.runCycle(); return `ran cycle ${r.cycle}`; }
    return "waiting for measurement window";
    } finally { this.ticking = false; }
  }

  /** Demonstrates the gate: deliberately non-compliant copy must be refused. Never executes anything. */
  probeGuardrail() {
    const cycle = this.e.d.cycles.list().at(-1)?.cycle ?? 0;
    return this.e.d.state.propose({ cycle, kind: "postiz.create_post.now", channel: "x", summary: "[PROBE] guardrail test with deliberately non-compliant copy",
      text: "Own a share of the company and earn weekly dividends!" }, this.e.d.loadPolicy());
  }

  /** Cycle 0: an example record, clearly labelled, with no actions and no numbers. */
  seed(): CycleRecord {
    const { cycles, now } = this.e.d;
    const existing = cycles.get(0);
    if (existing) return existing;
    const brief = this.e.d.loadBrief();
    const t = now();
    const rec: CycleRecord = {
      cycle: 0, seeded: true, dryRun: true, startedAt: t, finishedAt: t, targets: [], assets: [], copy: [], actionIds: [],
      steps: (["sense", "decide"] as StepName[]).map(name => ({ name, status: "done" as const, ts: t, note: "SEEDED EXAMPLE" })),
      directive: { cycle: 0, diagnosis: "SEEDED EXAMPLE — not real data. Example of a diagnosis the CEO would write.", stage: "awareness",
        bet: { hypothesis: "Example hypothesis.", channel: brief.channels[0]!, audience: brief.icp.primary, metric: brief.funnel[1] ?? brief.funnel[0]!, target: 25, hours: 24 }, assets: ["key_art"], budget_usd: 0 },
      learning: "SEEDED EXAMPLE — no measurements exist for this cycle.",
    };
    cycles.save(rec);
    return rec;
  }

  /** Opt-in only: records consent, then sends the confirmation through the gate (resend.send.optin, L1). */
  async waitlistSignup(email: string) {
    const added = this.e.d.optin.add(email);
    if (!added) return { added: false };
    const brief = this.e.d.loadBrief();
    const to = email.trim().toLowerCase();
    await this.e.act({ cycle: this.e.d.cycles.list().at(-1)?.cycle ?? 0, kind: "resend.send.optin", summary: `waitlist confirmation to ${to.replace(/^(.).*(@.*)$/, "$1***$2")}`, channel: "email",
      text: `You're on the ${brief.product.name} waitlist (${brief.constraints.label}). You asked to hear about the game; reply STOP and we won't write again.`,
      payload: { to, subject: `${brief.product.name}: you're on the list` } });
    return { added: true };
  }
}
