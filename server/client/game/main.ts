import * as THREE from "three";
import type { HouseLevel } from "../../src/levels.js";
import { createState, revive, step, summarize, DT, HEAR_RANGE, RUN_SPEED, WALK_SPEED, SPRINT_MAX, ticksToMs } from "../../web/sneak-core.js";
import { Guard, Player, RouteDots, opaqueRects } from "./actors.js";
import { CameraRig, Particles, Rings } from "./fx.js";
import { Hud } from "./hud.js";
import { Input } from "./input.js";
import { World } from "./world.js";

type State = ReturnType<typeof createState>;
type Log = Array<[number, number, number, number]>;

async function api(path: string, body?: unknown) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error((data as { error?: string }).error ?? `Request failed (${res.status})`), { status: res.status });
  return data;
}

const QUIPS: Record<string, string[]> = {
  founder: ["Wait, did you sign the NDA?", "Is this a pivot?", "Who gave you access to my RAM?", "We're pre-revenue, take the couch.", "Are you from the YC batch?", "This is a stealth startup. You are not stealth enough."],
  roommate: ["Bro, you are not on our cap table.", "Dude. My RAM.", "I'm mid-standup, can this wait?", "Are you here to steal our runway?", "Did you just run into my house to steal RAM?"],
};

class Game {
  /** True once a Smoke Grenade is bought (verified payment): it resumes one capture per run. */
  owned = false;
  readonly renderer: THREE.WebGLRenderer;
  readonly world: World;
  readonly rig: CameraRig;
  readonly fx: Particles;
  readonly rings: Rings;
  readonly player = new Player();
  readonly guards: Guard[];
  readonly dots: RouteDots[][];
  readonly input: Input;
  state!: State;
  prev!: { px: number; py: number; guards: Array<{ x: number; y: number; hx: number; hy: number }> };
  log: Log = [];
  private lastKey = "";
  phase: "intro" | "play" | "caught" | "won" | "over" = "intro";
  private acc = 0;
  private time = 0;
  private last = performance.now();
  private hidden = 0;
  private dustTimer = 0;
  private ringTimer = 0;
  private stompTimer = 0;
  private told = new Set<string>();
  private caughtAt = 0;
  /** Debug only (?debug): play back a recorded input log instead of reading the keyboard. */
  bot: Log | null = null;
  private botIdx = 0;
  private botHeld = { mx: 0, my: 0, run: false };
  private velocity = new THREE.Vector3();
  private v3 = new THREE.Vector3();

  constructor(readonly level: HouseLevel, private best: number | undefined, readonly hud: Hud, canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, matchMedia("(pointer: coarse)").matches ? 1.5 : 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;
    this.world = new World(level);
    this.rig = new CameraRig(innerWidth / innerHeight);
    this.fx = new Particles(this.world.scene);
    this.rings = new Rings(this.world.scene);
    const opaque = opaqueRects(level);
    this.guards = level.guards.map(g => new Guard(g, opaque));
    this.dots = level.guards.map(g => g.routes.map(r => new RouteDots(r)));
    this.world.scene.add(this.player.root);
    for (const g of this.guards) this.world.scene.add(g.root, g.cone, g.spot, g.spot.target);
    for (const ds of this.dots) for (const d of ds) this.world.scene.add(d.mesh);
    this.input = new Input(document.getElementById("touch-zone")!, document.getElementById("run-btn")!, document.getElementById("stick-base")!, document.getElementById("stick-knob")!);
    this.input.onFirstInput = () => this.hud.hint("");
    this.hud.setTarget(level.targetMs);
    this.resize(); addEventListener("resize", () => this.resize());
    this.reset(false);
    requestAnimationFrame(t => { this.last = t; this.frame(t); });
  }

  private resize() {
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.rig.resize(innerWidth / innerHeight);
  }

  reset(start = true) {
    this.state = createState(this.level, this.owned ? 1 : 0);
    this.log = []; this.lastKey = ""; this.acc = 0; this.botIdx = 0; this.botHeld = { mx: 0, my: 0, run: false }; this.hidden = 0; this.caughtAt = 0;
    this.snapshot();
    this.world.loot.forEach((_, i) => this.world.setLootTaken(i, false));
    this.fx.clear(); this.rings.clear();
    this.rig.setPunch(0);
    this.player.showStars(false, 0); this.player.root.scale.setScalar(1); this.player.setHidden(0);
    this.rig.snap(this.state.player.x, this.state.player.y);
    this.hud.hideAll();
    if (start) { this.phase = "play"; this.input.enabled = true; this.hud.toast("GO!", 700); }
    else { this.phase = "intro"; this.input.enabled = false; }
    this.hud.hint(matchMedia("(pointer: coarse)").matches ? "Drag left side to sneak · hold RUN" : "WASD / arrows to sneak · Shift");
  }

