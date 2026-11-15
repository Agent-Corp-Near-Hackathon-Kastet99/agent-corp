# Hackathon demo runbook

Pages (all served by `pnpm start` in `server/`): `/` landing + Invest popup, `/investor` dashboard + Kanban + governance, `/game` game with **Unlock Premium — 1 NEAR**, `/ledger` the previous ledger page.

## Real vs mock
| Item | Source |
|---|---|
| Company Balance | NEAR testnet RPC for `HACKATHON_COMPANY_ACCOUNT` (default: contract account). "rpc unavailable" if unreachable |
| Premium payment, tx hash, explorer link | Wallet-signed 1 NEAR transfer; recorded only after the server verifies the transaction on testnet |
| 253,000 token baseline, Investor A/B 40/60, governance votes | Mock, labelled |
| Claude Code connection, 5,000 token grant, withdrawal | Simulated, labelled. Withdrawal makes no transaction |
| Kanban "Done" cards | Only work with a deliverable in the repo (path shown). Their token fields read "Not metered" |

My Contribution = tokens used by the completed launch-post job. Revenue share = contribution ÷ (253,000 + contribution). Available to Withdraw = verified payments × share − simulated withdrawals.

## Launch post (X)
The job never invents a post. Publish the real launch post first, then start the server with:
`HACKATHON_X_POST_URL` (https://x.com/<user>/status/<id>), `HACKATHON_X_POST_TEXT`, `HACKATHON_X_POSTED_AT` (ISO time), optional `HACKATHON_X_POST_TOKENS` (provider-reported usage; otherwise an estimate is shown and labelled).
Without them the job stops at "Publishing to X" with the reason shown and no link; **Retry marketing job** re-runs it. A restart during publishing stops the job instead of re-posting.

## Run
1. `DEMO_ACTIONS=on` server with testnet keys (`pnpm setup:testnet`), env above. Play Game uses the shared demo pass (`/api/demo/session`).
2. Landing → Invest on Testnet → Connect NEAR Wallet → Investor Dashboard → Connect Claude Code → watch the card move To Do → In Progress → Done.
3. Game → Unlock Premium → pay → hash + explorer link → dashboard revenue updates → Withdraw (simulated).
4. **Reset demo** on the dashboard clears the simulated state; verified payments stay (`POST /api/hackathon/reset {"payments":true}` clears them too).

Use one server for the game and dashboard: state lives in `.data/hackathon.json` per server. The macOS download is `artifacts/Agent-Corp-macOS-arm64.zip` (unsigned; button is disabled if absent): `ditto -c -k --keepParent "artifacts/Agent Corp.app" artifacts/Agent-Corp-macOS-arm64.zip`.
