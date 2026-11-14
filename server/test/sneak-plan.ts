import { FOUNDER_HOUSE as level } from "../src/levels.js";
import { compile, createState, perception, step, PLAYER_RADIUS } from "../web/sneak-core.js";

export type Log = Array<[number, number, number, number]>;
type Rect = { x: number; y: number; w: number; h: number };

/**
 * Plan a stealthy route on a quarter-tile grid against the guards' undisturbed schedule, then drive the
 * real simulation along it. Returns the recorded input log and the finished state, so tests can prove the
 * level is beatable by timing alone and that the server accepts a genuine run.
 */
export function planWinningRun() {
    const c = compile(level);
    const CELL = 0.25, cols = c.cols * 4, rows = c.rows * 4, N = cols * rows;
    const STEP = 15, K = 400; // 0.25 s per plan step, 100 s horizon
    const center = (i: number) => ({ x: ((i % cols) + 0.5) * CELL, y: (Math.floor(i / cols) + 0.5) * CELL });
    const walkable = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const { x, y } = center(i);
      walkable[i] = c.solids.every((r: Rect) => Math.hypot(x - Math.min(Math.max(x, r.x), r.x + r.w), y - Math.min(Math.max(y, r.y), r.y + r.h)) >= PLAYER_RADIUS + 0.02) ? 1 : 0;
    }
    // Guard schedule while nothing disturbs them.
    const base = createState(level);
    base.player.x = 1.5; base.player.y = 16.5; // far corner of the garden, out of everyone's sight
    const timeline: Array<typeof base.guards> = [structuredClone(base.guards)];
    for (let k = 0; k < K; k++) {
      for (let t = 0; t < STEP; t++) step(level, base, { mx: 0, my: 0, run: false });
      timeline.push(structuredClone(base.guards));
    }
    if (base.maxMeter !== 0) throw new Error("guards noticed the parked player");

    const safe = timeline.map(guards => {
      const out = new Uint8Array(N);
      for (let i = 0; i < N; i++) {
        if (!walkable[i]) continue;
        const { x, y } = center(i);
        let ok = true;
        for (const g of guards) {
          const per = perception(level, g, x, y, false, false);
          if (per.dist > per.range + 0.6) continue;
          // keep a margin around the cone and well away from the guard's body
          const wide = perception(level, g, x + 0.3, y, false, false).sees || perception(level, g, x - 0.3, y, false, false).sees
            || perception(level, g, x, y + 0.3, false, false).sees || perception(level, g, x, y - 0.3, false, false).sees;
          if (per.sees || wide || per.dist < 1.2) { ok = false; break; }
        }
        out[i] = ok ? 1 : 0;
      }
      return out;
    });

    const required = level.loot.map((l, i) => ({ l, i })).filter(({ l }) => l.required);
    const lootMask = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const { x, y } = center(i);
      required.forEach(({ l }, bit) => { if (Math.hypot(l.x - x, l.y - y) <= 0.8) lootMask[i] |= 1 << bit; });
    }
    const start = Math.floor(level.start.y / CELL) * cols + Math.floor(level.start.x / CELL);
    const layers: Int32Array[] = [];
    const first = new Int32Array(N * 4).fill(-2); first[start * 4] = -1; layers.push(first);
    let goal = -1, goalK = -1;
    const moves = [0, 1, -1, cols, -cols, 2, -2, 2 * cols, -2 * cols];
    for (let k = 0; k < K && goal < 0; k++) {
      const cur = layers[k]!, next = new Int32Array(N * 4).fill(-2);
      for (let s = 0; s < N * 4; s++) {
        if (cur[s] === -2) continue;
        const cell = s >> 2, mask = s & 3;
        for (const m of moves) {
          const n = cell + m;
          if (n < 0 || n >= N || !walkable[n] || !safe[k + 1]![n]) continue;
          if (Math.abs(m) === 2 || Math.abs(m) === 2 * cols) { if (!walkable[cell + m / 2]) continue; }
          const nm = mask | lootMask[n]!, ns = n * 4 + nm;
          if (next[ns] !== -2) continue;
          next[ns] = s;
          const p = center(n);
          if (nm === 3 && Math.hypot(p.x - level.exit.x, p.y - level.exit.y) <= level.exit.r - 0.2) { goal = ns; goalK = k + 1; }
        }
      }
      layers.push(next);
    }
    if (goal < 0) throw new Error("no stealthy route exists");

    const route: Array<{ x: number; y: number }> = [];
    for (let k = goalK, s = goal; k >= 0; k--) { route[k] = center(s >> 2); s = layers[k]![s]!; }

    // Drive the real simulation along the plan.
    const state = createState(level);
    const log: Log = [];
    let last = "";
    const guide = (tick: number) => {
      const k = Math.min(route.length - 1, Math.floor(tick / STEP) + 1);
      const a = route[Math.min(route.length - 1, k - 1)]!, b = route[k]!;
      const f = (tick % STEP) / STEP;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    };
    while (state.status === "playing" && state.tick < goalK * STEP + 600) {
      const target = guide(state.tick + 1);
      const dx = target.x - state.player.x, dy = target.y - state.player.y, d = Math.hypot(dx, dy);
      const mag = Math.min(1, d / 0.08);
      const input = d < 0.01 ? { mx: 0, my: 0, run: false } : { mx: Math.round((dx / d) * mag * 100), my: Math.round((dy / d) * mag * 100), run: false };
      const key = `${input.mx},${input.my}`;
      if (key !== last) { log.push([state.tick, input.mx, input.my, 0]); last = key; }
      step(level, state, input);
    }
  return { log, state, goalTick: goalK * STEP };
}
