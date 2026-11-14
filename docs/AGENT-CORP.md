# Agent Corp — Near Hackathon MVP

## 1. Core model

Agent Corp is autonomous startup. Contributors donate capped AI capacity to agents that build, operate, market, and improve company products. A contributor's metered usage becomes their **lifetime contribution units**. Units are contributor's ownership share. All contributors together form the **Board**; Board members receive dividends (distributions) from net profit.

Customers buy startup's products or services — subscriptions, seats, or usage. **RAM HEIST** is demo product: small paid stealth game. It is not market where player hires, funds, or directly pays workers.

Money path:

```text
contributor AI usage → lifetime contribution units
customers pay product revenue → company treasury
company pays operating costs → costs leave treasury
weekly close → positive net revenue allocated by contribution units
contributor withdraws allocated distribution
```

Never describe flow as `worker used X tokens → customer paid job → worker receives job payment`. Job work changes ownership share only. It does not create payout.

### Terms

| Term | Meaning | Not meaning |
|---|---|---|
| Contribution units | Metered AI usage donated to company work. Accumulate over time. | Invoiceable work or job wage. |
| Revenue | Money customer pays for company product. Enters company treasury. | Instant contributor payout. |
| Operating cost | Verifiable company expense paid from treasury: hosting, domain, API, payment fees, contractor/service cost. | Contributor distribution. Donated inference — that earns units, costs company nothing. |
| Expense reserve | Treasury money held back for future company expenses. Topped up at period close per reserve policy. | Money owed to contributors. |
| Net distributable revenue (net profit) | Period revenue minus paid operating costs and expense-reserve top-up. If result is negative, it is zero: nothing to distribute. | Gross customer payment. |
| Distribution reserve | Treasury money set aside for contributors: closed-period net profit credited as claimable, plus any undistributed remainder that rolls into next close. | Expense money. |
| Distribution (dividend) | Periodic allocation of positive net distributable revenue, proportional to contribution units at close. | Per-job settlement or tip. |
| Board | All contributors with nonzero units. Votes weighted by units. Receives distributions. | Separate group of directors or owner's private funds. |

Contributors do get ownership share and dividends. Exact public wording of “ownership”, “share”, and “dividend” needs legal review before mainnet; testnet demo carries `DEMO` labels.

## 2. Hackathon product

One company. One product. One full business cycle on NEAR testnet.

- Product: **RAM HEIST** — original 2D canvas stealth-puzzle game with real-time movement on a grid. The current demo includes House 01 and a testnet pass.
- Contributors: two distinct contributor wallets run capped agent sessions. Usage is metered into lifetime contribution units.
- Revenue: testnet customer payment is clearly labeled demo revenue and recorded in treasury.
- Costs: demo pays at least one visible operating cost in tNEAR (labeled `hosting`) before distribution. Inference is donated, so it is not company cost. Real cash cost categories are decided later.
- Distribution: close seeded **weekly** period on stage. Only then contributors receive claimable balance.

Mainnet requirements remain separate: legal review, real customer payments, real expense controls, provider terms, and production security.

### Game direction

RAM HEIST uses the high-level stealth loop of moving through a house, watching guard sightlines, using doors/walls as cover, taking loot, then escaping. It must be original: no Robbery Bob name, characters, art, level layouts, code, sound, or copied missions.

Player character is **Sam Alt-RAM**, fictional satirical tech-founder character — not claim about real Sam Altman. Homes, residents, rooms, and addresses are invented; no real-home data or real people.

Demo level: `House 01 — The Living Room Upgrade`.

- Front entrance blocked while resident watches TV. TV glow and resident sightline make direct entry unsafe.
- Player enters through side route, uses walls and closed doors to break line of sight.
- Drop flowerpot by window in kitchen to create a distraction and hide. Resident walks toward sound; route opens briefly.
- Second resident follows a readable routine: bathroom → hallway → fridge → kitchen. Player times movement around routine.
- Collect two RAM sticks, avoid light/view cones, exit through back door. Detection restarts level; no violence mechanic.

### Demo contributor setup

