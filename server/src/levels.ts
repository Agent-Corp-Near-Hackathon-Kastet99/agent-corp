/**
 * RAM HEIST level data. Kept on the server: a level is sent only to a wallet that holds the
 * on-chain pass. The house, rooms and resident are invented.
 *
 * Tiles: # wall · . floor · D door (walkable, blocks sight) · T television (solid)
 *        S start · E exit · R RAM stick · P flowerpot (solid; knock it over from a tile beside it)
 */
export type Level = {
  id: string; name: string; rows: string[];
  /** Resident's patrol loop. Consecutive tiles are adjacent; the last is adjacent to the first. */
  residentPath: [number, number][];
  /** Game ticks per resident step. The player may move every tick. */
  residentEvery: number;
  secondResidentPath?: [number, number][];
  secondResidentEvery?: number;
  /** How far the resident sees, in tiles. */
  sight: number;
  /** Ticks the resident stays at the broken flowerpot. */
  linger: number;
  routines?: { tv: [number, number]; tvFacing: string; resident: [number, number][]; pauses: Record<number, number> };
};

const rect: [number, number][] = [];
for (let x = 5; x <= 11; x++) rect.push([x, 2]);
rect.push([11, 3], [11, 4]);
for (let x = 10; x >= 5; x--) rect.push([x, 4]);
rect.push([5, 3]);

export const HOUSE_01: Level = {
  id: "house-01",
  name: "House 01 — The Living Room Upgrade",
  rows: [
    "#############",
    "#S..#.....R.#",
    "#H..#.......#",
    "#...D....TT.#",
    "#...#.......#",
    "##D####D#####",
    "#....P#...FR#",
    "#.....D.....#",
    "#H....#....E#",
    "#############",
  ],
  residentPath: rect,
  secondResidentPath: [[8, 7], [9, 7], [10, 7], [11, 7], [11, 8], [10, 8], [9, 8], [8, 8]],
  secondResidentEvery: 3,
  residentEvery: 2,
  sight: 4,
  linger: 14,
  // The second resident walks from the bathroom through the hall to the fridge,
  // lingers there, then returns through the kitchen.
  routines: { tv: [8, 3], tvFacing: "right", resident: [[8,8],[7,8],[7,7],[8,7],[9,7],[10,7],[9,7],[8,7],[7,7],[7,8]], pauses: { 0: 8, 5: 12, 8: 5 } },
};
