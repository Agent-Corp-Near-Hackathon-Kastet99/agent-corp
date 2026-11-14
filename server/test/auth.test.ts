import { describe, expect, it } from "vitest";
import { Nep413Auth } from "../src/auth.js";
const login = (nonce: string) => ({ account:"alice.testnet",publicKey:"ed25519:x",signature:"x",nonce });
describe("NEP-413", () => {
  it("rejects bad signature", async () => { const a=new Nep413Auth({viewAccessKey:async()=>({permission:"FullAccess" as const})}); await expect(a.verify(login(a.issue().nonce))).rejects.toThrow("bad signature"); });
  it("rejects function-call key", async () => { const a=new Nep413Auth({viewAccessKey:async()=>({permission:{FunctionCall:{}}})},()=>0,()=>true); await expect(a.verify(login(a.issue().nonce))).rejects.toThrow("FullAccess"); });
  it("burns nonce and checks recipient/expiry", async () => { let now=0; const a=new Nep413Auth({viewAccessKey:async()=>({permission:"FullAccess" as const})},()=>now,()=>true); const n=a.issue().nonce; await a.verify(login(n)); await expect(a.verify(login(n))).rejects.toThrow("nonce"); const e=a.issue().nonce; now=300001; await expect(a.verify(login(e))).rejects.toThrow("expired"); const w=a.issue().nonce; await expect(a.verify({...login(w),recipient:"elsewhere"})).rejects.toThrow("recipient"); });
});

it("accepts actual NEP-413 signature produced by worker payload and rejects account tampering", async () => {
  const { KeyPair } = await import("near-api-js");
  const { loginPayload } = await import("@agentcorp/shared");
  const key = KeyPair.fromRandom("ed25519");
  const auth = new Nep413Auth({ viewAccessKey: async () => ({ permission: "FullAccess" }) });
  const nonce = auth.issue().nonce;
  const account = "alice.testnet";
  const signature = Buffer.from(key.sign(loginPayload({ account, nonce })).signature).toString("base64");
  await expect(auth.verify({ account, nonce, signature, publicKey: key.getPublicKey().toString() })).resolves.toBeUndefined();
  const n = auth.issue().nonce;
  const sig = Buffer.from(key.sign(loginPayload({ account, nonce: n })).signature).toString("base64");
  await expect(auth.verify({ account: "bob.testnet", nonce: n, signature: sig, publicKey: key.getPublicKey().toString() })).rejects.toThrow("bad signature");
});

it("bounds outstanding challenges and reclaims expired entries", () => {
  let now = 0;
  const auth = new Nep413Auth({ viewAccessKey: async () => undefined }, () => now);
  for (let i = 0; i < 1000; i++) auth.issue();
  expect(() => auth.issue()).toThrow("too many"); now = 300001;
  expect(() => auth.issue()).not.toThrow();
});
