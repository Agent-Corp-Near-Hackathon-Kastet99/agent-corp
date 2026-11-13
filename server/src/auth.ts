import { randomBytes, verify } from "node:crypto";

export type Login = { account: string; publicKey: string; signature: string; nonce: string; recipient?: string };
export type AccessKeyRpc = { viewAccessKey(account: string, publicKey: string): Promise<{ permission: "FullAccess" | unknown } | undefined> };

type Challenge = { expiresAt: number; used: boolean };
export class Nep413Auth {
  private readonly challenges = new Map<string, Challenge>();
  constructor(private readonly rpc: AccessKeyRpc, private readonly now = () => Date.now(), private readonly verifySignature = defaultVerify) {}
  issue(): { nonce: string; recipient: "agentcorp" } {
    const nonce = randomBytes(32).toString("base64url");
    this.challenges.set(nonce, { expiresAt: this.now() + 5 * 60_000, used: false });
    return { nonce, recipient: "agentcorp" };
  }
  async verify(login: Login): Promise<void> {
    if (login.recipient !== undefined && login.recipient !== "agentcorp") throw new Error("wrong recipient");
    const c = this.challenges.get(login.nonce);
    if (!c || c.used) throw new Error("nonce already used or unknown");
    if (c.expiresAt <= this.now()) throw new Error("nonce expired");
    // Burn before async RPC: concurrent replay can never pass.
    c.used = true;
    if (!this.verifySignature(login)) throw new Error("bad signature");
    const accessKey = await this.rpc.viewAccessKey(login.account, login.publicKey);
    if (!accessKey || accessKey.permission !== "FullAccess") throw new Error("public key is not FullAccess");
  }
}

/** NEP-413 payload used by this service. Worker must sign exact UTF-8 bytes. */
export function nep413Payload(login: Pick<Login, "account" | "nonce">): Buffer {
  return Buffer.from(JSON.stringify({ message: `Sign in to agentcorp as ${login.account}`, nonce: login.nonce, recipient: "agentcorp" }), "utf8");
}
function defaultVerify(login: Login): boolean {
  try {
    if (!login.publicKey.startsWith("ed25519:")) return false;
    const raw = base58(login.publicKey.slice(8));
    if (raw.length !== 32) return false;
    // RFC 8410 Ed25519 SubjectPublicKeyInfo prefix + NEAR's raw public key.
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
    return verify(null, nep413Payload(login), { key: spki, format: "der", type: "spki" }, Buffer.from(login.signature, "base64"));
  } catch { return false; }
}
function base58(value: string): Buffer {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const c of value) { const i = alphabet.indexOf(c); if (i < 0) throw new Error("bad base58"); n = n * 58n + BigInt(i); }
  const body: number[] = []; while (n) { body.unshift(Number(n & 255n)); n >>= 8n; }
  let zeroes = 0; while (value[zeroes] === "1") zeroes++;
  return Buffer.from([...Array(zeroes).fill(0), ...body]);
}