  private snapshot() {
    const s = this.state;
    this.prev = { px: s.player.x, py: s.player.y, guards: (s.guards as Array<{ x: number; y: number; hx: number; hy: number }>).map(g => ({ x: g.x, y: g.y, hx: g.hx, hy: g.hy })) };
  }

  start() { this.phase = "play"; this.input.enabled = true; this.hud.toast("Acquire RAM. Extract through any glowing exit.", 3600); }

  private toWorld(i: number) { return this.world.lootWorldPos(i); }
  private screenOf(v: THREE.Vector3) { const p = v.clone().project(this.rig.camera); return { x: (p.x * 0.5 + 0.5) * innerWidth, y: (-p.y * 0.5 + 0.5) * innerHeight }; }

  private tick() {
    let input = this.input.read();
    if (this.bot) {
      while (this.botIdx < this.bot.length && this.bot[this.botIdx]![0] <= this.state.tick) { const e = this.bot[this.botIdx++]!; this.botHeld = { mx: e[1], my: e[2], run: e[3] === 1 }; }
      input = this.botHeld;
    }
    const key = `${input.mx},${input.my},${input.run ? 1 : 0}`;
    if (key !== this.lastKey) { this.log.push([this.state.tick, input.mx, input.my, input.run ? 1 : 0]); this.lastKey = key; }
    this.snapshot();
    step(this.level, this.state, input);
    for (const e of this.state.events as Array<{ type: string; index?: number; guard?: string }>) this.onEvent(e);
  }

  private onEvent(e: { type: string; index?: number; guard?: string }) {
    if (e.type === "loot") {
      const i = e.index!, spec = this.level.loot[i]!;
      this.world.setLootTaken(i, true);
      const p = this.toWorld(i);
      this.fx.burst(p.x, p.y, p.z, spec.required ? 26 : 16, spec.required ? 0x7dffb8 : 0xffd45c, 2.6);
      this.rings.emit(p.x, p.z, 0.2, 1.4, 0.6, spec.required ? 0x7dffb8 : 0xffd45c);
      const s = this.screenOf(p);
      this.hud.float(s.x, s.y - 30, `+${spec.value}`, spec.required ? "big" : "");
      this.hud.float(s.x, s.y - 4, spec.name, "name");
      this.hud.bump();
      const ram = this.level.loot.filter((l, j) => l.required && this.state.taken[j]).length;
      if (spec.required && ram === 1) this.hud.toast("One more RAM stick.", 2200);
      if (spec.required && ram === 2) this.hud.toast("Both sticks acquired. Extract through any glowing exit.", 3000);
      this.rig.kick(0.25);
    } else if (e.type === "alert") {
      this.rig.kick(0.35);
      this.hud.flash("rgba(255,170,40,.28)");
      const who = (this.state.guards as Array<{ id: string; sawPlayer: boolean }>).find(g => g.id === e.guard);
      if (who && !who.sawPlayer) { if (!this.told.has("heard")) { this.told.add("heard"); this.hud.toast("They heard you stomping. Walk, don't run.", 3200); } }
      else if (!this.told.has("alert")) { this.told.add("alert"); this.hud.toast("Seen! Break line of sight, the meter drains.", 3200); }
    } else if (e.type === "caught") {
      this.phase = "caught"; this.caughtAt = this.time; this.input.enabled = false;
      const p = this.state.player;
      this.rig.kick(1); this.rig.setPunch(1);
      this.fx.smoke(p.x, 0.5, p.y, 22);
      this.hud.flash("rgba(255,50,70,.55)");
      const who = (this.state.guards as Array<{ id: string; meter: number }>).reduce((a, b) => (b.meter > a.meter ? b : a));
      const quips = QUIPS[this.level.guards.find(g => g.id === who.id)!.skin]!;
      setTimeout(() => this.hud.busted(quips[Math.floor(Math.random() * quips.length)]!, () => this.reset(), {
        owned: this.owned,
        buy: async () => { const walletUrl = "/wallet.js"; const { buySmokeGrenade } = await import(/* @vite-ignore */ walletUrl); await buySmokeGrenade(); this.owned = true; this.state.smokes = 1; },
        use: () => this.useSmoke(),
      }), 850);
    } else if (e.type === "won") {
      this.phase = "won"; this.input.enabled = false;
      const x = this.level.exit.x, z = this.level.exit.y;
      for (const c of [0x7dffb8, 0xffd45c, 0xff7aa8, 0x8fb4ff]) this.fx.burst(x, 0.8, z, 18, c, 3.4);
      this.rings.emit(x, z, 0.3, 2.4, 0.9, 0x7dffb8);
      this.finish();
    }
  }

