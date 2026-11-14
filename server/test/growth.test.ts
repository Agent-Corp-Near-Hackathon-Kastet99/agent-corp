import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { ROOT } from "../src/config.js";
import { validatePolicy, loadPolicy, levelFor, type GrowthPolicy } from "../src/growth/policy.js";
import { validateBrief, loadBrief, hasPlaceholderUrl } from "../src/growth/brief.js";
import { contentLint } from "../src/growth/lint.js";
import { decide } from "../src/growth/gate.js";
import { GrowthState } from "../src/growth/state.js";
import type { Activity } from "../src/ledger.js";

const policy = (over: Partial<GrowthPolicy> = {}): GrowthPolicy => ({ ...loadPolicy(), ...over });
const tmpFile = () => join(mkdtempSync(join(tmpdir(), "growth-")), "actions.json");
const rawPolicy = () => parse(readFileSync(join(ROOT, "growth", "policy.yaml"), "utf8"));

describe("growth config files", () => {
  it("shipped policy.yaml and brief.yaml validate", () => {
    expect(loadPolicy().levels["bluesky.post"]).toBe("L1");
    expect(loadBrief().product.name).toBe("RAM HEIST");
  });
  it("placeholder product URL is detected", () => { const brief=loadBrief(); expect(hasPlaceholderUrl({...brief,product:{...brief.product,url:"https://REPLACE-ME.vercel.app"}})).toBe(true); expect(hasPlaceholderUrl(brief)).toBe(false); });
  it("rejects bad policy", () => {
    const base = rawPolicy();
    expect(() => validatePolicy({ ...base, levels: { ...base.levels, "x.post": "L9" } })).toThrow("unknown level");
    expect(() => validatePolicy({ ...base, cycle_budget_usd: 50, total_budget_usd: 10 })).toThrow("cannot exceed");
    expect(() => validatePolicy({ ...base, growth_paused: "no" })).toThrow("growth_paused");
    expect(() => validatePolicy({ ...base, postiz_calls_per_hour: 1.5 })).toThrow("integer");
    expect(() => validatePolicy({ ...base, max_posts_per_day: { bluesky: -1 } })).toThrow("non-negative");
  });
  it("rejects bad brief", () => {
    const base = parse(readFileSync(join(ROOT, "growth", "brief.yaml"), "utf8"));
    expect(() => validateBrief({ ...base, product: { ...base.product, url: "ftp://x" } })).toThrow("http(s)");
    expect(() => validateBrief({ ...base, product: { ...base.product, url: "nope" } })).toThrow("valid URL");
    expect(() => validateBrief({ ...base, channels: [] })).toThrow("channels");
  });
  it("levelFor prefers exact over wildcard and longest wildcard", () => {
    const p = policy({ levels: { "chain.*": "DENY", "chain.view": "L0", "a.*": "L2", "a.b.*": "L1" } });
    expect(levelFor(p, "chain.view")).toBe("L0");
    expect(levelFor(p, "chain.send")).toBe("DENY");
    expect(levelFor(p, "a.b.c")).toBe("L1");
    expect(levelFor(p, "a.z")).toBe("L2");
    expect(levelFor(p, "unknown.kind")).toBeUndefined();
    expect(levelFor(p, "chain")).toBeUndefined();
  });
});

