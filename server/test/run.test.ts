import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { GameSessions } from "../src/game.js";
import { Store } from "../src/store.js";
import { FOUNDER_HOUSE } from "../src/levels.js";
import { planWinningRun } from "./sneak-plan.js";

it("verifies a browser run by replaying its input log and records only server-computed results", { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentcorp-run-"));
  try {
    const store = new Store(join(dir, "state.json"));
    const games = new GameSessions(store, () => 5000);
    const token = games.create("buyer.testnet");
    expect(() => games.level3d("invented")).toThrow();
    expect(games.level3d(token).level.id).toBe("founder-house");

    // Rejects malformed logs.
    for (const bad of [null, {}, { log: "x" }, { log: [[0, 0, 0]] }, { log: [[0, 500, 0, 0]] }, { log: [[10, 0, 0, 0], [5, 0, 0, 0]] }, { log: [[0, 0.5, 0, 0]] }, { log: [[0, 0, 0, 2]] }]) {
      expect(() => games.submitRun(token, bad)).toThrow("invalid run");
    }

    // Standing still does not win and records nothing (a patrol eventually checks the front door).
    const idle = games.submitRun(token, { log: [] });
    expect(idle.result.status).not.toBe("won");
    expect(store.bestScore("buyer.testnet", FOUNDER_HOUSE.id)).toBeUndefined();

    // A genuine winning log is accepted; time comes from the replay.
    const { log, state } = planWinningRun();
    const won = games.submitRun(token, { log });
    expect(won.result.status).toBe("won");
    expect(won.result.ms).toBe(Math.round((state.tick * 1000) / 60));
    expect(won.result.medals.undetected).toBe(true);
    expect(won.best?.ms).toBe(won.result.ms);

    // A cut-down log cannot claim a win: the server never trusts a claimed result.
    expect(games.submitRun(token, { log: log.slice(0, Math.floor(log.length / 2)) }).result.status).not.toBe("won");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
