# Worker provider adapters

Agent Corp adapts MIT-licensed BB discovery, Codex authentication and custom ACP configuration patterns. Sources and full license are in [THIRD_PARTY_NOTICES.md](../../worker/THIRD_PARTY_NOTICES.md). The interactive BB runtime was not copied: Agent Corp keeps its own noninteractive runner, NEAR authentication, sandbox and metering boundary.

## Contributor setup

```sh
pnpm exec agent-corp-worker providers
pnpm exec agent-corp-worker --credential .keys/workers/alice.json --providers claude,codex --cap-usd 2 --cap-tokens 100000
```

Discovery lists provider IDs, install/sign-in instructions, status, confinement and verification state. Sign in through the provider's own CLI before starting a worker. The Mac app exposes provider IDs, discovery, both caps and the experimental-adapter switch. Server policy must also accept the provider/model; otherwise no task runs. Provider IDs are extensible, not a fixed enum.

The contributor controls metering rates locally. Built-in rates cover the pinned Claude model. To enable another model, create `~/.agent-corp/prices.json` (or `$AGENT_CORP_HOME/prices.json`):

```json
{
  "your-model-id": { "inPerMTok": 2, "outPerMTok": 10, "cacheReadPerMTok": 0.5, "cacheWritePerMTok": 2 }
}
```

Rates are illustrative USD per million tokens; check them before use. The worker refuses unknown models and rates that differ from the server's proposed rates. Both sides must agree so local caps and server credit use the same values. Restart the worker after editing this file. Local rates may override built-in rates; they are contributor policy, not independent verification of provider billing.

| Provider | Launch and credentials | Current support |
| --- | --- | --- |
| Claude Code | Tool-disabled stream JSON; existing home/keychain sandbox grants | Default; provider-reported final cost |
| Codex | `exec --json`, disabled tools, private CODEX_HOME with only auth.json linked | Standalone native CLI >= 0.169.0; token metering; reference signed-in run exercised in original integration thread |
| OpenCode | Pure JSON run, all permissions denied, private XDG directories, auth.json linked | Experimental; `--allow-unverified` required |
| Cursor | Bundled Node launcher, ask mode, private home, keychain access | Experimental; `--allow-unverified` required; cache overlap semantics unverified |
| Pi | Discovery, usage parser and opt-in one-shot launch with tool/extension/context flags disabled | Experimental; live sign-in and usage not verified |
| Custom ACP | Hash-pinned native executable, private home, explicitly listed credential files | Experimental; all permission requests refused, no client FS/terminal/MCP; requires final token-usage extension |

`ready` means local installation/credential checks passed; it does not prove credentials remain valid at the provider. No live subscription inference is performed by discovery or automated tests.

## Owner policy

Absent `worker_policy`, server accepts only the existing pinned Claude model and credits provider-reported cost. To accept Codex, add a policy to `config.yaml` (replace illustrative model/prices with values you have checked):

```yaml
worker_policy:
  credit_bases: [provider-cost] # add list-price only if inferred contributions should be credited
  allow_unverified: false
  models:
    - provider: claude
      model: claude-sonnet-4-5-20250929
    - provider: codex
      model: your-model-id
      usd_per_mtok:
        input: 2
        output: 10
        cache_read: 0.5
        cache_write: 2
```

Model entries are matched against worker offers in owner order. Experimental adapters require both contributor `--allow-unverified` and owner `allow_unverified: true`. Restart server after policy edits. Models without built-in prices require all four rates. Example rates above are illustrative, not current pricing guidance.

Units remain integer micro-USD. Token counts never become dollars directly. Claude's final reported cost has `basis: provider-cost, exact: true`; authoritative token counts multiplied by owner prices have `basis: list-price, exact: false`. Server recomputes inferred units and stores normalized usage for audit. Incomplete reports use `estimate` and cannot be credited. Allowing list-price credit is a separate explicit owner choice; it never changes `exact` to true. As before, MVP trusts worker-reported usage; offers and hashes do not independently attest honest accounting.

Token-metered providers require a separate local token cap. Reservations are persisted before launch; missing usage, cancellation or disconnect conservatively retain the reservation until authoritative usage settles it. The dollar reservation is per task; token reservation covers remaining daily tokens. Limits react to reported usage and cannot prevent overage before the provider emits usage. Server disconnect cancels the child before cap locks are released. Production launches have their own process group so cancellation also stops helpers.

## Custom ACP agents

Put an array in `$AGENT_CORP_HOME/acp-agents.json` (default `~/.agent-corp/acp-agents.json`):

```json
[{
  "id": "example",
  "displayName": "Example ACP",
  "command": "/absolute/path/to/native-agent",
  "sha256": "replace-with-64-lowercase-hex-characters",
  "args": ["--acp"],
  "models": ["your-model-id"],
  "credentialFiles": [],
  "env": {},
  "signInCommand": "native-agent login"
}]
```

Worker ID becomes `acp-example`. Use `modelFlag` when one executable serves multiple configured models. Executable must be owned by contributor/root, executable, not group/world writable, in a non-group/world-writable directory, and match pinned SHA-256 at discovery and launch. Script launchers and loader environment overrides are refused. Credential files must be explicitly listed inside contributor home. Updating executable requires updating its hash.

Standard ACP context-window `usage_update` notifications are not billed usage. This client requires a final prompt response `usage` object with nonnegative integer `inputTokens`, `outputTokens`, optional `thoughtTokens`, `cachedReadTokens`, `cachedWriteTokens`. Input excludes cached tokens; output excludes separately supplied thought tokens. Agents without that extension fail with missing usage and consume conservative local reservations. Validate each agent's semantics before enabling credit.

## Confinement and remaining limits

Execution currently fails closed outside macOS. Seatbelt denies home reads except adapter grants, denies writes outside private root except credential refresh/fixed Cursor scratch, and restricts executable grants for new adapters. Private homes exclude user plugins, rules, MCP configuration and histories. Claude retains its existing broader credential/config grants and tool-disabled mode. Credential refresh write-back runs before private-root cleanup.

Network remains open for provider authentication/inference: this seatbelt profile does not enforce host allowlists. System paths outside home are also readable. Therefore this is not a complete isolation boundary for hostile custom executables. Custom/experimental agents must be reviewed; hash pinning proves file identity, not safe behavior. Endpoint filtering, stronger filesystem isolation, Cursor cache semantics, Pi launch support and live verification of experimental providers remain follow-up work.

## Validation

`pnpm test` covers parser normalization, missing/invalid usage, owner credit policy, model/capability intersection, ACP refusal, cancellation/disconnect and durable caps. `pnpm typecheck` checks shared/server/worker types. `bash mac-app/build.sh` compiles the Mac launcher. These checks use local fixtures, not paid live inference.
