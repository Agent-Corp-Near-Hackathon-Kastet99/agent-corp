# Growth Harness — Tool Map and Implementation Plan

Date: 2026-11-14. Status: harness implemented; the sections below preserve the original design plan. Current runtime is in `server/src/growth/`, with owner configuration in `growth/` and Mission Control via `pnpm growth`. Tool adapters, approval gates, durable actions, Board-derived budgets, storage locks and graceful shutdown are implemented and fixture-tested. Real-service end-to-end verification and live growth Board writes remain unverified. Actual growth payments can be recorded as testnet on-chain expenses through the owner-confirmed bridge in `server/src/growth/expenses.ts` (off by default); estimates are never booked as paid. kickbacks.ai was not integrated (see §9). Companion to [AGENT-CORP.md](AGENT-CORP.md) and the earlier [Game operations stack](../reports/Game%20operations%20stack.md) report.

## 0. TL;DR

**Goal:** the CEO agent notices "we need customers", picks one growth bet, and the company executes it end-to-end with real tools: research the ICP → write copy → make visuals → publish → read results → learn → pick the next bet. Everything is visible live on one "Mission Control" page and logged in the existing activity feed.

**Core idea:** don't integrate 15 tools. Build **one small harness (~600–900 lines TypeScript)** and plug **6 tools** into it tonight. The harness is the product; tools are interchangeable.

**Tonight's stack (must-have):**

| Job | Tool | Why this one |
|---|---|---|
| Brain | Claude (Anthropic API / Agent SDK) | Already the project's model family; tool use + structured output |
| Publish + analytics | **Postiz** (REST + MCP, 30+ channels, `draft`/`schedule`/`now`) | One integration → X, LinkedIn, Bluesky, Reddit, Discord, Telegram, YouTube, TikTok… Already chosen in the ops-stack report |
| Visuals | **fal.ai** (Flux for images, Kling/Veo for short video) + Playwright capture of real gameplay | Cheap per-asset pricing, one REST call |
| Research / lead discovery | **Exa** (search + contents, hosted MCP) | Semantic "find me people/communities like X" queries |
| Measurement | **PostHog** (free 1M events/mo, MCP exposes funnels/trends/SQL) + **on-chain `buy_pass` events** | PostHog = top of funnel; the contract = ground-truth revenue |
| Owned-audience email | **Resend** (official MCP, free 100/day) | Waitlist/transactional only. **Its AUP bans cold email** (see §2) |

**Nice-to-have tonight:** Apollo (official MCP, lead lists), Bluesky direct API (free, no approval — the safe auto-publish channel), Telegram/Discord webhooks.
**Showcase only tonight:** Instantly (agent builds a *paused* cold-email campaign; launch is L2 and not done tonight). **Do not do tonight:** launching cold email (mailbox warm-up, deliverability, legal), Reddit API (access now approval-only), direct X API (pay-per-use, link surcharge), Keymailer/Lurkit (no public API found), Clay (expensive, overkill).

**Wow moment (90 seconds of demo):** press one button → CEO card appears with a written diagnosis ("0 players, 0 audience → awareness is the bottleneck; bet: gameplay clip on X + Bluesky + r/stealthgames draft") → asset gallery fills with real generated images + the real House 01 clip → approval inbox shows 3 drafts → click Approve on one → real post URL appears in the feed → analytics number ticks → CEO writes a one-line learning and proposes cycle 2.

---

## 1. What the repo already gives us (reuse, don't rebuild)

Verified by reading the working tree:

- **Activity feed + live WS**: `store.log(...)`, `GET /api/activity`, `WS /api/live` (`server/src/app.ts`, `store.ts`). `Actor` today is `"CEO" | "ORACLE" | "WORKER" | "CONTRACT" | "CUSTOMER" | "OWNER"` (`ledger.ts:23`). The design doc (`AGENT-CORP.md:176`) already anticipates `"BIZDEV" | "MARKETING"` — add them.
- **Task model with `kind: "marketing"`** (`store.ts:8`) and a seeded "Trailer captions" task (`app.ts:116`).
- **Pattern: deterministic policy agents bounded by owner config** (`agents.ts`, `config.yaml`). The growth harness should copy this pattern: owner edits `growth/brief.yaml` + `growth/policy.yaml`; the agent cannot edit them.
- **Interval timer** in `index.ts` (`AGENT_INTERVAL_SECS`). The Agent SDK has no built-in scheduler that I could find, so growth cycles hang off the same style of timer.
- **Authority model** already written in the ops-stack report: agents draft, humans approve publish/outreach/spend, wallet signs money. The harness makes this a machine-enforced gate, not a convention.
- **Worker sessions** (`worker/src/runner.ts`) run `claude -p --tools ""` — *tool-disabled*, metered into contribution units. Implication: LLM steps that only need to *emit structured JSON* can run as worker tasks (inference becomes contributor units, on-brand for the company). Steps that need tools run in the harness process. See §3.5.

**Constraints found that shape the plan:**

1. `server/web/*` is staged for deletion in the working tree (UI is mid-restructure). **Confirm where Mission Control lives before building the UI.** Fallback: one static HTML page served by `server/src/app.ts` — no framework.
2. The project's own docs say public wording of "ownership/share/dividend" needs **legal review** (`AGENT-CORP.md` §1). Marketing copy must therefore never promise returns. This is encoded as a hard lint rule in the policy (§3.4).
3. The project forbids copying code without license audit (`AGENT-CORP.md` adapter plan). Third-party marketing "skill packs" below are for *reading/ideas*; check license before copying anything.

---

## 2. The tool map

Legend — **Verified**: ✔ = confirmed in official docs fetched/seen this session; ~ = only third-party/vendor-blog sources, re-check; ✖ = conflicting sources.
**Setup** = realistic time to first successful API call by someone with an account.

### 2.1 Map by funnel stage

