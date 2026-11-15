import { afterEach, expect, it } from "vitest";
import { KeyPair } from "near-api-js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { PlayerAuth, playerPayload, type PlayerChallenge } from "../src/player-auth.js";
import { createApplication } from "../src/app.js";
import { Store } from "../src/store.js";
import { TestLedger } from "./ledger-fixture.js";
const key = KeyPair.fromRandom("ed25519");
const sign = (c: PlayerChallenge) => ({ account: c.account, nonce: c.nonce, publicKey: key.getPublicKey().toString(), signature: Buffer.from(key.sign(playerPayload(c)).signature).toString("base64") });
it("binds login to browser, account, origin, fresh nonce and a real authorized key", async () => {
  let now = 0;
  const auth = new PlayerAuth("game.testnet", {viewAccessKey: async () => ({permission:"FullAccess"})}, () => now);
  const c = auth.issue("alice.testnet", "https://game.example");
  await expect(auth.verify(sign(c.challenge), "other-browser", "https://game.example")).rejects.toThrow("another browser");
  await expect(auth.verify(sign(c.challenge), c.browser, "https://evil.example")).rejects.toThrow("another browser");
  const session = await auth.verify(sign(c.challenge), c.browser, "https://game.example");
  expect(auth.account(session.token)).toBe("alice.testnet");
  await expect(auth.verify(sign(c.challenge), c.browser, "https://game.example")).rejects.toThrow();
  const changed = auth.issue("alice.testnet", "https://game.example");
  await expect(auth.verify({...sign(changed.challenge),account:"bob.testnet"}, changed.browser, "https://game.example")).rejects.toThrow("changed");
  const expired = auth.issue("alice.testnet", "https://game.example"); now = 300001;
  await expect(auth.verify(sign(expired.challenge), expired.browser, "https://game.example")).rejects.toThrow("expired");
  now = 13 * 3600000; expect(auth.account(session.token)).toBeUndefined();
  expect(() => auth.issue("alice.near", "https://game.example")).toThrow("testnet");
});
it("rejects forged signatures, unauthorized keys and function-call keys", async () => {
  for (const permission of [undefined, { FunctionCall: {} }]) {
    const auth = new PlayerAuth("game.testnet", { viewAccessKey: async () => permission === undefined ? undefined : { permission } });
    const c = auth.issue("alice.testnet", "https://game.example");
    await expect(auth.verify(sign(c.challenge), c.browser, "https://game.example")).rejects.toThrow("full-access");
  }
  const auth = new PlayerAuth("game.testnet", { viewAccessKey: async () => ({ permission: "FullAccess" }) });
  const c = auth.issue("alice.testnet", "https://game.example");
  await expect(auth.verify({...sign(c.challenge),signature:Buffer.alloc(64).toString('base64')}, c.browser, "https://game.example")).rejects.toThrow("signature");
});
const roots: string[] = [], servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r())))); roots.splice(0).forEach(r => rmSync(r,{recursive:true,force:true})); });
it("creates personal sessions without a purchase", async () => {
  const root = mkdtempSync(join(tmpdir(),"player-http-")); roots.push(root);
  const ledger = new TestLedger();
  const server = createApplication({ledger,store:new Store(join(root,'state.json')),gameOnly:true,gameOrigin:'https://game.example',playerRpc:{viewAccessKey:async()=>({permission:'FullAccess'})}});
  servers.push(server); await new Promise<void>(r => server.listen(0,'127.0.0.1',r));
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const post = (path: string, body: object = {}, cookie = '', origin = 'https://game.example') => fetch(base+path,{method:'POST',headers:{origin,cookie,'content-type':'application/json'},body:JSON.stringify(body)});
  expect((await post('/api/player/challenge',{account:'alice.testnet'},'','https://evil.example')).status).toBe(403);
  const login = async(account:string) => {
    const c = await post('/api/player/challenge',{account});
    const challenge = await c.json() as PlayerChallenge;
    const verified = await post('/api/player/verify',sign(challenge),c.headers.getSetCookie()[0]!.split(';')[0]);
    expect(verified.status).toBe(200);
    return verified.headers.getSetCookie().find(c=>c.startsWith('heist-player='))!.split(';')[0]!;
  };
  const alice = await login('alice.testnet'), bob = await login('bob.testnet');
  expect((await post('/api/player/checkout',{},alice)).status).toBe(404);
  expect((await post('/api/player/session',{},bob)).status).toBe(200);
  const session = await post('/api/player/session',{},alice);expect(session.status).toBe(200);
  const gameCookie = session.headers.getSetCookie()[0]!.split(';')[0]!;
  expect(session.headers.getSetCookie()[0]).toContain('Secure');
  const game = await (await fetch(base+'/api/game/levels/house-01',{headers:{cookie:gameCookie}})).json();expect(game.account).toBe('alice.testnet');
  await post('/api/player/logout',{},`${alice}; ${gameCookie}`);
  expect((await fetch(base+'/api/player/me',{headers:{cookie:alice}})).status).toBe(401);
  expect((await fetch(base+'/api/game/levels/house-01',{headers:{cookie:gameCookie}})).status).toBe(401);
  expect(ledger.calls).toEqual([]);
});
