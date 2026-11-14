# Domain language

| Term | Meaning |
|---|---|
| Contributor | Wallet donating metered AI work; earns lifetime contribution units. |
| Contribution units | Integer micro-USD of list-price inference; voting and distribution weight, never job wages. |
| Board | All contributors with nonzero units; votes weighted by units. |
| CEO | Agent proposing budgets and approving operating costs within owner and Board limits. |
| Accounting oracle | Agent recording units, paying approved expenses and closing periods. |
| Owner constraints | Human-set price, reserve policy, cadence, expense cap and kill switch. |
| RAM HEIST Pass | Product entitlement bought by player; exact price is company revenue. |
| Period | Weekly ledger of revenue, paid operating costs and immutable close receipt. |
| Expense reserve | Operating funds held for future costs; separate from distributions. |
| Distribution reserve | Closed-period claimable plus rounding/zero-unit carry. |
| Claimable | Contributor's allocation from completed closes, restored if withdrawal fails. |
| Refund liability | Failed return of purchase excess; independent from claimable. Pass sales themselves are final. |
| Operating cost | CEO-approved expense actually paid by oracle; pending transfers must settle before close. |
| Budget | Board-approved aggregate expense limit, bounded by owner constraints. |
| Worker session | Contributor-owned model process with pinned model, authentication and daily cap. Current macOS runner is a tool-disabled reviewer with per-wallet caps and filesystem sandbox. Signed-in Claude inference was exercised and credited on-chain; Codex is integrated. Coding-tool execution and complete filesystem/network isolation remain unfinished. |
| Usage meter | Provisional inference estimate replaced by authoritative final cost when reported. |

Source of truth: `docs/AGENT-CORP.md`; contract Interface: `contract/README.md`; accounting decision: `docs/adr/0001-period-accounting.md`.