```
 RESEARCH ──► CREATE ──► DISTRIBUTE ──► CONVERT ──► MEASURE ──► LEARN
  Exa          Claude     Postiz         Landing +   PostHog     Claude writes
  Apollo       fal.ai     Bluesky API    buy_pass    Postiz      learnings.md,
  (Claude      Playwright Telegram/      (on-chain)  analytics   updates ICP
   web search) +FFmpeg    Discord hooks  Resend      on-chain    + next bet
                          (human: Reddit, waitlist   revenue
                           X, LinkedIn,
                           influencers)
```

### 2.2 Tier A — build tonight (must / should)

| # | Stage | Tool | Integration path | Setup | Cost (verify) | Verified | Notes / gotchas |
|---|---|---|---|---|---|---|---|
| A1 | Distribute + measure | **Postiz** | REST `https://api.postiz.com/public/v1` (cloud) or `https://{host}/api/public/v1` (self-host); header `Authorization: <key>` (no `Bearer`). `POST /posts` with `type: draft \| schedule \| now`; `POST /upload` (multipart, `file`; jpeg/png/gif/webp/avif/bmp/tiff/mp4); `GET /integrations`; `GET /analytics/{integration}?date=N`; `GET /analytics/post/{postId}`. MCP: `https://mcp.postiz.com/mcp` (Bearer key) — tools include `integrationList`, `integrationSchema`, `schedulePostTool`, `postsListTool`, `generateImageTool`, `generateVideoTool`, `clippingTool`. | 20–30 min (connect channels via OAuth in UI is the slow part) | Hosted plan price **not found** | ✔ (docs.postiz.com) | **Rate limit conflict**: docs say 30 req/h in OpenAPI text, 90 (100 cloud) req/h in intro. Design for ≤25 calls/h. MCP **cannot read/reply to comments**. Platform count differs by page (27/32/34). Use **REST from the harness** (auditable gate) rather than MCP. |
| A2 | Distribute (auto-safe) | **Bluesky AT Protocol** direct | `@atproto/api`, app password, `createRecord` post, blob upload for images, 300-char limit, no native scheduling (our loop schedules) | 10 min | Free | ~ | No approval process; good "L1 auto-publish" channel for the live demo. Bluesky doesn't mark API-posted content as bot → we add an explicit "AI-operated account" disclosure in bio. |
| A3 | Distribute (auto-safe) | **Telegram Bot API / Discord webhook** | Plain HTTPS POST | 10 min | Free | not researched here (well-known APIs) | Post into **our own** channel/server only. Good for NEAR-community-style launch posts. Check ToS of target communities before posting anywhere not ours. |
| A4 | Create (copy, strategy) | **Claude** | Anthropic Messages API / Agent SDK (`@anthropic-ai/claude-agent-sdk`: in-process custom tools, `canUseTool` approval callback, hooks) | 15 min | Per token | ~ (SDK summaries are third-party) | Use structured output validated with zod. |
| A5 | Create (visuals) | **fal.ai** | REST/JS client (no official fal MCP found). Flux family for images (~$0.03–0.05/img listed), Kling / Veo for short clips (~$0.10–0.20/s listed), Wan cheaper | 15 min | Prices vary by source and are not confirmed for Nov 2026 — **put a hard $ cap in policy** | ~ ✖ | Use image gen for key art / social cards / thumbnails; use **real Playwright gameplay capture** for the clip (existing plan) — AI video of a game that doesn't look like the game is a credibility killer. For text-heavy graphics, a second provider (OpenAI image API) is recommended by several sources. |
| A6 | Create (real clip) | **Playwright `recordVideo` + FFmpeg** | Local; already in ops-stack report | 30–45 min (needs deterministic House 01 route) | Free | ✔ (Playwright docs, per prior report) | The most credible asset we have. Claude writes the caption timeline; code records. |
| A7 | Research | **Exa** | Hosted MCP or REST: `web_search_exa`, `web_fetch_exa`; contents ≈ $1 / 1k pages | 10 min | Small | ~ | Used for: communities/subreddits/newsletters/streamers who covered similar games; competitor positioning. Alternatives: Tavily (free tier size conflicts 500 vs 1,000 credits), Firecrawl (better for crawling known sites). Don't use all three. |
| A8 | Measure | **PostHog** | JS snippet on landing/game page + `posthog-node` for server events; official MCP exposes trends, funnels, retention, SQL, saved insights | 20 min | Free ≤1M events/mo (overage rates conflict across sources) | ~ (PostHog's own page via search) | UTM → `page_view` → `wallet_connect` → `pass_click` → (chain) `pass_bought`. |
| A9 | Measure (truth) | **On-chain `buy_pass` + existing dashboard** | Already built | 0 | — | ✔ (repo) | Revenue attribution without trusting any third party. Pass UTM into the purchase-intent record. |
| A10 | Convert / owned audience | **Resend** | Official MCP (`https://mcp.resend.com/mcp`) or REST/SDK; free 3,000/mo, **100/day**, 1 domain | 15 min + **DNS verification wait** (start first) | Free | ✔ for AUP (resend.com/legal/acceptable-use) | **AUP prohibits unsolicited / cold outreach, purchased lists, scraped contacts.** Use only for: waitlist confirmations, receipts, newsletter to people who opted in. |

### 2.3 Tier B — add if Tier A is green before ~03:00

| # | Stage | Tool | Path | Notes |
|---|---|---|---|---|
| B1 | Research / leads | **Apollo** | Official MCP `https://mcp.apollo.io/mcp` (OAuth, no key). People search returns no contact details; enrichment spends credits (email reveal ~1 credit, phone ~8). | Free-plan limits **conflict** across sources (search/enrichment gating, ~600 req/day claimed). For a *game*, Apollo's B2B bias is a weak fit — useful only for: press/newsletter editors, NEAR ecosystem/BD contacts, game-studio founders. Use to build a **target list**; human sends. |
| B2 | Distribute | **Typefully** | API v2 (`api.typefully.com/v2`), drafts + scheduling for X/LinkedIn/Threads/Bluesky/Mastodon | Backup if Postiz fails for X/LinkedIn. Whether the free plan includes API access: **not found**. |
| B3 | Outreach (one-shot) | **Boardy** | Documented path = one reviewed email to `boardy@boardy.ai`; double opt-in; no public API/MCP verified | One warm intro for a NEAR-games organizer. Human sends. (Per ops-stack report.) |
| B5 | Outreach (showcase) | **Instantly** | API v2 + community MCP servers (`create_campaign`, bulk add up to 1,000 leads; one variant creates campaigns **paused** with preview and launch as separate steps). API key: Settings → Integrations → API. | Build paused only; launch = L2 and not tonight. Warm-up duration and pricing not verified. |
| B4 | Create (video) | **fal Kling/Veo image-to-video** | REST | Only for short atmosphere loops/stingers; cap spend. |
| B5 | Distribute (paid-for) | **X API pay-per-use** | Only if Postiz's X connector is blocked | ~$0.015/post, **~$0.20 if post contains a URL** (surcharge reported since Apr 2026), reads $0.005/resource; no free tier for new devs (one source claims promo credits — unverified). → put the link in a reply or bio, not the post body. |

### 2.4 Tier C — explicitly *not* tonight, and why

| Tool | Why not |
|---|---|
| **Launching** Instantly/Smartlead cold email (a paused Instantly campaign is in Tier B) | New sending domains/mailboxes need warm-up before they deliver (**duration not verified in this research** — assume weeks); real legal exposure (CAN-SPAM/GDPR); reputational risk for a hackathon brand. If you want it in the demo: have the agent build the campaign **paused** and show it, never launch. |
| **Reddit** | Self-service API access closed Nov 2025; new access is approval-based, commercial use needs written approval, bots must not circumvent labeling; subreddits remove self-promo (account age/karma/flair rules). → Agent **drafts** Reddit posts per subreddit rules; human posts. |
| **Keymailer / Lurkit / Gamosy** (streamer key distribution) | No public API documentation found. → Agent produces a ranked streamer/YouTuber list (Exa) + personalised pitch drafts; human sends/uses platform UI. |
| **Clay** | $149–800+/mo (reported), usage-priced; overkill for a 1-product launch. |
| **Buffer / Ayrshare / Metricool** | Fine products (Buffer hosted MCP, ~15–20 tools), but redundant with Postiz. Swap-in candidates only. |
| **Higgsfield / unverified AI editor APIs** | Already flagged in ops-stack report. |

### 2.5 Open-source reference material (read, don't depend on)

- `cgallic/kai-cmo-harness` — Claude Code/Codex skills for SEO, content, email, ads, launches; ICP + brand-voice file; optional autonomous loop. Good source of prompt structure.
- `ericosiu/ai-marketing-skills` — includes an **ICP Learner** (updates ICP from win/loss) and an **experiment engine** — the exact "learn" step we want.
- Both: license not checked → ideas only until verified.

---

## 3. Harness design

### 3.1 Principles

1. **LLM decides; code executes; policy gates.** The model never holds credentials. It requests actions; `gate()` decides auto / needs-approval / deny; executors hold the keys.
2. **Everything is an `Action` row** with a status machine: `PROPOSED → APPROVED → EXECUTED → MEASURED` (or `REJECTED/FAILED`). The feed and the inbox are views over this table. Never fabricate a status or a metric (consistent with the repo's honesty labels: `DRAFT / APPROVED / PUBLISHED / REQUESTED …`).
3. **One bet per cycle.** A cycle = hypothesis + channel + asset set + success metric + deadline. Prevents the "spray everything" failure mode and makes the learning step meaningful.
4. **Owner-editable constraints in files, like `config.yaml`.** Agents can't edit them.

### 3.2 Component diagram

```
 growth/brief.yaml  (owner)          growth/policy.yaml (owner)
        │                                   │
        ▼                                   ▼
 ┌─────────────┐  directive   ┌──────────────────┐   approved   ┌───────────────┐
 │ CEO step    │─────────────►│ Specialist roles │─────────────►│ gate()        │
 │ (diagnose + │              │ Researcher       │  Action[]    │ L0 auto       │
 │  pick bet)  │◄──────┐      │ Copywriter       │              │ L1 auto+caps  │
 └─────────────┘       │      │ Designer         │              │ L2 human      │
        ▲ learnings    │      │ Publisher        │              │ L3 wallet     │
        │              │      │ Analyst          │              └──────┬────────┘
 ┌──────┴──────┐       │      └──────────────────┘                     │
 │ Analyst     │       │                                                ▼
 │ metrics →   │◄──────┴────────────────── metrics ◄──────────── Executors (tools)
 │ learning    │                                        Postiz · Bluesky · fal · Exa ·
 └─────────────┘                                        PostHog · Resend · chain views
        │
        ▼
  .data/growth/{actions.jsonl, cycles/*.json, assets/, learnings.md}
        │
        ▼
  store.log() → /api/activity + WS /api/live → Mission Control page
```

### 3.3 The cycle (what "agent decides himself" means concretely)

1. **Sense** — snapshot: on-chain treasury/revenue/passes, PostHog funnel (visits → wallet connect → pass click), Postiz analytics for last cycle's posts, `learnings.md`, brief.
2. **Diagnose + decide (CEO step)** — structured output `Directive`:
   ```ts
   type Directive = {
     cycle: number;
     diagnosis: string;                 // 2–4 sentences, must cite numbers from the snapshot
     stage: "awareness" | "traffic" | "conversion" | "retention";
     bet: { hypothesis: string; channel: Channel; audience: string; success_metric: string; target: number; hours: number };
     assets: ("key_art" | "social_card" | "gameplay_clip" | "thread" | "reddit_post" | "email" )[];
     budget_usd: number;                // ≤ policy.cycle_budget_usd
     needs_board_vote?: boolean;        // if > policy.autonomous_budget_usd → calls existing create_proposal
   };
   ```
   Decision rule seed (in the prompt, not code): *if no audience data → awareness bet; if traffic but few wallet connects → conversion bet (landing copy/clip); if connects but no purchases → price/offer/onboarding bet.* Cycle 1 default for RAM HEIST: awareness.
3. **Research (if directive needs it)** — Researcher uses Exa (≤ N queries): 10 target communities/accounts, 3 competitor angles. Output: `targets.json` with source URLs (no invented handles — every target needs a URL).
4. **Create** — Copywriter (per-channel variants + UTM), Designer (fal prompts derived from brand brief; Playwright clip request). Outputs saved to `.data/growth/assets/` with hash + prompt provenance.
5. **Propose actions** — `Action[]` like `postiz.create_post(channel, text, media, type)`, `resend.send(...)`, `human.task("post to r/stealthgames", draftText)`.
6. **Gate** — policy decides; L2 items appear in the Approval Inbox.
7. **Execute** — executors run, write `external_id` / `url` into the Action.
8. **Measure (after `hours`)** — Analyst pulls Postiz analytics + PostHog funnel + chain; compares to `target`.
9. **Learn** — writes 3–5 lines to `learnings.md` (what worked, what didn't, update to ICP/voice). Feeds step 1 of the next cycle.

### 3.4 Autonomy levels and policy (`growth/policy.yaml`)

| Level | Meaning | Examples | Who acts |
|---|---|---|---|
| **L0** | Read/think/generate, no external side effect | Exa search, fal image, copy drafting, Postiz `type: draft`, PostHog read | Agent, automatic |
| **L1** | Public side effect on **our own sandbox channels**, capped | Bluesky post, Telegram/Discord message in our channel | Agent, automatic with caps + lint |
| **L2** | Public/third-party side effect | Postiz `schedule`/`now` to X/LinkedIn/YouTube; any email to a person; spend over cycle cap | Human clicks Approve |
| **L3** | Money / on-chain | Wallet-signed purchases, expense payment, distribution | Human wallet; **never** the growth agent |

Example `policy.yaml` (RAM HEIST defaults):

```yaml
cycle_budget_usd: 5            # hard cap per cycle across fal/Exa/etc.
autonomous_budget_usd: 5       # above this → needs Board proposal
max_posts_per_day: { bluesky: 4, telegram: 3, discord: 3 }
postiz_calls_per_hour: 25      # docs conflict (30 vs 90); stay under the lower
levels:
  postiz.create_post.draft: L0
  postiz.create_post.schedule: L2
  postiz.create_post.now: L2
  bluesky.post: L1
  telegram.post: L1
  discord.post: L1
  resend.send.to_optin_list: L1  # only recipients with recorded opt-in
  resend.send.other: DENY
  email.cold: DENY               # Resend AUP; deliverability; legal
  reddit.post: HUMAN_TASK        # agent drafts, human posts
  chain.*: DENY                  # growth agent has no chain write access
content_rules:
  require_disclosure: "AI-operated account"   # in bio / first post
  forbid_terms: [dividend, ownership, "earn", "returns", "profit share", "investment", "guaranteed"]
  require_label_if_testnet: "DEMO / testnet"
  forbid: [fabricated_metrics, fake_testimonials, impersonation, real_person_likeness]
  links: { x: reply_only }       # avoid X URL surcharge
```

`content_lint()` runs on every outgoing text; failing items are rejected with a reason (shown in the feed — itself a nice demo beat: "CEO agent's post was blocked: mentions 'dividend'").

### 3.5 Where LLM inference runs

Two options; **recommend A for tonight, B as a stretch that fits the company story:**

- **A. Harness calls Anthropic directly** (Messages API or Agent SDK with an in-process MCP tool server). Fastest. Use `canUseTool`/hooks to route every tool call through `gate()` and `store.log()`. Needs `ANTHROPIC_API_KEY` (use the `secrets` skill — never paste into chat).
- **B. "Plan-as-JSON" through existing worker sessions.** Worker is `claude -p --tools ""` (tool-disabled), so it can emit the `Directive`/`Action[]` JSON and the harness executes. Pros: inference is metered into contributor units (the company's core mechanic), safer. Cons: more plumbing, and signed-in inference has *not been exercised* per README. Do after A works.

### 3.6 State and files

```
growth/
  brief.yaml  policy.yaml        # owner-edited; the agent cannot change them
  track.js                       # landing/game page tracker (copy inlined into landing/index.html, disabled until the meta tag is set)
.env.growth.example              # copy to .env.growth (gitignored)
server/src/growth/
  policy.ts brief.ts lint.ts gate.ts state.ts      # Phase 0: validation, deterministic gate, action table (atomic JSON)
  env.ts http.ts util.ts llm.ts types.ts           # env loader (dry-run default), http w/o secret leakage, Anthropic client + DryLlm
  events.ts optin.ts cycles.ts                     # first-party funnel events, consent store, per-cycle JSON + learnings.md
  tools/{postiz,bluesky,chat,fal,exa,posthog,resend,instantly,clip,index}.ts
  engine.ts                      # act() = propose -> gate -> claim -> execute; at-most-once; dispatcher
  roles.ts                       # sense, CEO, researcher, copywriter, designer, publisher, analyst (one file)
  loop.ts runtime.ts routes.ts page.ts             # cycle orchestration, wiring, HTTP API, Mission Control page
server/scripts/growth.ts         # standalone server, no chain keys needed:  pnpm growth
server/scripts/capture-clip.ts   # Playwright recorder (UNTESTED, Playwright not a dependency)
server/test/growth*.test.ts      # 79 tests across gate, adapters (mocked network), engine, routes
.data/growth/                    # runtime: actions.json, cycles/NNN.json, assets/, events.json, optin.json, learnings.md
```

`brief.yaml` skeleton for RAM HEIST (owner fills real values):

```yaml
product: { name: "RAM HEIST", pitch: "Isometric 3D stealth-puzzle; sneak into homes, recover RAM.", price: "1 tNEAR pass (DEMO)", url: "<vercel-url>" }
icp:
  primary: "Casual/indie stealth-puzzle players on desktop browsers"
  secondary: "NEAR ecosystem builders/judges who like shipped agent-run businesses"
  pains: ["short sessions", "readable stealth mechanics", "something new"]
channels: [bluesky, x, linkedin, telegram, discord, reddit_human]
funnel: [impression, click, game_page_view, wallet_connect, pass_click, pass_bought]
voice: { tone: "dry, heist-movie, self-aware satire", avoid: ["hype", "income claims"], emoji: "sparingly" }
visual: { palette: "<fill>", style: "isometric, neon-on-dark", references: [] }
constraints: { legal: "no dividend/ownership/returns language", label: "DEMO/testnet" }
```

### 3.7 Attribution (cheap, but a strong demo story)

Every published link carries `utm_source/channel/cycle/asset`. Landing page stores them in PostHog and passes `cycle`+`asset` into the purchase intent so `buy_pass` revenue can be tied back to the bet. The Mission Control card then shows "Cycle 1 → 312 impressions → 41 clicks → 6 wallet connects → 1 pass (1 tNEAR)" from real sources. If numbers are zero, **show zero** and the CEO reacts to zero — that's still a decision.

### 3.8 Mission Control page (the wow surface)

Single page, 5 panels, all fed by `/api/growth/*` + `/api/live`:

1. **CEO card**: diagnosis, bet, target, countdown.
2. **Pipeline strip**: Research → Create → Gate → Publish → Measure, current step pulsing.
3. **Asset gallery**: real generated images/clip with prompt provenance on hover.
4. **Approval inbox**: Approve / Edit / Reject; shows channel preview, lint result, cost.
5. **Funnel + feed**: funnel numbers, then the activity ticker (actor `MARKETING`/`BIZDEV`/`CEO`).

---

## 4. Implementation plan

Assumes one engineer + Claude Code, ~9 hours of focused work. **Cut line** = what to drop if behind.

### Phase −1 — human tasks, start immediately (parallel, ~45 min, you do these while I/agent codes)

| Task | Output | Time-sensitive? |
|---|---|---|
| Resend: add domain, add DNS records | verified domain | **Yes — DNS wait** |
| Postiz: sign up (or self-host), connect **Bluesky** + **X** + **LinkedIn** (OAuth), generate API key | `POSTIZ_API_KEY` + channel IDs | OAuth approvals can lag |
| Create Bluesky bot account + app password; Telegram bot via @BotFather + a test channel; Discord webhook | keys | no |
| fal.ai key with a small prepaid balance | `FAL_KEY` | no |
| Exa key | `EXA_API_KEY` | no |
| PostHog project (free) | project key + personal API key | no |
| Anthropic key | `ANTHROPIC_API_KEY` | no |
| (B1) Apollo account, authorize MCP | — | optional |
| (B5) Instantly account + API v2 key | `INSTANTLY_API_KEY` | optional |

Deliver keys via the `secrets` skill into a dotenv file (`.env` is already gitignored). Do not paste keys into chat.

### Phase 0 — Skeleton and gate (0:00–1:15) **must** — ✅ DONE 2026-11-14 (26 new tests, full server suite 62/62, `tsc` clean)

- Add `MARKETING | BIZDEV` to `Actor` (`ledger.ts:23`) and the store validators.
- `brief.ts`/`policy.ts`: load + zod-validate YAML (mirror `config.ts`).
- `state.ts`: `Action` table (JSONL), status machine, `store.log` bridge.
- `gate.ts` + `lint.ts` with unit tests: dry-run executors; assert L0/L1/L2/DENY routing, forbid-term rejection, caps, budget.
- **Acceptance:** `pnpm test` green; a fake `postiz.create_post.now` action lands in the inbox, not executed.

### Phase 1 — First real action end-to-end (1:15–3:00) **must**

- `tools/postiz.ts`: `listIntegrations`, `uploadMedia`, `createPost(type)`, `postAnalytics`. Rate-limiter (25/h). Retry/backoff on 429.
- `tools/bluesky.ts`: login, post with image, return URL.
- `ceo.ts`: Directive generation (Anthropic, structured output) from brief + empty snapshot.
- `roles/copywriter.ts`: per-channel copy with UTMs.
- Minimal `routes.ts`: `GET /api/growth/state`, `POST /api/growth/run`, approvals endpoints; run endpoint gated like `DEMO_ACTIONS`.
- **Acceptance:** one command produces: Directive → 3 copy variants → Bluesky post live (L1) + X/LinkedIn Postiz **drafts** + 1 pending approval; approving the X draft converts it to `schedule`/`now` and stores the real URL.

### Phase 2 — Visuals (3:00–4:15) **must (image), should (clip)**

- `tools/fal.ts`: text-to-image (Flux), cost tracking against `cycle_budget_usd`; save with prompt + seed + hash.
- `roles/designer.ts`: brand-brief → 3 key-art prompts + 1 social card; pick best via a cheap Claude vision critique (compare against `visual` brief).
- **Clip (should):** Playwright script for House 01 route + FFmpeg 16:9 and 9:16 cuts; Claude writes caption timeline; upload through Postiz `/upload` as `video/mp4`. If the deterministic route isn't ready, drop this and ship image-only.
- **Acceptance:** gallery shows ≥3 real generated images with provenance; spend counter accurate to fal's billing within ±10%.

### Phase 3 — Research + measurement (4:15–5:45) **should**

- `tools/exa.ts` + `roles/researcher.ts`: communities, newsletters, creators, competitor angles → `targets.json` with source URLs.
- `tools/posthog.ts`: server-side capture + funnel read (HogQL/insights API or MCP); landing snippet with UTM capture.
- `roles/analyst.ts`: measure step → `learnings.md` → feeds next Directive.
- **Acceptance:** cycle 2 Directive text cites at least two real numbers from cycle 1 (even if "0 clicks").

### Phase 4 — Mission Control UI (5:45–7:30) **must (minimum), should (polish)**

- Single page, 5 panels (§3.8), WS live updates. Use existing design tokens if the dashboard has them (check where UI now lives — §1 constraint 1).
- **Acceptance:** Full demo path runs without touching a terminal.

### Phase 5 — Owned audience + leads (7:30–8:30) **could**

- Resend waitlist: landing form → opt-in recorded → confirmation email (L1, opt-in only).
- Apollo MCP lead list → `targets.json` (human sends outreach).
- Instantly: create **paused** campaign only (agent writes sequence + lead list; shown in inbox as "ready to launch, L2"). Needs `INSTANTLY_API_KEY`.

### Phase 6 — Hardening + rehearsal (8:30–9:30) **must**

- Kill switch: `policy.growth_paused` + env `GROWTH=off` (mirrors `AGENTS=off`).
- Dry-run mode (`GROWTH_DRY_RUN=on`): all executors log intent and return fake IDs labeled `DRY`. Use it for rehearsal; live for the actual demo.
- Seed a **clearly labeled** "cycle 0" history so the first screen isn't empty.
- Rehearse 3 times; record a backup screen capture.

### Cut order if behind

1. Drop Phase 5 entirely. 2. Drop video clip → static clip frames + image. 3. Drop PostHog → use Postiz analytics + chain only. 4. Drop Exa → Claude's built-in web search. 5. Keep **Directive → copy → image → Bluesky live → Postiz draft → approval → feed** at all costs; that's the wow.

---

## 5. Demo script (3 minutes)

| t | Beat |
|---|---|
| 0:00 | Dashboard shows treasury, two contributors, "0 customers". Presenter: "Company has a product and no audience." |
| 0:15 | CEO card writes a diagnosis from real numbers → picks **awareness bet** → sets target and budget. |
| 0:35 | Research panel streams real communities/accounts with source links. |
| 0:55 | Gallery fills: real key art + gameplay clip; copy variants per channel appear. |
| 1:20 | Bluesky post publishes automatically (L1) — click through to the real URL. |
| 1:40 | One X draft is blocked by lint ("contains 'dividend'") — shows guardrails work. |
| 1:55 | Approval inbox: approve the X post → real URL. LinkedIn stays draft. |
| 2:15 | Reddit item shows as **Human task** with a ready-to-paste draft and the subreddit's rule summary. |
| 2:30 | Analyst reads analytics; CEO writes a learning line and proposes cycle 2 (and a $ budget over the autonomous cap → opens a Board proposal in the existing contract flow). |
| 2:50 | Close on the line: *every external action has an ID, a URL, a cost, and an approver.* |

---

## 6. Risks and open verification items

| Risk / unknown | Impact | Mitigation |
|---|---|---|
| Postiz rate limit documented as both 30/h and 90–100/h; hosted pricing not found | Throttling mid-demo | Limiter at 25/h; batch; Bluesky direct as fallback; consider self-host |
| X connector or API cost/approval surprises (pay-per-use, URL surcharge; sources conflict on free credits) | X post fails | X is L2 + optional; links in reply; demo still works on Bluesky |
| Reddit access/self-promo rules | Account bans | Human-post only |
| Resend AUP vs. any cold email | Account termination | Opt-in only; cold email DENY in policy |
| Cold-email warm-up duration, Instantly pricing — **not verified** | Wasted time | Out of scope tonight |
| fal pricing/model names for Nov 2026 not confirmed from fal's own page | Overspend | Hard cap; log per-call cost; verify on fal.ai/pricing before the run |
| Apollo free-plan limits conflict | Empty results | Treat as optional |
| Agent SDK scheduler/unattended loop unconfirmed | — | We use our own timer (as `index.ts` does) |
| Legal: marketing a dividend-paying community on testnet | Reputational/regulatory | Lint forbids returns language; labels `DEMO/testnet`; wording needs legal review per project docs |
| UI location in flux (`server/web` staged for deletion) | Rework | Confirm first; standalone page fallback |
| Search results were mostly vendor blogs | Stale/biased facts | ✔ only where an official doc was read (Postiz docs, Resend AUP/MCP, Apollo MCP docs); everything else re-check on the vendor page before relying on it |
| Fake-audience temptation | Honesty/credibility | Hard rule: metrics only from APIs; zero stays zero; seeded history labeled |

## 7. Decisions (resolved 2026-11-14)

1. **Channels:** Bluesky live (L1); **X via Postiz (L2, approve then publish)**; LinkedIn draft/approve; Telegram/Discord on our own channels. **Instantly is a showcase**: agent builds a *paused* cold-email campaign (leads from Apollo/Exa, copy, sequence); launch stays L2 and is not done tonight.
2. **UI:** standalone Mission Control page served by `server/src/app.ts`, no framework.
3. **Link target:** the public URL every post points to (the page where a player lands). Default: the Vercel preview of RAM HEIST. Lives in `brief.yaml` as `product.url`, so swapping to a custom domain later needs no code change.
4. **LLM path:** A, direct Anthropic calls. Worker plan-as-JSON later.
5. **Spend cap:** $10 total tonight, $5 per cycle.

## 8. Day-2 roadmap

Warmed domain + Instantly/Smartlead for compliant B2B outreach · Apollo/Clay enrichment · streamer key distribution through Keymailer (manual → API if available) · ICP Learner and experiment engine adapted from the open-source skill packs (after license check) · growth LLM steps as metered worker tasks (§3.5 B) · per-channel analytics → bandit-style budget allocation across bets · expense integration (fal/Exa spend recorded through the existing CEO `record_expense` flow, category `api`).


## 9. Implementation status (2026-11-14) and runbook

**Built and tested:** all of Phases 0-6 except the items under "Not built". `pnpm test` (shared 3, worker 17, server 118) and `pnpm typecheck` are green. A real server was started in dry-run, a cycle was run over HTTP, events/measure/learn exercised, and Mission Control was rendered in a real browser.

**What "tested" means here.** Every adapter is tested against a *mocked* `fetch` (request shape, headers, secret redaction, error paths). **No live third-party call has been made**, because no keys exist yet. Treat each integration as "implemented to documented/assumed behaviour, unproven live".

### Runbook
1. `pnpm growth` and open the printed `Mission Control: http://127.0.0.1:8788/growth#token=...` URL. Press **Run cycle** (dry-run: no network, labelled `[DRY]`, placeholder art, sample targets marked as samples). Use **Guardrail probe** to show a non-compliant post being refused. **Seed example** adds a clearly labelled cycle 0.
2. Set `product.url` in `growth/brief.yaml` (live runs refuse while it is the placeholder).
3. `cp .env.growth.example .env.growth`, add keys (prefer the `secrets` skill). Tools appear in the header badge only when their keys exist.
4. Go live explicitly: `GROWTH_DRY_RUN=off` (anything else stays dry). Live also requires `ANTHROPIC_API_KEY`.
5. Optional: set `<meta name="agentcorp-events" content="https://your-server">` on the landing/game page and call `agentCorpTrack("wallet_connect")` / `"pass_click"` / `"game_page_view"` from the relevant pages. Without it the funnel reads zero and the analyst reports `no_data`, not a made-up number.
6. `GROWTH=off` removes the routes entirely; `growth_paused: true` in `policy.yaml` denies every action; `GROWTH_AUTO_HOURS=N` enables the auto loop (minimum N hours between cycles).
7. The main server (`pnpm start`) mounts the same routes and prints the same URL.

### Board voting (built, 18 tests, run against a fake chain that mirrors the contract's rules)
The contract already had `create_proposal` / `vote` / `finalize` / `get_budget`; the harness now uses them for growth spend.
- **Cap rule:** `growth cycle cap = min(owner cycle cap, Board budget in NEAR x usd_per_near x growth_share_pct/100)`. The owner caps in `growth/policy.yaml` stay the ceiling. The Board can lower growth spend, or raise it up to that ceiling.
- **Fail-closed:** no active Board budget, no chain connection, or an outage with no known budget means only `bootstrap_cycle_usd` ($1) is available, so the CEO can plan and ask but cannot spend freely. `board.enabled: false` restores the plain owner cap.
- **Proposals:** when the CEO wants more than the cap, or no Board budget exists yet, it creates a Budget proposal on-chain through its scoped key (action `board.propose`, L1). One option per owner-approved tier (`tiers_usd`, default $0/$1/$2/$5), encoded exactly as the contract parses it. Never more than one open vote; the feed says so when it waits instead.
- **Voting:** unit-weighted by the contract. Real contributors vote from their own wallets. The only votes this server can cast are the demo wallets (alice/bob) on a `demo_mode` contract, by an admin click in Mission Control.
- **Finalizing:** permissionless on-chain; done automatically at cycle start / tick / "Sync & finalize" once the period is over or everyone has voted. A tie or zero votes keeps the previous budget (contract rule). `finalize` was added to the oracle key's allowed methods in `server/scripts/setup.ts`; existing deployments need `setup --rekey` for that, and in `demo_mode` the harness falls back to the alice wallet and tells you.
- **Dry-run safety:** chain writes (propose/vote/finalize) are off in dry-run unless `GROWTH_BOARD_WRITES=on`, which targets the testnet contract only.
- **Honest limits:** `usd_per_near` is an owner assumption (testnet NEAR has no price). Growth spend is capped by the Board budget but still **not recorded on-chain** as expenses, so the on-chain per-period cap does not itself see it. Tiers must divide exactly at the configured rate and share (validated at load).
- UI: a Board panel shows the cap and why, the open proposal with live tallies, demo vote buttons, Finalize, and recent outcomes.

### Safety properties (each has a test)
- Default-deny policy; DENY levels (`chain.*`, `email.cold`, `resend.send.other`) can never execute; kill switch; budget caps (cycle/total) that count only non-failed spend; Postiz rate window defers instead of failing; daily caps on auto-posted channels.
- Lint (returns language, testnet label, channel length, X links in replies) runs on every outgoing text and thread part *before* an approval is requested.
- Models never write URLs (code adds UTM links) and cannot invent targets (URLs must appear in the Exa output) or channels/metrics (validated against the brief).
- **At-most-once execution:** an action is atomically claimed (`EXECUTING`) before any external call; two executors cannot both run it; a crash mid-call becomes `FAILED: verify externally` on restart and is never retried automatically.
- Admin routes need a constant-time-compared token header; public routes (`/event`, `/waitlist`) are rate-limited, whitelist-validated, and carry no admin power; assets are served from a validated path with a sandbox CSP; the page uses `textContent` only under a strict CSP.
- Email only to recorded opt-ins (dispatcher re-checks); Instantly campaigns are created paused and the adapter has no launch method.
- Secrets never appear in errors (origin-only URLs; tested with Telegram-style token paths).

### Not built, or only partially
| Item | State |
|---|---|
| Apollo | Not integrated. Official MCP is OAuth-only, so use it from a Claude Code session to build a lead list by hand; Exa covers discovery in the harness. |
| Driving the real game with Playwright | `scripts/capture-clip.ts` exists but is **untested** and Playwright is not installed; the game's controls are unknown. FFmpeg cuts (16:9 and 9:16) are implemented and unit-tested with a mocked runner. Set `GROWTH_CLIP_PATH` to use a clip. |
| AI video (Kling/Veo) | Not built. Images only. |
| Typefully, direct X API | Not built (Postiz covers X). |
| Spend on the ledger | fal/Exa/LLM spend is tracked in the harness only; it is not recorded as an on-chain `api` expense. |
| Worker "plan-as-JSON" LLM path | Not built (direct Anthropic only, per decision). |
| `pass_bought` attribution | Uses current-period contract revenue divided by pass price, not per-link attribution. |
| Instantly leads | Campaign + sequence only; no leads attached. |

### Assumptions to verify on first live run (not confirmed against official docs this session)
1. **Postiz:** the create-post *response* shape (postId parsing is defensive) and any per-channel `settings` X or LinkedIn require. If a platform rejects a post, read its schema via the Postiz MCP `integrationSchema` and pass `settings`.
2. **Instantly v2** campaign schema (schedule/sequence fields, timezone value) is from memory/community servers.
3. **fal:** default model `fal-ai/flux/schnell` and the $0.05/image estimate; **LLM** token prices default to $3/$15 per million. Both only feed the budget gate; check real billing.
4. **PostHog** HogQL query endpoint and `person_id` distinct count.
5. **Bluesky/Telegram/Discord/Exa/Resend** request shapes follow their public APIs from memory; each is covered by mocked tests only.
6. The model ID default is `claude-sonnet-5-5`; change with `GROWTH_MODEL`.

### Found along the way
- `landing/index.html` says "You earn a share of revenue from sales." Our own lint policy would block that wording in a post, and the project docs say share/dividend language needs legal review. The landing copy is not touched by this work; worth a decision.
- `server/web/*` is still staged for deletion in the working tree; Mission Control is therefore a standalone page (`/growth`) and does not depend on it.

## Decision: kickbacks.ai is not integrated (2026-11-14)
Asked to integrate kickbacks.ai to cut costs and raise revenue. Not done, for four reasons (sources below; the product's GitHub README returned 404, so these come from two secondary reviews by the same author and are unverified by me):
1. **It cannot cut our costs.** Our costs are Anthropic/fal/Exa API calls. Kickbacks pays developers a share of ad impressions for sponsored text in the Claude Code spinner. Reported figures: ~$1 CPM floor, $10 minimum payout, $5.85 average lifetime per registered developer, $2.24 over four days in one reviewer's test. Against a $10 total growth budget that is rounding error.
2. **It likely cannot earn on our workers.** It is a VS Code extension that patches Claude Code's webview. Our workers run headless `claude -p --tools ""` in a macOS sandbox with a pinned model. Neither review tests headless runs (unverified), but there is no spinner UI to monetise.
3. **Security.** The reviews report it appends code to Claude Code's extension files, relaxes its Content Security Policy, and polls for self-updates every 90 seconds with an empty public key, i.e. no signature verification, plus open issues about client-forgeable billing. Our contributors' machines hold `~/.near-credentials` wallet keys. An unsigned auto-updater there is a remote-code-execution channel into the keys the Board and payouts depend on, and it undermines the sandbox, metering and pinned-model guarantees the contributor model relies on.
4. **Maturity.** Reported marketplace removal and relaunch under kickbacks.dev; current status unknown.
Real cost levers instead (not built; see the answer in chat): per-role model routing (a cheaper model for query-writing/analysis, the strong one for CEO and copy), prompt caching of the stable brief prefix, and reading actual token usage for the budget gate.

## 10. Sources

Official docs read this session:
- Postiz public API & MCP: [introduction](https://docs.postiz.com/public-api/introduction.md), [create post](https://docs.postiz.com/public-api/posts/create.md), [upload](https://docs.postiz.com/public-api/uploads/upload-file.md), [analytics](https://docs.postiz.com/public-api/analytics/platform.md), [MCP](https://docs.postiz.com/mcp/introduction.md), [llms.txt](https://docs.postiz.com/llms.txt)
- Resend: [Acceptable Use Policy](https://resend.com/legal/acceptable-use), [MCP changelog](https://resend.com/changelog/mcp), [MCP docs](https://resend.com/docs/mcp-server)
- Apollo: [MCP server docs](https://docs.apollo.io/docs/apollo-mcp-server-documentation)
- PostHog: [MCP product analytics docs](https://posthog.com/docs/product-analytics/build-insights-mcp.md)
- Claude Agent SDK: [permissions](https://platform.claude.com/docs/en/agent-sdk/permissions), [hooks](https://code.claude.com/docs/en/agent-sdk/hooks.md)
- Bluesky: [create post](https://docs.bsky.app/blog/create-post), [get started](https://docs.bsky.app/docs/get-started)
- Typefully: [API docs](https://typefully.com/docs/api)

Kickbacks.ai reviews (secondary, same author, unverified): [Darius J. Davis](https://dariusjdavis.com/blog/kickbacks-ai-reverse-engineering/) · [Southside Chi Solutions](https://southsidechisolutions.com/blog/kickbacks-ai-is-adware-with-a-payout-page/) · [Product Hunt listing](https://www.producthunt.com/products/kickbacks-ai)

Third-party (directional; re-verify): [Salesforge outreach tools](https://www.salesforge.ai/blog/sales-outreach-tools) · [Saleshandy sales MCP servers](https://www.saleshandy.com/blog/mcp-servers-for-sales/) · [Blotato social MCP servers](https://www.blotato.com/blog/best-social-media-mcp-servers) · [X API pricing (OpenTweet)](https://opentweet.io/x-api-pricing) · [X pay-per-use explainer](https://superframeworks.com/articles/x-api-pay-per-use-pricing-indie-hackers) · [Reddit limits (Postiz)](https://postiz.com/blog/reddit-api-limits-rules-and-posting-restrictions-explained) · [Reddit Responsible Builder Policy thread](https://r.datuan.dev/r/redditdev/comments/1oug31u/introducing_the_responsible_builder_policy_new/) · [Exa alternatives](https://parallel.ai/articles/exa-alternatives) · [Web search MCPs](https://parallel.ai/articles/best-web-search-mcp) · [fal pricing](https://fal.ai/pricing) · [image/video API pricing](https://www.developersdigest.tech/blog/image-video-generation-api-pricing-2026) · [Instantly MCP](https://www.instantly.ai/blog/instantly-mcp-server-connect-your-ai-assistant-directly-to-your-cold-email-platform/) · [Keymailer review](https://www.creator-hero.com/blog/keymailer-pricing-and-review) · [Martech gaming influencer platforms](https://martech.zone/choosing-the-best-gaming-influencer-marketing-platform-10-options-in-2026/) · [kai-cmo-harness](https://github.com/cgallic/kai-cmo-harness) · [ai-marketing-skills](https://github.com/ericosiu/ai-marketing-skills)
