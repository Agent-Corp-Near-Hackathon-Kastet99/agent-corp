# Canonical testnet verification

A fresh deployment of the canonical build is active locally through `.keys/active`. Previous testnet credentials and deployments remain intact.

- Contract: `contract.agentcorp-c103c2bb.testnet`
- Canonical deployment: https://testnet.nearblocks.io/txns/8CeEewZTRraVrW1P1Swun5i12G1iDnGBj2ZPPGCgbB3E
- Weekly demo close: https://testnet.nearblocks.io/txns/H4dkuGwLhZwrWwAxeva9V8i8bDtx72YfNiiqmUYn71cn
- `AGENTCORP_KEYS=.keys/testnet-canonical.json pnpm demo` passed: distinct contributor wallets seeded at 60,000/40,000 units; Board approved budget; one 1 tNEAR pass sale did not change claimable; 0.10 tNEAR hosting was paid; close allocated 0.48/0.32 tNEAR; both withdrew; duplicate close rejected. All amounts are testnet/demo.
- Two signed-in Claude sessions, using separate demo-wallet credentials and 0.20 USD per-wallet caps, authenticated through worker transport. Their exact reported usage was recorded on-chain. An initial QA output lacked the requested checklist because it had no game context; it is retained as failed in the local activity store, and the corrected task was rerun successfully. Later real work changes the contributors' lifetime unit percentages from the original 60/40 seed.
- Claude authentication on macOS required read access to the user's Keychains directory in addition to Claude's own installation and configuration. The sandbox denies other home-directory reads and restricts writes to its temporary workspace; it is not a complete production isolation guarantee. Other platforms fail closed.
- A 0.01 USD callback threshold was exceeded by one live model response before its final usage became available (0.029603 USD); streaming usage limits cannot guarantee a hard provider-side spending cap. Metered actual usage was retained.

Outstanding: external-wallet checkout and game authentication, non-demo payments, production security and legal review, final demo recording and publication. No claim that testnet demo is production-ready.
