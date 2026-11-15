import { describe, expect, it } from "vitest";
import { FOUNDER_HOUSE as level } from "../src/levels.js";
import { compile, createState, perception, replay, revive, step, summarize, DT, WALK_SPEED, SPRINT_MAX } from "../web/sneak-core.js";
import { planWinningRun, type Log } from "./sneak-plan.js";

describe("level data", () => {
  it("has a rectangular grid and valid coordinates", () => {
    const c = compile(level);
    expect(c.cols).toBe(26);
    for (const row of level.rows) expect(row.length).toBe(26);
    const free = (x: number, y: number) => !c.solids.some((r: { x: number; y: number; w: number; h: number }) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
    expect(free(level.start.x, level.start.y)).toBe(true);
    expect(free(level.exit.x, level.exit.y)).toBe(true);
    for (const g of level.guards) {
      expect(g.routes.length).toBeGreaterThanOrEqual(3);
      for (const route of g.routes) {
        expect([route[0]!.x, route[0]!.y]).toEqual([g.routes[0]![0]!.x, g.routes[0]![0]!.y]); // every patrol starts at the guard's post
        for (const p of route) expect(free(p.x, p.y), `${g.id} waypoint ${p.x},${p.y}`).toBe(true);
      }
    }
    expect(level.loot.filter(l => l.required)).toHaveLength(2);
  });
});

describe("simulation", () => {
  it("walls stop the player and walking is slower than running", () => {
    const state = createState(level);
    state.player.x = 8; state.player.y = 14.5; // just outside the front wall, away from the door
    for (let i = 0; i < 120; i++) step(level, state, { mx: 0, my: -100, run: false });
    expect(state.player.y).toBeGreaterThan(14); // the wall occupies y 13..14; the player cannot enter it
    const walk = createState(level), run = createState(level);
    for (let i = 0; i < 60; i++) { step(level, walk, { mx: 0, my: -100, run: false }); step(level, run, { mx: 0, my: -100, run: true }); }
    expect(level.start.y - walk.player.y).toBeCloseTo(WALK_SPEED, 1);
    expect(level.start.y - run.player.y).toBeGreaterThan(level.start.y - walk.player.y + 1.5);
  });

  it("limits sprint to three seconds and recharges it while walking", () => {
    const s = createState(level);
    for (let i = 0; i < 60 * 4; i++) step(level, s, { mx: 0, my: -100, run: true });
    expect(s.player.sprint).toBeCloseTo(0, 8);
    expect(s.player.run).toBe(false);
    for (let i = 0; i < 60; i++) step(level, s, { mx: 0, my: 0, run: false });
    expect(s.player.sprint).toBeCloseTo(1, 3);
    expect(SPRINT_MAX).toBe(3);
  });

  it("hedges hide the player and a guard spots one in the open", () => {
    const s = createState(level);
    s.player.x = 6; s.player.y = 15.5; step(level, s, { mx: 0, my: 0, run: false });
    expect(s.hidden).toBe(true);
    const founder = s.guards[0]!;
    const per = perception(level, founder, founder.x + 3, founder.y, false, false);
    expect(per.sees).toBe(true);
    expect(perception(level, founder, founder.x + 3, founder.y, false, true).sees).toBe(false);
  });

  it("catches a player who stands in the hall", () => {
    const s = createState(level);
    s.player.x = 12; s.player.y = 8.4;
    for (let i = 0; i < 600 && s.status === "playing"; i++) step(level, s, { mx: 0, my: 0, run: false });
    expect(s.status).toBe("caught");
    expect(summarize(level, s).score).toBe(0);
  });

  it("guards pursue a heard runner, but cannot catch by sound alone", () => {
    const s = createState(level);
    const founder = s.guards[0]!;
    // Behind the Founder's back, 5 tiles away in the open hall: out of his cone, but running is heard and walking is not.
    founder.hx = -1; founder.hy = 0;
    s.player.x = founder.x + 5; s.player.y = 8.4; s.hidden = false;
    const walk = structuredClone(s), run = structuredClone(s);
    const founderStart = { x: founder.x, y: founder.y };
    for (let i = 0; i < 60; i++) { step(level, walk, { mx: 100, my: 0, run: false }); step(level, run, { mx: 100, my: 0, run: true }); }
    expect(walk.maxMeter).toBeLessThan(0.05);
    expect(run.maxMeter).toBeGreaterThan(0.3);
    expect(run.guards[0]!.hold).toBeGreaterThan(0);
    expect(Math.hypot(run.guards[0]!.x - founderStart.x, run.guards[0]!.y - founderStart.y)).toBeGreaterThan(0.4);
    // Noise through a wall is quieter: the roommate in the living room does not hear someone sprinting in the foyer.
    const far = createState(level);
    far.player.x = 12; far.player.y = 11.5;
    for (let i = 0; i < 90; i++) step(level, far, { mx: 100, my: 0, run: true });
    expect(far.guards[1]!.meter).toBe(0);
  });

  it("guards walk several different patrols, in turn", () => {
    const s = createState(level);
    const seen = new Set<string>();
    for (let i = 0; i < 60 * 150; i++) {
      s.player.x = 1.5; s.player.y = 16.5; s.hidden = true; // parked far away so nothing disturbs them
      step(level, s, { mx: 0, my: 0, run: false });
      for (const g of s.guards) seen.add(`${g.id}:${g.route}`);
    }
    for (const g of level.guards) expect([...seen].filter(k => k.startsWith(g.id)).length).toBe(g.routes.length);
  });

  it("is deterministic when replayed", () => {
    const log: Log = [[0, 0, -100, 0], [90, 100, 0, 1], [140, 0, 0, 0], [200, -50, 50, 0]];
    const a = replay(level, log, 900), b = replay(level, log, 900);
    expect(a.player).toEqual(b.player);
    expect(a.guards).toEqual(b.guards);
  });

  it("Smoke Grenade resumes a caught run once, unseen for a few seconds, and replays identically", () => {
    const place = (smokes: number) => {
      const s = createState(level, smokes), g = s.guards[0]!;
      s.player.x = g.x + g.hx * 0.3; s.player.y = g.y + g.hy * 0.3; // point blank: instant capture
      return s;
    };
    const plain = place(0); step(level, plain, { mx: 0, my: 0, run: false });
    expect(plain.status).toBe("caught");
    expect(revive(plain)).toBe(false);
    const s = place(1); step(level, s, { mx: 0, my: 0, run: false });
    expect(s.status).toBe("caught");
    expect(revive(s)).toBe(true);
    expect(s.status).toBe("playing");
    for (let i = 0; i < 60; i++) step(level, s, { mx: 0, my: 0, run: false });
    expect(s.status).toBe("playing");
    expect(revive(s)).toBe(false);
  });

  it("replay applies the grenade marker only when a grenade is owned", () => {
    const probe = createState(level, 1), g = probe.guards[0]!;
    const start = { x: g.x + g.hx * 0.3, y: g.y + g.hy * 0.3 };
    const lvl = { ...level, start };
    const log = [[0, 0, 0, 0], [1, 0, 0, 0, 1]] as unknown as Log;
    expect(replay(lvl, log, 120, 0).status).toBe("caught");
    const withSmoke = replay(lvl, log, 120, 1);
    expect(withSmoke.tick).toBe(120);
  });

  it("cannot leave early: the exit needs both RAM sticks", () => {
    const s = createState(level);
    s.player.x = level.exit.x; s.player.y = level.exit.y;
    step(level, s, { mx: 0, my: 0, run: false });
    expect(s.status).toBe("playing");
  });

  it("allows extraction through the Welcome entrance after acquiring RAM", () => {
    const s = createState(level);
    s.taken = level.loot.map(l => !!l.required);
    const exit = level.alternateExits![0]!;
    s.player.x = exit.x; s.player.y = exit.y;
    step(level, s, { mx: 0, my: 0, run: false });
    expect(s.status).toBe("won");
  });
});

/** Proof that the level can be beaten by timing alone, with the server replaying only the input log. */
describe("solvability", () => {
  it("has a stealthy winning route", { timeout: 120_000 }, () => {
    const { log, state } = planWinningRun();
    expect(state.status).toBe("won");
    expect(state.maxMeter).toBeLessThan(0.05);
    const verified = replay(level, log);
    expect(verified.status).toBe("won");
    expect(verified.tick).toBe(state.tick);
    const result = summarize(level, verified);
    expect(result.medals.undetected).toBe(true);
    console.log(`plan: win in ${(state.tick * DT).toFixed(1)}s, ${log.length} input changes, medals`, result.medals);
  });
});
