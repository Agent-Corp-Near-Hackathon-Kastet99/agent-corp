// RAM HEIST continuous stealth simulation. Pure functions, no DOM, no Node APIs.
//
// The browser plays this at a fixed 60 Hz and the server replays the recorded input log with the
// exact same file to verify a win. For that to be reproducible across JS engines the simulation only
// uses + - * / and Math.sqrt (all IEEE-754 exact). No sin/cos/atan2: headings are unit vectors.
//
// Units are tiles. +x is east (screen right), +y is south (screen down).

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const WALK_SPEED = 2.2;
export const RUN_SPEED = 4.4;
export const SPRINT_MAX = 3;
export const SPRINT_RECHARGE = 1;
export const PLAYER_RADIUS = 0.27;
export const PICKUP_RADIUS = 0.85;
export const MAX_INPUT = 100;
/** Seconds of stealth a guard needs to fill the meter at point blank / at maximum range. */
export const SPOT_TIME_NEAR = 0.45;
export const SPOT_TIME_FAR = 1.45;
/** Running is loud: guards within this many tiles hear it, less through walls. */
export const HEAR_RANGE = 6.5;
export const HEAR_WALL_FACTOR = 0.55;
/** Hearing alone can only fill the meter this far, but the guard stops and looks toward the noise. */
export const HEAR_CAP = 0.6;
export const HEAR_HOLD = 2.2;

/** Grid legend. solid: blocks movement. opaque: blocks sight. hide: walkable, makes the player unseen. */
export const TILE_KINDS = {
  "#": { kind: "wall", solid: true, opaque: true },
  M: { kind: "bush", solid: true },
  g: { kind: "hedge", hide: true },
  h: { kind: "closet", hide: true },
  C: { kind: "couch", solid: true },
  T: { kind: "tv", solid: true },
  B: { kind: "desk", solid: true },
  G: { kind: "beanbag", solid: true },
  K: { kind: "counter", solid: true },
  F: { kind: "fridge", solid: true, opaque: true },
  Z: { kind: "rack", solid: true, opaque: true },
  Y: { kind: "shelf", solid: true, opaque: true },
  P: { kind: "plant", solid: true },
  Q: { kind: "fixture", solid: true },
};

const compiled = new WeakMap();

/** Turn the ASCII grid into merged rectangles. Cached per level object. */
export function compile(level) {
  const cached = compiled.get(level);
  if (cached) return cached;
  const rows = level.rows;
  const cols = rows[0].length;
  const claimed = rows.map(r => Array.from({ length: r.length }, () => false));
  const rects = [];
  for (let y = 0; y < rows.length; y++) {
    if (rows[y].length !== cols) throw new Error(`row ${y} has ${rows[y].length} columns, expected ${cols}`);
    for (let x = 0; x < cols; x++) {
      const ch = rows[y][x];
      const info = TILE_KINDS[ch];
      if (!info || claimed[y][x]) continue;
      let w = 1;
      while (x + w < cols && rows[y][x + w] === ch && !claimed[y][x + w]) w++;
      let h = 1;
      grow: while (y + h < rows.length) {
        for (let i = 0; i < w; i++) if (rows[y + h][x + i] !== ch || claimed[y + h][x + i]) break grow;
        h++;
      }
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) claimed[y + j][x + i] = true;
      rects.push({ ch, kind: info.kind, x, y, w, h, solid: !!info.solid, opaque: !!info.opaque, hide: !!info.hide });
    }
  }
  const result = {
    cols, rows: rows.length, rects,
    solids: rects.filter(r => r.solid),
    opaque: rects.filter(r => r.opaque),
    hides: rects.filter(r => r.hide),
  };
  compiled.set(level, result);
  return result;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Push a circle out of every solid rectangle it overlaps. Mutates p. */
