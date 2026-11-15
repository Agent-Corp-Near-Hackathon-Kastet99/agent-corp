import { createHash, randomBytes } from "node:crypto";
import { ACCOUNT_RE } from "@agentcorp/shared";
import { verifySignedPayload, type AccessKeyRpc } from "./auth.js";
import { RPC_URL } from "./near.js";

export type PlayerChallenge = { account: string; nonce: string; message: string; recipient: string; callbackUrl: string };
export function playerPayload(c: PlayerChallenge, withCallback = true): Buffer {
  const str = (s: string) => { const b = Buffer.from(s); const n = Buffer.alloc(4); n.writeUInt32LE(b.length); return Buffer.concat([n, b]); };
  const tag = Buffer.alloc(4); tag.writeUInt32LE(2 ** 31 + 413);
  return createHash("sha256").update(Buffer.concat([tag, str(c.message), Buffer.from(c.nonce, "base64url"), str(c.recipient),
    withCallback ? Buffer.concat([Buffer.from([1]), str(c.callbackUrl)]) : Buffer.from([0])])).digest();
}

export const playerRpc: AccessKeyRpc = { async viewAccessKey(account, publicKey) {
  const r = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: "player-key", method: "query", params: { request_type: "view_access_key", finality: "final", account_id: account, public_key: publicKey } }) });
  if (!r.ok) throw new Error("Wallet verification RPC unavailable");
  const data = await r.json() as { result?: { permission: unknown } };
  return data.result;
} };

/** Browser-bound, origin/contract-bound NEP-413 login. No wallet secret reaches the server. */
export class PlayerAuth {
  private challenges = new Map<string, { challenge: PlayerChallenge; browser: string; expires: number }>();
  private sessions = new Map<string, { account: string; expires: number }>();
  constructor(private contract: string, private rpc: AccessKeyRpc = playerRpc, private now = Date.now) {}
  issue(account: string, origin: string) {
    if (!ACCOUNT_RE.test(account) || !(account.endsWith(".testnet") || /^[a-f0-9]{64}$/.test(account))) throw new Error("Choose a NEAR testnet account");
    for (const [key, c] of this.challenges) if (c.expires <= this.now()) this.challenges.delete(key);
    if (this.challenges.size >= 1000) throw new Error("Login capacity reached; retry later");
    const nonce = randomBytes(32).toString("base64url"), browser = randomBytes(32).toString("base64url");
    const challenge = { account, nonce, recipient: origin, callbackUrl: `${origin}/wallet-callback`,
      message: `Sign in to Sam Alt-Ram as ${account}. Network: testnet. Contract: ${this.contract}. This does not authorize a transaction.` };
    this.challenges.set(nonce, { challenge, browser, expires: this.now() + 5 * 60_000 });
    return { challenge, browser };
  }
  async verify(input: Record<string, unknown>, browser: string, origin: string) {
    if (!["nonce", "account", "publicKey", "signature"].every(k => typeof input[k] === "string" && (input[k] as string).length <= 512)) throw new Error("Invalid wallet signature");
    const entry = this.challenges.get(input.nonce as string);
    if (!entry || !browser || entry.browser !== browser || entry.challenge.recipient !== origin || entry.expires <= this.now()) throw new Error("Login challenge expired or belongs to another browser");
    this.challenges.delete(input.nonce as string); // consume before RPC; concurrent replay fails
    const c = entry.challenge;
    if (c.account !== input.account) throw new Error("Wallet account changed; reconnect");
    // NEP-413 wallets may include the optional callback in the signed payload or use it only for transport.
    if (![true, false].some(callback => verifySignedPayload(input.publicKey as string, input.signature as string, playerPayload(c, callback)))) throw new Error("Invalid wallet signature");
    const key = await this.rpc.viewAccessKey(c.account, input.publicKey as string);
    if (!key || key.permission !== "FullAccess") throw new Error("Sign with a full-access wallet key");
    for (const [token, session] of this.sessions) if (session.expires <= this.now()) this.sessions.delete(token);
    if (this.sessions.size >= 1000) throw new Error("Player capacity reached");
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, { account: c.account, expires: this.now() + 12 * 60 * 60_000 });
    return { token, account: c.account };
  }
  account(token: string) {
    const s = this.sessions.get(token);
    if (!s || s.expires <= this.now()) { this.sessions.delete(token); return undefined; }
    return s.account;
  }
  logout(token: string) { this.sessions.delete(token); }
}
