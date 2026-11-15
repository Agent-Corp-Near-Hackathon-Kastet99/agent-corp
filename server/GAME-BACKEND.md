# Game-only backend

Run `pnpm --filter @agentcorp/server exec tsx src/game-server.ts` on a persistent host. This entry point does not load `.keys` or start company agents. Configure it through a secret manager or a root-readable environment file:

- `GAME_CONTRACT_ID`: testnet contract account.
- `GAME_CUSTOMER_ID` and `GAME_CUSTOMER_KEY`: a dedicated, minimally funded testnet customer wallet. Do not copy company or owner credentials to the game host.
- `GAME_MAX_PRICE_YOCTO`: maximum permitted pass price in yoctoNEAR.
- `GAME_PURCHASE_MARKER`: absolute path on persistent storage, writable only by the service account.
- `AGENTCORP_STATE`: absolute path on persistent storage for scores.
- `GAME_ORIGIN`: exact HTTPS origin the browser uses (prod: `https://f-stack.ai`, not the vercel.app alias), without a path. Wallet login rejects any other Origin; `EXTRA_ORIGINS` (comma list) only widens non-login routes.
- `HOST` and `PORT`: listener; defaults to loopback and port 8787. Use a TLS reverse proxy with a narrowly scoped route allowlist.

The 3D game (`/game`) is played entirely in the browser; the backend serves the level (demo or pass session) (`GET /api/game/levels/founder-house`) and verifies a finished run (`POST /api/game/run`) by replaying the submitted input log on the shared simulation, so time and result come from the server. The older tile endpoints (`/api/game/step`, `/api/game/levels/house-01`) are still served for the legacy engine and tests.

The server allows game, checkout and required read-only endpoints only. Checkout permits one attempted purchase for the shared demo wallet. It creates the purchase marker before submitting a transaction, so even an uncertain RPC result cannot cause an automatic second payment. A failed or uncertain attempt requires an operator to inspect the chain before removing the marker. Existing passes prevent a new purchase. The deployed backend uses a shared demo wallet and shared score. Personal-wallet routes (`/api/player/*`) exist in the repository but are not part of the current deployment; there is no production payment support. The customer key is full access because buying a pass attaches a deposit; keep its balance low. Persistent storage is required for the purchase marker and scores. Sessions remain in memory and end on restart.

## Current deployment

Game: `https://ram-heist-game.vercel.app`. The game-only service runs on the Hetzner server `ram-heist-backend` (178.105.9.179), behind Caddy at `https://178-105-9-179.sslip.io`. The Vercel project is `ram-heist-game` in `kastet99s-projects`. The backend's state and one-purchase marker live under `/var/lib/ram-heist`; the service environment is `/etc/ram-heist.env`. These paths must be backed up securely; the environment contains the customer wallet key. The server's disk is persistent across reboots but is not a backup.

To build a new static deployment, run `GAME_BACKEND_ORIGIN=https://178-105-9-179.sslip.io node game-site/build.mjs`. Link `game-site/dist` explicitly to the existing Vercel project and deploy that directory. Do not deploy the repository or its `.keys` directory. Before promotion, verify `https://ram-heist-game.vercel.app/api/deployment`: it must return only the shared demo-customer wallet, never contributor identities. To update the backend, package only the server/shared source and the game engine, excluding `.keys`, `.env*`, and runtime data. Keep the service bound to loopback behind the Caddy route allowlist.

## Production site (f-stack.ai)

Public site: `https://f-stack.ai`, built by `GAME_BACKEND_ORIGIN=https://178-105-9-179.sslip.io node landing-site/build.mjs` and deployed from `landing-site/dist` to the Vercel project `foundry-stack-landing`. The build bundles `artifacts/Agent-Corp-macOS-arm64.zip` (gitignored; must exist locally) at `/download/agent-corp-macos-arm64.zip`. A plain deploy does not move the domain: run `vercel alias set <deployment-url> f-stack.ai`. `www.f-stack.ai` 308-redirects to the apex (set on project `founder-stack-web`); wallet login only works on the apex because the backend sets `GAME_ORIGIN=https://f-stack.ai` in `/etc/ram-heist.env` (`EXTRA_ORIGINS` keeps the vercel.app alias for non-login routes).
