# Public game deploy

The static game needs a public HTTPS backend for `/api/*`. It deliberately has
no fallback to a local address or machine IP.

```sh
GAME_BACKEND_ORIGIN=https://api.example.com node game-site/build.mjs
cd game-site/dist && vercel --prod
```

Before publishing, open `/game` from a clean browser profile and
confirm `/api/deployment` responds through the deployed domain. The backend
must run with `DEMO_ACTIONS=on` only for the testnet demo and its `gameOrigin`
must match the deployed game origin.
