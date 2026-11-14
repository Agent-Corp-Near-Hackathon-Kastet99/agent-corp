import { describe, expect, it } from "vitest";
import { initial, nearPot, seen, solve, step, visible, walkable, facingOf } from "../web/heist-core.js";
import { HOUSE_01 } from "../src/levels.js";

describe("RAM HEIST — House 01", () => {
  it("has a valid patrol loop: every step is one walkable tile", () => {
    const path = HOUSE_01.residentPath;
    path.forEach(([x, y], i) => {
      const [nx, ny] = path[(i + 1) % path.length]!;
      expect(walkable(HOUSE_01, x, y)).toBe(true);
      expect(facingOf({ x, y }, { x: nx, y: ny })).toBeDefined();
    });
  });

  it("can be finished by timing alone, without the flowerpot", () => {
    const inputs = solve(HOUSE_01) as (string | null)[] | null;
    expect(inputs).not.toBeNull();
    let state = initial(HOUSE_01);
    for (const input of inputs!) state = step(HOUSE_01, state, input);
    expect(state.status).toBe("won");
    expect(state.ram.every((r: { taken: boolean }) => r.taken)).toBe(true);
  });

  it("catches a player who waits in the resident's path", () => {
    let state = initial(HOUSE_01);
    for (const input of ["down", "down", "right", "right", "right", "right"]) state = step(HOUSE_01, state, input);
    for (let i = 0; i < 60 && state.status === "playing"; i++) state = step(HOUSE_01, state, null);
    expect(state.status).toBe("caught");
  });

  it("doors and walls block the resident's sight", () => {
    const state = initial(HOUSE_01);
    const resident = { ...state.resident, x: 5, y: 3, facing: "left" };
    const tiles = visible(HOUSE_01, resident) as { x: number; y: number }[];
    expect(tiles.some(t => t.x < 4)).toBe(false); // door at (4,3) hides the start room
    expect(seen(HOUSE_01, { ...state, resident })).toBe(false);
  });

  it("the flowerpot pulls the resident off the patrol, then they return", () => {
    let state = initial(HOUSE_01);
    for (const input of ["down", "down", "down", "right", "down", "down", "right", "right", "right"]) state = step(HOUSE_01, state, input);
    expect(state.player).toEqual({ x: 4, y: 6 });
    expect(nearPot(state)).toBe(true);
    state = step(HOUSE_01, state, "pot");
    expect(state.pot.broken).toBe(true);
    expect(state.resident.mode).toBe("investigate");
    // Leave through the start room before the resident arrives.
    for (const input of ["left", "left", "up", "up"]) state = step(HOUSE_01, state, input);
    let returned = false;
    for (let i = 0; i < 200 && state.status === "playing"; i++) {
      state = step(HOUSE_01, state, null);
      if (state.resident.mode === "patrol") { returned = true; break; }
    }
    expect(returned).toBe(true);
  });

  it("second resident follows its route and can detect the player", () => {
    const state = initial(HOUSE_01);
    const resident = state.secondResident!;
    expect(resident).not.toBeNull();
    expect(seen(HOUSE_01, { ...state, player: { x: resident.x, y: resident.y } })).toBe(true);
    let next = state;
    for (let i = 0; i < HOUSE_01.secondResidentEvery!; i++) next = step(HOUSE_01, next, null);
    expect(next.secondResident!.index).toBe(1);
  });

  it("the exit does nothing until both RAM sticks are taken", () => {
    const state = initial(HOUSE_01);
    const atExit = { ...state, secondResident: null, player: { x: state.exit.x - 1, y: state.exit.y }, resident: { ...state.resident, x: 5, y: 2, facing: "up" } };
    expect(step(HOUSE_01, atExit, "right").status).toBe("playing");
  });
});
