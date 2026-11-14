import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDotenv, loadGrowthEnv, isDryRun } from "../src/growth/env.js";
import { http, safeOrigin } from "../src/growth/http.js";
import { postiz } from "../src/growth/tools/postiz.js";
import { bluesky, linkFacets } from "../src/growth/tools/bluesky.js";
import { telegram, discord } from "../src/growth/tools/chat.js";
import { fal } from "../src/growth/tools/fal.js";
import { exa } from "../src/growth/tools/exa.js";
import { posthog } from "../src/growth/tools/posthog.js";
import { resend } from "../src/growth/tools/resend.js";
import { instantly } from "../src/growth/tools/instantly.js";
import { cutClip } from "../src/growth/tools/clip.js";
import { makeTools } from "../src/growth/tools/index.js";
import { AnthropicLlm, DryLlm, extractJson } from "../src/growth/llm.js";
import { EventStore } from "../src/growth/events.js";
import { OptInStore } from "../src/growth/optin.js";
import { utmLink } from "../src/growth/util.js";
import { validateDirective } from "../src/growth/types.js";

type Call = { url: string; init: RequestInit };
const reply = (body: unknown, status = 200, headers: Record<string, string> = { "content-type": "application/json" }) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
function mock(handler: (url: string, init: RequestInit, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init: RequestInit = {}) => { calls.push({ url: String(url), init }); return handler(String(url), init, calls.length); }) as typeof fetch;
  return { f, calls };
}
const hdr = (c: Call, k: string) => new Headers(c.init.headers).get(k);
const body = (c: Call) => JSON.parse(String(c.init.body));

describe("env + http", () => {
  it("parses dotenv, process env wins, only known keys, dry-run default on", () => {
    expect(parseDotenv("# c\nA=1\nexport B='two words'\nC=\"x\" \nD=v # trailing\nbad line")).toEqual({ A: "1", B: "two words", C: "x", D: "v" });
    const dir = mkdtempSync(join(tmpdir(), "env-")); const file = join(dir, ".env.growth");
    writeFileSync(file, "FAL_KEY=file\nEXA_API_KEY=file\nRANDOM_SECRET=nope\n");
    const env = loadGrowthEnv({ FAL_KEY: "proc" } as NodeJS.ProcessEnv, file);
    expect(env).toEqual({ FAL_KEY: "proc", EXA_API_KEY: "file" });
    expect(isDryRun({})).toBe(true);
    expect(isDryRun({ GROWTH_DRY_RUN: "off" })).toBe(false);
    expect(isDryRun({ GROWTH_DRY_RUN: "OFF" })).toBe(false);
    expect(isDryRun({ GROWTH_DRY_RUN: "false" })).toBe(true); // only an explicit "off" goes live
  });
  it("http errors never contain URL secrets or auth headers", async () => {
    const { f } = mock(() => reply("nope", 500, {}));
    await expect(http(f, "https://api.telegram.org/botSECRET123/sendMessage", { method: "POST", headers: { authorization: "Bearer TOPSECRET" } })).rejects.toThrow(/api\.telegram\.org → 500/);
    try { await http(f, "https://api.telegram.org/botSECRET123/sendMessage", { headers: { authorization: "Bearer TOPSECRET" } }); } catch (e) {
      expect(String((e as Error).message)).not.toMatch(/SECRET123|TOPSECRET/);
    }
    const boom = mock(() => { throw new Error("connect ECONNREFUSED https://x/botSECRET123"); });
    await expect(http(boom.f, "https://x.example/botSECRET123/y")).rejects.toThrow(/failed: Error$/);
    expect(safeOrigin("https://discord.com/api/webhooks/1/token")).toBe("https://discord.com");
    expect(safeOrigin("nope")).toBe("invalid-url");
  });
});