function resolve(solids, p, r) {
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const s of solids) {
      const cx = clamp(p.x, s.x, s.x + s.w), cy = clamp(p.y, s.y, s.y + s.h);
      const dx = p.x - cx, dy = p.y - cy, d2 = dx * dx + dy * dy;
      if (d2 >= r * r) continue;
      moved = true;
      if (d2 > 1e-12) {
        const d = Math.sqrt(d2), k = (r - d) / d;
        p.x += dx * k; p.y += dy * k;
      } else {
        // Centre is inside the rectangle: leave by the nearest side.
        const l = p.x - s.x, rr = s.x + s.w - p.x, t = p.y - s.y, b = s.y + s.h - p.y;
        const m = Math.min(l, rr, t, b);
        if (m === l) p.x = s.x - r; else if (m === rr) p.x = s.x + s.w + r; else if (m === t) p.y = s.y - r; else p.y = s.y + s.h + r;
      }
    }
    if (!moved) break;
  }
}

/** True when the straight segment crosses an opaque rectangle. */
export function blocked(opaque, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  for (const r of opaque) {
    let t0 = 0, t1 = 1, hit = true;
    for (let axis = 0; axis < 2 && hit; axis++) {
      const o = axis ? y0 : x0, d = axis ? dy : dx, lo = axis ? r.y : r.x, hi = lo + (axis ? r.h : r.w);
      if (d === 0) { if (o < lo || o > hi) hit = false; continue; }
      let a = (lo - o) / d, b = (hi - o) / d;
      if (a > b) { const tmp = a; a = b; b = tmp; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) hit = false;
    }
    if (hit) return true;
  }
  return false;
}

function normalize(x, y, fx, fy) {
  const d = Math.sqrt(x * x + y * y);
  return d > 1e-9 ? [x / d, y / d] : [fx, fy];
}

/** Rotate unit heading h towards target direction by exponential approach. No trigonometry. */
function turn(g, tx, ty, rate) {
  const [ux, uy] = normalize(tx, ty, g.hx, g.hy);
  const k = Math.min(1, rate * DT);
  const [nx, ny] = normalize(g.hx + (ux - g.hx) * k, g.hy + (uy - g.hy) * k, g.hx, g.hy);
  g.hx = nx; g.hy = ny;
}

export function sanitizeInput(input) {
  const q = v => (Number.isFinite(v) ? Math.max(-MAX_INPUT, Math.min(MAX_INPUT, Math.round(v))) : 0);
  return { mx: q(input?.mx), my: q(input?.my), run: input?.run === true };
}

/** Smoke Grenade: once per run, after being caught, resume on the spot unseen and unheard for this long. */
export const SMOKE_TIME = 3;

export function createState(level, smokes = 0) {
  const c = compile(level);
  return {
    tick: 0,
    status: "playing", // playing | caught | won
    player: { x: level.start.x, y: level.start.y, fx: 0, fy: 1, moving: false, run: false, sprint: SPRINT_MAX },
    hidden: false,
    smokes: smokes > 0 ? 1 : 0, smoke: 0,
    guards: level.guards.map(g => ({
      id: g.id, x: g.routes[0][0].x, y: g.routes[0][0].y, hx: g.face?.x ?? 0, hy: g.face?.y ?? 1,
      route: 0, next: 1 % g.routes[0].length, wait: g.routes[0][0].wait ?? 0, lookAt: g.routes[0][0].look ?? null,
      meter: 0, sawPlayer: false, hold: 0, ax: null, ay: null,
    })),
    taken: level.loot.map(() => false),
    maxMeter: 0,
    events: [],
    _c: c,
  };
}

/** Does guard g see (or hear) a player standing at x,y? Returns suspicion seconds-rate inputs. */
export function perception(level, g, x, y, run, hidden) {
  const spec = level.guards.find(s => s.id === g.id);
  const c = compile(level);
  const dx = x - g.x, dy = y - g.y, d2 = dx * dx + dy * dy, dist = Math.sqrt(d2);
  let sees = false;
  if (!hidden && dist <= spec.range && dist > 1e-6) {
    const dot = g.hx * dx + g.hy * dy;
    if (dot >= spec.fovCos * dist && !blocked(c.opaque, g.x, g.y, x, y)) sees = true;
  }
  // Stomping is heard whether or not you hide, a little less through walls.
  const reach = blocked(c.opaque, g.x, g.y, x, y) ? HEAR_RANGE * HEAR_WALL_FACTOR : HEAR_RANGE;
  const hears = run && dist <= reach;
  return { sees, hears, dist, range: spec.range };
}

