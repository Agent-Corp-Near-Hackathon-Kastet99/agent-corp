// Server-authoritative stealth simulation. One tick represents 200 ms.
import { DIRS, initial, tile, walkable, visible, route, facingOf } from './heist-core.js';
export const TICK_MS = 200;
export function startRealtime(level) {
  const s = initial(level);
  const person = r => r && ({ ...r, mode: 'patrol', target: null, search: 0, pause: 0 });
  const resident = person(s.resident), secondResident = person(s.secondResident);
  if (level.routines) {
    [resident.x, resident.y] = level.routines.tv;
    resident.facing = level.routines.tvFacing;
    [secondResident.x, secondResident.y] = level.routines.resident[0];
    secondResident.index = 0;
    secondResident.pause = level.routines.pauses[0] ?? 0;
  }
  return { ...s, resident, secondResident, stamina: 15, hidden: false };
}
const same = (a, b) => a.x === b.x && a.y === b.y;
function updateResident(level, resident, path, player, hidden, tick, { seated = false, pauses = {} } = {}) {
  if (!resident || !path) return resident;
  const r = { ...resident };
  const sees = !hidden && (same(r, player) || visible(level, r).some(p => same(p, player)));
  if (sees) { r.mode = 'chase'; r.target = { ...player }; r.search = 12; }
  else if (r.mode === 'chase') { r.search--; if (r.search <= 0) { r.mode = 'return'; r.target = null; } }
  if (r.mode === 'patrol' && seated) return r;
  if (r.mode === 'patrol' && r.pause > 0) { r.pause--; return r; }
  const interval = r.mode === 'chase' ? 2 : 3;
  if (tick % interval) return r;
  let next;
  if (r.mode === 'chase' && r.target) {
    next = route(level, r, r.target)?.[0];
  } else if (r.mode === 'return') {
    const [x, y] = path[r.index];
    next = route(level, r, { x, y })?.[0];
    if (!next) r.mode = 'patrol';
  } else {
    r.index = (r.index + 1) % path.length;
    const [x, y] = path[r.index]; next = { x, y };
    r.pause = pauses[r.index] ?? 0;
  }
  if (next) { r.facing = facingOf(r, next) ?? r.facing; r.x = next.x; r.y = next.y; }
  return r;
}
export function tickRealtime(level, state, input = {}) {
  if (state.status !== 'playing') return state;
  const s = structuredClone(state); s.tick++;
  const dir = typeof input.direction === 'string' && Object.hasOwn(DIRS, input.direction) ? DIRS[input.direction] : null;
  const sprint = !!dir && input.sprint === true && s.stamina > 0;
  if (sprint) s.stamina--; else s.stamina = Math.min(15, s.stamina + 1);
  if (dir && (sprint || s.tick % 2 === 0)) {
    const [dx, dy] = dir;
    if (walkable(level, s.player.x + dx, s.player.y + dy)) { s.player.x += dx; s.player.y += dy; }
  }
  s.hidden = tile(level, s.player.x, s.player.y) === 'H';
  for (const item of s.ram) if (!item.taken && same(item, s.player)) item.taken = true;
  const routine = level.routines;
  const tvPath = routine ? [routine.tv] : level.residentPath;
  s.resident = updateResident(level, s.resident, tvPath, s.player, s.hidden, s.tick, { seated: !!routine });
  s.secondResident = updateResident(level, s.secondResident, routine?.resident ?? level.secondResidentPath, s.player, s.hidden, s.tick, { pauses: routine?.pauses });
  if ([s.resident, s.secondResident].filter(Boolean).some(r => same(r, s.player))) s.status = 'caught';
  else if (s.ram.every(r => r.taken) && same(s.player, s.exit)) s.status = 'won';
  return s;
}