- **Alice**: separate demo contributor wallet, seeded with 60,000 units. A real signed-in Claude session produced a proposed QA checklist; do not claim the tool-disabled worker built the game.
- **Bob**: separate demo contributor wallet, seeded with 40,000 units. A second real signed-in Claude session produced marketing copy. Later metered work changes the original 60/40 proportions.
- Use two different NEAR wallets even if both sessions run from one laptop. Label this setup on screen. Do not imply separate physical machines if not true.
- Default demo uses two Claude Code sessions. Claude Code + Codex is allowed after Codex has equivalent sandboxing, metering, and contributor-login support.
- **Adapter plan:** reuse the relevant MIT-licensed Claude Code, Codex, and future provider-adapter patterns from `get-bb/bb`; retain its copyright and MIT license notice with copied files, audit every copied dependency/license, and keep Agent Corp's contributor metering/login/payout rules in its own adapter boundary. Do not copy provider credentials, telemetry configuration, branding, or unrelated bb app code.

## 3. Product flow

### Player flow: one game pass

1. Current public demo uses one server-controlled testnet customer wallet. A **RAM HEIST Pass** purchase calls `buy_pass` for the configured price (1 tNEAR in the canonical demo), unlocking House 01 and replay. Individual wallet checkout and additional levels remain future work.
2. Same call records payment as company revenue and activates pass for paying wallet. Overpayment is returned in that call.
3. Game server verifies on-chain entitlement, unlocks levels, and stores run/score data off-chain.
4. Player completes a level, receives non-financial on-chain or off-chain loot receipt, and can replay for score.
5. If payment fails, pass stays locked and no revenue is recorded. MVP has no refunds; storefront copy says so.
6. Agents building levels, art, game logic, marketing, and operations earn contribution units from metered work. A player purchase does not change contributor balance.

### Company close: weekly distribution

1. At period end, accounting oracle gathers period revenue, paid operating costs, and expense-reserve top-up.
2. It closes one immutable period: `net = revenue - operating costs - expense-reserve top-up`.
3. If `net > 0`, contract moves it to distribution reserve and allocates it across contributors by lifetime contribution units at close. If `net <= 0`, no distribution; loss is not carried into next period.
4. Each contributor's claimable balance rises by allocation. It never depends on which player purchase, level, or feature they worked on.
5. Contributors withdraw after close. Failed transfer remains claimable.

Default period: 7 days. No early close except explicitly labeled demo close. Close must be idempotent and publish on-chain receipt.

## 4. Accounting and contract rules

### Revenue and expenses

- Product payments enter revenue treasury. Pass receipt proves payment and entitlement; it does **not** list contributor shares.
- Every expense needs category, amount, period, evidence/reference, approver, and on-chain payment or recorded payable state.
- Supported categories: `hosting`, `domain`, `api`, `payment_fee`, `contractor`, `other`. Reserve is not expense category.
- Expense approval follows active Board budget. Payment must not exceed approved category budget.
- An approved but unpaid expense is visible as committed cost; it does not reduce distributable revenue until paid.
- Expense-reserve top-up reduces distributable revenue at close. Top-up never exceeds `revenue − paid costs`, so it cannot push net below zero. Paid costs draw from period revenue first, then expense reserve.
- No refunds in MVP. All pass sales are final revenue.
- Treasury view separates: revenue this period, operating costs this period, expense reserve, distribution reserve (claimable balances + undistributed remainder).

### Distribution math

At close, use single 256-bit `mul_div`:

```text
period_net        = max(0, period_revenue - period_operating_costs - expense_reserve_topup)
net_distributable = period_net + distribution_remainder_carried_in
contributor_distribution = net_distributable × contributor_lifetime_units / total_lifetime_units_at_close
```

Demo example: player buys 1.00 tNEAR RAM HEIST pass. Company pays 0.10 tNEAR hosting cost and keeps 0.10 tNEAR in expense reserve. Net distributable is 0.80 tNEAR. At close, Alice has 60,000 units and Bob has 40,000: Alice gets 0.48 tNEAR and Bob gets 0.32 tNEAR. Both amounts come from closed weekly net revenue, not direct payment for particular pass, level, or feature.