function stepGuard(level, state, g) {
  const spec = level.guards.find(s => s.id === g.id);
  const p = state.player;
  const smoked = state.smoke > 0;
  const per = perception(level, g, p.x, p.y, p.moving && p.run, state.hidden || smoked);
  if (smoked) per.hears = false;
  g.sawPlayer = per.sees;
  if (per.sees) g.meter += DT / (SPOT_TIME_NEAR + (SPOT_TIME_FAR - SPOT_TIME_NEAR) * (per.dist / per.range));
  if (per.hears) {
    // Heard, not seen: the meter rises to a cap and the guard stops to listen towards the noise.
    if (g.meter < HEAR_CAP) g.meter = Math.min(HEAR_CAP, g.meter + DT / 0.9);
    g.hold = HEAR_HOLD; g.ax = p.x; g.ay = p.y;
  }
  if (!per.sees && !per.hears) g.meter -= DT / 1.5;
  if (per.sees) { g.ax = p.x; g.ay = p.y; }
  if (g.meter < 0) g.meter = 0;
  if (per.dist < 0.55 && !smoked) g.meter = 1;
  if (g.meter > 1) g.meter = 1;
  if (g.meter > state.maxMeter) state.maxMeter = g.meter;

  if (g.meter > 0.04 || g.hold > 0) {
    // Something is wrong: pursue last seen/heard position, then resume patrol.
    if (!per.hears && g.hold > 0) g.hold = Math.max(0, g.hold - DT);
    const tx = g.ax ?? p.x, ty = g.ay ?? p.y;
    const dx = tx - g.x, dy = ty - g.y, dist = Math.sqrt(dx * dx + dy * dy);
    turn(g, dx, dy, 9);
    if (dist > 0.16) {
      const chase = Math.min(dist, spec.speed * 1.18 * DT);
      g.x += (dx / dist) * chase; g.y += (dy / dist) * chase;
      resolve(state._c.solids, g, PLAYER_RADIUS);
    }
    return;
  }
  g.ax = null; g.ay = null;
  const route = spec.routes[g.route];
  const wp = route[g.next];
  if (g.wait > 0) {
    g.wait -= DT;
    if (g.lookAt) turn(g, g.lookAt.x - g.x, g.lookAt.y - g.y, 4);
    return;
  }
  const dx = wp.x - g.x, dy = wp.y - g.y, dist = Math.sqrt(dx * dx + dy * dy);
  const step = spec.speed * DT;
  turn(g, dx, dy, 7);
  if (dist <= step) {
    g.x = wp.x; g.y = wp.y;
    g.wait = wp.wait ?? 0; g.lookAt = wp.look ?? null;
    if (g.next === 0) {
      // Back at the starting post: take the next patrol.
      g.route = (g.route + 1) % spec.routes.length;
      g.next = 1 % spec.routes[g.route].length;
    } else g.next = (g.next + 1) % route.length;
  } else {
    g.x += (dx / dist) * step; g.y += (dy / dist) * step;
  }
}

