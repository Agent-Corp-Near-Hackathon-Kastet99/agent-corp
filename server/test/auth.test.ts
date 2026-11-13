import { describe, expect, it } from "vitest";
import { Nep413Auth } from "../src/auth.js";
const login = (nonce: string) => ({ account:"alice.testnet",publicKey:"ed25519:x",signature:"x",nonce });
describe("NEP-413", () => {
  it("rejects bad signature", async () => { const a=new Nep413Auth({viewAccessKey:async()=>({permission:"FullAccess" as const})}); await expect(a.verify(login(a.issue().nonce))).rejects.toThrow("bad signature"); });
  it("rejects function-call key", async () => { const a=new Nep413Auth({viewAccessKey:async()=>({permission:{FunctionCall:{}}})},()=>0,()=>true); await expect(a.verify(login(a.issue().nonce))).rejects.toThrow("FullAccess"); });
  it("burns nonce and checks recipient/expiry", async () => { let now=0; const a=new Nep413Auth({viewAccessKey:async()=>({permission:"FullAccess" as const})},()=>now,()=>true); const n=a.issue().nonce; await a.verify(login(n)); await expect(a.verify(login(n))).rejects.toThrow("nonce"); const e=a.issue().nonce; now=300001; await expect(a.verify(login(e))).rejects.toThrow("expired"); const w=a.issue().nonce; await expect(a.verify({...login(w),recipient:"elsewhere"})).rejects.toThrow("recipient"); });
});
