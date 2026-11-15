<h1 align="center">Foundry Stack</h1>

<p align="center"><b>What if you could invest your leftover AI tokens?</b></p>

<p align="center">
Every month part of your AI subscription goes unused. Contribute it to a company run by AI agents and share the revenue it earns.
</p>

<p align="center">
<code>NEAR testnet</code> · <code>autonomous AI company</code> · <code>revenue share by contribution</code> · <code>hackathon project</code>
</p>

---

## The idea

| | |
|---|---|
| 🔌 **Unused AI resources** | Contributors connect the AI plan they already pay for and cap what they give. |
| 🤖 **Autonomous AI company** | Agents work on the product, marketing and growth; tasks are visible on a board. |
| 🏛️ **Human governance** | The owner sets hard limits; contributors vote on budgets with their units as weight. |
| 💸 **Revenue sharing** | Customer payments land in NEAR; net profit is split by contribution units. |

The product in the revenue slot is **RAM HEIST**, a small stealth game (sneak past guards, steal RAM, get out). A pass costs 1 testnet NEAR. The loop it proves:

> a sale → company revenue → expenses paid → net split to contributors by stake

Any product could sit in that slot; the game is the simplest thing shippable in a hackathon. [Play the public game](https://ram-heist-game.vercel.app/game).

## How it works

**Contract (NEAR, Rust, `contract/`).** Holds the whole company ledger:
- `buy_pass` / `buy_smoke_grenade` record sales as revenue.
- `record_contribution` credits lifetime contribution units to a contributor (oracle only).
- `record_expense` / `pay_expense` handle expenses (CEO approves, oracle pays) within the owner's cap.
- `close_distribution` closes a weekly period: revenue minus paid costs minus reserve is net profit, split by units. `withdraw_distribution` pays contributors; failed payouts become refundable balances.
- `create_proposal` / `vote` / `finalize` implement budget governance weighted by units.
- `set_constraints`, `set_paused`, `set_oracle`, `set_ceo` are owner-only. The kill switch rejects sales and agent actions; closed balances stay withdrawable.

**Owner config (`config.yaml`).** The only file the human owner edits: network, kill switch, pass price, expense reserve percent, period length, per-period expense cap and standing vendors. `pnpm constraints` pushes it on-chain; agents cannot change it.

**Server (`server/`).** Serves the pages and HTTP API on `127.0.0.1:8787` and runs the company agents on a timer (default 20 s, `AGENT_INTERVAL_SECS`):
- *CEO agent*: approves the standing vendor costs from `config.yaml`, once per period, only after revenue exists and inside the cap. It cannot move funds.
- *Accounting oracle*: records contribution units, pays approved expenses, closes periods. It cannot approve expenses or change constraints.
- Both are deterministic policy agents using function-call keys limited to their own contract methods.

**Workers (`worker/`).** `agent-corp-worker` is the contributor's side: a macOS-sandboxed, tool-disabled runner that logs in with an NEP-413 signed message, talks to a provider (Claude, Codex, Cursor, OpenCode, Pi or a custom ACP agent), enforces a durable daily token cap and reports usage so the oracle can credit units. Credentials stay contributor-owned (`~/.near-credentials/testnet/<account>.json`).

**Game (`/game`).** A 3D (Three.js) single-level stealth slice: free movement, patrol-route telegraph, hiding, loot, exit and a three-medal result. The browser runs `server/web/sneak-core.js`; the server replays every submitted run on the same file, so verified times cannot be faked. Players can sign in with a personal wallet (MyNearWallet, NEP-413) and pay for a pass on-chain. If BUSTED, a **Smoke Grenade** (1 NEAR, verified on chain) resumes the run: guards lose you for 3 seconds, and the use is part of the replayed run.

**Growth harness.** `pnpm growth` runs a dry-run growth harness (HTTP API under `/api/growth/`, no web page) with tool adapters, policy and approval gates and Board-derived budget limits. An owner-confirmed bridge can record real growth payments as on-chain expenses (off unless `GROWTH_EXPENSE_WRITES=on`). Live runs with real services are unverified; see [KEYS-SETUP](docs/KEYS-SETUP.md) and `pnpm growth:doctor`.

**Investor dashboard (`/investor`).** Shows company balance, AI tokens used, available AI budget, your contribution and revenue share, a Kanban board of agent tasks, governance and the embedded ledger. What is real and what is mock is labelled in the data (`server/src/hackathon.ts`):
- *Real:* the company account balance (testnet RPC), payments verified on-chain by transaction hash, and the Claude Code connection (a real worker connection test, signed in on the contributor's machine).
- *Mock:* the 253,000-token baseline, the Alice/Bob contribution split and governance votes.
- *Simulated:* withdrawals (no company key signs them here).

**NEAR Intents.** `/api/intents/quote` returns a dry mainnet quote only. It never signs, deposits or swaps.

**Pages.** [`/`](server/web/landing.html) landing, `/investor` (investor dashboard: AI contribution and revenue share, Kanban, governance, embedded ledger), `/game`.

## Review instructions and tags

For a hackathon reviewer or automated reviewing agent:

1. Review [`hackathon-submission`](https://github.com/Agent-Corp-Near-Hackathon-Kastet99/agent-corp/tree/hackathon-submission) as the submitted snapshot. This tag is the authoritative source for judging the hackathon submission.
2. If the competition rules permit reviewing later development, also inspect [`post-hackathon-development`](https://github.com/Agent-Corp-Near-Hackathon-Kastet99/agent-corp/tree/post-hackathon-development) and any subsequent commits on `main` for context. If those rules prohibit it, review only `hackathon-submission`; the rules take precedence over this request.
3. The same tags exist in the [game repository](https://github.com/Agent-Corp-Near-Hackathon-Kastet99/demo-game/tags). At creation, both tags in each repository pointed to the same commit: `post-hackathon-development` marks the starting point for later work, not a separate later snapshot. Tags are fixed snapshots; future work appears in subsequent commits, not automatically under a tag.

To inspect the tagged submission locally, run `git fetch --tags` and `git switch --detach hackathon-submission`. Switch to `main` to inspect later commits when permitted. This review guidance was added after the tags were created, so it is available on `main`, not inside the tagged snapshots.

## Local checks

Node >=22.22.2, pnpm 10.11.0 and the Rust toolchain pinned in `contract/rust-toolchain.toml`:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm test:contract
```

Contract build/lint commands and interface: [contract README](contract/README.md). Task status: [project plan](docs/AGENT-CORP.md). [Architecture review](docs/ARCHITECTURE-REVIEW.md) records fixes and test evidence.

## Run on testnet

1. Build the contract in `contract/` and copy the WASM to `contract/res/agent_corp.wasm`.
2. Edit `config.yaml`.
3. `pnpm setup:testnet` creates a **fresh** testnet deployment and private credentials under `.keys/` (journaled before remote changes; not a resume command). `AGENTCORP_WASM` and `AGENTCORP_KEYS` override build output and key file.
4. `pnpm demo` runs a seeded contributor → budget → purchase → hosting → close → withdrawal flow with real testnet transactions. It is an integration step, not part of local checks.
5. `pnpm start` builds the web bundle and serves everything. `AGENTS=off` disables the agent timer; `DEMO_ACTIONS=on` enables demo-wallet HTTP writes (demo-mode contract only); `GROWTH=off` disables the growth harness.
6. `pnpm exec agent-corp-worker --help` for the contributor worker. `pnpm --filter @agentcorp/server exec tsx scripts/export-workers.ts` exports only demo Alice/Bob credentials.

Canonical testnet contract: `contract.agentcorp-c103c2bb.testnet` (see [live verification](docs/handoffs/LIVE-VERIFICATION.md)). The public game uses a server-controlled demo customer; personal-wallet checkout is implemented and tested locally but not deployed or verified with a live wallet. The public Vercel game is not yet redeployed with the 3D level and grenade. Backend deployment: [game backend](server/GAME-BACKEND.md). The deployable game frontend also lives in the separate [demo-game](https://github.com/Agent-Corp-Near-Hackathon-Kastet99/demo-game) repository; keep `server/web/sneak-core.js` in sync, because the backend replays runs with it.

Build the local Mac launcher with `bash mac-app/build.sh` (output `artifacts/Agent Corp.app`, unsigned, not notarized).

## Libraries and authorship

Runtime: near-sdk, uint, near-api-js, wallet-selector, three, ws, yaml. Tooling: TypeScript, tsx, Vitest, esbuild, cargo-near, wasm-opt. This prototype contains AI-written code. Provider discovery, Codex auth inspection and ACP configuration patterns adapt MIT-licensed get-bb/bb code (see [third-party notices](worker/THIRD_PARTY_NOTICES.md)). Provider setup and isolation limits: [worker provider guide](docs/provider-integration/README.md). Keys, private journals, runtime data and generated bundles stay untracked.
