# Step 0: isolation and interface agreement

> Historical handoff: deployment, test counts and remaining work below describe that stage. Current status: [project status](../AGENT-CORP.md#10-implementation-status-and-migration), [canonical live verification](LIVE-VERIFICATION.md) and [provider support](../provider-integration/README.md). The canonical contract is now deployed and two real Claude sessions have been credited on-chain.

Original checkout: `/Users/kastet/Agent Corp`; original base: `06ae563f80f11dc9a4d9f6c951c2de9628174174`.
Inherited source snapshot: `fefa5f92f11dec8f34746324d4efbbc88c1e43ea`.

Existing staged/unstaged changes and untracked source were preserved in the original checkout. Exact original status and binary patches are in `/Users/kastet/Agent-Corp-worktrees/`; keys and local runtime data were excluded. Snapshot commit records inherited work, not work authored in this task. Prior audit thread supplied contract/accounting and partial application; prior Agent B thread supplied task-status annotations. Finer authorship cannot be proven from uncommitted files.

| Lane | Branch | Worktree | Ownership |
|---|---|---|---|
| Agent A | task/step0-agent-a | /Users/kastet/Agent-Corp-worktrees/agent-a | contract/ |
| Agent B | task/step0-agent-b | /Users/kastet/Agent-Corp-worktrees/agent-b | server/, worker/, shared/, landing/ |
| Coordinator / integration owner | task/step0-integration | /Users/kastet/Agent-Corp-worktrees/integration | docs, shared files, cherry-picks, integration, architecture follow-up |

Both lanes start from the same inherited snapshot. Current agent performs lane work sequentially; no second implementation agent is active. This coordinator owns both sides of the interface agreement and integration. Application implementation remains separate future work except fixes found in the requested architecture review. No deployment in this task. The inherited snapshot initially retained staged-deleted legacy files; integration commit `0400b1c` corrects that snapshot error without touching original staged work.

## Canonical contract agreement

`contract/src/lib.rs` and `contract/README.md` are canonical. Amounts/units are decimal strings (`U128`); nanosecond times and durations are decimal strings (`U64`); IDs are JSON numbers. Expense status is `Approved`, `Paying`, or `Paid`; period status is `Open` or `Closed`; proposal status is tagged `{type: Open|Passed|NoChange, option?: number}`. Failed changes panic and roll back atomically. Views return `null` for unknown singular records. Pages accept `from_index` and `limit`, capped at 100.

CEO approves; oracle records units, pays expenses, and closes; owner sets constraints and pause. Board finalization sets a machine-readable aggregate spending limit. Budget proposal options are JSON strings containing `max_expense_per_period` as a decimal string. No active Board budget means no expense approval; effective limit is minimum of owner cap and active Board budget. Existing human-readable budget options need replacement on a fresh deployment. Per-category budgets stay future scope.

Purchase activates entitlement and records only exact price as revenue; excess returns to payer. Failed excess returns remain a separate refund liability, never contributor distribution. Distribution closes only after outstanding expense transfers settle. A close snapshots units, publishes immutable receipt, opens next weekly period, and rejects duplicate closes. Early close only for init-time demo mode. Failed contributor withdrawal restores distribution liability.

Events use `EVENT_JSON` with standard `agentcorp`, version `2.0.0`, event name and single-item data array. All owner mutations, votes, purchases, approvals, payment results, closes, withdrawals and refund results publish events. See contract README for exact public methods and callback arguments.

## Application agreement

Section 6 of AGENT-CORP.md defines intended application views, distinct from raw snake_case contract JSON. Application must map explicitly: `null` pass to locked, existing pass to active; reserve fields remain separate; claimable derives only from closed periods. No job settlement or direct worker payment. Existing unfinished application is not evidence of completed Agent B tasks. Until integration, Agent B uses frozen contract fixtures conforming to these types, or the canonical local contract test harness; never deployed credentials.

Final coordinator correction: `new` also accepts optional `initially_paused`; setup supplies config.kill_switch, so no transient unpaused deployment is required. Exact final ABI in contract/res/agent_corp_abi.json.

## Concurrent lane handoff reconciled

Agent B thread `thr_f8mgqqu8dx` was discovered writing original checkout after initial isolation. It explicitly agreed canonical contract Interface, then stopped writes for stable handoff. Its complete tracked/staged/unstaged/untracked source was preserved as commit `24c74df` on `task/step0-agent-b`; credentials/runtime data excluded. Coordinator merged that commit into integration worktree, resolving conflicts around both implementations rather than replacing its UI/game/worker features. Its required `record_contribution_once` and `has_contribution_reference` methods are retained, with conflicting-payload protection. Canonical RPC uses FINAL transaction completion and final views, as Agent B's live check exposed stale optimistic reads.

Agent B created an interim testnet deployment, `contract.agentcorp-862d34c2.testnet`, before this canonical contract. It lacks Board-budget enforcement and must not be represented as deployed canonical code. Its `.keys/active`, `.keys/testnet-v3.json` and original `.keys/testnet.json` remain untouched by coordinator. Canonical code requires fresh deployment in a separate integration task. Final evidence in FINAL.md.