  /** Smoke Grenade after a capture: resume on the spot, unseen for a few seconds. The use is logged so the server replays it. */
  private useSmoke() {
    if (this.phase !== "caught") return;
    this.owned = false;
    this.state.smokes = 1;
    if (!revive(this.state)) return;
    this.log.push([this.state.tick, 0, 0, 0, 1] as unknown as Log[number]); this.lastKey = "";
    this.phase = "play"; this.input.enabled = true; this.rig.setPunch(0);
    const p = this.state.player;
    this.fx.smoke(p.x, 0.5, p.y, 40);
    this.hud.flash("rgba(200,210,230,.5)");
    this.hud.toast("Smoke Grenade! Unseen for 3 seconds. Move!", 3000);
    this.rig.kick(0.5);
  }

  private async finish() {
    const result = summarize(this.level, this.state);
    const view = { won: true, ms: result.ms, targetMs: this.level.targetMs, lootPct: result.lootPct, loot: result.loot, lootTotal: result.lootTotal, score: result.score, medals: result.medals, best: this.best };
    setTimeout(() => {
      this.hud.results(view, () => this.reset());
      api("/api/game/run", { log: this.log }).then((r: { best?: { ms: number } }) => {
        this.best = r.best?.ms ?? this.best;
      }).catch(() => {});
    }, 900);
  }

  private frame(now: number) {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now; this.time += dt;
    if (this.phase === "play") {
      this.acc += dt;
      while (this.acc >= DT && this.state.status === "playing") { this.tick(); this.acc -= DT; }
      if (this.state.status !== "playing") this.acc = 0;
    }
    this.render(dt);
    requestAnimationFrame(t => this.frame(t));
  }

