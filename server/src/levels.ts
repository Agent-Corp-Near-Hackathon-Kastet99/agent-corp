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

/**
 * Continuous-movement level for the 3D game. The grid is the authoring format only: web/sneak-core.js
 * merges it into collision rectangles. Units are tiles; (0,0) is the top-left corner of the map.
 *
 * Tiles: # wall · M border bush · g garden hedge (hides) · h closet (hides) · d doorway · . floor · , grass
 *        C couch · T tv · B desk · G bean bag · K counter · F fridge · Z server rack · Y shelf · P plant · Q bathroom
 * Tall things (# F Z Y) block sight, everything else can be seen over.
 */
export type Waypoint = { x: number; y: number; wait?: number; look?: { x: number; y: number } };
/** Each route is a loop that starts and ends at its first waypoint, the guard's post. All routes of a guard share that post; the guard walks them in turn. */
export type GuardSpec = { id: string; name: string; skin: "founder" | "roommate"; speed: number; range: number; fovCos: number; face?: { x: number; y: number }; routes: Waypoint[][] };
export type LootSpec = { id: string; name: string; kind: "ram" | "gpu" | "paper" | "merch" | "watch" | "supplements" | "condoms"; x: number; y: number; value: number; required?: boolean };
export type Room = { name: string; x: number; y: number; w: number; h: number; theme: "living" | "office" | "kitchen" | "hall" | "bath" | "foyer" | "bedroom" };
export type HouseLevel = {
  id: string; name: string; rows: string[]; rooms: Room[];
  start: { x: number; y: number }; exit: { x: number; y: number; r: number };
  /** Other valid exits, visually marked the same way as the primary exit. */
  alternateExits?: Array<{ x: number; y: number; r: number; label?: string }>;
  loot: LootSpec[]; guards: GuardSpec[];
  /** Time medal threshold in ms. */
  targetMs: number;
};

const border = "M".repeat(26);
const garden = "M" + ",".repeat(24) + "M";
const hedges = "M,,,,gggg,,,,,,,,,gggg,,,M";