describe("contentLint", () => {
  const p = policy();
  it("passes clean copy", () => {
    expect(contentLint({ text: "House 01 is live. Sneak past the TV watcher.", channel: "bluesky" }, p).ok).toBe(true);
  });
  it("blocks returns language incl. plurals, but not look-alikes", () => {
    for (const bad of ["Get your dividends weekly", "Own a share: ownership for all", "A smart investment", "Guaranteed fun, earn more", "passive income!"]) {
      expect(contentLint({ text: bad }, p).ok, bad).toBe(false);
    }
    expect(contentLint({ text: "Learn the patrol routes. Early access." }, p).ok).toBe(true);
  });
  it("requires testnet label when mentioning buying or price", () => {
    expect(contentLint({ text: "Buy the pass now" }, p).violations.join()).toContain("label");
    expect(contentLint({ text: "Buy the pass (DEMO / testnet)" }, p).ok).toBe(true);
    expect(contentLint({ text: "pass for 1 tNEAR, demo on testnet" }, p).ok).toBe(true);
  });
  it("enforces channel length in characters, not bytes", () => {
    expect(contentLint({ text: "é".repeat(300), channel: "bluesky" }, p).ok).toBe(true);
    expect(contentLint({ text: "a".repeat(301), channel: "bluesky" }, p).ok).toBe(false);
    expect(contentLint({ text: "a".repeat(281), channel: "x" }, p).ok).toBe(false);
  });
  it("X links must be in replies", () => {
    expect(contentLint({ text: "play https://a.co", channel: "x" }, p).ok).toBe(false);
    expect(contentLint({ text: "play https://a.co", channel: "x", isReply: true }, p).ok).toBe(true);
    expect(contentLint({ text: "play https://a.co", channel: "bluesky" }, p).ok).toBe(true);
    expect(contentLint({ text: "play https://a.co", channel: "x" }, policy({ content_rules: { ...p.content_rules, x_links: "any" } })).ok).toBe(true);
  });
  it("rejects empty text", () => { expect(contentLint({ text: "  " }, p).violations).toContain("empty text"); });
});