  private render(dt: number) {
    const s = this.state, alpha = this.phase === "play" ? Math.min(1, this.acc / DT) : 1;
    const lerp = (a: number, b: number) => a + (b - a) * alpha;
    const p = s.player;
    const px = lerp(this.prev.px, p.x), py = lerp(this.prev.py, p.y);
    const speed = p.moving ? (p.run ? RUN_SPEED : WALK_SPEED) : 0;
    this.player.root.position.set(px, 0, py);
    this.player.animate(dt, this.phase === "caught" ? 0 : speed, Math.atan2(p.fx, p.fy), this.time);
    this.hidden += ((s.hidden || s.smoke > 0 ? 1 : 0) - this.hidden) * Math.min(1, dt * 10);
    this.player.setHidden(this.hidden);
    this.player.showStars(this.phase === "caught", this.time);
    if (this.phase === "caught") { const t = Math.min(1, (this.time - this.caughtAt) * 4); this.player.body.scale.set(1 + 0.15 * t, 1 - 0.25 * t, 1 + 0.15 * t); this.rig.setPunch(Math.max(0, 1 - (this.time - this.caughtAt) / 2.2)); }
    else this.player.body.scale.set(1, 1 - this.hidden * 0.35, 1);

    // footsteps: dust and a noise ring when running
    if (this.phase === "play" && p.moving && p.run) {
      this.dustTimer -= dt; this.ringTimer -= dt;
      if (this.dustTimer <= 0) { this.dustTimer = 0.07; this.fx.emit({ x: px - p.fx * 0.2, y: 0.08, z: py - p.fy * 0.2, vx: -p.fx * 0.4 + (Math.random() - 0.5) * 0.5, vy: 0.3, vz: -p.fy * 0.4 + (Math.random() - 0.5) * 0.5, life: 0.5, size: 0.22, grow: 1.4, color: 0xd9d2c4, opacity: 0.5, drag: 2 }); }
      this.stompTimer -= dt;
      if (this.stompTimer <= 0) { this.stompTimer = 0.22; this.rings.emit(px, py, 0.2, 1.3, 0.35, 0xffb066); }
      if (this.ringTimer <= 0) { this.ringTimer = 0.6; this.rings.emit(px, py, 0.4, HEAR_RANGE, 0.85, 0xff7a3d); }
    }
    if (this.hidden > 0.6 && Math.random() < dt * 8) this.fx.emit({ x: px + (Math.random() - 0.5) * 0.5, y: 0.5, z: py + (Math.random() - 0.5) * 0.5, vy: 0.6, life: 0.7, size: 0.1, color: 0x7fe38a, opacity: 0.8, gravity: -0.5 });

    // guards
    let alerted = false;
    this.guards.forEach((g, i) => {
      const cur = s.guards[i]!, was = this.prev.guards[i]!;
      const gx = lerp(was.x, cur.x), gy = lerp(was.y, cur.y);
      let hx = lerp(was.hx, cur.hx), hy = lerp(was.hy, cur.hy);
      const hl = Math.hypot(hx, hy) || 1; hx /= hl; hy /= hl;
      g.root.position.set(gx, 0, gy);
      const moved = Math.hypot(cur.x - was.x, cur.y - was.y) / DT;
      g.animate(dt, this.phase === "play" ? moved : 0, Math.atan2(hx, hy), this.time);
      g.updateCone(gx, gy, hx, hy, cur.meter, false);
      g.setAlert(cur.meter, !cur.sawPlayer);
      if (cur.meter > 0.04) alerted = true;
      this.dots[i]!.forEach((d, j) => { d.mesh.visible = j === cur.route; });
      this.dots[i]![cur.route]!.update(gx, gy, cur.next, cur.meter > 0.04);
    });
    void alerted;

    // objective, markers and HUD
    const required = this.level.loot.map((l, i) => ({ l, i })).filter(({ l, i }) => l.required && !s.taken[i]);
    let target: THREE.Vector3, label: string;
    if (required.length) {
      const nearest = required.reduce((a, b) => (Math.hypot(a.l.x - p.x, a.l.y - p.y) < Math.hypot(b.l.x - p.x, b.l.y - p.y) ? a : b));
      target = this.toWorld(nearest.i); label = "RAM";
    } else { target = new THREE.Vector3(this.level.exit.x, 0.9, this.level.exit.y); label = "EXIT"; }
    this.velocity.set(p.moving ? p.fx * speed : 0, 0, p.moving ? p.fy * speed : 0);
    this.rig.update(dt, px, py, this.velocity.x, this.velocity.z, p.moving && p.run, this.time);
    this.world.update(this.time, dt, this.rig.camera, this.v3.set(px, 0.6, py), target);
    const cam = this.rig.camera;
    const nd = (v: THREE.Vector3) => { const q = v.clone().project(cam); return { x: q.x, y: q.y, behind: q.z > 1 }; };
    if (this.phase === "play") {
      const o = nd(target);
      this.hud.mark("objective", o.behind ? -o.x : o.x, o.behind ? -o.y : o.y, label);
      this.guards.forEach((g, i) => {
        const q = nd(this.v3.set(g.root.position.x, 1, g.root.position.z));
        const near = Math.hypot(g.root.position.x - px, g.root.position.z - py) < 9;
        const off = near && (Math.abs(q.x) > 0.93 || Math.abs(q.y) > 0.9 || q.behind);
        this.hud.mark(i, q.behind ? -q.x : q.x, q.behind ? -q.y : q.y, null, off);
      });
    } else this.hud.hideMarkers();
    const ram = this.level.loot.filter((l, i) => l.required && s.taken[i]).length;
    const ms = ticksToMs(s.tick);
    this.hud.update({ ms, loot: s.taken.filter(Boolean).length, lootTotal: this.level.loot.length, ram, ramTotal: this.level.loot.filter(l => l.required).length, objectiveText: required.length ? `Acquire RAM  ${ram}/2` : "Extract · any glowing exit", late: ms > this.level.targetMs, sprint: p.sprint, sprintMax: SPRINT_MAX });

    this.fx.update(dt); this.rings.update(dt);
    this.renderer.render(this.world.scene, cam);
  }
}

async function boot() {
  const hud = new Hud(document.getElementById("hud")!);
  const canvas = document.getElementById("scene") as HTMLCanvasElement;
  try {
    await api("/api/demo/session", {});
    const data = (await api("/api/game/levels/founder-house")) as { level: HouseLevel; best?: { ms: number } };
    const game = new Game(data.level, data.best?.ms, hud, canvas);
    hud.intro(data.best?.ms, () => game.start());
    if (location.search.includes("debug")) (window as unknown as { __heist: Game }).__heist = game;
    document.documentElement.classList.add("ready");
  } catch (e) {
    hud.locked((e as Error).message);
  }
}
void boot();
