import type { Ledger } from "../src/ledger.js";
import type { Role } from "../src/credentials.js";

export const YOCTO = 10n ** 24n;

/** A fake contract that mirrors the real governance rules closely enough to catch integration mistakes. */
export class FakeChain implements Ledger {
  contractId = "corp.testnet";
  accounts = { owner: "owner.testnet", oracle: "oracle.testnet", ceo: "ceo.testnet", alice: "alice.testnet", bob: "bob.testnet", customer: "c.testnet", vendor: "v.testnet" } as Record<Role, string>;
  nowMs = 1_000_000;
  demo = true;
  oracleCanFinalize = true;
  down = false;
  units: Record<string, number> = { alice: 60_000, bob: 40_000 };
  proposals: any[] = [];
  votes = new Map<string, { option: number; weight: number }>();
  budget: { proposal_id: number; option: string; max_expense_per_period: string } | null = null;
  calls: { role: Role; method: string; args: Record<string, unknown> }[] = [];
  private get ns() { return BigInt(this.nowMs) * 1_000_000n; }
  async view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this.down) throw new Error("rpc down");
    const v: Record<string, unknown> = {
      get_budget: this.budget,
      get_stats: { contributors_with_units: Object.keys(this.units).length },
      get_config: { demo_mode: this.demo, constraints: { pass_price: (1n * YOCTO).toString() } },
      get_treasury: { period_revenue: "0" },
      get_proposals: this.proposals.slice(Number(args.from_index ?? 0), Number(args.from_index ?? 0) + Number(args.limit ?? 20)),
      get_proposal: this.proposals.find(p => p.id === args.proposal_id) ?? null,
    };
    return structuredClone(v[method]) as T;
  }
  async call<T>(role: Role, method: string, args: Record<string, unknown> = {}) {
    this.calls.push({ role, method, args });
    const tx = (value: unknown) => ({ value: value as T, txHash: `tx${this.calls.length}`, explorerUrl: `https://explorer/tx${this.calls.length}` });
    if (method === "create_proposal") {
      if (role !== "ceo") throw new Error("only the CEO can propose");
      const opts = args.options as string[];
      if (args.kind !== "Budget") throw new Error("unsupported proposal kind");
      if (opts.length < 2 || opts.length > 6) throw new Error("need 2-6 options");
      for (const o of opts) { const j = JSON.parse(o); if (Object.keys(j).join() !== "max_expense_per_period") throw new Error("budget option must encode max_expense_per_period as U128"); BigInt(j.max_expense_per_period); }
      const id = this.proposals.length;
      this.proposals.push({ id, kind: "Budget", title: args.title, options: opts, tallies: opts.map(() => "0"), voters: 0, proposer: "ceo.testnet", created_at: String(this.ns), ends_at: String(this.ns + BigInt(String(args.voting_period_secs)) * 1_000_000_000n), status: { type: "Open" } });
      return tx(id);
    }
    if (method === "vote") {
      const w = this.units[role]; if (!w) throw new Error("only contributors with units can vote");
      const p = this.proposals[Number(args.proposal_id)]; if (!p) throw new Error("unknown proposal");
      if (p.status.type !== "Open") throw new Error("proposal is closed");
      if (this.ns >= BigInt(p.ends_at)) throw new Error("voting period ended");
      const key = `${p.id}:${role}`, prev = this.votes.get(key);
      if (prev) p.tallies[prev.option] = String(Number(p.tallies[prev.option]) - prev.weight); else p.voters++;
      p.tallies[Number(args.option)] = String(Number(p.tallies[Number(args.option)]) + w);
      this.votes.set(key, { option: Number(args.option), weight: w });
      return tx(undefined);
    }
    if (method === "finalize") {
      if (role === "oracle" && !this.oracleCanFinalize) throw new Error("Method finalize is not allowed for this access key");
      const p = this.proposals[Number(args.proposal_id)]; if (!p) throw new Error("unknown proposal");
      if (p.status.type !== "Open") throw new Error("proposal is closed");
      const all = p.voters > 0 && p.voters >= Object.keys(this.units).length;
      if (!all && this.ns < BigInt(p.ends_at)) throw new Error("voting still open");
      const t = p.tallies.map(Number), max = Math.max(...t), winners = t.flatMap((x: number, i: number) => x === max ? [i] : []);
      if (max === 0 || winners.length !== 1) p.status = { type: "NoChange" };
      else { p.status = { type: "Passed", option: winners[0] }; this.budget = { proposal_id: p.id, option: p.options[winners[0]], max_expense_per_period: JSON.parse(p.options[winners[0]]).max_expense_per_period }; }
      return tx(p.status);
    }
    throw new Error(`unexpected ${method}`);
  }
}