- Snapshot denominator and each eligible contributor's units at close, or use reward-debt accounting that yields same result. New units after close cannot claim prior periods.
- Rounding remainder stays in distribution reserve and is added to next period's net distributable.
- If period net is zero or negative, nothing is distributed. Loss is not carried forward as debt against later periods.
- `claimable` changes only on `close_distribution` or failed withdrawal callback — never on pass purchase, game event, or worker report.
- If total eligible units are zero, whole net distributable stays in distribution reserve and carries into next close. Do not send it to player, worker, or platform.
- Platform/accounting fees are operating costs only when explicitly approved and recorded. No automatic 70/20/10 split.

### Governance

Board = all contributors with nonzero units. Board votes with lifetime contribution units on company-level budgets, expense reserve, expense categories, distribution cadence, hiring, and rules. CEO is AI agent: it creates proposals and budgets, Board votes, result binds expense approval. AI agents decide product-level work.

Live voting weight is acceptable for hackathon. Period distribution weight must be snapshotted at close. MVP shows each contributor's share as `%` of total units; there is no separate points system.

- **MVP core:** existing `create_proposal` / `vote` / `finalize` keep working with unit-weighted votes; one budget proposal is visible on dashboard.
- **Future:** Board-voted cadence and reserve changes, hiring votes, rule changes, per-category budget enforcement beyond single active budget.

## 5. Required contract surface

Names may differ in Rust, behavior is binding.

| Capability | Required behavior |
|---|---|
| `buy_pass` | Payable, called by player. Records payment as period revenue and activates pass for caller's wallet in same call. Returns overpayment; rejects underpayment. No contributor allocation, no payout. |
| `record_contribution` | Accounting oracle adds units for company work. No payout. |
| `record_expense` | Record approved operating cost with category, period, reference, amount. |
| `pay_expense` | Send approved treasury expense; `#[private]` callback restores expense to unpaid if transfer fails. |
| `close_distribution(period)` | Once per ended period: top up expense reserve, snapshot units, calculate positive net, credit contributor claimable balances, emit period receipt. |
| `withdraw_distribution` | Contributor withdraws prior-period claimable balance; failed transfer restores it. |
| `create_proposal` / `vote` / `finalize` | CEO agent creates proposal; Board votes by units; finalize sets active budget. |
| Views | Pass receipt, period ledger/receipt, contributor units and share %, claimable distributions, treasury breakdown, budgets, proposals. |

Roles remain separate: owner (human) configures contract; CEO agent creates proposals and budgets; Board votes; accounting oracle records revenue/costs/units and closes periods; workers cannot move funds. All state changes emit `EVENT_JSON` for dashboard.

## 6. Interfaces

```ts
export type PassState = "locked" | "active";
export type Units = string; // integer micro-USD of model-list-price usage
export type ExpenseCategory = "hosting" | "domain" | "api" | "payment_fee" | "contractor" | "other";

type GamePassView = {
  id: string; account: string; state: PassState;
  product: "ram-heist-pass"; unlockedLevelIds: string[];
  paymentReceipt?: { txHash: string; explorerUrl: string; amountYocto: string; product: string };
};

type DistributionPeriod = {
  id: string; startsAt: number; endsAt: number; status: "open" | "closed";
  revenueYocto: string; operatingCostsYocto: string; expenseReserveTopUpYocto: string; carriedInYocto: string;
  netDistributableYocto?: string; totalUnitsAtClose?: Units; closedTxHash?: string;
};

type DashboardView = {
  network: "testnet" | "mainnet";
  treasury: { periodRevenueYocto: string; periodCostsYocto: string; expenseReserveYocto: string; distributionReserveYocto: string };
  currentPeriod: DistributionPeriod;
  nextDistributionAt: number;
  contributors: { account: string; lifetimeUnits: Units; sharePct: number; claimableYocto: string; lastDistributionYocto?: string }[];
  expenses: { category: ExpenseCategory; amountYocto: string; reference: string; status: "approved" | "paid" }[];
  proposal?: { id: number; title: string; status: "open" | "finalized" };
  activity: { ts: number; actor: "CEO" | "WORKER" | "CONTRACT" | "BIZDEV" | "MARKETING"; text: string; recorded: boolean; txHash?: string }[];
};
```

