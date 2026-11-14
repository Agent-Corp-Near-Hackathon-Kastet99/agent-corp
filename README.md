# Agent Corp

NEAR testnet autonomous-company MVP. Donated AI work earns lifetime contribution units. RAM HEIST Pass sales become company revenue; paid costs and reserve reduce weekly net profit; only close credits contributors.

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

The [public game](https://ram-heist-game.vercel.app/game) and [store](https://ram-heist-game.vercel.app/store) run on Vercel with a separate HTTPS game backend. The deployed version shares one testnet demo wallet. The repository now also contains personal-wallet login and checkout (MyNearWallet, NEP-413 signature, testnet only; run `pnpm build:web` to bundle the wallet client). This code is tested locally but not yet deployed or exercised with a real wallet. Backend deployment and recovery instructions: [game backend](server/GAME-BACKEND.md). Current implementation, verification and remaining work are consolidated in [AGENT-CORP.md](docs/AGENT-CORP.md#10-implementation-status-and-migration); older handoffs are historical records.

Growth Mission Control is implemented: `pnpm growth` runs the default dry-run harness. It includes tool adapters, policy/approval gates, Board-derived budget limits and an owner-confirmed bridge that records actual growth payments as testnet on-chain expenses (disabled unless `GROWTH_EXPENSE_WRITES=on`). Live runs with real services are unverified; key setup is in [KEYS-SETUP](docs/KEYS-SETUP.md) and `pnpm growth:doctor`; see [growth status](docs/GROWTH-HARNESS-PLAN.md).

Build the local Mac launcher with `bash mac-app/build.sh`; output is `artifacts/Agent Corp.app`. This is a local unsigned launcher, not a standalone notarized installer.
