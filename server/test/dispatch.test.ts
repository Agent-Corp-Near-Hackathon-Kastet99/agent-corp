import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { Dispatcher } from "../src/dispatch.js";
import { FakeChain } from "../src/chain.js";

describe("dispatcher", () => {
  it("persists both sections before fake-chain settlement", async () => {
    const db = new Db(); const chain = new FakeChain(); const sent: any[] = [];
    const d = new Dispatcher(db, chain);
    d.addWorker({ account: "alice.testnet", send: x => sent.push(x) });
    d.addWorker({ account: "bob.testnet", send: x => sent.push(x) });
    await d.create("job", "https://example.com", "page"); await chain.pay("job"); await d.paid("job");
    await d.result(sent[0].attemptId, sent[0].leaseGeneration, "copy text", "10");
    await d.result(sent[1].attemptId, sent[1].leaseGeneration, "design text", "20");
    expect(db.getJob("job")?.state).toBe("settled");
    expect(db.getJob("job")?.teardown_copy).toBe("copy text");
  });
});