API semantics:

```text
POST /api/passes {tier}                -> {passId, price, contractId}
GET  /api/passes/:id                   -> GamePassView
GET  /api/game/levels/:id              -> {id, state, score?}
GET  /api/dashboard                    -> DashboardView
GET  /api/periods/:id                  -> DistributionPeriod
WS   /api/live                         -> purchase, dashboard, distribution_closed events
POST /api/admin/expenses               -> create/approve company expense
POST /api/admin/periods/:id/close      -> close ended distribution period
```

## 7. UI requirements

### Dashboard

Treasury-first company view:

1. Current-period revenue, paid/approved operating costs, expense reserve, estimated net. Label estimates until close.
2. Next weekly distribution date, prior closed-period receipt.
3. Contributor table: lifetime units, share `%`, claimable **from closed periods**, last distribution.
4. Expense ledger with category/reference/status.
5. Board and activity ticker.

**Studio strip animation.** Add original isometric mini-studio above the activity ticker: desk for the CEO, plus Build, Test, Marketing, Treasury, and Distribution stations. Behind the glass should be the Boardroom. Each time new contributor appears, it shows with the logo/logos of LLM providers he uses. It is a game-development-management feel, not copied Game Dev Tycoon art, UI, characters, or animation.

- A real activity event advances one small, readable step: Alice's task card moves Build → Test; Bob's clip moves Marketing → Postiz draft; a purchased pass moves into Treasury; hosting invoice moves Treasury → Costs; weekly close moves net revenue Treasury → Distribution.
- Cards show event label, time, and status; clicking one opens matching receipt, task, post draft, or period ledger. Animation must reflect stored events only — never fake completed work.
- Keep visual subordinate to ledger: no money appears in contributor wallets until `close_distribution` completes. During close, 60/40 meter fills, then Alice/Bob claimable balances update to 0.48 / 0.32 tNEAR.
- Use CSS/Canvas or lightweight sprites. Pause control, `prefers-reduced-motion` static state, no essential information only in motion.

Withdraw appears only for nonzero claimable distribution. Completed pass purchase or game level cannot make it appear. On close, dashboard — not game page — shows restrained “weekly distribution closed” state and period receipt.

### Storefront

Product checkout only. Copy says player is buying RAM HEIST Pass: three levels plus score replay. It must not promise payment pays builders or show worker pay. Copy states pass sales are final: no refunds in MVP.

States: wallet waiting, cancelled wallet, paid then redirect to game page, failed payment with locked pass.

### Game page

Player game page. Main column: isometric home, movement, resident sightlines, light cones, cover, doors, RAM loot, and exit. Side rail: pass/payment receipt, unlocked levels, score, product transaction link.

Do not show contributor allocations, builder earnings, “split complete,” or Withdraw. Game page may show level progress and loot receipt, but game attribution is not financial attribution.

Responsive/a11y: 44px controls; keyboard movement alternative; tab order for Buy Pass, Vote, Withdraw; `header`, `main`, `aside`; live region for pass status and distribution close; receipt rail moves below content on narrow screens.

## 8. Demo script (3 minutes)

| Time | Beat |
|---|---|
| 0:00–0:20 | Dashboard: contributors, treasury, current weekly ledger, next close. Explain units create ownership share, not job wages. |
| 0:20–0:45 | Two contributor sessions: Alice builds patrol/door logic; Bob captures House 01 and prepares marketing draft. Show 60k / 40k units on two wallets. |
| 0:45–1:40 | Judge buys RAM HEIST Pass, unlocks House 01, and plays TV watcher / flowerpot distraction / bathroom-to-fridge patrol puzzle. Player payment becomes company revenue. Show pass receipt only. |
| 1:40–2:15 | Dashboard: revenue increased; pay visible 0.10 tNEAR hosting cost. No contributor balance changed. |
| 2:15–2:50 | Close seeded weekly period: 1.00 revenue − 0.10 hosting cost − 0.10 expense reserve = 0.80 distributed. Show 60/40 snapshot and 0.48 / 0.32 claimable receipt. |
| 2:50–3:00 | Alice and Bob each withdraw closed-period distribution. “Customers fund company; company pays costs; contributors share weekly net revenue.” |

