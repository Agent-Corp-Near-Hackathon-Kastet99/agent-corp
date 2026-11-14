/**
 * The growth team. Each role is a function over the Engine: the model proposes content and decisions,
 * code validates them, the gate decides, executors act. Models never see credentials and never write URLs
 * (links are built here with UTM parameters).
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { Brief } from "./brief.js";
import type { AssetRecord, CycleRecord, Measurement, Target } from "./cycles.js";
import { LLM_RESERVE_USD, mimeFor, type Engine } from "./engine.js";
import { CHANNEL_LIMITS } from "./lint.js";
import type { JsonRequest } from "./llm.js";
import { ASSET_KINDS, METRICS, STAGES, validateDirective, type Directive } from "./types.js";
import { cutClip } from "./tools/clip.js";
import { FUNNEL_EVENTS } from "./events.js";
import { errMsg, slug, utmLink } from "./util.js";

const DAY = 86_400_000;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** One LLM call, budget-gated and audited as an action. Throws if the gate refuses. */
async function ask<T>(e: Engine, cycle: number, label: string, req: Omit<JsonRequest<T>, "label">): Promise<T> {
  const r = await e.act<T>({ cycle, kind: "llm.generate", summary: label, costUsd: e.d.llm.live ? LLM_RESERVE_USD : 0 }, async ({ settle }) => {
    const res = await e.d.llm.json<T>({ label, ...req });
    settle(res.costUsd);
    return res.value;
  });
  if (r.rec.status !== "EXECUTED") throw new Error(`${label} ${r.error ? `failed: ${r.error}` : `blocked: ${r.rec.reason ?? r.rec.status}`}`);
  return r.out as T;
}

// ---------------------------------------------------------------- sense

export type Snapshot = {
  cycle: number;
  funnel: Record<string, number>;
  funnelSource: "posthog" | "local" | "none";
  chain?: { revenueYocto: string; passPriceYocto?: string };
  previous: { cycle: number; stage?: string; metric?: string; target?: number; value?: number; outcome?: string; learning?: string; seeded?: boolean }[];
  learnings: string;
  spentUsd: number;
  waitlist: number;
};

export async function sense(e: Engine, cycle: number): Promise<Snapshot> {
  const { events, tools, dryRun, cycles, state, optin, readChain, now } = e.d;
  let funnel: Record<string, number> = events.funnel({ sinceTs: now() - 7 * DAY });
  let funnelSource: Snapshot["funnelSource"] = events.count() > 0 ? "local" : "none";
  if (tools.posthog && !dryRun) {
    try { funnel = await tools.posthog.funnel([...FUNNEL_EVENTS], 7); funnelSource = "posthog"; } catch { /* fall back to local */ }
  }
  let chain: Snapshot["chain"];
  try { chain = await readChain?.(); } catch { chain = undefined; }
  const previous = cycles.list().slice(-3).map(c => ({
    cycle: c.cycle, stage: c.directive?.stage, metric: c.measurement?.metric ?? c.directive?.bet.metric, target: c.directive?.bet.target,
    value: c.measurement?.value, outcome: c.measurement?.outcome, learning: c.learning, seeded: c.seeded,
  }));
  return { cycle, funnel, funnelSource, chain, previous, learnings: cycles.learnings().slice(-2000), spentUsd: state.spentUsd(), waitlist: optin.count() };
}

// ---------------------------------------------------------------- CEO

const CEO_SYSTEM = `You are the CEO agent of Agent Corp, a tiny autonomous company. You decide ONE growth bet per cycle.
Rules: diagnose from the numbers you are given and cite them; if there is no audience data, say so and choose an awareness bet;
if there is traffic but few wallet connections, choose a conversion bet; if connections but no purchases, choose an offer/onboarding bet.
Never promise returns, dividends, ownership or income. The product is a DEMO on testnet. Prefer cheap, testable bets.`;

