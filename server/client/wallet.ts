import { Buffer } from "buffer";
import { setupWalletSelector } from "@near-wallet-selector/core";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
(globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;

let pending: ReturnType<typeof setupWalletSelector> | undefined;
async function wallet() {
  const dep = await fetch("/api/deployment").then(r => r.json());
  if (dep.network !== "testnet" || !dep.contractId?.endsWith(".testnet")) throw new Error("Only NEAR testnet is enabled");
  pending ??= setupWalletSelector({ network: { networkId: "testnet", nodeUrl: dep.rpcUrl, helperUrl: "https://helper.testnet.near.org", explorerUrl: dep.explorer, indexerUrl: "https://testnet-api.kitwallet.app" }, modules: [setupMyNearWallet()] });
  const selector = await pending;
  const w = await selector.wallet("my-near-wallet");
  return { w, dep };
}
async function request(path: string, data?: unknown) {
  const r = await fetch(path, data === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  const b = await r.json(); if (!r.ok) throw new Error(b.error ?? `Request failed (${r.status})`); return b;
}
export async function connectPlayer() {
  const { w, dep } = await wallet();
  const accounts = await w.signIn({ contractId: dep.contractId, methodNames: ["buy_pass"] });
  const account = accounts[0]?.accountId;
  if (!account) throw new Error("No wallet account selected");
  const challenge = await request("/api/player/challenge", { account });
  const signed = await w.signMessage({ message: challenge.message, recipient: challenge.recipient, nonce: Buffer.from(challenge.nonce, "base64url"), callbackUrl: challenge.callbackUrl });
  if (!signed || signed.accountId !== account) throw new Error("Wallet signature cancelled or account changed");
  return request("/api/player/verify", { account, nonce: challenge.nonce, publicKey: signed.publicKey, signature: signed.signature });
}
export async function disconnectPlayer() {
  await request("/api/player/logout", {});
  const { w } = await wallet(); await w.signOut();
}
export async function buyPlayerPass() {
  const tx = await request("/api/player/checkout", {});
  const { w } = await wallet();
  const accounts = await w.getAccounts();
  if (accounts[0]?.accountId !== tx.signerId) throw new Error("Wallet account changed; reconnect before buying");
  const result = await w.signAndSendTransaction(tx);
  // Entitlement is always re-read from final chain state, never trusted from popup/query parameters.
  for (let i = 0; i < 12; i++) {
    const me = await request("/api/player/me");
    if (me.hasPass) {
      await request("/api/player/session", {});
      return result?.transaction_outcome?.id;
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error("Transaction submitted; pass not final yet. Refresh to check before trying again.");
}