describe("postiz", () => {
  it("sends raw Authorization key, documented body, and parses response + analytics", async () => {
    const m = mock((url) => {
      if (url.endsWith("/integrations")) return reply([{ id: "i1", identifier: "x" }, { nope: true }]);
      if (url.endsWith("/upload")) return reply({ id: "m1", path: "https://cdn/x.png" });
      if (url.endsWith("/posts")) return reply([{ postId: "p9", integration: "i1" }]);
      return reply([{ label: "Impressions", data: [{ total: "10", date: "d" }, { total: "5", date: "e" }], percentageChange: 1 }, { label: 5 }]);
    });
    const p = postiz({ POSTIZ_API_KEY: "KEY" }, m.f);
    expect(await p.listIntegrations()).toEqual([{ id: "i1", identifier: "x" }]);
    expect(hdr(m.calls[0]!, "authorization")).toBe("KEY");
    expect(m.calls[0]!.url).toBe("https://api.postiz.com/public/v1/integrations");
    const media = await p.upload(new Uint8Array([1, 2, 3]), "a.png", "image/png");
    expect(media).toEqual({ id: "m1", path: "https://cdn/x.png" });
    expect(m.calls[1]!.init.body).toBeInstanceOf(FormData);
    const r = await p.createPost({ type: "now", integrationId: "i1", provider: "x", parts: ["main", "reply"], media: [media] });
    expect(r.postId).toBe("p9");
    const b = body(m.calls[2]!);
    expect(b).toMatchObject({ type: "now", shortLink: false, tags: [] });
    expect(b.posts[0]).toMatchObject({ integration: { id: "i1" }, settings: { __type: "x" } });
    expect(b.posts[0].value[0].image).toEqual([{ id: "m1", path: "https://cdn/x.png" }]);
    expect(b.posts[0].value[1].image).toEqual([]);
    expect(await p.postAnalytics("p 9", 7)).toEqual([{ label: "Impressions", total: 15 }]);
    expect(m.calls[3]!.url).toContain("/analytics/post/p%209?date=7");
  });
  it("requires a key and at least one part; supports self-host base URL", async () => {
    await expect(postiz({}, mock(() => reply([])).f).listIntegrations()).rejects.toThrow("POSTIZ_API_KEY");
    const m = mock(() => reply([]));
    await postiz({ POSTIZ_API_KEY: "k", POSTIZ_BASE_URL: "https://me.example/api/public/v1/" }, m.f).listIntegrations();
    expect(m.calls[0]!.url).toBe("https://me.example/api/public/v1/integrations");
    await expect(postiz({ POSTIZ_API_KEY: "k" }, m.f).createPost({ type: "draft", integrationId: "i", provider: "x", parts: [] })).rejects.toThrow("at least one");
  });
});

describe("bluesky", () => {
  it("computes link facets in UTF-8 bytes", () => {
    const f = linkFacets("é🙂 see https://a.co/x?y=1 ok");
    const enc = new TextEncoder();
    expect(f).toHaveLength(1);
    expect(f[0]!.index.byteStart).toBe(enc.encode("é🙂 see ").length);
    expect(f[0]!.index.byteEnd - f[0]!.index.byteStart).toBe(enc.encode("https://a.co/x?y=1").length);
  });
  it("logs in once, uploads blobs, posts with embed and returns a real URL", async () => {
    let t = 0;
    const m = mock((url) => {
      if (url.endsWith("createSession")) return reply({ accessJwt: "JWT", did: "did:plc:abc" });
      if (url.endsWith("uploadBlob")) return reply({ blob: { $type: "blob", ref: { $link: "bafy" } } });
      return reply({ uri: "at://did:plc:abc/app.bsky.feed.post/3kxyz" });
    });
    const b = bluesky({ BLUESKY_HANDLE: "corp.bsky.social", BLUESKY_APP_PASSWORD: "app-pass" }, m.f, () => t);
    const r = await b.post("hello https://a.co", [{ bytes: new Uint8Array([1]), mime: "image/png", alt: "alt" }]);
    expect(r.url).toBe("https://bsky.app/profile/corp.bsky.social/post/3kxyz");
    const create = m.calls.find(c => c.url.endsWith("createRecord"))!;
    expect(hdr(create, "authorization")).toBe("Bearer JWT");
    const rec = body(create);
    expect(rec.repo).toBe("did:plc:abc");
    expect(rec.record.embed.images[0].alt).toBe("alt");
    expect(rec.record.facets).toHaveLength(1);
    await b.post("again");
    expect(m.calls.filter(c => c.url.endsWith("createSession"))).toHaveLength(1); // session cached
    t = 5 * 60_000;
    await b.post("later");
    expect(m.calls.filter(c => c.url.endsWith("createSession"))).toHaveLength(2); // expired → relogin
    await expect(b.post("x".repeat(301))).rejects.toThrow("300");
    await expect(bluesky({}, m.f).post("x")).rejects.toThrow("missing");
  });
});