function dryDirective(b: Brief, snap: Snapshot, cap: number, cycle: number): Directive {
  const sum = Object.values(snap.funnel).reduce((s, n) => s + n, 0);
  const channel = ["bluesky", "x"].find(c => b.channels.includes(c)) ?? b.channels[0]!;
  const metric = (b.funnel.includes("click") ? "click" : b.funnel[1] ?? b.funnel[0])!;
  const stage = sum === 0 ? "awareness" : (snap.funnel.wallet_connect ?? 0) === 0 ? "conversion" : "traffic";
  return {
    cycle,
    diagnosis: sum === 0
      ? `No audience data yet (0 tracked visitors in 7 days, ${snap.waitlist} waitlist sign-ups). Awareness is the bottleneck.`
      : `${snap.funnel.page_view ?? 0} visitors, ${snap.funnel.wallet_connect ?? 0} wallet connects, ${snap.funnel.pass_click ?? 0} pass clicks in 7 days. ${stage} is the weak stage.`,
    stage,
    bet: { hypothesis: `A short, specific hook about the core mechanic on ${channel} drives first clicks.`, channel, audience: b.icp.primary, metric, target: 25, hours: 24 },
    assets: ["key_art", "social_card", "thread", "reddit_post"],
    budget_usd: Math.min(2, cap),
  };
}

export async function ceoDecide(e: Engine, snap: Snapshot): Promise<Directive> {
  const brief = e.d.loadBrief(), policy = e.policy();
  const ctx = { cycle: snap.cycle, channels: brief.channels, funnel: brief.funnel };
  const schema = `{"diagnosis": string (cite numbers), "stage": ${STAGES.map(s => `"${s}"`).join("|")}, "bet": {"hypothesis": string, "channel": one of ${JSON.stringify(brief.channels)}, "audience": string, "metric": one of ${JSON.stringify(brief.funnel)}, "target": positive number, "hours": 1-168}, "assets": subset of ${JSON.stringify(ASSET_KINDS)}, "budget_usd": number <= ${policy.cycle_budget_usd}}`;
  return ask(e, snap.cycle, "ceo.directive", {
    system: CEO_SYSTEM,
    prompt: `Company brief:\n${JSON.stringify({ product: brief.product, icp: brief.icp, channels: brief.channels, funnel: brief.funnel, constraints: brief.constraints, verifiedFacts: brief.facts }, null, 1)}\n\nSnapshot:\n${JSON.stringify(snap, null, 1)}\n\nRespond with JSON: ${schema}`,
    validate: v => validateDirective(v, ctx),
    dry: () => dryDirective(brief, snap, policy.cycle_budget_usd, snap.cycle),
  });
}

// ---------------------------------------------------------------- researcher

export async function research(e: Engine, d: Directive): Promise<{ targets: Target[]; note: string }> {
  const brief = e.d.loadBrief();
  const q = await ask(e, d.cycle, "researcher.queries", {
    system: "You are the research agent. Write web search queries that find communities, newsletters, creators and accounts relevant to the audience.",
    prompt: `Audience: ${d.bet.audience}\nProduct: ${brief.product.pitch}\nChannel focus: ${d.bet.channel}\nReturn JSON {"queries": [up to 3 short search queries]}`,
    validate: v => {
      const qs = isObject(v) && Array.isArray(v.queries) ? v.queries : [];
      const ok = qs.filter((s): s is string => typeof s === "string" && s.trim().length > 0 && s.length <= 160).slice(0, 3);
      if (ok.length === 0) throw new Error("no queries");
      return ok;
    },
    dry: () => ({ queries: ["indie stealth puzzle game communities", "best isometric stealth games newsletter", "streamers who play indie puzzle games"] }),
  });

  if (e.d.dryRun || !e.d.tools.exa) {
    const why = "DRY-RUN SAMPLE — not a real search result";
    return { note: e.d.dryRun ? "dry-run: no live search" : "exa not configured: research skipped", targets: e.d.dryRun ? [{ name: "(sample) stealth-game subreddit", url: "dry://sample/community", why }, { name: "(sample) indie game newsletter", url: "dry://sample/newsletter", why }] : [] };
  }
  const results: { title: string; url: string; text?: string }[] = [];
  for (const query of q) {
    const r = await e.act({ cycle: d.cycle, kind: "exa.search", summary: query, costUsd: 0.01 }, () => e.d.tools.exa!.search(query, 8));
    if (r.out) results.push(...r.out);
  }
  const allowed = new Map(results.map(r => [r.url, r]));
  if (allowed.size === 0) return { note: "search returned nothing", targets: [] };
  const targets = await ask(e, d.cycle, "researcher.targets", {
    system: "You are the research agent. Pick the most relevant targets from the search results ONLY. Never invent a URL or handle.",
    prompt: `Audience: ${d.bet.audience}\nResults:\n${JSON.stringify([...allowed.values()].map(r => ({ title: r.title, url: r.url, text: (r.text ?? "").slice(0, 300) })), null, 1)}\nReturn JSON {"targets": [{"name": string, "url": exact url from results, "why": one sentence}]} (max 8)`,
    validate: v => (isObject(v) && Array.isArray(v.targets) ? v.targets : []).flatMap((t: unknown) =>
      isObject(t) && typeof t.url === "string" && allowed.has(t.url) && typeof t.name === "string" && typeof t.why === "string"
        ? [{ name: t.name.slice(0, 120), url: t.url, why: t.why.slice(0, 300) }] : []).slice(0, 8),
    dry: () => ({ targets: [] }),
  });
  return { note: `${results.length} results, ${targets.length} targets verified against search output`, targets };
}

