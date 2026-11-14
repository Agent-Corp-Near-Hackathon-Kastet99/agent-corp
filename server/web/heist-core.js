// RAM HEIST rules engine. Pure functions, no DOM: the browser and the tests share this file.
// A level is plain data (see server/src/levels.ts) delivered by the server to pass holders.

export const DIRS = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] };
const SOLID = new Set(["#", "T", "P", "F"]);
const OPAQUE = new Set(["#", "T", "D", "F"]);

export function tile(level, x, y) {
  return level.rows[y]?.[x] ?? "#";
}
export const walkable = (level, x, y) => !SOLID.has(tile(level, x, y));

function find(level, ch) {
  const out = [];
  level.rows.forEach((row, y) => [...row].forEach((c, x) => { if (c === ch) out.push({ x, y }); }));
  return out;
}

export function facingOf(from, to) {
  for (const [name, [dx, dy]] of Object.entries(DIRS)) if (from.x + dx === to.x && from.y + dy === to.y) return name;
  return undefined;
}

export function initial(level) {
  const [start] = find(level, "S");
  const [sx, sy] = level.residentPath[0];
  const [nx, ny] = level.residentPath[1];
  return {
    tick: 0,
    status: "playing", // playing | caught | won
    player: { x: start.x, y: start.y },
    ram: find(level, "R").map(r => ({ ...r, taken: false })),
    exit: find(level, "E")[0],
    pot: find(level, "P")[0] ? { ...find(level, "P")[0], broken: false } : null,
    secondResident: level.secondResidentPath ? { x: level.secondResidentPath[0][0], y: level.secondResidentPath[0][1], facing: facingOf({ x: level.secondResidentPath[0][0], y: level.secondResidentPath[0][1] }, { x: level.secondResidentPath[1][0], y: level.secondResidentPath[1][1] }) ?? "right", index: 0 } : null,
    resident: { x: sx, y: sy, facing: facingOf({ x: sx, y: sy }, { x: nx, y: ny }) ?? "right", mode: "patrol", index: 0, route: [], wait: 0 },
  };
}

