import { Buffer } from "buffer";
import { setupWalletSelector } from "@near-wallet-selector/core";
import { setupHotWallet } from "@near-wallet-selector/hot-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupModal } from "@near-wallet-selector/modal-ui";
import "@near-wallet-selector/modal-ui/styles.css";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
(globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;

if (!document.querySelector("link[data-wallet-css]")) { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "/wallet.css"; l.dataset.walletCss = "1"; document.head.append(l); }

let pending: ReturnType<typeof setupWalletSelector> | undefined;

// Wallet Selector v10 adapters still convert NEAR API JS (NAJ) actions to their
// internal format. Supplying the internal actions here makes Hot/Meteor Wallet
// reject the payment before it reaches the wallet.
type NajAction =
  | { functionCall: { methodName: string; args: Uint8Array; gas: bigint; deposit: bigint } };

const functionCall = (methodName: string, args: Record<string, unknown>, gas: string, deposit: string): NajAction => ({
  functionCall: { methodName, args: new TextEncoder().encode(JSON.stringify(args)), gas: BigInt(gas), deposit: BigInt(deposit) },
});

async function wallet() {
  const dep = await fetch("/api/deployment").then(r => r.json());
  if (dep.network !== "testnet" || !dep.contractId?.endsWith(".testnet")) throw new Error("Only NEAR testnet is enabled");
  pending ??= setupWalletSelector({ network: { networkId: "testnet", nodeUrl: dep.rpcUrl, helperUrl: "https://helper.testnet.near.org", explorerUrl: dep.explorer, indexerUrl: "https://testnet-api.kitwallet.app" }, modules: [setupMeteorWallet(), setupHotWallet(), setupMyNearWallet({ deprecated: true })] });
  const selector = await pending;
  if (!selector.isSignedIn()) {
    const modal = setupModal(selector, { contractId: dep.contractId });
    modal.show();
    await new Promise<void>(resolve => {
      const sub = selector.on("signedIn", () => { sub.remove(); resolve(); });
      modal.on("onHide", () => { sub.remove(); resolve(); });
    });
    if (!selector.isSignedIn()) throw new Error("Wallet connection cancelled");
  }
  const w = await selector.wallet();
  return { w, dep };
}
async function request(path: string, data?: unknown) {
  const r = await fetch(path, data === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  const b = await r.json(); if (!r.ok) throw new Error(b.error ?? `Request failed (${r.status})`); return b;
}
export async function connectPlayer() {
  const { w, dep } = await wallet();
  const accounts = await w.signIn({ contractId: dep.contractId, methodNames: ["withdraw_distribution", "buy_smoke_grenade", "vote"] });
  const account = accounts[0]?.accountId;
  if (!account) throw new Error("No wallet account selected");
  const challenge = await request("/api/player/challenge", { account });
  const signed = await w.signMessage({ message: challenge.message, recipient: challenge.recipient, nonce: Buffer.from(String(challenge.nonce).replace(/-/g, "+").replace(/_/g, "/"), "base64"), callbackUrl: challenge.callbackUrl });
  if (!signed || signed.accountId !== account) throw new Error("Wallet signature cancelled or account changed");
  return request("/api/player/verify", { account, nonce: challenge.nonce, publicKey: signed.publicKey, signature: signed.signature });
}
export async function withdrawPlayer(account: string) {
  const { w, dep } = await wallet();
  if ((await w.getAccounts())[0]?.accountId !== account) throw new Error("Wallet account changed; reconnect before withdrawing");
  const result = await w.signAndSendTransaction({ signerId: account, receiverId: dep.contractId, actions: [functionCall("withdraw_distribution", {}, "100000000000000", "0")] } as never);
  return result?.transaction_outcome?.id;
}
/** Real on-chain vote signed by the contributor's own wallet. */
export async function voteProposal(account: string, proposalId: number, option: number) {
  const { w, dep } = await wallet();
  if ((await w.getAccounts())[0]?.accountId !== account) throw new Error("Wallet account changed; reconnect before voting");
  const result = await w.signAndSendTransaction({ signerId: account, receiverId: dep.contractId, actions: [functionCall("vote", { proposal_id: proposalId, option }, "50000000000000", "0")] } as never);
  return result?.transaction_outcome?.id as string | undefined;
}
export async function disconnectPlayer() {
  await request("/api/player/logout", {});
  const { w } = await wallet(); await w.signOut();
}
/** Smoke Grenade purchase: payable contract call, so its revenue is in the period ledger. */
export async function payPremium(company: string, account: string) {
  const { w, dep } = await wallet();
  if ((await w.getAccounts())[0]?.accountId !== account) throw new Error("Wallet account changed; reconnect before paying");
  if (company !== dep.contractId) throw new Error("Company account must be the configured contract");
  const result = await w.signAndSendTransaction({ signerId: account, receiverId: company, actions: [functionCall("buy_smoke_grenade", {}, "100000000000000", "1000000000000000000000000")] } as never);
  const hash = result?.transaction_outcome?.id;
  if (!hash) throw new Error("Wallet did not return a transaction hash; check your wallet before paying again");
  return hash as string;
}

/** Smoke Grenade: connect wallet if needed, buy it on-chain, then record verified receipt. */
export async function buySmokeGrenade() {
  let me: { account: string } | undefined;
  try { me = await request("/api/player/me"); } catch { /* not connected yet */ }
  if (!me) me = await connectPlayer();
  const state = await request("/api/hackathon/state");
  const hash = await payPremium(state.company.account, me!.account);
  let last = "Payment not final yet";
  for (let i = 0; i < 10; i++) {
    try { const rec = await request("/api/hackathon/payment", { txHash: hash }); return { owned: false as const, txHash: rec.txHash as string, explorerUrl: rec.explorerUrl as string }; }
    catch (e) { last = (e as Error).message; await new Promise(r => setTimeout(r, 1500)); }
  }
  throw new Error(`${last}. Transaction ${hash} was sent; do not pay again.`);
}
