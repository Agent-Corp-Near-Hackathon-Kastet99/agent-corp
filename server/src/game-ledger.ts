import { Account, type KeyPairString } from "near-api-js";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { ACCOUNT_RE } from "./config.js";
import { call, provider, view } from "./near.js";
import type { Ledger, ChainConfig, CallOptions } from "./ledger.js";
import type { Role } from "./credentials.js";

/** Game-only signer. The key can spend testnet funds; fund this wallet minimally. */
export function createGameLedger(settings: { contractId: string; customerId: string; customerKey: string; maxPrice: string; purchaseMarker: string }): Ledger {
  const { contractId, customerId, customerKey, maxPrice, purchaseMarker } = settings;
  if (!ACCOUNT_RE.test(contractId) || !contractId.endsWith(".testnet") || !ACCOUNT_RE.test(customerId) || !customerId.endsWith(".testnet") || !customerKey.startsWith("ed25519:") || !/^[1-9][0-9]*$/.test(maxPrice) || !purchaseMarker) throw new Error("Invalid game backend configuration");
  const accounts = Object.freeze(Object.fromEntries(["owner", "oracle", "ceo", "alice", "bob", "customer", "vendor"].map(role => [role, customerId])) as Record<Role, string>);
  const signer = new Account(customerId, provider, customerKey as KeyPairString);
  return {
    contractId, accounts,
    view: <T>(method: string, args: Record<string, unknown> = {}) => view<T>(contractId, method, args),
    async call<T>(role: Role, method: string, args: Record<string, unknown> = {}, opts: CallOptions = {}) {
      if (role !== "customer" || method !== "buy_pass" || Object.keys(args).length !== 0) throw new Error("Game backend cannot sign this transaction");
      const chain = await view<ChainConfig>(contractId, "get_config");
      if (!chain.demo_mode || BigInt(chain.constraints.pass_price) > BigInt(maxPrice) || opts.depositYocto !== BigInt(chain.constraints.pass_price)) throw new Error("Purchase exceeds configured demo limit");
      if (await view<boolean>(contractId, "has_pass", { account_id: customerId })) throw new Error("Demo wallet already has a pass");
      // Create before submission: even an ambiguous RPC failure cannot trigger a second payment.
      mkdirSync(dirname(purchaseMarker), { recursive: true, mode: 0o700 });
      try { closeSync(openSync(purchaseMarker, "wx", 0o600)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Demo purchase already attempted; operator review required");
        throw error;
      }
      return call<T>(signer, contractId, method, args, opts);
    },
  };
}