All values/payments carry `TESTNET` / `DEMO` labels. If live wallet payment or game load fails, recorded fallback shows pass activation and House 01 completion followed by same weekly-close sequence.

## 9. Security and operating controls

- Game levels use invented homes, residents, room plans, and addresses only. Never ingest real-home maps, security-camera feeds, or personal data.
- Keep game mechanics fictional: no real burglary guidance, real access methods, or real person/house targeting.
- Workers: current sessions are tool-disabled reviewers with pinned provider/model policy, contributor-owned daily dollar/token caps, cancellation and durable metering. macOS Seatbelt limits filesystem access; network remains open and this is not a complete hostile-code boundary. Coding-tool execution and stronger isolation remain future work. Workers hold no owner, CEO, oracle, or treasury credentials. See `docs/provider-integration/README.md`.
- Usage: final `total_cost_usd × 1e6` replaces provisional estimate. Failed attempt usage can earn contribution units, but never creates cash payout.
- MVP trusts worker-reported usage. Independent usage verification and anti-farming limits are post-MVP.
- Separate owner, CEO, accounting oracle, worker credentials. Accounted expenses require approval trail. Accounting oracle close power bounded to one ended period and immutable inputs.
- Retain pass payment, entitlement, expense, distribution receipts. Reconcile after restart without double-closing period or double-crediting units.

## 10. Implementation status and migration

The testnet MVP has replaced the earlier **job-settlement payout** prototype. Canonical period accounting, storefront, House 01, dashboard, authenticated workers, provider adapters and Growth Mission Control are implemented. Current scope is a testnet demo, not production payments or individual player-wallet checkout.

Do not claim old testnet contract's 70/20/10 split, per-job accumulator, `settle` receipt, job-triggered withdrawal as support for this model. The canonical replacement is already deployed as `contract.agentcorp-c103c2bb.testnet`; receipts are in `docs/handoffs/LIVE-VERIFICATION.md`.

### Tasks — MVP core (two parallel agents)

Assign one owner per lane for the entire phase. Check off tasks only after their acceptance checks pass. Parallel work starts after the setup and interface agreement below; integration and deployment are serialized.

#### 0. Shared setup — coordinator, before either agent edits

- [x] Inspect `git status` and preserve all existing changes, including untracked files. Record the base commit and which changes belong to whom; do not reset, clean, overwrite, or silently absorb existing work.
- [x] Create one branch and separate worktree per agent from the agreed base. If existing uncommitted changes are needed, explicitly carry them into the appropriate worktree without removing them from the original checkout. Each agent edits and runs commands only in its own worktree.
- [x] Agree on §5 contract methods, arguments, JSON serialization, events, error behavior, and §6 API types before implementation. Record any necessary corrections here with both owners' agreement. Until the contract is ready, Agent B uses fixtures or a mock implementing that agreement; Agent A owns the canonical contract behavior.
- [x] Assign integration owner (default: Agent B). Only integration owner merges or cherry-picks, updates shared lockfiles, deploys, or edits files outside the lane boundaries. Agents request shared-file changes rather than editing them concurrently. Keep commits scoped to one lane and report commit IDs, tests, and interface deviations at handoff.

Step 0 completed sequentially by coordinator; provenance, lane branches/worktrees, agreement and ownership: `docs/handoffs/STEP-0.md`. No concurrent implementation agent active.

#### Agent A — contract and accounting

Exclusive write ownership: `contract/`, including its Rust manifest, lockfile, tests, and generated contract artifacts. Do not edit `server/`, `worker/`, `shared/`, root manifests/lockfiles, or this task list during parallel work.

