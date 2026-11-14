# Marketing and outreach operations

## How can Postiz be used for publishing and scheduling through API or MCP?

### Takeaway

Postiz is viable action layer for launch marketing: its official product pages say it offers a public REST API, hosted MCP server, CLI, media upload, scheduling/publishing, webhooks, and analytics. Use it for approved assets and posts; treat content generation as separate from the authority to publish.

### Cited Findings

- Postiz says every plan includes a REST API for creating posts, uploading media, and managing channels; it also has webhooks for post events. [Source](https://postiz.com/)
- Postiz says its hosted MCP server uses OAuth and lets external agents draft, schedule, and publish; it also offers a CLI and installable skill. [Source](https://postiz.com/)
- Its official OAuth/API guide lists connected-channel discovery, post creation, post listing/deletion, analytics, and media upload endpoints. [Source](https://postiz.com/blog/direct-postiz-integration-oauth-api)
- Postiz supports per-channel previews and channel-specific copy/media adjustments before scheduling. [Source](https://postiz.com/)
- Postiz describes AI video clipping from longer videos and says its MCP tools include channel discovery, schema lookup, post scheduling, image generation, and video generation. [Source](https://postiz.com/blog/ai-builders-postiz-98k-month-millions-views)

### Inferences

- Recommended demo path: capture RAM HEIST gameplay locally, make one short launch clip, upload it to Postiz, create platform-specific drafts for X and LinkedIn, then have a human approve and publish. Store the resulting post URL/id plus Postiz webhook event in the company activity feed.
- MCP is quickest for an agent-operated demo; REST API is better when the game/admin server needs an auditable publish queue. Either path should default to `draft`, with an explicit human promotion to scheduled/published.
- Use only account connections the team owns and platform-supported settings returned by Postiz's integration schema. Do not rely on unofficial cookie-based posting routes.

### Gaps

- Channel availability, limits, price, and media specifications vary by connected social network and plan; verify after connecting target accounts.
- Current workspace installation/authorization for Postiz MCP was not verified here.

## What is Boardy and how could it support outreach? Is an API or MCP available?

### Takeaway

Boardy is a warm-introduction service, not a bulk-outreach tool. Official guidance routes agents through one reviewed email to `boardy@boardy.ai`; it requires user context and LinkedIn, uses double opt-in, and caps introduction starts. I found no official public Boardy API or MCP documentation.

### Cited Findings

- Boardy describes itself as an AI superconnector that seeks a fit in its network and makes introductions only when both people agree. [Source](https://www.boardy.ai/faq)
- Boardy says onboarding happens through text, WhatsApp, or email and requests name, email, phone, and LinkedIn. [Source](https://www.boardy.ai/faq)
- Boardy says introductions are not guaranteed, are double opt-in, and are rate-limited, including for potential customers. [Source](https://www.boardy.ai/faq)
- Boardy's official agent instructions require a complete email to `boardy@boardy.ai`, user review of the exact message and profile links, then sending only after approval. [Source](https://www.boardy.ai/agents)
- Boardy says it uses public LinkedIn/profile context and shares email/phone only after both sides agree. [Source](https://www.boardy.ai/faq)

### Inferences

- Use Boardy once for a high-fit ask: an indie-game creator, NEAR ecosystem partner, or Web3-game community organizer who can review/introduce RAM HEIST. Do not use it to solicit players at scale.
- The agent can assemble a brief from verified project facts, but must show the exact email and wait for user approval before sending. Log only the approved ask and Boardy's reply/status; do not treat a requested intro as a lead or a guaranteed outcome.

### Gaps

- No official public API/MCP reference was found. The documented agent integration is reviewed email, so any claim of direct Boardy API automation needs confirmation from Boardy.
- User identity, verified LinkedIn, and specific outreach goal are still needed before a Boardy brief can be sent.

## What minimal safe launch workflow should demo use, including approval boundaries?

### Takeaway

Use small, evidence-backed actions: one gameplay clip, two owned social accounts, and one double-opt-in warm-intro request. Agents may prepare artifacts and drafts; a human approves external publishing, outreach, spending, and financial actions.

### Cited Findings

- Postiz supports cross-posting with per-channel previews and editing before a scheduled publish. [Source](https://postiz.com/)
- Postiz exposes webhooks and analytics, enabling a dashboard to record that a post was published and later measure its performance. [Source](https://postiz.com/)
- Boardy's official instructions require review of the full email, sender, recipient, subject, and confirmed profile links before sending. [Source](https://www.boardy.ai/agents)
- Boardy introductions are consent-based and limited rather than guaranteed outreach volume. [Source](https://www.boardy.ai/faq)

### Inferences

- **Agent authority:** capture/edit metadata, draft copy, create Postiz drafts, read publish status/webhooks, prepare a Boardy brief, and keep an activity ledger.
- **Human approval required:** connect social accounts, publish/schedule any post, send Boardy email, buy domain, spend treasury funds, record/approve an expense, close distribution, and withdraw funds.
- **Demo sequence:** agent records a House 01 run → produces 20–30 second captioned clip → prepares X/LinkedIn drafts in Postiz → human publishes one post → dashboard records post URL → human approves one Boardy request for a NEAR-game/community introduction → dashboard records result as `requested`, `introduced`, or `declined`.
- Label all demo actions honestly: `DRAFT`, `APPROVED`, `PUBLISHED`, `REQUESTED`, `INTRODUCED`, or `DECLINED`; never fabricate audience, outreach, or revenue results.

### Gaps

- The exact target platforms, owner accounts, and approval person are unspecified.
- Domain purchase, email, CRM, and game hosting need separate provider selection and credential setup before those actions can be automated.