describe("telegram / discord", () => {
  it("posts to the env chat only and does not leak the token on failure", async () => {
    const m = mock(() => reply({ ok: true, result: { message_id: 7, chat: { username: "corpchan" } } }));
    const t = telegram({ TELEGRAM_BOT_TOKEN: "TOK", TELEGRAM_CHAT_ID: "@corpchan" }, m.f);
    expect(await t.post("hi")).toEqual({ messageId: "7", url: "https://t.me/corpchan/7" });
    expect(body(m.calls[0]!).chat_id).toBe("@corpchan");
    const bad = mock(() => reply("denied", 403, {}));
    await expect(telegram({ TELEGRAM_BOT_TOKEN: "TOK", TELEGRAM_CHAT_ID: "1" }, bad.f).post("x")).rejects.not.toThrow(/TOK\b/);
  });
  it("discord requires a real discord webhook, disables mentions, uses wait=true", async () => {
    const m = mock(() => reply({ id: "55" }));
    const hook = "https://discord.com/api/webhooks/1/abc";
    expect(await discord({ DISCORD_WEBHOOK_URL: hook }, m.f).post("hi @everyone")).toEqual({ messageId: "55" });
    expect(m.calls[0]!.url).toBe(`${hook}?wait=true`);
    expect(body(m.calls[0]!).allowed_mentions).toEqual({ parse: [] });
    await expect(discord({ DISCORD_WEBHOOK_URL: "https://evil.example/api/webhooks/1/x" }, m.f).post("x")).rejects.toThrow("not a Discord webhook");
  });
});

describe("fal / exa / posthog / resend / instantly", () => {
  it("fal generates then downloads over https only", async () => {
    const m = mock((url) => url.startsWith("https://fal.run/") ? reply({ images: [{ url: "https://cdn.fal/x.png", content_type: "image/png" }], seed: 3 })
      : new Response(new Uint8Array([9, 9]), { headers: { "content-type": "image/png" } }));
    const r = await fal({ FAL_KEY: "K" }, m.f).image("a heist");
    expect(hdr(m.calls[0]!, "authorization")).toBe("Key K");
    expect(m.calls[0]!.url).toBe("https://fal.run/fal-ai/flux/schnell");
    expect(Array.from(r.bytes)).toEqual([9, 9]);
    expect(fal({ FAL_KEY: "K" }, m.f).estimateUsd).toBe(0.05);
    expect(() => fal({ FAL_KEY: "K", GROWTH_FAL_IMAGE_USD: "-1" }, m.f)).toThrow();
    const http1 = mock(() => reply({ images: [{ url: "http://insecure/x.png" }] }));
    await expect(fal({ FAL_KEY: "K" }, http1.f).image("x")).rejects.toThrow("https");
  });
  it("exa maps results and clamps n", async () => {
    const m = mock(() => reply({ results: [{ title: "T", url: "https://u", text: "tx" }, { title: "no url" }] }));
    const r = await exa({ EXA_API_KEY: "E" }, m.f).search("q", 99);
    expect(r).toEqual([{ title: "T", url: "https://u", text: "tx", publishedDate: undefined }]);
    expect(body(m.calls[0]!).numResults).toBe(10);
    expect(hdr(m.calls[0]!, "x-api-key")).toBe("E");
  });
  it("posthog validates funnel inputs (no HogQL injection) and parses counts", async () => {
    const m = mock(() => reply({ results: [["page_view", 12], ["other", 5]] }));
    const ph = posthog({ POSTHOG_PERSONAL_API_KEY: "P", POSTHOG_PROJECT_ID: "42" }, m.f);
    expect(await ph.funnel(["page_view", "pass_click"], 7)).toEqual({ page_view: 12, pass_click: 0 });
    expect(m.calls[0]!.url).toBe("https://us.posthog.com/api/projects/42/query/");
    await expect(ph.funnel(["a' OR 1=1 --"], 7)).rejects.toThrow("step names");
    await expect(ph.funnel(["page_view"], 0)).rejects.toThrow("days");
    await expect(posthog({ POSTHOG_PERSONAL_API_KEY: "P", POSTHOG_PROJECT_ID: "4;2" }, m.f).funnel(["page_view"], 1)).rejects.toThrow("numeric");
    await posthog({ POSTHOG_KEY: "pk" }, m.f).capture("page_view", "u1", { a: 1 });
    expect(body(m.calls.at(-1)!)).toMatchObject({ api_key: "pk", event: "page_view", distinct_id: "u1" });
  });
  it("resend sends one recipient; instantly creates a campaign and has no launch method", async () => {
    const m = mock(() => reply({ id: "id1" }));
    expect(await resend({ RESEND_API_KEY: "R", RESEND_FROM: "a@b.co" }, m.f).send("c@d.co", "s", "t")).toEqual({ id: "id1" });
    expect(body(m.calls[0]!).to).toEqual(["c@d.co"]);
    const inst = instantly({ INSTANTLY_API_KEY: "I" }, m.f);
    expect(await inst.createCampaignPaused("n", [{ subject: "s", body: "b", delayDays: 2 }])).toEqual({ id: "id1" });
    expect(Object.keys(inst)).toEqual(["createCampaignPaused"]);
    await expect(inst.createCampaignPaused("n", [])).rejects.toThrow("empty");
  });
  it("makeTools exposes only tools with credentials", () => {
    expect(Object.keys(makeTools({}))).toEqual([]);
    expect(Object.keys(makeTools({ POSTIZ_API_KEY: "k", EXA_API_KEY: "e", BLUESKY_HANDLE: "h" })).sort()).toEqual(["exa", "postiz"]);
  });
});