// ---------------------------------------------------------------- copywriter

export type Variant = { channel: string; text: string; reply?: string };
const COPY_LIMIT: Record<string, number> = { bluesky: 140, x: 200, telegram: 400, discord: 400, linkedin: 600, reddit: 1200 };

function dryCopy(b: Brief): Variant[] {
  const hook = `${b.product.name}: ${b.product.pitch}`;
  return b.channels.map(channel => ({
    channel,
    text: channel === "x" ? `${hook}`.slice(0, 190) : channel === "reddit" ? `[Feedback] I built a stealth-puzzle about robbing a house for RAM\n\n${b.product.pitch} Would love honest notes on the sightline mechanic. {{LINK}}`
      : channel === "linkedin" ? `We are running ${b.product.name} as an AI-operated company experiment. ${b.product.pitch} {{LINK}}`
      : `${hook.slice(0, COPY_LIMIT[channel] ?? 300)} {{LINK}}`,
    reply: channel === "x" ? "Play House 01:" : undefined,
  }));
}

export async function writeCopy(e: Engine, d: Directive, targets: Target[]): Promise<Variant[]> {
  const brief = e.d.loadBrief(), policy = e.d.loadPolicy();
  const limits = Object.fromEntries(brief.channels.map(c => [c, COPY_LIMIT[c] ?? 600]));
  return ask(e, d.cycle, "copywriter", {
    system: `You are the copy chief. Voice: ${brief.voice.tone}. Avoid: ${brief.voice.avoid.join(", ")}. Never use these terms: ${policy.content_rules.forbid_terms.join(", ")}. Never write URLs; write the token {{LINK}} where the link belongs (omit it for channel "x", where the link goes in a reply). Never invent statistics, testimonials or quotes. The product is a DEMO on testnet. You may state ONLY these verified product facts, and no other claim about gameplay, numbers, durations, clips, videos or features: ${JSON.stringify(brief.facts)}. If a fact is not listed, leave it out.`,
    prompt: `Bet: ${JSON.stringify(d.bet)}\nProduct: ${JSON.stringify(brief.product)}\nAudience pains: ${brief.icp.pains.join("; ")}\nKnown communities (context only): ${JSON.stringify(targets.slice(0, 5).map(t => t.name))}\nMax characters of body text per channel (excluding link): ${JSON.stringify(limits)}\nFor "reddit": first line is the post title, then a blank line, then the body, written as honest feedback-seeking, not an ad.\nReturn JSON {"variants": [{"channel": string, "text": string, "reply": optional string (only for "x", a short lead-in like "Play House 01:")}]} with one variant per channel in ${JSON.stringify(brief.channels)}.`,
    validate: v => {
      const list = isObject(v) && Array.isArray(v.variants) ? v.variants : [];
      const out: Variant[] = [];
      for (const x of list) {
        if (!isObject(x) || typeof x.channel !== "string" || !brief.channels.includes(x.channel) || typeof x.text !== "string" || !x.text.trim()) continue;
        if (/https?:\/\//i.test(x.text) || (typeof x.reply === "string" && /https?:\/\//i.test(x.reply))) throw new Error("copy must not contain URLs; use {{LINK}}");
        if (x.text.length > (COPY_LIMIT[x.channel] ?? 600) * 2) throw new Error(`${x.channel} text far over its limit`);
        if (!out.some(o => o.channel === x.channel)) out.push({ channel: x.channel, text: x.text.trim(), reply: typeof x.reply === "string" ? x.reply.trim() : undefined });
      }
      if (out.length === 0) throw new Error("no valid variants");
      return out;
    },
    dry: () => ({ variants: dryCopy(brief) }),
  });
}

/** Turn a model variant into final outgoing text: code adds the UTM link and the testnet label. */
export function finalizeVariant(v: Variant, brief: Brief, cycle: number): { text: string; parts?: { text: string; isReply: boolean }[]; link: string } {
  const label = brief.constraints.label;
  const link = utmLink(brief.product.url, { channel: v.channel, cycle, asset: `c${cycle}-${v.channel}` });
  const withLabel = (s: string) => (s.includes(label) ? s : `${s}\n(${label})`);
  if (v.channel === "x") {
    const main = withLabel(v.text.replace(/\{\{LINK\}\}/g, "").trim());
    const reply = withLabel(`${(v.reply ?? "Play House 01:").replace(/\{\{LINK\}\}/g, "").trim()} ${link}`);
    return { text: main, parts: [{ text: reply, isReply: true }], link };
  }
  let text = v.text.replace(/\{\{LINK\}\}/g, link).trim();
  if (!text.includes(link)) text = `${text}\n${link}`;
  return { text: withLabel(text), link };
}

// ---------------------------------------------------------------- designer

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function placeholderSvg(brief: Brief, kind: string) {
  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="#0b0f1a"/><path d="M640 120 L1000 330 L640 540 L280 330Z" fill="none" stroke="#39ff9c" stroke-width="4"/><text x="640" y="350" fill="#e8fff4" font-family="monospace" font-size="72" text-anchor="middle">${esc(brief.product.name)}</text><text x="640" y="640" fill="#ffb347" font-family="monospace" font-size="28" text-anchor="middle">DRY-RUN PLACEHOLDER (${esc(kind)}) — not generated art</text></svg>`;
}

export async function design(e: Engine, d: Directive, copy: Variant[]): Promise<AssetRecord[]> {
  const brief = e.d.loadBrief();
  const out: AssetRecord[] = [];
  const wantsImages = d.assets.includes("key_art") || d.assets.includes("social_card");
  if (wantsImages) {
    const n = Math.min(3, Math.max(1, Math.floor(d.budget_usd / (e.d.tools.fal?.estimateUsd ?? 0.05))));
    const plan = await ask(e, d.cycle, "designer.prompts", {
      system: "You are the art director. Write image-generation prompts. No real people, no logos or trademarks, no text in the image.",
      prompt: `Style: ${brief.visual.style}. Palette: ${brief.visual.palette}.\nProduct: ${brief.product.pitch}\nHook being posted: ${JSON.stringify(copy[0]?.text ?? "")}\nReturn JSON {"images": [{"kind": "key_art"|"social_card", "prompt": string}]} with exactly ${n} items.`,
      validate: v => {
        const imgs = (isObject(v) && Array.isArray(v.images) ? v.images : []).flatMap((i: unknown) =>
          isObject(i) && (i.kind === "key_art" || i.kind === "social_card") && typeof i.prompt === "string" && i.prompt.trim() ? [{ kind: i.kind as string, prompt: i.prompt.trim().slice(0, 600) }] : []).slice(0, n);
        if (imgs.length === 0) throw new Error("no image prompts");
        return imgs;
      },
      dry: () => ({ images: Array.from({ length: n }, (_, i) => ({ kind: i === 0 ? "key_art" : "social_card", prompt: `${brief.visual.style}, isometric house interior, stealth heist atmosphere, variant ${i + 1}` })) }),
    });
    for (const [i, p] of plan.entries()) {
      const base = `c${d.cycle}-${i + 1}-${slug(p.kind)}`;
      if (e.d.dryRun || !e.d.tools.fal) {
        const bytes = new TextEncoder().encode(placeholderSvg(brief, p.kind));
        const file = `${base}.svg`;
        const r = await e.act({ cycle: d.cycle, kind: "fal.image", summary: `placeholder ${p.kind}`, costUsd: 0 }, async () => { writeFileSync(e.assetPath(file), bytes); });
        if (r.rec.status === "EXECUTED") out.push({ file, kind: "image", prompt: p.prompt, model: "dry-run-placeholder", sha256: sha(bytes), costUsd: 0, createdAt: e.d.now() });
        continue;
      }
      const fal = e.d.tools.fal;
      const r = await e.act({ cycle: d.cycle, kind: "fal.image", summary: `${p.kind}: ${p.prompt.slice(0, 80)}`, costUsd: fal.estimateUsd }, async () => {
        const img = await fal.image(p.prompt, p.kind === "social_card" ? "square_hd" : "landscape_16_9");
        const ext = img.mime.includes("png") ? "png" : img.mime.includes("webp") ? "webp" : "jpg";
        const file = `${base}.${ext}`;
        writeFileSync(e.assetPath(file), img.bytes);
        return { file, bytes: img.bytes, model: img.model };
      });
      if (r.out) out.push({ file: r.out.file, kind: "image", prompt: p.prompt, model: r.out.model, sha256: sha(r.out.bytes), costUsd: fal.estimateUsd, createdAt: e.d.now() });
    }
    if (out.length > 0) {
      let pick = 0;
      if (e.d.llm.live && out.length > 1 && !out[0]!.file.endsWith(".svg")) {
        try {
          const { readFileSync } = await import("node:fs");
          pick = await ask(e, d.cycle, "designer.pick", {
            system: "You are the art director picking the best image for a social post. Judge fit with the style brief, clarity at thumbnail size, no text artifacts.",
            prompt: `Style: ${brief.visual.style}. Images are numbered 0..${out.length - 1} in order. Return JSON {"best": index}`,
            images: out.map(o => ({ mime: mimeFor(o.file), base64: readFileSync(e.assetPath(o.file)).toString("base64") })),
            validate: v => { const b = isObject(v) ? Number(v.best) : NaN; if (!Number.isInteger(b) || b < 0 || b >= out.length) throw new Error("bad index"); return b; },
            dry: () => ({ best: 0 }),
          });
        } catch { pick = 0; }
      }
      out[pick]!.selected = true;
    }
  }
  const clipPath = e.d.env.GROWTH_CLIP_PATH;
  if (clipPath && d.assets.includes("gameplay_clip")) {
    try {
      const cuts = await cutClip(clipPath, e.d.cycles.assetsDir.replace(/assets$/, `assets/c${d.cycle}-clip`));
      for (const f of [cuts.wide, cuts.tall]) {
        const rel = `c${d.cycle}-clip/${f.split("/").pop()}`;
        out.push({ file: rel, kind: "clip", sha256: createHash("sha256").update(f).digest("hex"), costUsd: 0, createdAt: e.d.now() });
      }
    } catch (err) { e.d.state.propose({ cycle: d.cycle, kind: "clip.cut", summary: `clip cut failed: ${errMsg(err)}` }, e.d.loadPolicy()); }
  }
  return out;
}

// ---------------------------------------------------------------- publisher

export type PublishPlan = { actionIds: string[]; notes: string[] };

export async function publish(e: Engine, d: Directive, copy: Variant[], assets: AssetRecord[], targets: Target[]): Promise<PublishPlan> {
  const brief = e.d.loadBrief();
  const ids: string[] = [], notes: string[] = [];
  const image = assets.find(a => a.kind === "image" && a.selected) ?? assets.find(a => a.kind === "image");
  const clipWide = assets.find(a => a.file.endsWith("clip-16x9.mp4"));
  const live = !e.d.dryRun;
  const record = (r: { rec: { id: string } }) => { ids.push(r.rec.id); };

  for (const v of copy) {
    const f = finalizeVariant(v, brief, d.cycle);
    const base = { cycle: d.cycle, text: f.text, parts: f.parts, channel: v.channel };
    const imgFiles = image ? [image.file] : [];
    switch (v.channel) {
      case "bluesky":
        if (live && !e.d.tools.bluesky) { notes.push("bluesky: not configured, skipped"); break; }
        record(await e.act({ ...base, kind: "bluesky.post", summary: `Bluesky: ${f.text.slice(0, 80)}`, payload: { mediaFiles: imgFiles, alt: `${brief.product.name} key art` } })); break;
      case "telegram":
        if (live && !e.d.tools.telegram) { notes.push("telegram: not configured, skipped"); break; }
        record(await e.act({ ...base, kind: "telegram.post", summary: `Telegram: ${f.text.slice(0, 80)}` })); break;
      case "discord":
        if (live && !e.d.tools.discord) { notes.push("discord: not configured, skipped"); break; }
        record(await e.act({ ...base, kind: "discord.post", summary: `Discord: ${f.text.slice(0, 80)}` })); break;
      case "x":
        if (live && !e.d.tools.postiz) { notes.push("x: postiz not configured, skipped"); break; }
        record(await e.act({ ...base, kind: "postiz.create_post.now", summary: `X post + reply: ${f.text.slice(0, 70)}`, payload: { provider: "x", mediaFiles: [...imgFiles, ...(clipWide ? [clipWide.file] : [])].slice(0, 1) } })); break;
      case "linkedin":
        if (live && !e.d.tools.postiz) { notes.push("linkedin: postiz not configured, skipped"); break; }
        record(await e.act({ ...base, kind: "postiz.create_post.draft", summary: `LinkedIn draft: ${f.text.slice(0, 70)}`, payload: { provider: "linkedin", mediaFiles: imgFiles } })); break;
      case "reddit": {
        const subs = targets.filter(t => /reddit\.com\/r\//i.test(t.url)).map(t => t.url);
        record(await e.act({ ...base, kind: "reddit.post", summary: `Reddit draft (human posts): ${f.text.split("\n")[0]!.slice(0, 80)}`, payload: { suggestedSubreddits: subs, note: "Check each subreddit's self-promotion rules, account age and karma before posting." } })); break;
      }
      default: notes.push(`${v.channel}: no publisher`);
    }
  }

  if (d.assets.includes("email") && (e.d.tools.instantly || !live)) {
    const seq = await ask(e, d.cycle, "outreach.sequence", {
      system: "You write a short, honest 2-step cold outreach sequence to indie-game press/creators. No fake familiarity, no false claims. Plain text. Include a clear opt-out line.",
      prompt: `Product: ${JSON.stringify(brief.product)}\nReturn JSON {"steps": [{"subject": string, "body": string, "delayDays": integer}]} (2 steps). Body must not contain URLs except the literal token {{LINK}}.`,
      validate: v => {
        const steps = (isObject(v) && Array.isArray(v.steps) ? v.steps : []).flatMap((s: unknown) =>
          isObject(s) && typeof s.subject === "string" && typeof s.body === "string" ? [{ subject: s.subject.slice(0, 120), body: s.body.slice(0, 1200).replace(/\{\{LINK\}\}/g, utmLink(brief.product.url, { channel: "email", cycle: d.cycle, asset: `c${d.cycle}-email` })), delayDays: Math.min(Math.max(Math.floor(Number(s.delayDays)) || 2, 1), 14) }] : []).slice(0, 2);
        if (steps.length === 0) throw new Error("no steps");
        return steps;
      },
      dry: () => ({ steps: [{ subject: `${brief.product.name}: a stealth puzzle you can try in a browser`, body: `Hi — we built ${brief.product.name} (${brief.product.pitch}) and would value a quick look. {{LINK}}\nReply STOP and we won't write again.`, delayDays: 2 }] }),
    });
    record(await e.act({ cycle: d.cycle, kind: "instantly.create_campaign_paused", summary: "Instantly campaign (PAUSED, not launched, no leads attached)", payload: { name: `${brief.product.name} outreach c${d.cycle} (paused)`, sequence: seq }, text: seq.map(s => `${s.subject}\n${s.body}`).join("\n---\n") }));
    notes.push("instantly: campaign created PAUSED; launch is a human decision");
  }
  return { actionIds: ids, notes };
}

