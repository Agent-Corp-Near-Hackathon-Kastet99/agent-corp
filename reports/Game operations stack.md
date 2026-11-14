# Turn RAM Heist Into Operations

RAM HEIST can demonstrate a real autonomous-company loop without pretending agents can act everywhere unsupervised. Use deterministic browser capture plus a local render for a genuine gameplay clip; use Postiz for an approved social post; use Boardy once for a consent-based warm introduction; and use NEAR testnet for a real 1 tNEAR game-pass entitlement. The current workspace already has Vercel capability for deployment and domains, but no verified Postiz or Boardy connection, and no Playwright or video-rendering dependency. That makes the practical demo sequence: build and deploy preview, record House 01, create marketing drafts, obtain approval to publish, sell a testnet pass, record a cost, then close the seeded weekly ledger. A custom domain, public post, outreach email, wallet transaction, expense payment, and distribution all cross an external boundary, so each needs a human approval gate. This produces auditable activity — transaction hashes, post URLs, receipts, and dashboard events — instead of an agent merely claiming it did work.

## Capture a repeatable House 01 run

**Claude should direct the campaign, not be treated as a video editor.** Its computer-use tools execute through the host application; they do not themselves yield a finished video file ([Computer use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)). Use Claude to write the 20–30 second route and captions: side entrance, TV-watcher's sightline, flowerpot distraction, bathroom-to-fridge patrol, two RAM sticks, back-door exit. Replay that fixed route in a browser with Playwright `recordVideo`; Playwright finalizes its capture after the browser context closes ([Playwright video recording](https://playwright.dev/docs/videos)). Then render one master and one vertical crop with local FFmpeg. Add Remotion only if reusable branded titles and weekly-ledger overlays become necessary; it supports CLI and server-side rendering, but is extra surface for a hackathon ([Remotion rendering](https://www.remotion.dev/docs/render)).

Keep raw recording, caption script, final MP4, and published URL as campaign artifacts. This makes “agent did marketing” visible: it planned a route, captured a real build, generated channel-specific copy, and created a publisher-ready asset. **Do not build around Higgsfield or an unverified AI editor API.** The first rehearsal should prove recording, encoding, dimensions, and upload using one clip.

## Postiz is the publish layer; Boardy is one warm ask

**Postiz is suitable for real publishing.** Its official materials document REST API and MCP/CLI paths for channel discovery, media upload, draft/scheduled posts, webhooks, and analytics ([Postiz](https://postiz.com/), [OAuth/API guide](https://postiz.com/blog/direct-postiz-integration-oauth-api)). Agent flow should be `capture → caption/copy → upload → per-channel DRAFT`. A human reviews the X and LinkedIn previews, then explicitly promotes one draft to scheduled or published. Store Postiz post ID, URL, webhook result, and later analytics in the activity feed. This is a real external action, not generated code.

**Boardy is not bulk outreach and no public Boardy API/MCP was verified.** Its documented agent path is one reviewed email to `boardy@boardy.ai`; introductions are double-opt-in and limited ([Boardy agent instructions](https://www.boardy.ai/agents), [Boardy FAQ](https://www.boardy.ai/faq)). Use it once for a narrow, credible ask: an introduction to a NEAR games community organizer or an indie-game creator. Agent prepares the facts and email, but human reviews exact recipient, profile links, subject, and body before send. Dashboard state must say `REQUESTED`, `INTRODUCED`, or `DECLINED` — never imply an intro or audience result happened when it did not.

## Vercel and NEAR make business actions visible

Start at a Vercel preview URL. A custom domain is not required to share a deployment ([Vercel domains](https://vercel.com/docs/domains/working-with-domains)). Vercel's registrar API and CLI can search availability/pricing, purchase, renew, attach domains, and manage DNS ([Registrar API](https://vercel.com/docs/domains/registrar-api), [Domains CLI](https://vercel.com/docs/cli/domains)). Let an agent shortlist names and prices; require human confirmation of exact domain, first-year and renewal prices, registrant data, and auto-renew before a purchase. Treat nameserver changes, DNS deletion, and production alias changes the same way.

For monetization, keep first playable path small: Wallet Selector sends a wallet-approved `buy_pass()` function-call transaction for **1 tNEAR on testnet**, server reads finalized entitlement, House 01 unlocks. Wallet Selector exposes `signAndSendTransactions`, and NEAR's TypeScript tools support contract/RPC integration ([Wallet Selector API](https://github.com/near/wallet-selector/blob/main/packages/core/docs/api/wallet.md), [NEAR developer guide](https://near.github.io/DX/)). This proves real product revenue. Skip NFTs, token sales, recurring subscriptions, and Intents/USDC until direct pass purchase works. A confirmed wallet transaction is not a reversible draft, so player approval remains mandatory ([MyNearWallet terms](https://www.mynearwallet.com/documents/terms-and-conditions.pdf)).

## Make authority boundaries part of product

| Area | Agent can do | Human must approve |
|---|---|---|
| Game media | Script route, capture test, draft captions, render preview | Final public asset |
| Social | Upload media, create Postiz draft, read webhook/analytics | Connect account; schedule or publish |
| Outreach | Prepare one Boardy brief/email, track response | Send email and disclose profile/contact context |
| Domain/deploy | Search/price domain, create preview, inspect DNS | Purchase/renew/transfer; DNS deletion/nameserver change; production release |
| NEAR/treasury | Build unsigned transaction, verify contract state, calculate period preview | Wallet-sign pass purchase; expense payment/refund; close distribution; withdrawal |

Use a **two-step money rule**: every money-moving request shows amount, asset, recipient, reason, and expected ledger effect; a human wallet signs; server stores final transaction hash; dashboard reconciles it. Marketing gets equivalent proof: draft ID before approval, post URL after publication, webhook/analytics afterward. The agent never gets treasury power or permission to publish/approach people silently.

## Rehearse seven real actions in order

1. Deploy RAM HEIST preview on Vercel and play House 01 with a seeded route.
2. Record game browser run with Playwright; cut it locally; Claude supplies caption timing and X/LinkedIn copy.
3. Create Postiz drafts only; presenter approves and publishes one.
4. Show published post URL/webhook in dashboard.
5. Presenter approves one Boardy warm-intro request; show its honest status.
6. Presenter wallet-signs `buy_pass()` on testnet; server verifies entitlement and unlocks House 01.
7. Record demo operating cost, preview weekly net, human closes seeded period, then contributor withdraws closed-period balance.

## Conclusion

The compelling proof is not “agents wrote code.” It is **agents operating a tiny game business under explicit authority**: shipping a playable preview, making a clip, preparing a post, executing an approved publish, selling a NEAR pass, and accounting for cost before weekly distribution. Keep domain acquisition and Boardy as optional visible approvals, not dependencies that can derail the demo.