- [x] Remove per-job `settle` payout and 70/20/10 split; work records contribution units only.
- [x] Add `buy_pass`: payable, records revenue, activates pass for caller, returns overpayment; locked/active states and no refunds. — *Done: repeat purchase by same wallet adds revenue, pass stays active.*
- [x] Add period ledger: revenue, paid costs, expense-reserve top-up, carried-in remainder, and net.
- [x] Add `record_expense` and `pay_expense`: category, amount, period, reference, approver, active-budget limit, and unpaid restoration on failed transfer. — *Done: both owner cap and machine-readable Board-approved aggregate budget enforced. CEO approves, oracle pays.*
- [x] Add `close_distribution` and `withdraw_distribution`: one close per period, unit snapshot, pro-rata claimable credit, receipt, labeled seeded demo close, and failed-withdrawal restoration.
- [x] Preserve unit-weighted `create_proposal` / `vote` / `finalize`. — *Done: proposal kind renamed `BudgetSplit` → `Budget`.*
- [x] Test pass purchase leaves claimable unchanged; locked/active pass; underpayment and overpayment; expense and reserve reductions; 60/40 close yields 0.48 / 0.32 from 0.80; later units cannot claim earlier periods; zero or negative net; zero units carry forward; double close rejection; failed withdrawal restoration. — *Done: 56 unit tests pass; format, strict Clippy and WASM build pass. Transfer callbacks tested in NEAR unit environment; network integration remains separate.*
- [x] Handoff: provide commit IDs, test results, exact contract interface/events, deployment inputs, and any gaps to integration owner. Do not deploy independently. — *Done: lane commit `87436e9`; exact Interface, events, deploy inputs, artifacts and gaps in `docs/handoffs/AGENT-A.md`. No deployment.*

#### Agent B — application, worker, and demo preparation

Exclusive write ownership: `server/`, `worker/`, `shared/`, and `landing/`. Integration owner alone handles root `package.json`, `pnpm-lock.yaml`, `.gitignore`, README, and other shared files; defer those changes until Agent A's handoff. Do not edit `contract/` or this task list during parallel work.

- [x] Replace job APIs with pass, period, expense, and dashboard APIs from §6. Keep pass and distribution receipts separate. — *Done for testnet demo: canonical Ledger routes serve deployment, dashboard/activity, pass gate, score, demo buy/agents/close/withdraw/vote; old job web/API removed. Public deployment and external-wallet checkout remain separate.*
- [x] Build storefront: Buy Pass checkout, no-refunds copy, locked/cancelled/failed/paid states; no payout, share, or withdrawal language. — *Done for server-controlled testnet demo wallet; external-wallet checkout remains future work.*
- [x] Build House 01 game: patrols, sightlines, doors, flowerpot distraction, RAM loot, exit, and on-chain pass verification. No payout, share, or withdrawal language. — *Done for server-controlled testnet demo session; rules/game tests pass. External-wallet sessions remain future work.*
- [x] Build dashboard: treasury, period P&L, expense ledger and reserve, units/share/claimable, budget proposal, and Withdraw only for nonzero claimable. Remove points from UI and types. — *Done for testnet demo data and actions.*
- [x] Implement the current tool-disabled worker scope in §9: macOS sandbox, durable caps, final-cost/token metering and Alice/Bob demo seeds. — *Two real Claude sessions credited on-chain; Codex integration and Mac provider controls implemented. Coding-tool sandbox, stronger isolation and experimental-provider live verification remain future work.*
- [x] Test application and worker flows against agreed fixtures, including purchase leaving claimable unchanged and withdrawal appearing only after a close. — *Current local verification: 185 TypeScript tests (153 server, 29 worker, 3 shared), typecheck and 56 Rust tests pass. Historical lane provenance is retained in the handoffs; live canonical script/worker evidence is in `LIVE-VERIFICATION.md`.*

#### Integration owner — after both handoffs, one writer

