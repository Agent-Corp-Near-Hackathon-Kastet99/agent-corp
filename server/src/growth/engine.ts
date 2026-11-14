import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Brief } from "./brief.js";
import type { Log } from "../ledger.js";
import type { Board } from "./board.js";
import type { CycleStore } from "./cycles.js";
import type { EventStore } from "./events.js";
import type { GrowthEnv } from "./env.js";
import type { ActionRecord, Proposal } from "./gate.js";
import { decide } from "./gate.js";
import type { Llm } from "./llm.js";
import type { OptInStore } from "./optin.js";
import type { GrowthPolicy } from "./policy.js";
import type { GrowthState } from "./state.js";
import type { Tools } from "./tools/index.js";
import type { PostizMedia } from "./tools/postiz.js";
import { errMsg } from "./util.js";

export type ChainSnapshot = { revenueYocto: string; passPriceYocto?: string };

export type EngineDeps = {
  state: GrowthState;
  cycles: CycleStore;
  events: EventStore;
  optin: OptInStore;
  tools: Tools;
  llm: Llm;
  env: GrowthEnv;
  dryRun: boolean;
  loadBrief: () => Brief;
  loadPolicy: () => GrowthPolicy;
  readChain?: () => Promise<ChainSnapshot | undefined>;
  board: Board;
  log: Log;
  now: () => number;
};

export type ActResult<T> = { rec: ActionRecord; out?: T; error?: string };

/** Per-call LLM budget reservation (live only). The actual token cost replaces it once known. */
export const LLM_RESERVE_USD = 0.1;

const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/;
const MIME_BY_EXT: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4", ".svg": "image/svg+xml" };
export const mimeFor = (file: string) => MIME_BY_EXT[file.slice(file.lastIndexOf(".")).toLowerCase()] ?? "application/octet-stream";

/**
 * Executes actions. Two ways in, one gate: `act` proposes an action and, if policy auto-approves it,
 * runs it now; `executeRunnable` runs actions a human approved later. Dry-run never touches the network
 * for external-effect kinds and labels everything "[DRY]".
 */
export class Engine {
  constructor(readonly d: EngineDeps) {}

  /** Owner policy with the Board-derived spend cap applied. Everything that spends goes through this. */
  policy(): GrowthPolicy { return this.d.board.applyTo(this.d.loadPolicy()); }

  assetPath(file: string) {
    const segments = file.split("/");
    if (segments.length > 2 || !segments.every(s => SEGMENT.test(s) && !s.includes(".."))) throw new Error("invalid asset name");
    return join(this.d.cycles.assetsDir, ...segments);
  }

  /** Propose → (auto-approved?) → run. `run` is for local/L0 work whose result the caller needs. */
  async act<T>(p: Proposal, run?: (ctx: { settle: (costUsd: number) => void }) => Promise<T>): Promise<ActResult<T>> {
    const summary = this.d.dryRun ? `[DRY] ${p.summary}` : p.summary;
    const rec = this.d.state.propose({ ...p, summary }, this.policy());
    if (rec.status !== "APPROVED") return { rec };
    try { this.d.state.begin(rec.id); } catch (err) { return { rec, error: errMsg(err) }; }
    try {
      if (run) {
        let settled: number | undefined;
        const out = await run({ settle: usd => { settled = usd; } });
        return { rec: this.d.state.executed(rec.id, { externalId: this.d.dryRun ? `DRY-${rec.id.slice(0, 8)}` : undefined, costUsd: settled }), out };
      }
      const r = await this.execute(rec);
      return { rec: this.d.state.executed(rec.id, r) as ActionRecord, out: r as unknown as T };
    } catch (e) {
      const msg = errMsg(e);
      return { rec: this.d.state.failed(rec.id, msg), error: msg };
    }
  }

  /** Run actions that a human approved since the last pass. */
  async executeRunnable(): Promise<{ done: number; failed: number }> {
    let done = 0, failed = 0;
    for (const rec of this.d.state.runnable()) {
      // Queued approvals can survive restarts and policy or mode changes. Never turn
      // a rehearsal into a live effect, or execute an action under a revoked policy.
      const wasDry = rec.summary.startsWith("[DRY] ");
      if (wasDry !== this.d.dryRun) continue;
      const decision = decide(rec, this.policy(), this.d.state.list().filter(a => a.id !== rec.id), this.d.now());
      if (decision.status !== "APPROVED" && !(decision.status === "PENDING_APPROVAL" && rec.decidedBy?.startsWith("human:"))) continue;
      try { this.d.state.begin(rec.id); } catch { continue; } // another executor already claimed it
      try { this.d.state.executed(rec.id, await this.execute(rec)); done++; }
      catch (e) { this.d.state.failed(rec.id, errMsg(e)); failed++; }
    }
    return { done, failed };
  }