/** Advance one fixed tick. Mutates and returns state. */
export function step(level, state, rawInput) {
  if (state.status !== "playing") return state;
  const c = state._c ?? compile(level);
  const input = sanitizeInput(rawInput);
  state.events.length = 0;
  state.tick++;
  if (state.smoke > 0) state.smoke = Math.max(0, state.smoke - DT);

  const p = state.player;
  let ix = input.mx / MAX_INPUT, iy = input.my / MAX_INPUT;
  const mag = Math.min(1, Math.sqrt(ix * ix + iy * iy));
  p.moving = mag > 0.05;
  p.run = input.run && p.moving && p.sprint > 0;
  if (p.run) p.sprint = Math.max(0, p.sprint - DT);
  else if (!input.run) p.sprint = Math.min(SPRINT_MAX, p.sprint + SPRINT_RECHARGE * DT);
  if (p.moving) {
    const [ux, uy] = normalize(ix, iy, 0, 1);
    const speed = (p.run ? RUN_SPEED : WALK_SPEED) * Math.max(0.35, mag);
    p.x += ux * speed * DT; p.y += uy * speed * DT;
    p.fx = ux; p.fy = uy;
    resolve(c.solids, p, PLAYER_RADIUS);
  }
  state.hidden = c.hides.some(r => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h);

  for (let i = 0; i < level.loot.length; i++) {
    if (state.taken[i]) continue;
    const item = level.loot[i], dx = item.x - p.x, dy = item.y - p.y;
    if (dx * dx + dy * dy <= PICKUP_RADIUS * PICKUP_RADIUS) { state.taken[i] = true; state.events.push({ type: "loot", index: i }); }
  }

  for (const g of state.guards) {
    const before = g.meter;
    stepGuard(level, state, g);
    if (before < 0.04 && g.meter >= 0.04) state.events.push({ type: "alert", guard: g.id });
  }
  if (state.guards.some(g => g.meter >= 1)) { state.status = "caught"; state.events.push({ type: "caught" }); return state; }

  const required = level.loot.every((item, i) => !item.required || state.taken[i]);
  const exits = [level.exit, ...(level.alternateExits ?? [])];
  if (required && exits.some(exit => { const ex = exit.x - p.x, ey = exit.y - p.y; return ex * ex + ey * ey <= exit.r * exit.r; })) { state.status = "won"; state.events.push({ type: "won" }); }
  return state;
}

/** Use the Smoke Grenade after a capture: guards lose you and the run resumes. Returns false if there is none to use. */
export function revive(state) {
  if (state.status !== "caught" || state.smokes <= 0) return false;
  state.smokes = 0; state.smoke = SMOKE_TIME; state.status = "playing";
  for (const g of state.guards) { g.meter = 0; g.hold = 0; g.sawPlayer = false; g.ax = null; g.ay = null; }
  state.events.length = 0; state.events.push({ type: "smoke" });
  return true;
}

export const ticksToMs = ticks => Math.round((ticks * 1000) / TICK_RATE);

/** Results shown after a run and recorded on the server. */
export function summarize(level, state) {
  const ms = ticksToMs(state.tick);
  const total = level.loot.length;
  const got = state.taken.filter(Boolean).length;
  const lootValue = level.loot.reduce((sum, item, i) => sum + (state.taken[i] ? item.value : 0), 0);
  const medals = {
    undetected: state.maxMeter <= 0.35,
    time: state.status === "won" && ms <= level.targetMs,
    loot: got === total,
  };
  const medalCount = Object.values(medals).filter(Boolean).length;
  const timeBonus = state.status === "won" ? Math.max(0, Math.round((level.targetMs * 2 - ms) / 100)) : 0;
  return {
    status: state.status, ms, loot: got, lootTotal: total, lootPct: Math.round((got / total) * 100),
    medals, medalCount, score: state.status === "won" ? lootValue + medalCount * 250 + timeBonus : 0,
  };
}

/**
 * Replay a recorded input log: [[tick, mx, my, run], ...] sorted by tick, held until the next entry.
 * A 5-entry [tick, 0, 0, 0, 1] marks the Smoke Grenade used at the capture on that tick.
 */
export function replay(level, log, maxTicks = TICK_RATE * 240, smokes = 0) {
  const state = createState(level, smokes);
  let held = { mx: 0, my: 0, run: false }, i = 0;
  while (state.tick < maxTicks) {
    if (state.status === "caught") {
      const m = log[i];
      if (m && m.length === 5 && m[0] === state.tick && revive(state)) { i++; continue; }
      break;
    }
    if (state.status !== "playing") break;
    while (i < log.length && log[i][0] <= state.tick && log[i].length !== 5) { held = { mx: log[i][1], my: log[i][2], run: !!log[i][3] }; i++; }
    step(level, state, held);
  }
  return state;
}