// ---------------------------------------------------------------- analyst

export async function measure(e: Engine, rec: CycleRecord): Promise<Measurement> {
  const d = rec.directive!;
  const { events, tools, dryRun, state, readChain, now } = e.d;
  const hoursBack = Math.max(d.bet.hours, 24);
  let funnel: Record<string, number> = events.funnel({ cycle: d.cycle });
  let funnelSource: Measurement["funnelSource"] = Object.values(funnel).some(n => n > 0) || events.count() > 0 ? "local" : "none";
  if (tools.posthog && !dryRun) {
    try { funnel = await tools.posthog.funnel([...FUNNEL_EVENTS], Math.min(Math.ceil(hoursBack / 24), 90)); funnelSource = "posthog"; } catch { /* keep local */ }
  }
  const posts: Measurement["posts"] = [];
  for (const a of state.list({ cycle: d.cycle })) {
    if (a.status !== "EXECUTED" || !a.kind.startsWith("postiz.create_post") || !a.externalId || a.externalId.startsWith("DRY-")) continue;
    let metrics: { label: string; total: number }[] | undefined;
    if (tools.postiz && !dryRun) {
      const r = await e.act({ cycle: d.cycle, kind: "postiz.read", summary: `analytics for ${a.externalId}` }, () => tools.postiz!.postAnalytics(a.externalId!, Math.max(1, Math.ceil(hoursBack / 24))));
      metrics = r.out;
    }
    posts.push({ actionId: a.id, channel: a.channel, url: a.url, metrics });
  }
  let chain: Awaited<ReturnType<NonNullable<typeof readChain>>>;
  try { chain = await readChain?.(); } catch { chain = undefined; }
  const passes = chain?.passPriceYocto && BigInt(chain.passPriceYocto) > 0n ? Number(BigInt(chain.revenueYocto) / BigInt(chain.passPriceYocto)) : 0;
  const impressions = posts.flatMap(p => p.metrics ?? []).filter(m => /impression|view/i.test(m.label)).reduce((s, m) => s + m.total, 0);
  const value = ({ impression: impressions, click: funnel.page_view ?? 0, game_page_view: funnel.game_page_view ?? 0, wallet_connect: funnel.wallet_connect ?? 0, pass_click: funnel.pass_click ?? 0, pass_bought: passes } as Record<string, number>)[d.bet.metric] ?? 0;
  const haveData = funnelSource !== "none" || posts.some(p => (p.metrics?.length ?? 0) > 0) || !!chain;
  return {
    at: now(), funnel, funnelSource, chainRevenueYocto: chain?.revenueYocto, posts,
    metric: d.bet.metric, value, target: d.bet.target,
    outcome: !haveData ? "no_data" : value >= d.bet.target ? "hit" : "miss",
  };
}

export async function learn(e: Engine, rec: CycleRecord, m: Measurement): Promise<string> {
  const d = rec.directive!;
  return ask(e, d.cycle, "analyst.learning", {
    system: "You are the analyst. Write a 2-4 line learning for the CEO's next cycle: what the numbers say, what to keep, what to change. Cite the numbers. Do not claim causes you cannot see. If there is no data, say the test is inconclusive and what to instrument.",
    prompt: `Directive: ${JSON.stringify(d)}\nMeasurement: ${JSON.stringify(m)}\nReturn JSON {"learning": string}`,
    validate: v => { if (!isObject(v) || typeof v.learning !== "string" || !v.learning.trim()) throw new Error("no learning"); return v.learning.trim().slice(0, 900); },
    dry: () => ({ learning: `Cycle ${d.cycle} (${d.stage}, ${d.bet.channel}): ${m.metric} = ${m.value} vs target ${d.bet.target} → ${m.outcome}. Funnel source: ${m.funnelSource}. ${m.outcome === "no_data" ? "Inconclusive: no tracked traffic yet; verify the landing page sends events before judging the bet." : m.outcome === "hit" ? "Keep the hook; test a second channel." : "Change the hook or the channel before spending more."}` }),
  });
}

export { METRICS };