- [x] Integrate both lanes into a dedicated integration branch/worktree. Review conflicts and preserve pre-existing changes; coordinate any contract interface mismatch with Agent A before changing it. Update shared manifests/lockfiles only here. — *Done: both lane snapshots reconciled in `4aa701e`; interface agreement and provenance in `docs/handoffs/STEP-0.md`.*
- [x] Run contract/application tests and exercise canonical testnet accounting: buy pass → entitlement → paid hosting → weekly close → both withdrawals. Confirm purchase/game events do not credit claimable. — *The complete accounting cycle passed through `pnpm demo`; this is script evidence, not a recorded end-to-end UI rehearsal.*
- [ ] Rehearse the complete accounting cycle through dashboard UI against the live contract; keep this distinct from automated fixtures and the script run.
- [x] Deploy new contract version to testnet and configure application; verify on-chain receipts, failed-transfer handling, and reconciliation. Seed Alice 60,000 and Bob 40,000 units using distinct wallets. — *Done: canonical `contract.agentcorp-c103c2bb.testnet`; deployment and close receipts, seeded 60,000/40,000 contributors, and live run recorded in `docs/handoffs/LIVE-VERIFICATION.md`. Failed-transfer behaviour is contract-unit-tested; public-host verification remains pending.*
- [ ] Rehearse the three-minute demo and record fallback video. Resolve player character name before demo; update all references consistently.
- [x] Write README with numbered “do X, see Y” steps; list libraries, AI-written code, and reused MIT code. Account for root `.gitignore` excluding `*.md`.
- [ ] Prepare and publish X demo post with video; submit before 2026-11-14 23:59 UTC.

Architecture follow-up completed after Agent A: all eleven findings, four second-pass defects, and three completion-audit defects resolved. Later growth storage/shutdown and contributor pricing fixes are also implemented. See `docs/ARCHITECTURE-REVIEW.md`; historical `FINAL.md` is superseded for deployment status by `LIVE-VERIFICATION.md`.

### Tasks — future (post-MVP)

- [ ] Studio-strip activity animation driven by stored events only.
- [ ] Refund flow and refundable-revenue hold.
- [ ] Independent usage verification and anti-farming limits for contribution units.
- [ ] Board votes on cadence, reserve policy, hiring, and rules; per-category budget enforcement.
- [ ] Real cash cost categories and expense evidence rules.
- [ ] Production payments: USDC / NEAR Intents. Keep separate from testnet demo.
- [ ] Legal/tax review of ownership, dividend, and revenue-share wording before mainnet.
- [x] Claude/Codex provider adapters, local pricing, provider policy and Mac launcher controls.
- [ ] Live-verify experimental Cursor/OpenCode/custom ACP; implement Pi execution only after launch/auth/confinement verification.
- [ ] Stronger worker filesystem/network isolation, independent usage attestation and coding-tool execution.
- [ ] External-wallet game authentication and checkout.
- [ ] Growth: real-service end-to-end verification, live Board integration and durable on-chain accounting of paid growth expenses.
- [ ] Transferable contributor NFT (see §11).

## 11. Decisions still needed

Decided for MVP: no refunds; share shown as `%`, no points; Board = all contributors; negative net distributes nothing and is not carried forward; demo cost is tNEAR hosting cost, not inference.

- Distribution period: weekly default proposed. Confirm cadence and close authority.
- Expense-reserve policy: fixed amount or percentage of period revenue. Demo uses 0.10 tNEAR.
- Expense control: evidence/approval rule and who can pay approved costs.
- Revenue rail: testnet tNEAR demo first; decide USDC/NEAR Intents separately for production.
- Legal/tax: obtain jurisdiction-specific advice before real distributions; review public wording of ownership and dividends.
- Player character name: replace before demo.
- **Stretch — transferable contributor NFT:** only after core usage, treasury, and weekly-close flow work. On NEAR, mint a NEP-171 NFT that maps to one contributor's lifetime units in contract state. Transfer gives buyer those units, their voting weight, and distributions from later closes. Ownership is read at each period close: prior owner keeps claimable balances from already-closed periods; buyer receives distributions from next close on. Sale copy about ownership and dividends needs legal review first. Marketplace/escrow and sale fees remain later scope.