  private async readAsset(file: string) {
    const path = this.assetPath(file);
    if (!existsSync(path)) throw new Error(`asset not found: ${file}`);
    return { bytes: new Uint8Array(readFileSync(path)), mime: mimeFor(file), file };
  }

  private async resolveIntegration(provider: string): Promise<string> {
    const pin = provider === "x" ? this.d.env.POSTIZ_X_INTEGRATION_ID : provider === "linkedin" ? this.d.env.POSTIZ_LINKEDIN_INTEGRATION_ID : undefined;
    if (pin) return pin;
    const list = await this.d.tools.postiz!.listIntegrations();
    const hit = list.find(i => i.identifier === provider && !i.disabled);
    if (!hit) throw new Error(`no connected Postiz channel for "${provider}"`);
    return hit.id;
  }

  /** Payload-driven execution for kinds with external effects. */
  async execute(rec: ActionRecord): Promise<{ externalId?: string; url?: string; costUsd?: number }> {
    const boardWrite = rec.kind.startsWith("board.") && this.d.env.GROWTH_BOARD_WRITES === "on";
    if (this.d.dryRun && !boardWrite) return { externalId: `DRY-${rec.id.slice(0, 8)}` };
    const t = this.d.tools;
    const files = Array.isArray(rec.payload.mediaFiles) ? (rec.payload.mediaFiles as unknown[]).filter((f): f is string => typeof f === "string") : [];
    const text = rec.text ?? "";
    switch (rec.kind) {
      case "bluesky.post": {
        if (!t.bluesky) throw new Error("bluesky not configured");
        const images = await Promise.all(files.filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f)).map(async f => { const a = await this.readAsset(f); return { bytes: a.bytes, mime: a.mime, alt: String(rec.payload.alt ?? "") }; }));
        const r = await t.bluesky.post(text, images);
        return { externalId: r.uri, url: r.url };
      }
      case "telegram.post": { if (!t.telegram) throw new Error("telegram not configured"); const r = await t.telegram.post(text); return { externalId: r.messageId, url: r.url }; }
      case "discord.post": { if (!t.discord) throw new Error("discord not configured"); const r = await t.discord.post(text); return { externalId: r.messageId }; }
      case "postiz.create_post.draft":
      case "postiz.create_post.schedule":
      case "postiz.create_post.now": {
        if (!t.postiz) throw new Error("postiz not configured");
        const provider = String(rec.payload.provider ?? "");
        if (!provider) throw new Error("postiz: provider missing");
        const integrationId = await this.resolveIntegration(provider);
        const media: PostizMedia[] = [];
        for (const f of files.filter(f => /\.(png|jpe?g|webp|gif|mp4)$/i.test(f))) { const a = await this.readAsset(f); media.push(await t.postiz.upload(a.bytes, f, a.mime)); }
        const parts = [text, ...(rec.parts ?? []).map(p => p.text)];
        const type = rec.kind.endsWith(".draft") ? "draft" : rec.kind.endsWith(".schedule") ? "schedule" : "now";
        const r = await t.postiz.createPost({ type, date: typeof rec.payload.date === "string" ? rec.payload.date : undefined, integrationId, provider, parts, media });
        return { externalId: r.postId };
      }
      case "resend.send.optin": {
        if (!t.resend) throw new Error("resend not configured");
        const to = String(rec.payload.to ?? "").trim().toLowerCase();
        if (!this.d.optin.has(to)) throw new Error("recipient has no recorded opt-in");
        const r = await t.resend.send(to, String(rec.payload.subject ?? ""), text);
        return { externalId: r.id };
      }
      case "instantly.create_campaign_paused": {
        if (!t.instantly) throw new Error("instantly not configured");
        const seq = rec.payload.sequence as { subject: string; body: string; delayDays: number }[];
        const r = await t.instantly.createCampaignPaused(String(rec.payload.name ?? "RAM HEIST outreach (paused)"), seq);
        return { externalId: r.id };
      }
      case "board.propose": {
        const r = await this.d.board.propose(String(rec.payload.title ?? "Growth budget"), typeof rec.payload.votingPeriodSecs === "number" ? rec.payload.votingPeriodSecs : undefined);
        return { externalId: `proposal-${r.id}`, url: r.explorerUrl };
      }
      case "board.finalize": {
        const r = await this.d.board.finalize(Number(rec.payload.proposalId));
        return { externalId: r.txHash, url: r.explorerUrl };
      }
      default: throw new Error(`no executor for "${rec.kind}"`);
    }
  }
}
