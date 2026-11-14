import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { GameSessions } from "../src/game.js";
import { Store } from "../src/store.js";
import { HOUSE_01 } from "../src/levels.js";
import { solve } from "../web/heist-core.js";

it("advances real-time play from elapsed server time, including while idle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentcorp-realtime-"));
  try {
    let now = 1000;
    const game = new GameSessions(new Store(join(dir, "state.json")), () => now);
    const token = game.create("buyer.testnet");
    const command = { mode: "realtime", direction: null, sprint: false };
    expect(game.move(token, command).state.tick).toBe(0);
    now += 600;
    const state = game.move(token, command).state;
    expect(state.tick).toBe(3);
    expect((state.secondResident as unknown as { pause: number }).pause).toBeLessThan(8);
    for (let i = 0; i < 20; i++) game.move(token, command);
    expect(game.current(token).state.tick).toBe(3);
    expect(() => game.move(token, { ...command, direction: "teleport" })).toThrow("invalid move");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("records only a server-played win with server time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentcorp-game-"));
  try {
    const store = new Store(join(dir, "state.json")); let time = 1000;
    const game = new GameSessions(store, () => time); const token = game.create("buyer.testnet");
    expect(() => game.current("invented")).toThrow();
    expect(() => game.move(token, "teleport")).toThrow();
    const inputs = solve(HOUSE_01) as Array<string | null>;
    expect(inputs.length).toBeGreaterThan(0);
    const exposed = game.current(token); exposed.state.status = "won"; exposed.level.rows[0] = "changed";
    expect(game.current(token).state.status).toBe("playing"); expect(game.current(token).level.rows[0]).not.toBe("changed");
    for (const input of inputs.slice(0, -1)) { time += 50; game.move(token, input); }
    const save = vi.spyOn(store, "addScore").mockImplementationOnce(() => { throw new Error("disk failed"); });
    time += 50; expect(() => game.move(token, inputs.at(-1)!)).toThrow("disk failed");
    expect(game.current(token).state.status).toBe("playing");
    game.move(token, inputs.at(-1)!); save.mockRestore();
    expect(game.current(token).state.status).toBe("won");
    expect(store.bestScore("buyer.testnet", HOUSE_01.id)?.ms).toBe(inputs.length * 50);
    game.move(token, null);
    expect(store.bestScore("buyer.testnet", HOUSE_01.id)?.ms).toBe(inputs.length * 50);
    time += 12 * 60 * 60_000;
    expect(() => game.current(token)).toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
