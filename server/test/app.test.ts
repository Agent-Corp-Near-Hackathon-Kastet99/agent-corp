import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApplication } from "../src/app.js";
import { Store } from "../src/store.js";
import { TestLedger } from "./ledger-fixture.js";
const roots: string[] = [], servers: Server[] = [];
async function app(demoActions = false, gameOnly = false) {
  const root = mkdtempSync(join(tmpdir(), "corp-http-")); roots.push(root);
  const web = join(root, "web"); mkdirSync(web); writeFileSync(join(web, "index.html"), "ledger");
  const ledger = new TestLedger(); const server = createApplication({ ledger, store: new Store(join(root, "state.json")), demoActions, webRoot: web, gameOnly, gameOrigin: gameOnly ? "https://game.example" : undefined });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { ledger, root, web, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});
describe("HTTP application Interface", () => {
  it("restricts the game backend to game routes and the configured browser origin", async () => {
    const { url, ledger } = await app(true, true);
    const post = (path: string, origin: string) => fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", origin }, body: "{}" });
    expect((await post("/api/demo/close", "https://game.example")).status).toBe(404);
    expect((await post("/api/demo/buy", "https://attacker.example")).status).toBe(403);
    expect((await post("/api/game/step", "https://attacker.example")).status).toBe(403);
    ledger.passes.add(ledger.accounts.customer);
    const session = await post("/api/demo/session", "https://game.example");
    expect(session.status).toBe(200);
    expect(session.headers.get("set-cookie")).toContain("Secure");
    expect(ledger.calls).toEqual([]);
    const deployment = await (await fetch(`${url}/api/deployment`)).json();
    expect(deployment.demoWallets).toEqual({ customer: ledger.accounts.customer });
  });
  it("gates level, activates pass through explicit demo capability, saves score", async () => {
    const { ledger, url } = await app(true);
    expect((await fetch(`${url}/api/game/levels/house-01?account=customer.testnet`)).status).toBe(401);
    expect((await fetch(`${url}/api/demo/buy`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(201);
    const session = await fetch(`${url}/api/demo/session`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(session.status).toBe(200); const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    const level = await (await fetch(`${url}/api/game/levels/house-01`, { headers: { cookie } })).json();
    expect(level.state.status).toBe("playing"); expect(level.level.id).toBe("house-01");
    expect((await fetch(`${url}/api/game/score`, { method: "POST", body: JSON.stringify({ account: "customer.testnet", ms: 1 }) })).status).toBe(404);
    expect((await fetch(`${url}/api/game/step`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ action: "teleport" }) })).status).toBe(400);
    expect((await fetch(`${url}/api/dashboard`)).status).toBe(200);
    expect((await ledger.view<{ claimable_total: string }>("get_treasury")).claimable_total).toBe("0");
  });
  it("rejects disabled, cross-origin and non-demo signing", async () => {
    const off = await app(); expect((await fetch(`${off.url}/api/demo/buy`, { method: "POST" })).status).toBe(403); expect(off.ledger.calls).toEqual([]);
    const on = await app(true); expect((await fetch(`${on.url}/api/demo/buy`, { method: "POST", headers: { origin: "https://attacker.test" } })).status).toBe(403);
    on.ledger.config.demo_mode = false; expect((await fetch(`${on.url}/api/demo/buy`, { method: "POST" })).status).toBe(403); expect(on.ledger.calls).toEqual([]);
  });
  it("serves static content, rejects symlink escape, catches malformed paths and request input", async () => {
    const { url, root, web } = await app(); writeFileSync(join(root, "private.txt"), "secret"); symlinkSync(join(root, "private.txt"), join(web, "leak.txt"));
    expect(await (await fetch(url)).text()).toBe("ledger"); expect((await fetch(`${url}/leak.txt`)).status).toBe(403);
    expect((await fetch(`${url}/%ZZ`)).status).toBe(400);
    expect((await fetch(`${url}/api/game/step`, { method: "POST", headers: { "content-type": "application/json" }, body: "not-json" })).status).toBe(400);
    expect((await fetch(`${url}/api/passes/invalid..testnet`)).status).toBe(400);
  });
});
