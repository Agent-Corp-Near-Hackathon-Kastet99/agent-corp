# Domain commerce and NEAR stack

## Which domain registrars/supporting APIs can programmatically check/register domains? Is Vercel Domains suitable?

### Takeaway

Yes. Vercel Domains is suitable for RAM HEIST because it can search, price, purchase, attach, verify, renew, and manage DNS through APIs or CLI. Use it for a live demo only after a human confirms exact name, price, registrant data, and renewal policy; use the assigned `*.vercel.app` URL before that.

### Cited Findings

- Vercel's Domains Registrar API supports TLD/pricing lookup, single and bulk availability checks, purchase, order lookup, renewal, auto-renew control, nameserver changes, and transfer tracking. [Programmatic Domain Management](https://vercel.com/docs/domains/registrar-api)
- Vercel says domain search/availability/pricing can run without authentication, but buying/managing domains still requires authentication. [Search domains without authentication](https://vercel.com/changelog/search-domains-without-authentication)
- `vercel domains` includes `buy`, `add`, `inspect`, `transfer-in`, and remove; `vercel dns` manages DNS records. [Domains CLI](https://vercel.com/docs/cli/domains), [DNS CLI](https://vercel.com/docs/cli/dns)
- A Vercel deployment receives a `vercel.app` URL, so a custom domain is not a prerequisite for sharing the demo. [Working with domains](https://vercel.com/docs/domains/working-with-domains)
- Vercel states that domain registration can require registrant information for WHOIS purposes. [Vercel privacy notice](https://assets.vercel.com/image/upload/v1713812574/front/legal/privacy-policy/Privacy_Notice_v2024.pdf)

### Inferences

- Start with `ram-heist.vercel.app` (or project URL) for rehearsal. Use unauthenticated search to make shortlist. Submit one chosen domain, its first-year price, renewal price, and registrant consequences for human approval; only then invoke purchase.
- The existing Vercel connector exposes domain search/pricing, purchase, project-domain, DNS-record, and deployment actions in this session. Search and inspection can be automated; purchase, nameserver changes, and DNS deletion should require explicit approval.
- Vercel is lower-friction than combining a separate registrar and host for this demo. A separate registrar remains viable if name/TLD/price is better, but introduces DNS handoff and another credential/billing surface.

### Gaps

- No domain candidate, desired TLD, Vercel team, or billing/registrant identity has been supplied. Exact availability and price cannot be known until search.
- A domain purchase is an external spend and registration act; this research does not authorize it.

## What is minimal testnet/mainnet payment and deployment workflow?

### Takeaway

For demo, deploy static game plus small entitlement API, then use NEAR Wallet Selector to make player approve one `buy_pass` function-call transaction on testnet. Server verifies finalized transaction/contract pass state, then unlocks House 01. Keep NEAR Intents/USDC out of first playable path; it is optional production expansion, not needed to prove NEAR monetization.

### Cited Findings

- NEAR Wallet Selector exposes `signAndSendTransactions`; browser wallets may redirect for signing and return on callback, and transactions use function-call actions. [Wallet Selector API](https://github.com/near/wallet-selector/blob/main/packages/core/docs/api/wallet.md)
- `near-api-js` supports account management, transaction building, keys, contract interaction, and RPC calls from TypeScript/JavaScript. [near-api-js README](https://github.com/near/near-api-js)
- NEAR's developer guide lists Wallet Selector for wallet integration and `near-api-js` for frontend/backend protocol interaction. [NEAR Developer Guide](https://near.github.io/DX/)
- Vercel REST API can deploy web applications and manage domains, deployments, and environment variables. [Vercel REST API](https://vercel.com/docs/rest-api)
- NEAR Intents Treasury documentation describes cross-chain asset management and payment requests, including stablecoins, but is treasury-focused rather than a verified consumer-game checkout guide. [NEAR Intents Treasury Docs](https://docs.neartreasury.com/payments/intents)
- MyNearWallet terms state that a confirmed transaction cannot be reversed or cancelled. [MyNearWallet terms](https://www.mynearwallet.com/documents/terms-and-conditions.pdf)

### Inferences

- Minimum demo contract: `buy_pass()` accepts 1 tNEAR, stores wallet entitlement and payment receipt; `get_pass(account)` is read by game server. This proves a real NEAR product sale without tokens, NFTs, or cross-chain routing.
- Minimum client path: connect wallet → explain price and `TESTNET / DEMO` → wallet-confirmed `buy_pass` → wait for final state → unlock levels. Use a server-side idempotency key/pass record so refresh/callback repeats do not unlock twice.
- Minimum deployment path: deploy preview first, test wallet callback and contract state, then create production deployment. Custom domain is optional and can be attached after verification.
- Mainnet later: retain the same entitlement call, replace testnet IDs/configuration, use real price/refund rules, and obtain legal/consumer-payment review. Treat checkout confirmation as irreversible after wallet approval.
- Add USDC/NEAR Intents only after direct NEAR pass purchase works. It adds quote/deposit/status/refund handling and cross-chain support; it does not improve the demo's core proof.

### Gaps

- Official NEAR search results did not yield a current, end-to-end consumer checkout implementation for NEAR Intents. Do not promise it in demo until an actual merchant integration is validated.
- Mainnet contract account, price, refund period, wallet modules, and deployment target are not selected.

## Which actions should remain human-approved because they cause external spend or legal commitments?

### Takeaway

Agents can prepare, test, publish preview deployments, inspect state, and draft transactions. Human approval must gate spending, commitments, recipient-changing actions, public production publishing, and any payout/distribution close.

### Cited Findings

- Vercel's registrar surface includes purchase, renew, auto-renew, nameserver updates, and transfers. [Programmatic Domain Management](https://vercel.com/docs/domains/registrar-api)
- Vercel documents direct CLI commands to buy a domain and add/remove domains/DNS records. [Domains CLI](https://vercel.com/docs/cli/domains), [DNS CLI](https://vercel.com/docs/cli/dns)
- Vercel's documentation says changing external-DNS settings requires records to be configured through the external provider, while Vercel-managed DNS can create records from its platform. [Set up custom domain](https://vercel.com/docs/domains/set-up-custom-domain)
- NEAR wallet transaction signing is an explicit wallet action; browser wallets can redirect for approval. [Wallet Selector API](https://github.com/near/wallet-selector/blob/main/packages/core/docs/api/wallet.md)

### Inferences

- **Automate:** domain search/price comparison; code/build/test; preview deployment; read-only contract/RPC checks; expense draft; period calculation preview; pass purchase test on dedicated testnet account; dashboard/receipt generation.
- **Human approval required:** domain purchase/renewal/transfer; DNS nameserver change or record deletion; connecting billing; production deployment/alias; mainnet contract deploy/upgrade; wallet payment; expense payment; refund; weekly distribution close; contributor withdrawal; any public post/outreach send.
- **Two-step money rule:** agent produces unsigned transaction plus amount, recipient, reason, and expected ledger effect; human wallet signs; server records final tx hash; dashboard reconciles it. This keeps action evidence without giving worker/marketing agents treasury power.
- **Demo safe default:** only pay 1 tNEAR on testnet from a dedicated customer account. Treat the visible model/API expense as a recorded demo cost unless a human signs an actual testnet transfer.

### Gaps

- Team's approval thresholds, signer/multisig arrangement, and who owns domain/contact information are undecided.
- Real-money revenue sharing needs jurisdiction-specific legal/tax advice; no source here substitutes for it.