describe("llm", () => {
  it("extractJson tolerates prose and fences", () => {
    expect(extractJson('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => extractJson("nothing")).toThrow();
  });
  it("DryLlm validates its own stand-in", async () => {
    await expect(new DryLlm().json({ label: "x", system: "", prompt: "", dry: () => 5, validate: v => { if (v !== 5) throw new Error("bad"); return v as number; } })).resolves.toEqual({ value: 5, costUsd: 0 });
  });
  it("AnthropicLlm retries once on invalid JSON, sums cost, sends images, never leaks key", async () => {
    let n = 0;
    const m = mock(() => reply({ content: [{ type: "text", text: ++n === 1 ? "not json" : '{"ok":true}' }], usage: { input_tokens: 1_000_000, output_tokens: 100_000 } }));
    const llm = new AnthropicLlm({ ANTHROPIC_API_KEY: "SK", GROWTH_LLM_IN_PER_MTOK: "3", GROWTH_LLM_OUT_PER_MTOK: "15" }, m.f);
    const r = await llm.json({ label: "t", system: "s", prompt: "p", images: [{ mime: "image/png", base64: "AAAA" }], validate: v => { if (!(v as { ok?: boolean }).ok) throw new Error("x"); return true; }, dry: () => true });
    expect(r.value).toBe(true);
    expect(r.costUsd).toBeCloseTo(2 * (3 + 1.5), 5);
    expect(m.calls).toHaveLength(2);
    expect(hdr(m.calls[0]!, "x-api-key")).toBe("SK");
    expect(body(m.calls[0]!).messages[0].content[0].type).toBe("image");
    expect(body(m.calls[1]!).messages[0].content.at(-1).text).toContain("previous reply was invalid");
    const bad = mock(() => reply({ content: [{ type: "text", text: "never json" }] }));
    await expect(new AnthropicLlm({ ANTHROPIC_API_KEY: "SK" }, bad.f).json({ label: "t", system: "", prompt: "", validate: v => v, dry: () => 0 })).rejects.toThrow("valid JSON");
    expect(() => new AnthropicLlm({}, bad.f)).toThrow("ANTHROPIC_API_KEY");
  });
});

describe("clip", () => {
  it("builds two ffmpeg commands with an args array (no shell) and rejects a missing input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clip-")); const input = join(dir, "in.mp4"); writeFileSync(input, "x");
    const seen: string[][] = [];
    const out = await cutClip(input, join(dir, "out"), async (cmd, args) => { expect(cmd).toBe("ffmpeg"); seen.push(args); });
    expect(seen).toHaveLength(2);
    expect(seen[0]!.join(" ")).toContain("scale=1280:720");
    expect(seen[1]!.join(" ")).toContain("crop=ih*9/16:ih");
    expect(out.tall.endsWith("clip-9x16.mp4")).toBe(true);
    await expect(cutClip(join(dir, "missing.mp4"), dir, async () => undefined)).rejects.toThrow("not found");
  });
});

