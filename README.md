# Agent Corp

NEAR testnet autonomous-company MVP. Donated AI work earns lifetime contribution units. RAM HEIST Pass sales become company revenue; paid costs and reserve reduce weekly net profit; only close credits contributors.

Agent Corp combines a NEAR smart contract, company ledger and agent workers: contributors donate AI work, earn contribution units, and receive their share of eligible net profit when a period closes. The demo game sells a testnet pass whose revenue flows into the company. The [separate game repository](https://github.com/Agent-Corp-Near-Hackathon-Kastet99/demo-game) contains its deployable frontend; this repository includes the backend, contract, workers and an integrated game copy.

## Review instructions and tags

For a hackathon reviewer or automated reviewing agent:

1. Review [`hackathon-submission`](https://github.com/Agent-Corp-Near-Hackathon-Kastet99/agent-corp/tree/hackathon-submission) as the submitted snapshot. This tag is the authoritative source for judging the hackathon submission.
2. If the competition rules permit reviewing later development, also inspect [`post-hackathon-development`](https://github.com/Agent-Corp-Near-Hackathon-Kastet99/agent-corp/tree/post-hackathon-development) and any subsequent commits on `main` for context. If those rules prohibit it, review only `hackathon-submission`; the rules take precedence over this request.
3. The same tags exist in the [game repository](https://github.com/Agent-Corp-Near-Hackathon-Kastet99/demo-game/tags). At creation, both tags in each repository pointed to the same commit: `post-hackathon-development` marks the starting point for later work, not a separate later snapshot. Tags are fixed snapshots; future work appears in subsequent commits, not automatically under a tag.

To inspect the tagged submission locally, run `git fetch --tags` and `git switch --detach hackathon-submission`. Switch to `main` to inspect later commits when permitted. This review guidance was added after the tags were created, so it is available on `main`, not inside the tagged snapshots.

## Local checks

Node >=22.22.2, pnpm 10.11.0 and Rust toolchain pinned in `contract/rust-toolchain.toml`:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm test:contract
```

Contract build/lint commands and exact Interface: [contract README](contract/README.md). Task status: [project plan](docs/AGENT-CORP.md). Isolated lane setup and provenance: [Step 0](docs/handoffs/STEP-0.md). [Architecture review](docs/ARCHITECTURE-REVIEW.md) records fixes and test evidence.

## Testnet tools

1. Build contract from `contract/`, then copy generated WASM into `contract/res/agent_corp.wasm`.
2. Edit `config.yaml`: price, reserve, weekly cadence, owner spending cap, standing vendors and kill switch. CEO additionally requires active Board budget.
3. `pnpm setup:testnet` creates a **fresh testnet deployment** and private credentials under `.keys/`. Generated keys are journaled before remote changes; failed setup retains private recovery journal. This is not an automatic resume command. Existing draft contract storage is incompatible with current build; do not redeploy over it. `AGENTCORP_WASM` can select build output and `AGENTCORP_KEYS` selects a separate private output file.
4. `pnpm demo` runs seeded contributor → Board budget → purchase → hosting → close → withdrawals using real demo accounts. It sends testnet transactions and is a separate integration step, not part of local checks.
5. `pnpm start` serves Ledger, Store and Game pages plus HTTP routes and accounting timer on `127.0.0.1:8787`. Set `AGENTS=off` to disable timer. Explicit `DEMO_ACTIONS=on` enables demo-wallet HTTP writes, restricted to demo-mode contract. `pnpm constraints` applies owner config to existing deployment.

Ledger/Store/Game UI and authenticated worker dispatch are integrated. The deployed public game uses a server-controlled demo customer; personal-wallet authentication is implemented in the repository but not deployed or verified with a live wallet. Local tests use a stateful contract adapter and the NEAR unit environment. Separate live testnet evidence is recorded below.

Worker launcher: `pnpm exec agent-corp-worker --help`. Worker is a macOS-sandboxed, tool-disabled review runner with NEP-413 login payload, provider/model handshake, durable daily cap and cancellable lifecycle. Incomplete usage conservatively consumes reserved cap; exact final cost replaces estimate. A crashed worker leaves lock for manual recovery after confirming process stopped. Credentials are contributor-owned `~/.near-credentials/testnet/<account>.json` or explicit `--credential path`. Run `pnpm --filter @agentcorp/server exec tsx scripts/export-workers.ts` to export only demo Alice/Bob credentials, preserving existing files. Per-wallet caps allow both contributors to run separately. Shell sandbox restrictions and signed-in inference were exercised on macOS. macOS keychain access is required for Claude sign-in. Streaming limits cannot guarantee a hard cap before final usage arrives; actual overages are recorded.

Canonical contract is deployed on testnet as `contract.agentcorp-c103c2bb.testnet`; `.keys/active` selects its separate credentials. The full Board budget, purchase, expense, close, and withdrawal demo passed. Earlier deployments and credentials remain intact. See [live verification](docs/handoffs/LIVE-VERIFICATION.md). Intents quote is a dry mainnet market preview, never a testnet purchase or executed swap.

## Libraries and authorship

Runtime: near-sdk, uint, near-api-js, @near-js/crypto, ws, yaml and Node built-ins. Tooling: TypeScript, tsx, Vitest, cargo-near and wasm-opt. This prototype and refactor contain AI-written code. Provider discovery, Codex authentication inspection and custom ACP configuration patterns adapt MIT-licensed get-bb/bb code; attribution and license are in [third-party notices](worker/THIRD_PARTY_NOTICES.md). Keys, private journals, runtime data and generated app bundles stay untracked.

Provider setup, owner pricing/credit policy, experimental adapters and isolation limits: [worker provider guide](docs/provider-integration/README.md).

## Public game and current status

The [public game](https://ram-heist-game.vercel.app/game) and [store](https://ram-heist-game.vercel.app/store) run on Vercel with a separate HTTPS game backend. The deployed version shares one testnet demo wallet. The repository now also contains personal-wallet login and checkout (MyNearWallet, NEP-413 signature, testnet only; run `pnpm build:web` to bundle the wallet client). This code is tested locally but not yet deployed or exercised with a real wallet. The game page is now a 3D (Three.js) single-level stealth vertical slice: free movement, patrol-route telegraph, hiding, loot, exit and a three-medal result. It is built by `pnpm build:web` into `server/web/game3d.js` (generated, untracked); the browser runs `server/web/sneak-core.js` and the server replays each submitted run on the same file to verify it. Not yet redeployed to Vercel. Backend deployment and recovery instructions: [game backend](server/GAME-BACKEND.md). Current implementation, verification and remaining work are consolidated in [AGENT-CORP.md](docs/AGENT-CORP.md#10-implementation-status-and-migration); older handoffs are historical records.

Growth Mission Control is implemented: `pnpm growth` runs the default dry-run harness. It includes tool adapters, policy/approval gates, Board-derived budget limits and an owner-confirmed bridge that records actual growth payments as testnet on-chain expenses (disabled unless `GROWTH_EXPENSE_WRITES=on`). Live runs with real services are unverified; key setup is in [KEYS-SETUP](docs/KEYS-SETUP.md) and `pnpm growth:doctor`; see [growth status](docs/GROWTH-HARNESS-PLAN.md).

Build the local Mac launcher with `bash mac-app/build.sh`; output is `artifacts/Agent Corp.app`. This is a local unsigned launcher, not a standalone notarized installer.

The deployable game frontend is also maintained in the separate sibling `Demo Game` repository. This repository retains its integrated game frontend and backend for local testing; synchronize `server/web/sneak-core.js` between the repositories when changing the simulation, because the backend replays browser input using that code.