export const FOUNDER_HOUSE: HouseLevel = {
  id: "founder-house",
  name: "The Founder's House",
  rows: [
    border,
    "M,######################,M",
    "M,#" + "PTTT...Y" + "#" + "ZZP..Z" + "#" + "FKKK" + "#,M",
    "M,#" + ".......Y" + "#" + "......" + "#" + "...." + "d,M",
    "M,#" + ".CCC...." + "#" + "G..BB." + "d" + ".KK." + "#,M",
    "M,#" + "........" + "#" + "hG...." + "#" + "...." + "#,M",
    "M," + "#####d######dd####d###" + ",M",
    "M,#" + "P......YY..........P" + "#,M",
    "M,#" + ".".repeat(20) + "#,M",
    "M," + "###d######dd######d###" + ",M",
    "M,#" + "QQ..Q" + "#" + "h......." + "#" + "...BB" + "#,M",
    "M,#" + "....." + "#" + "........" + "#" + "...BB" + "#,M",
    "M,#" + "....h" + "#" + "P......P" + "#" + "....." + "#,M",
    "M," + "##########dd##########" + ",M",
    garden,
    hedges,
    hedges,
    garden,
    border,
  ],
  rooms: [
    { name: "Living room", x: 3, y: 2, w: 8, h: 4, theme: "living" },
    { name: "Home office", x: 12, y: 2, w: 6, h: 4, theme: "office" },
    { name: "Kitchen", x: 19, y: 2, w: 4, h: 4, theme: "kitchen" },
    { name: "Hall", x: 3, y: 7, w: 20, h: 2, theme: "hall" },
    { name: "Bathroom", x: 3, y: 10, w: 5, h: 3, theme: "bath" },
    { name: "Foyer", x: 9, y: 10, w: 8, h: 3, theme: "foyer" },
    { name: "Growth office", x: 18, y: 10, w: 5, h: 3, theme: "office" },
  ],
  start: { x: 13, y: 17.3 },
  exit: { x: 24.5, y: 3.5, r: 0.9 },
  alternateExits: [{ x: 13, y: 13.5, r: 0.9, label: "WELCOME / EXIT" }],
  loot: [
    { id: "ram-1", name: "RAM stick", kind: "ram", x: 16, y: 4, value: 500, required: true },
    { id: "ram-2", name: "RAM stick", kind: "ram", x: 16.5, y: 3.5, value: 500, required: true },
    { id: "gpu", name: "Used H100", kind: "gpu", x: 12.5, y: 3, value: 300 },
    { id: "termsheet", name: "Series A term sheet", kind: "paper", x: 5, y: 4, value: 200 },
    { id: "merch", name: "Founder's signed hoodie", kind: "merch", x: 20.5, y: 4, value: 150 },
    { id: "condoms", name: "Jensen Huang 100-condom pack", kind: "condoms", x: 20, y: 11.2, value: 250 },
    { id: "nootropics", name: "Nootropics stack", kind: "supplements", x: 5.5, y: 11.5, value: 100 },
  ],
  guards: [
    {
      id: "founder", name: "The Founder", skin: "founder", speed: 1.7, range: 5.6, fovCos: 0.72, face: { x: 1, y: 0 },
      routes: [
        // Check the office, then the east end of the hall.
        [
          { x: 4.5, y: 8.4, wait: 1.5, look: { x: 8, y: 8.4 } },
          { x: 12, y: 8.4 }, { x: 14.5, y: 8.4 }, { x: 14.5, y: 6.5 },
          { x: 14.5, y: 4, wait: 3, look: { x: 15.5, y: 2.5 } },
          { x: 14.5, y: 6.5 }, { x: 14.5, y: 8.4 },
          { x: 19.5, y: 8.4, wait: 1.5, look: { x: 21, y: 8.4 } },
        ],
        // Peek into the living room, then the bathroom.
        [
          { x: 4.5, y: 8.4, wait: 1.5, look: { x: 8, y: 8.4 } },
          { x: 7.5, y: 8.4 }, { x: 7.5, y: 6.5 },
          { x: 7.5, y: 5.2, wait: 2.5, look: { x: 6, y: 3.5 } },
          { x: 7.5, y: 6.5 }, { x: 7.5, y: 8.4 }, { x: 5.5, y: 8.4 },
          { x: 5.5, y: 10.8, wait: 2.5, look: { x: 4, y: 11.8 } },
          { x: 5.5, y: 8.4 },
        ],
        // Check the front door and the foyer.
        [
          { x: 4.5, y: 8.4, wait: 1.5, look: { x: 8, y: 8.4 } },
          { x: 13, y: 8.4 }, { x: 13, y: 10.8 },
          { x: 11, y: 11.5, wait: 2, look: { x: 9.5, y: 11 } },
          { x: 14.5, y: 11.5, wait: 2, look: { x: 16, y: 11.5 } },
          { x: 13, y: 12.3, wait: 2.5, look: { x: 13, y: 13.5 } },
          { x: 13, y: 10.8 }, { x: 13, y: 8.4 },
        ],
      ],
    },
    {
      id: "roommate", name: "The Roommate", skin: "roommate", speed: 1.4, range: 4.6, fovCos: 0.74, face: { x: 0, y: -1 },
      routes: [
        // Fridge run.
        [
          { x: 6.5, y: 3.5, wait: 5, look: { x: 6.5, y: 0.5 } },
          { x: 7.5, y: 5.5 }, { x: 7.5, y: 6.5 }, { x: 7.5, y: 8.5 }, { x: 20.5, y: 8.5 },
          { x: 20.5, y: 6.5 }, { x: 20.5, y: 3.8, wait: 4, look: { x: 19.5, y: 2.5 } },
          { x: 20.5, y: 6.5 }, { x: 20.5, y: 8.5 }, { x: 7.5, y: 8.5 }, { x: 7.5, y: 6.5 }, { x: 7.5, y: 5.5 },
        ],
        // Bathroom break.
        [
          { x: 6.5, y: 3.5, wait: 4, look: { x: 6.5, y: 0.5 } },
          { x: 7.5, y: 5.5 }, { x: 7.5, y: 6.5 }, { x: 7.5, y: 8.5 }, { x: 5.5, y: 8.5 },
          { x: 5.5, y: 10.8, wait: 3.5, look: { x: 4, y: 12 } },
          { x: 5.5, y: 8.5 }, { x: 7.5, y: 8.5 }, { x: 7.5, y: 6.5 }, { x: 7.5, y: 5.5 },
        ],
        // Chill on the office bean bags, then grab a drink.
        [
          { x: 6.5, y: 3.5, wait: 3, look: { x: 6.5, y: 0.5 } },
          { x: 7.5, y: 5.5 }, { x: 7.5, y: 6.5 }, { x: 7.5, y: 8.5 }, { x: 14.5, y: 8.5 }, { x: 14.5, y: 6.5 },
          { x: 14.5, y: 3.4, wait: 4, look: { x: 13, y: 4.6 } },
          { x: 17.5, y: 4.5 }, { x: 19.5, y: 4.5 },
          { x: 19.5, y: 3.4, wait: 3, look: { x: 21, y: 2.5 } },
          { x: 19.5, y: 5.2 }, { x: 20.5, y: 6.5 }, { x: 20.5, y: 8.5 }, { x: 7.5, y: 8.5 }, { x: 7.5, y: 6.5 }, { x: 7.5, y: 5.5 },
        ],
      ],
    },
  ],
  targetMs: 45_000,
};
