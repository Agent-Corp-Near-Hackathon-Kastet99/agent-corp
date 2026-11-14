# Agent A handoff

> Historical handoff: deployment, test counts and remaining work below describe that stage. Current status: [project status](../AGENT-CORP.md#10-implementation-status-and-migration), [canonical live verification](LIVE-VERIFICATION.md) and [provider support](../provider-integration/README.md). The canonical contract is now deployed and two real Claude sessions have been credited on-chain.

Contract lane commit: `87436e9` on `task/step0-agent-a`; inherited baseline: `fefa5f9`; isolated worktree: `/Users/kastet/Agent-Corp-worktrees/agent-a`.
Integration owner: current coordinator (Agent B responsibility). Contract lane only changed `contract/`. Coordinator cherry-picked lane commit into `task/step0-integration`.

Verification: 53 Rust contract tests pass; `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` pass; `cargo near build non-reproducible-wasm --locked` succeeds. Generated reviewed WASM SHA-256: `9b9758f0dd562947faf1f5665a4ff086a6d6566e65f72898e59cae47d77aa732`, 297017 bytes. Exact machine-readable Interface in `contract/res/agent_corp_abi.json`; human Interface/events/error semantics in `contract/README.md`.

Completed gaps: Board-approved aggregate spending cap enforced alongside owner cap; close waits for expense callbacks; stale expense callbacks ignored; excess-payment failures kept out of contributor claimable; duration overflow rejected; owner role changes emit events. 60/40 demo still yields 0.48 / 0.32 from 0.80 net.

Deployment inputs: new distinct owner/oracle/CEO account IDs; optional constraints `{pass_price:"1000000000000000000000000",expense_reserve_bps:1000,period_secs:"604800",max_expense_per_period:"500000000000000000000000"}`; `demo_mode:true` for testnet seeded early-close demonstration only. Deploy WASM and call `new` once on a **fresh account**. Existing deployed draft cannot deserialize new storage. No deployment or keys modified.

Interface corrections agreed by current coordinator owning both lanes: `Budget` proposal options must encode JSON text `{max_expense_per_period: decimalString}`. `get_budget` adds parsed max_expense_per_period. Treasury adds refund_total and pending_expense_payments. New get_refund/withdraw_refund/private on_refund keep recovery separate. Application raw contract types and demo must adopt these changes during architecture follow-up. Prior free-text budget proposals are incompatible.

Limits: per-category budgets, production payments, worker usage verification and old-state migration remain outside MVP. Near SDK unit environment covers transfer success/failure and invariants; live sandbox/network reconciliation and server/UI integration belong to integration tasks and are not claimed complete.

Final coordinator integration supersedes the initial artifact/test count above: 56 contract tests; Board Interface agreement confirmed by Agent B thread; initially_paused, record_contribution_once and has_contribution_reference included; conflicting report payload rejected. Canonical final artifact digest and integrated verification in FINAL.md. Existing interim testnet deployment is not the canonical build.
