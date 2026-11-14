# Completed Step 0, Agent A and architecture review

> Historical handoff: deployment, test counts and remaining work below describe that stage. Current status: [project status](../AGENT-CORP.md#10-implementation-status-and-migration), [canonical live verification](LIVE-VERIFICATION.md) and [provider support](../provider-integration/README.md). The canonical contract is now deployed and two real Claude sessions have been credited on-chain.

Integration branch: `task/step0-integration`; worktree `/Users/kastet/Agent-Corp-worktrees/integration`.

| Evidence | Result |
|---|---|
| Step 0 | Original status/binary patches preserved; isolated A/B/integration branches and worktrees; canonical Interface agreement explicitly confirmed by Agent B; coordinator owns integration. |
| Agent A | All checklist items complete; initial lane commit `87436e9`; final canonical contract adds Board cap, separate refund recovery, pending-transfer close guard, initial pause and retry-safe reports. |
| Architecture | All seven initial candidates, four second-pass defects, four findings in new Agent B Modules and three completion-audit defects fixed. Full detail in ARCHITECTURE-REVIEW.md. |
| `pnpm test` | 56 passed: shared 3, server 36, worker 17; includes real signing/socket, HTTP, game persistence, retry, cap and child lifecycle tests. |
| `pnpm typecheck` | Shared, server (including scripts/tests) and worker pass. |
| `cargo test --lib` | 56 passed with pinned Rust 1.95.0. |
| `cargo fmt --check` / strict Clippy | Pass; only uint macro-generated lint has narrow local allowance. |
| `cargo near build non-reproducible-wasm --locked` | Pass; reviewed WASM and ABI copied to contract/res/. |
| Executable smoke | Loopback server boots without keys; ledger/store/game pages and shared browser module return 200; worker launcher help works. |
| Sandbox | macOS filesystem restriction shell test passes; signed-in Claude inference not exercised. |

Final WASM: 309720 bytes, SHA-256 `8300c3f13cb23312dc244c276a2c54b67f46b327817d99cb5c21d5222075698f`. Exact method/JSON schema: `contract/res/agent_corp_abi.json`; human Interface/events: `contract/README.md`.

Commits: inherited snapshot `fefa5f9`; Step 0 agreement `2ce01a1`; Agent A integrated `a6792a2` (lane `87436e9`); completed handoff `618218c`; preserved original staged deletions `0400b1c`; architecture implementation `446ebae`; stable concurrent Agent B snapshot `24c74df`; reconciled merge `4aa701e`.

Coordinator sync copies only final differences from stable Agent B snapshot into original checkout, checking original bytes against that snapshot first. Original staged index is preserved. All `.keys/` and `.data/` files, including active deployment pointer, remain excluded and unchanged. Original source is additionally preserved in lane commits and saved patches. No reset, clean, forced checkout or deployment of original checkout was used.

> Historical record. Superseded: canonical contract `contract.agentcorp-c103c2bb.testnet` is deployed (see LIVE-VERIFICATION.md) and the public game backend is live. The paragraph below describes the state at hand-off time.

Canonical build was **not deployed** at hand-off. Agent B's live demo used interim `contract.agentcorp-862d34c2.testnet`, which predates Board-budget enforcement; its reported receipt is recorded in AGENT-B.md. Fresh canonical deployment, live network reconciliation, external-wallet game authentication and signed-in coding sandbox verification remain separate integration work. No production-readiness claim.

Completion re-audit: all Step 0 / Agent A acceptance tasks remain complete; corrected stale completed integration/README checklist items. Fixed timer reload exception containment, fair/nonzero credit retry batches and exact-report persistence recovery; added bootstrap and real-socket regressions. Current verification totals 112 tests (56 Rust unchanged, 56 TypeScript), workspace typecheck clean. Contract source and reviewed WASM are unchanged by this re-audit.