describe("events, opt-in, utm, directive", () => {
  const mk = () => mkdtempSync(join(tmpdir(), "ev-"));
  it("records only whitelisted events with validated fields and counts unique visitors per cycle", () => {
    const dir = mk(); let t = 1000;
    const s = new EventStore(() => t, join(dir, "e.json"));
    expect(s.record({ name: "page_view", anon: "abc", cycle: 1, channel: "x", asset: "c1-x" })).toBeUndefined();
    expect(s.record({ name: "page_view", anon: "abc", cycle: 1 })).toBeUndefined(); // same visitor
    expect(s.record({ name: "page_view", anon: "def", cycle: 2 })).toBeUndefined();
    expect(s.record({ name: "wallet_connect", anon: "abc", cycle: 1 })).toBeUndefined();
    expect(s.record({ name: "hack", anon: "abc" })).toBe("unknown event");
    expect(s.record({ name: "page_view", anon: "bad id with spaces" })).toBe("invalid anon id");
    expect(s.record({ name: "page_view", anon: "abc", channel: "<script>" })).toBe("invalid attribution field");
    expect(s.record({ name: "page_view", anon: "abc", cycle: -1 })).toBe("invalid cycle");
    expect(s.record("x")).toBe("invalid body");
    expect(s.funnel({ cycle: 1 })).toMatchObject({ page_view: 1, wallet_connect: 1 });
    expect(s.funnel({ cycle: 2 }).page_view).toBe(1);
    expect(s.funnel().page_view).toBe(2);
    t = 5000; expect(s.funnel({ sinceTs: 2000 }).page_view).toBe(0);
    expect(new EventStore(() => 0, join(dir, "e.json")).count()).toBe(4); // persisted
    expect(readFileSync(join(dir, "e.json"), "utf8")).not.toContain('"abc"'); // anon id is hashed
  });
  it("opt-in store validates, dedupes, caps and persists", () => {
    const dir = mk();
    const s = new OptInStore(() => 1, join(dir, "o.json"));
    expect(s.add(" A@B.co ")).toBe(true);
    expect(s.add("a@b.co")).toBe(false);
    expect(s.has("A@b.CO")).toBe(true);
    expect(() => s.add("nope")).toThrow("invalid email");
    expect(() => s.add("a b@c.co")).toThrow();
    expect(new OptInStore(() => 1, join(dir, "o.json")).count()).toBe(1);
    expect(existsSync(join(dir, "o.json"))).toBe(true);
  });
  it("utmLink sets attribution and replaces prior params", () => {
    const u = new URL(utmLink("https://g.example/play?utm_source=old&x=1", { channel: "bluesky", cycle: 3, asset: "c3-bluesky" }));
    expect(u.searchParams.get("utm_source")).toBe("bluesky");
    expect(u.searchParams.get("utm_campaign")).toBe("cycle-3");
    expect(u.searchParams.get("x")).toBe("1");
  });
  it("directive validation pins channel and metric to the brief", () => {
    const ctx = { cycle: 2, channels: ["bluesky", "x"], funnel: ["click", "pass_bought"] };
    const ok = { diagnosis: "d", stage: "awareness", bet: { hypothesis: "h", channel: "x", audience: "a", metric: "click", target: 10, hours: 24 }, assets: ["key_art"], budget_usd: 1 };
    expect(validateDirective(ok, ctx).cycle).toBe(2);
    expect(() => validateDirective({ ...ok, bet: { ...ok.bet, channel: "tiktok" } }, ctx)).toThrow("not in brief.channels");
    expect(() => validateDirective({ ...ok, bet: { ...ok.bet, metric: "revenue" } }, ctx)).toThrow("not in brief.funnel");
    expect(() => validateDirective({ ...ok, bet: { ...ok.bet, hours: 999 } }, ctx)).toThrow("hours");
    expect(() => validateDirective({ ...ok, bet: { ...ok.bet, target: 0 } }, ctx)).toThrow("target");
    expect(() => validateDirective({ ...ok, assets: ["rocket"] }, ctx)).toThrow("assets");
    expect(() => validateDirective({ ...ok, stage: "vibes" }, ctx)).toThrow("stage");
    expect(() => validateDirective({ ...ok, budget_usd: -1 }, ctx)).toThrow("budget");
  });
});
