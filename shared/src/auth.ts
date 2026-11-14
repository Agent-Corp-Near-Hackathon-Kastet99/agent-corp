import { createHash } from "node:crypto";

export const ACCOUNT_RE = /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
export const LOGIN_RECIPIENT = "agentcorp" as const;

/** NEP-413: tagged Borsh payload, then SHA-256; shared by signer and verifier.
 * https://github.com/near/NEPs/blob/master/neps/nep-0413.md
 */
export function loginPayload({ account, nonce }: { account: string; nonce: string }): Buffer {
  if (!ACCOUNT_RE.test(account)) throw new Error("invalid account");
  const nonceBytes = Buffer.from(nonce, "base64url");
  if (nonceBytes.length !== 32 || nonceBytes.toString("base64url") !== nonce) throw new Error("invalid nonce");
  const string = (value: string) => {
    const bytes = Buffer.from(value, "utf8");
    const size = Buffer.alloc(4); size.writeUInt32LE(bytes.length);
    return Buffer.concat([size, bytes]);
  };
  const tag = Buffer.alloc(4); tag.writeUInt32LE(2 ** 31 + 413);
  return createHash("sha256").update(Buffer.concat([
    tag, string(`Sign in to agentcorp as ${account}`), nonceBytes, string(LOGIN_RECIPIENT), Buffer.from([0]),
  ])).digest();
}