describe("gate.decide", () => {
  const p = policy();
  const now = 1_000_000_000;
  const base = { cycle: 1, summary: "s" };

  it("routes levels", () => {
    expect(decide({ ...base, kind: "exa.search" }, p, [], now)).toMatchObject({ status: "APPROVED", level: "L0", decidedBy: "policy:L0" });
    expect(decide({ ...base, kind: "bluesky.post", channel: "bluesky", text: "hello" }, p, [], now)).toMatchObject({ status: "APPROVED", level: "L1" });
    expect(decide({ ...base, kind: "postiz.create_post.now", channel: "x", text: "hello" }, p, [], now)).toMatchObject({ status: "PENDING_APPROVAL", level: "L2" });
    expect(decide({ ...base, kind: "postiz.create_post.draft", channel: "x", text: "hello" }, p, [], now).status).toBe("APPROVED");
    expect(decide({ ...base, kind: "reddit.post", text: "hello" }, p, [], now).status).toBe("HUMAN_TASK");
  });
  it("default-denies unknown kinds and DENY levels, incl. chain wildcard and cold email", () => {
    expect(decide({ ...base, kind: "mystery.action" }, p, [], now).status).toBe("DENIED");
    expect(decide({ ...base, kind: "chain.buy_pass" }, p, [], now).status).toBe("DENIED");
    expect(decide({ ...base, kind: "email.cold" }, p, [], now).status).toBe("DENIED");
    expect(decide({ ...base, kind: "resend.send.other" }, p, [], now).status).toBe("DENIED");
  });
  it("kill switch denies everything, even L0", () => {
    const d = decide({ ...base, kind: "exa.search" }, policy({ growth_paused: true }), [], now);
    expect(d).toMatchObject({ status: "DENIED" });
    expect(d.reason).toContain("paused");
  });
  it("lint failure denies before any approval is asked", () => {
    const d = decide({ ...base, kind: "postiz.create_post.now", channel: "x", text: "weekly dividends" }, p, [], now);
    expect(d.status).toBe("DENIED");
    expect(d.reason).toContain("dividend");
  });

  const mk = (over: Partial<import("../src/growth/gate.js").ActionRecord>): import("../src/growth/gate.js").ActionRecord =>
    ({ id: "x", cycle: 1, kind: "fal.image", summary: "", payload: {}, costUsd: 0, status: "EXECUTED", createdAt: now, updatedAt: now, ...over });

  it("enforces budgets and retains uncertain failed spend", () => {
    const hist = [mk({ costUsd: 4 }), mk({ costUsd: 3, status: "DENIED" }), mk({ costUsd: 3, status: "FAILED" })];
    expect(decide({ ...base, kind: "fal.image", costUsd: 1 }, p, hist, now).status).toBe("DENIED");
    expect(decide({ ...base, kind: "fal.image", costUsd: 1.01 }, p, hist, now).reason).toContain("cycle budget");
    // other cycle: total cap 10
    const big = [mk({ cycle: 1, costUsd: 5 }), mk({ cycle: 2, costUsd: 4.5 })];
    expect(decide({ ...base, cycle: 3, kind: "fal.image", costUsd: 1 }, p, big, now).reason).toContain("total budget");
    expect(decide({ ...base, kind: "fal.image", costUsd: -1 }, p, [], now).reason).toContain("invalid");
    expect(decide({ ...base, kind: "fal.image", costUsd: NaN }, p, [], now).reason).toContain("invalid");
  });
  it("defers when the Postiz hourly rate is exhausted and recovers after an hour", () => {
    const hist = Array.from({ length: 25 }, () => mk({ kind: "postiz.read", createdAt: now - 1000 }));
    expect(decide({ ...base, kind: "postiz.read" }, p, hist, now).status).toBe("DEFERRED");
    expect(decide({ ...base, kind: "postiz.read" }, p, hist, now + 3_600_001).status).toBe("APPROVED");
    expect(decide({ ...base, kind: "exa.search" }, p, hist, now).status).toBe("APPROVED"); // other tools unaffected
  });
  it("enforces daily post caps per channel", () => {
    const hist = Array.from({ length: 4 }, () => mk({ kind: "bluesky.post", createdAt: now - 1000 }));
    const d = decide({ ...base, kind: "bluesky.post", channel: "bluesky", text: "hi" }, p, hist, now);
    expect(d.status).toBe("DENIED");
    expect(d.reason).toContain("daily cap");
    expect(decide({ ...base, kind: "bluesky.post", channel: "bluesky", text: "hi" }, p, hist, now + 86_400_001).status).toBe("APPROVED");
    expect(decide({ ...base, kind: "telegram.post", channel: "telegram", text: "hi" }, p, hist, now).status).toBe("APPROVED");
  });
  it("denies a post kind with no configured cap rather than allowing it", () => {
    const q = policy({ levels: { ...p.levels, "mastodon.post": "L1" } });
    expect(decide({ ...base, kind: "mastodon.post", text: "hi" }, q, [], now).reason).toContain("no daily post cap");
  });
});

