import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store, type Task } from "../src/store.js";
import { SetupJournal } from "../src/credentials.js";
const roots: string[] = [];
const root = () => { const p = mkdtempSync(join(tmpdir(), "corp-store-")); roots.push(p); return p; };
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
describe("durable Store", () => {
  it("returns independent snapshots and reloads persisted updates", () => {
    const file = join(root(), "state.json"); const store = new Store(file);
    const task: Task = { id: "1", kind: "qa", title: "QA", prompt: "test", status: "queued" };
    store.upsertTask(task); task.status = "failed"; store.tasks()[0]!.status = "done";
    store.addScore({ account: "alice.testnet", level: "house-01", ms: 10, at: 1 });
    store.bestScore("alice.testnet", "house-01")!.ms = 1;
    store.log({ ts: 1, actor: "CEO", text: "recorded" }); store.activity()[0]!.text = "changed";
    const loaded = new Store(file);
    expect(loaded.tasks()[0]!.status).toBe("queued"); expect(loaded.activity()[0]!.text).toBe("recorded");
    expect(loaded.bestScore("alice.testnet", "house-01")!.ms).toBe(10);
  });
  it("does not change memory after persistence failure; rejects corrupt loaded state", () => {
    const dir = root(); const store = new Store(join(dir, "blocked", "state.json")); writeFileSync(join(dir, "blocked"), "file");
    expect(() => store.addScore({ account: "alice.testnet", level: "house-01", ms: 1, at: 1 })).toThrow();
    expect(store.bestScore("alice.testnet", "house-01")).toBeUndefined();
    const file = join(dir, "bad.json"); writeFileSync(file, '{"activity":[],"scores":{},"tasks":[]}');
    expect(() => new Store(file)).toThrow("Invalid off-chain state");
  });
  it("checkpoints generated setup credentials with private permissions", () => {
    const file = join(root(), "setup.json"); const journal = new SetupJournal(file);
    journal.record("contract", { accountId: "contract.testnet", privateKey: "test-only-placeholder" });
    expect(JSON.parse(readFileSync(file, "utf8")).accounts.contract.accountId).toBe("contract.testnet");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