/** Shortest walkable route between two tiles (excluding the start tile), or null. */
export function route(level, from, to) {
  const key = (x, y) => `${x},${y}`;
  const prev = new Map([[key(from.x, from.y), null]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    if (cur.x === to.x && cur.y === to.y) {
      const path = [];
      for (let n = cur; n && !(n.x === from.x && n.y === from.y); n = prev.get(key(n.x, n.y))) path.unshift(n);
      return path;
    }
    for (const [dx, dy] of Object.values(DIRS)) {
      const next = { x: cur.x + dx, y: cur.y + dy };
      if (!walkable(level, next.x, next.y) || prev.has(key(next.x, next.y))) continue;
      prev.set(key(next.x, next.y), cur);
      queue.push(next);
    }
  }
  return null;
}

function clearLine(level, from, to) {
  let x = from.x, y = from.y;
  const dx = Math.abs(to.x - x), dy = Math.abs(to.y - y);
  const sx = x < to.x ? 1 : -1, sy = y < to.y ? 1 : -1;
  let err = dx - dy;
  while (!(x === to.x && y === to.y)) {
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
    if (x === to.x && y === to.y) break;
    if (OPAQUE.has(tile(level, x, y))) return false;
  }
  return true;
}

/** Tiles the resident can see: a cone in the facing direction, cut off by walls, doors and the TV. */
export function visible(level, resident) {
  const [fx, fy] = DIRS[resident.facing];
  const out = [];
  for (let d = 1; d <= level.sight; d++) {
    const spread = d >= 2 ? 1 : 0;
    for (let s = -spread; s <= spread; s++) {
      const t = { x: resident.x + fx * d + fy * s, y: resident.y + fy * d + fx * s };
      if (OPAQUE.has(tile(level, t.x, t.y)) || tile(level, t.x, t.y) === "P") continue;
      if (clearLine(level, resident, t)) out.push(t);
    }
  }
  return out;
}

export function seen(level, state) {
  const { player, resident } = state;
  if (player.x === resident.x && player.y === resident.y) return true;
  return [resident, state.secondResident].filter(Boolean).some(r => (r.x === player.x && r.y === player.y) || visible(level, r).some(t => t.x === player.x && t.y === player.y));
}

export const nearPot = state => !!state.pot && !state.pot.broken
  && Math.abs(state.pot.x - state.player.x) + Math.abs(state.pot.y - state.player.y) === 1;

function moveResident(level, state) {
  const r = { ...state.resident };
  const walkTo = next => { r.facing = facingOf(r, next) ?? r.facing; r.x = next.x; r.y = next.y; };
  if (r.mode === "patrol") {
    r.index = (r.index + 1) % level.residentPath.length;
    const [x, y] = level.residentPath[r.index];
    walkTo({ x, y });
  } else if (r.mode === "investigate") {
    if (r.route.length) { const [next, ...rest] = r.route; walkTo(next); r.route = rest; }
    else if (r.wait > 0) r.wait -= 1;
    else {
      const [x, y] = level.residentPath[r.index];
      r.mode = "return";
      r.route = route(level, r, { x, y }) ?? [];
    }
  } else if (r.mode === "return") {
    if (r.route.length) { const [next, ...rest] = r.route; walkTo(next); r.route = rest; }
    if (!r.route.length) r.mode = "patrol";
  }
  return r;
}

/**
 * Advance one tick. `input` is a direction name, "pot", or null (wait).
 * Returns a new state; the given state is not modified.
 */
export function step(level, state, input) {
  if (state.status !== "playing") return state;
  const next = { ...state, tick: state.tick + 1, player: { ...state.player }, ram: state.ram.map(r => ({ ...r })), pot: state.pot && { ...state.pot } };

  if (input === "pot" && nearPot(state)) {
    next.pot.broken = true;
    // The resident walks to the free tile beside the pot that is closest to them.
    const spots = Object.values(DIRS).map(([dx, dy]) => ({ x: state.pot.x + dx, y: state.pot.y + dy })).filter(s => walkable(level, s.x, s.y));
    const routes = spots.map(s => route(level, state.resident, s)).filter(Boolean).sort((a, b) => a.length - b.length);
    if (routes[0]) next.resident = { ...state.resident, mode: "investigate", route: routes[0], wait: level.linger };
  } else if (DIRS[input]) {
    const [dx, dy] = DIRS[input];
    if (walkable(level, state.player.x + dx, state.player.y + dy)) next.player = { x: state.player.x + dx, y: state.player.y + dy };
  }

  for (const r of next.ram) if (!r.taken && r.x === next.player.x && r.y === next.player.y) r.taken = true;
  if (next.tick % level.residentEvery === 0) next.resident = moveResident(level, next);

  if (next.secondResident && next.tick % level.secondResidentEvery === 0) {
    const r = next.secondResident;
    const index = (r.index + 1) % level.secondResidentPath.length;
    const [x, y] = level.secondResidentPath[index];
    next.secondResident = { ...r, x, y, index, facing: facingOf(r, { x, y }) ?? r.facing };
  }
  if (seen(level, next)) next.status = "caught";
  else if (next.ram.every(r => r.taken) && next.player.x === next.exit.x && next.player.y === next.exit.y) next.status = "won";
  return next;
}

/**
 * Breadth-first search for a winning input sequence that never uses the flowerpot.
 * Proves a level can be finished by timing alone. Returns the inputs, or null.
 */
export function solve(level, maxTicks = 400) {
  const a = level.residentPath.length * level.residentEvery, b = level.secondResidentPath ? level.secondResidentPath.length * level.secondResidentEvery : 1;
  const gcd = (x, y) => y ? gcd(y, x % y) : x;
  const cycle = a * b / gcd(a, b);
  const key = s => `${s.player.x},${s.player.y},${s.ram.map(r => (r.taken ? 1 : 0)).join("")},${s.tick % cycle}`;
  const start = initial(level);
  const seenKeys = new Set([key(start)]);
  let frontier = [{ state: start, inputs: [] }];
  for (let depth = 0; depth < maxTicks && frontier.length; depth++) {
    const nextFrontier = [];
    for (const { state, inputs } of frontier) {
      for (const input of [null, "up", "right", "down", "left"]) {
        const s = step(level, state, input);
        if (s.status === "caught") continue;
        if (s.status === "won") return [...inputs, input];
        const k = key(s);
        if (seenKeys.has(k)) continue;
        seenKeys.add(k);
        nextFrontier.push({ state: s, inputs: [...inputs, input] });
      }
    }
    frontier = nextFrontier;
  }
  return null;
}
