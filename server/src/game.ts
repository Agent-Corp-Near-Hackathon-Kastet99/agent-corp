import { randomBytes } from "node:crypto";
import { HOUSE_01 } from "./levels.js";
import type { Store } from "./store.js";
import { initial, step } from "../web/heist-core.js";
import { startRealtime, tickRealtime, TICK_MS } from "../web/realtime-core.js";

type Session = { account: string; state: ReturnType<typeof initial>; started: number; expires: number; realtime?: { updated: number; input: { direction: string | null; sprint: boolean } } };
/** Server-owned demo sessions and authoritative game transitions. Sessions expire after 12 hours. */
export class GameSessions {
  private sessions = new Map<string, Session>();
  constructor(private store: Store, private now = () => Date.now()) {}
  create(account: string) {
    const now = this.now();
    for (const [key, session] of this.sessions) if (session.expires <= now) this.sessions.delete(key);
    if (this.sessions.size >= 1000) throw new Error("Game session capacity reached");
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, { account, state: initial(HOUSE_01), started: now, expires: now + 12 * 60 * 60_000 });
    return token;
  }
  private get(token: string) {
    const session = this.sessions.get(token);
    if (!session || session.expires <= this.now()) { this.sessions.delete(token); throw new Error("Game session expired; open the demo pass again"); }
    return session;
  }
  current(token: string) { const s = this.get(token); return { account: s.account, level: structuredClone(HOUSE_01), state: structuredClone(s.state), best: this.store.bestScore(s.account, HOUSE_01.id) ?? null }; }
  restart(token: string) { const s = this.get(token); s.state = initial(HOUSE_01); s.started = this.now(); delete s.realtime; return this.current(token); }
  move(token: string, input: unknown) {
    if (input && typeof input === "object" && !Array.isArray(input)) {
      const command = input as Record<string, unknown>;
      if (command.mode !== "realtime" || ![null, "up", "down", "left", "right"].includes(command.direction as string | null) || typeof command.sprint !== "boolean") throw new Error("invalid move");
      const s = this.get(token); const now = this.now();
      if (!s.realtime) { s.state = startRealtime(HOUSE_01); s.started = now; s.realtime = { updated: now, input: { direction: null, sprint: false } }; }
      // Bound catch-up so a sleeping tab cannot submit minutes of movement at once.
      const ticks = Math.min(5, Math.floor(Math.max(0, now - s.realtime.updated) / TICK_MS));
      if (ticks) s.realtime.updated = now - (now - s.realtime.updated) % TICK_MS;
      for (let i = 0; i < ticks; i++) {
        const next = tickRealtime(HOUSE_01, s.state, s.realtime.input);
        if (s.state.status === "playing" && next.status === "won") this.store.addScore({ account: s.account, level: HOUSE_01.id, ms: Math.max(1, now - s.started), at: now });
        s.state = next;
      }
      s.realtime.input = { direction: command.direction as string | null, sprint: command.sprint };
      return this.current(token);
    }
    if (input !== null && !["up", "down", "left", "right", "pot"].includes(String(input))) throw new Error("invalid move");
    const s = this.get(token);
    const previous = s.state.status;
    const next = step(HOUSE_01, s.state, input);
    if (previous === "playing" && next.status === "won") this.store.addScore({ account: s.account, level: HOUSE_01.id, ms: Math.max(1, this.now() - s.started), at: this.now() });
    s.state = next;
    return this.current(token);
  }
}