describe("GrowthState", () => {
  const setup = () => {
    const feed: Activity[] = [];
    let t = 1_000;
    const file = tmpFile();
    const state = new GrowthState(e => feed.push(e), () => t, file);
    return { feed, state, file, tick: (n: number) => { t += n; } };
  };
  const p = policy();

  it("records L2 proposals as pending, approve → runnable → executed with real URL", () => {
    const { state, feed } = setup();
    const a = state.propose({ cycle: 1, kind: "postiz.create_post.now", summary: "launch tweet", channel: "x", text: "House 01 is live." }, p);
    expect(a.status).toBe("PENDING_APPROVAL");
    expect(state.pending()).toHaveLength(1);
    expect(state.runnable()).toHaveLength(0);
    expect(() => state.executed(a.id, { url: "https://x.com/1" })).toThrow("expected APPROVED");
    state.approve(a.id, "ostap");
    expect(state.runnable()).toHaveLength(1);
    const done = state.executed(a.id, { externalId: "p1", url: "https://x.com/1" });
    expect(done).toMatchObject({ status: "EXECUTED", url: "https://x.com/1", decidedBy: "human:ostap" });
    expect(feed.every(e => e.actor === "MARKETING")).toBe(true);
    expect(feed.at(-1)!.text).toContain("https://x.com/1");
  });
  it("cannot approve twice, approve a denied action, or approve without a name", () => {
    const { state } = setup();
    const ok = state.propose({ cycle: 1, kind: "postiz.create_post.now", summary: "s", channel: "x", text: "hi" }, p);
    expect(() => state.approve(ok.id, " ")).toThrow("approver");
    state.approve(ok.id, "a");
    expect(() => state.approve(ok.id, "a")).toThrow("expected PENDING_APPROVAL");
    const bad = state.propose({ cycle: 1, kind: "postiz.create_post.now", summary: "s", channel: "x", text: "dividends" }, p);
    expect(bad.status).toBe("DENIED");
    expect(() => state.approve(bad.id, "a")).toThrow("DENIED");
    expect(() => state.approve("nope", "a")).toThrow("unknown");
  });
  it("reject and human-task completion require proof", () => {
    const { state } = setup();
    const r = state.propose({ cycle: 1, kind: "reddit.post", summary: "r/stealthgames", text: "hello" }, p);
    expect(r.status).toBe("HUMAN_TASK");
    expect(() => state.humanDone(r.id, "ostap", "")).toThrow("proof");
    expect(state.humanDone(r.id, "ostap", "https://reddit.com/r/x/1").status).toBe("EXECUTED");
    const q = state.propose({ cycle: 1, kind: "postiz.create_post.now", summary: "s", channel: "x", text: "hi" }, p);
    expect(state.reject(q.id, "ostap", "off brand")).toMatchObject({ status: "REJECTED", reason: "off brand" });
  });
  it("failed executions retain budget; executed cannot be failed", () => {
    const { state } = setup();
    const a = state.propose({ cycle: 1, kind: "fal.image", summary: "key art", costUsd: 2 }, p);
    expect(state.spentUsd()).toBe(2);
    state.failed(a.id, "fal 500");
    expect(state.spentUsd()).toBe(2);
    const b = state.propose({ cycle: 1, kind: "fal.image", summary: "key art", costUsd: 2 }, p);
    state.executed(b.id, {});
    expect(() => state.failed(b.id, "late")).toThrow("expected APPROVED");
    expect(state.spentUsd(1)).toBe(4);
    expect(state.spentUsd(2)).toBe(0);
  });
  it("budget gate sees recorded history across proposals", () => {
    const { state } = setup();
    state.propose({ cycle: 1, kind: "fal.image", summary: "a", costUsd: 3 }, p);
    state.propose({ cycle: 1, kind: "fal.image", summary: "b", costUsd: 2 }, p);
    const c = state.propose({ cycle: 1, kind: "fal.image", summary: "c", costUsd: 0.5 }, p);
    expect(c.status).toBe("DENIED");
    expect(c.reason).toContain("cycle budget");
  });
  it("persists atomically and reloads; rejects a corrupt file", () => {
    const { state, file } = setup();
    const a = state.propose({ cycle: 1, kind: "postiz.create_post.now", summary: "s", channel: "x", text: "hi" }, p);
    const again = new GrowthState(() => undefined, () => 5, file);
    expect(again.get(a.id)?.status).toBe("PENDING_APPROVAL");
    expect(again.get(a.id)).not.toBe(again.get(a.id)); // defensive copies
    require_("node:fs").writeFileSync(file, JSON.stringify([{ id: 1 }]));
    expect(() => new GrowthState(() => undefined, () => 5, file)).toThrow("Invalid growth action log");
  });
  it("a refusal is recorded and logged, not thrown", () => {
    const { state, feed } = setup();
    const d = state.propose({ cycle: 1, kind: "chain.buy_pass", summary: "try to buy" }, p);
    expect(d.status).toBe("DENIED");
    expect(feed.at(-1)!.text).toContain("blocked:");
  });
});

import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
