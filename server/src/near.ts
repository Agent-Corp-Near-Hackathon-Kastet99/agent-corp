import { Account, JsonRpcProvider, teraToGas, type KeyPairString } from "near-api-js";
import type { KeyFile, Role } from "./credentials.js";

export const RPC_URL = process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";
export const EXPLORER = "https://testnet.nearblocks.io";

export const provider = new JsonRpcProvider({ url: RPC_URL });

/** Signing account for a role. Agents (`oracle`, `ceo`) always sign with their scoped key. */
export function account(keys: KeyFile, role: Role, opts: { fullAccess?: boolean } = {}): Account {
  const entry = keys.accounts[role];
  if ((role === "oracle" || role === "ceo") && !opts.fullAccess && !entry.agentKey) {
    throw new Error(`Missing scoped key for ${role}; run setup --rekey`);
  }
  const key = opts.fullAccess ? entry.privateKey : entry.agentKey ?? entry.privateKey;
  return new Account(entry.accountId, provider, key as KeyPairString);
}

export async function view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await provider.callFunction({ contractId, method, args, blockQuery: { finality: "final" } })) as T;
}

export type TxResult<T> = { value: T; txHash: string; explorerUrl: string };

/** Change call. Waits until every receipt (including transfer callbacks) has executed. */
export async function call<T = unknown>(
  signer: Account,
  contractId: string,
  methodName: string,
  args: Record<string, unknown> = {},
  opts: { depositYocto?: bigint; tgas?: number } = {},
): Promise<TxResult<T>> {
  const outcome = await signer.callFunctionRaw({
    contractId,
    methodName,
    args,
    deposit: opts.depositYocto ?? 0n,
    gas: teraToGas(opts.tgas ?? 30),
    waitUntil: "FINAL",
  });
  const status = outcome.status as { SuccessValue?: string; Failure?: unknown };
  if (status.Failure) throw new Error(`${methodName} failed: ${JSON.stringify(status.Failure)}`);
  const raw = status.SuccessValue ? Buffer.from(status.SuccessValue, "base64").toString("utf8") : "";
  const txHash = outcome.transaction_outcome.id;
  return { value: (raw ? JSON.parse(raw) : undefined) as T, txHash, explorerUrl: `${EXPLORER}/txns/${txHash}` };
}

/** Readable reason from a contract panic or RPC error. */
export function reason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const panic = /Smart contract panicked: ([^"\\]+)/.exec(text);
  return panic ? panic[1]!.trim() : text;
}

/** Signing capability shared by the HTTP and policy Modules; serializes every change. */
export function createLedger(keys: KeyFile): import("./ledger.js").Ledger {
  let pending: Promise<unknown> = Promise.resolve();
  const accounts = Object.fromEntries(Object.entries(keys.accounts).map(([role, entry]) => [role, entry.accountId])) as Record<Role, string>;
  return {
    contractId: keys.contractId,
    accounts: Object.freeze(accounts),
    view: <T>(method: string, args: Record<string, unknown> = {}) => view<T>(keys.contractId, method, args),
    call<T>(role: Role, method: string, args: Record<string, unknown> = {}, opts = {}): Promise<TxResult<T>> {
      const next = pending.then(() => call<T>(account(keys, role), keys.contractId, method, args, opts));
      pending = next.catch(() => undefined);
      return next;
    },
  };
}
