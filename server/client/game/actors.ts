import * as THREE from "three";
import type { GuardSpec, Waypoint } from "../../src/levels.js";
import { compile } from "../../web/sneak-core.js";
import { box, mat } from "./world.js";
import { softDot, labelTexture } from "./textures.js";

type Rect = { x: number; y: number; w: number; h: number };

function capsule(r: number, len: number, m: THREE.Material) {
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 6, 12), m);
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}
function sphere(r: number, m: THREE.Material, sx = 1, sy = 1, sz = 1) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 18, 14), m);
  mesh.scale.set(sx, sy, sz); mesh.castShadow = true;
  return mesh;
}

function blobShadow(radius: number) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2), new THREE.MeshBasicMaterial({ map: softDot("rgba(0,0,0,.55)", "rgba(0,0,0,0)"), transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.03;
  m.userData.noFade = true; // its alpha comes from its texture; never touch its transparency
  return m;
}

/** A walking character: root at the feet, local +z is forward. */
class Walker {
  root = new THREE.Group();
  body = new THREE.Group();
  armL = new THREE.Group();
  armR = new THREE.Group();
  legL = new THREE.Group();
  legR = new THREE.Group();
  head = new THREE.Group();
  phase = 0;
  lean = 0;
  protected parts: THREE.Mesh[] = [];
  constructor() {
    this.root.add(this.body, blobShadow(0.42));
  }
  /** speed in tiles per second. */
  animate(dt: number, speed: number, heading: number, time: number) {
    this.phase += dt * (speed * 3.2);
    const swing = Math.min(1, speed / 2) * 0.9;
    const s = Math.sin(this.phase);
    this.legL.rotation.x = s * swing; this.legR.rotation.x = -s * swing;
    this.armL.rotation.x = -s * swing * 0.9; this.armR.rotation.x = s * swing * 0.9;
    this.body.position.y = Math.abs(Math.sin(this.phase)) * 0.045 * Math.min(1, speed) + Math.sin(time * 2.3) * 0.006;
    const targetLean = Math.min(0.5, speed * 0.09);
    this.lean += (targetLean - this.lean) * Math.min(1, dt * 10);
    this.body.rotation.x = this.lean;
    // turn smoothly toward heading
    let d = heading - this.root.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.root.rotation.y += d * Math.min(1, dt * 12);
  }
  private faded = false;
  setOpacity(o: number) {
    const fade = o < 0.999;
    const flip = fade !== this.faded;
    this.faded = fade;
    this.root.traverse(c => {
      const m = c as THREE.Mesh;
      if (!m.isMesh || m.userData.noFade) return;
      const apply = (mm: THREE.Material) => { if (flip) { mm.transparent = fade; mm.needsUpdate = true; } mm.opacity = o; };
      Array.isArray(m.material) ? m.material.forEach(apply) : apply(m.material);
    });
  }
}

export class Player extends Walker {
  stars: THREE.Sprite[] = [];
  private glow: THREE.Sprite;
  private visor!: THREE.Mesh;
  constructor() {
    super();
    const hoodie = mat(0x5a45d6, 0.8), trim = mat(0x2fd6c0, 0.5, 0, 0x2fd6c0, 0.25), skin = mat(0xf2c7a0, 0.7), dark = mat(0x1c1b2e, 0.6), beanie = mat(0x1e2a4a, 0.9), pom = mat(0xff8a3d, 0.8);
    const torso = capsule(0.2, 0.22, hoodie); torso.position.y = 0.52; this.body.add(torso);
    // glowing terminal prompt on the back
    const prompt = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.16), new THREE.MeshBasicMaterial({ map: labelTexture(">_", "#7dffe9", "#10142a", "bold 70px monospace", 160, 100), toneMapped: false }));
    prompt.position.set(0, 0.54, -0.205); prompt.rotation.y = Math.PI; prompt.userData.noFade = false; this.body.add(prompt);
    const pack = box(this.body, 0.26, 0.28, 0.1, trim, 0, 0.42, -0.2, 0.04); pack.castShadow = true;
    // head
    this.head.position.y = 0.92; this.body.add(this.head);
    this.head.add(sphere(0.19, skin));
    const cap = sphere(0.205, beanie, 1, 0.9, 1); cap.position.set(0, 0.04, -0.02); this.head.add(cap);
    const cuff = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.035, 8, 20), pom); cuff.rotation.x = Math.PI / 2; cuff.position.y = 0.0; cuff.scale.set(1, 1.05, 1); this.head.add(cuff);
    const ball = sphere(0.07, pom); ball.position.set(0, 0.24, 0); this.head.add(ball);
    // domino mask with glowing eyes
    this.visor = box(this.head, 0.34, 0.09, 0.08, dark, 0, -0.04, 0.12, 0.03);
    for (const x of [-0.07, 0.07]) { const e = sphere(0.032, mat(0x7dffe9, 0.3, 0, 0x7dffe9, 2.5)); e.position.set(x, 0.0, 0.17); this.head.add(e); }
    // arms and legs (pivot at shoulder / hip)
    for (const [arm, x] of [[this.armL, -0.27], [this.armR, 0.27]] as const) {
      arm.position.set(x, 0.66, 0); const a = capsule(0.07, 0.2, hoodie); a.position.y = -0.14; arm.add(a);
      const hand = sphere(0.065, skin); hand.position.y = -0.3; arm.add(hand); this.body.add(arm);
    }
    for (const [leg, x] of [[this.legL, -0.1], [this.legR, 0.1]] as const) {
      leg.position.set(x, 0.3, 0); const l = capsule(0.08, 0.14, dark); l.position.y = -0.1; leg.add(l);
      const shoe = box(leg, 0.15, 0.09, 0.24, mat(0xff8a3d, 0.7), 0, -0.3, 0.04, 0.04); void shoe; this.body.add(leg);
    }
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDot("rgba(125,255,233,.5)", "rgba(125,255,233,0)"), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.55 }));
    this.glow.scale.setScalar(1.5); this.glow.position.y = 0.5; this.glow.userData.noFade = true; this.root.add(this.glow);
    const starTex = new THREE.CanvasTexture(makeStar());
    for (let i = 0; i < 3; i++) { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: starTex, depthWrite: false, transparent: true })); s.scale.setScalar(0.28); s.visible = false; this.root.add(s); this.stars.push(s); }
  }
  showStars(on: boolean, time: number) {
    this.stars.forEach((s, i) => {
      s.visible = on;
      const a = time * 4 + (i * Math.PI * 2) / 3;
      s.position.set(Math.cos(a) * 0.32, 1.28 + Math.sin(a * 2) * 0.03, Math.sin(a) * 0.32);
    });
  }
  setHidden(hidden: number) { this.body.scale.y = 1 - hidden * 0.35; this.setOpacity(1 - hidden * 0.55); this.glow.visible = hidden < 0.5; }
}

function makeStar() {
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d")!; g.translate(32, 32); g.fillStyle = "#ffe27a"; g.strokeStyle = "#b87a00"; g.lineWidth = 4; g.lineJoin = "round";
  g.beginPath(); for (let i = 0; i < 10; i++) { const a = (i * Math.PI) / 5 - Math.PI / 2, r = i % 2 ? 11 : 27; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); } g.closePath(); g.fill(); g.stroke();
  return c;
}

/** Distance along a ray to the nearest opaque rectangle. */
function rayDistance(opaque: Rect[], ox: number, oy: number, dx: number, dy: number, max: number) {
  let best = max;
  for (const r of opaque) {
    let t0 = 0, t1 = best, hit = true;
    for (let axis = 0; axis < 2 && hit; axis++) {
      const o = axis ? oy : ox, d = axis ? dy : dx, lo = axis ? r.y : r.x, hi = lo + (axis ? r.h : r.w);
      if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) hit = false; continue; }
      let a = (lo - o) / d, b = (hi - o) / d;
      if (a > b) { const t = a; a = b; b = t; }
      t0 = Math.max(t0, a); t1 = Math.min(t1, b);
      if (t0 > t1) hit = false;
    }
    if (hit && t0 < best) best = t0;
  }
  return best;
}

export class Guard extends Walker {
  readonly cone: THREE.Mesh;
  readonly alert: THREE.Sprite;
  /** Flashlight: the only light a guard brings into the dark house. */
  readonly spot: THREE.SpotLight;
  private coneGeo: THREE.BufferGeometry;
  private alertCanvas = document.createElement("canvas");
  private alertTex: THREE.CanvasTexture;
  private lastBucket = -1;
  private rays = 34;
  readonly halfAngle: number;
  constructor(readonly spec: GuardSpec, private opaque: Rect[]) {
    super();
    this.halfAngle = Math.acos(spec.fovCos);
    if (spec.skin === "founder") this.founder(); else this.roommate();
    // vision cone
    const n = this.rays;
    this.coneGeo = new THREE.BufferGeometry();
    this.coneGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array((n + 2) * 3), 3));
    this.coneGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array((n + 2) * 4), 4));
    const idx: number[] = [];
    for (let i = 1; i <= n; i++) idx.push(0, i, i + 1);
    this.coneGeo.setIndex(idx);
    this.cone = new THREE.Mesh(this.coneGeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
    this.cone.frustumCulled = false; this.cone.renderOrder = 3;
    this.spot = new THREE.SpotLight(0xffe2a8, 55, spec.range + 1.5, this.halfAngle * 1.1, 0.75, 1.1);
    this.spot.castShadow = false;
    // "!" meter
    this.alertCanvas.width = this.alertCanvas.height = 128;
    this.alertTex = new THREE.CanvasTexture(this.alertCanvas);
    this.alertTex.colorSpace = THREE.SRGBColorSpace;
    this.alert = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.alertTex, transparent: true, depthWrite: false, depthTest: false }));
    this.alert.scale.setScalar(0.85); this.alert.position.y = 1.55; this.alert.renderOrder = 10; this.alert.visible = false;
    this.root.add(this.alert);
  }

  private founder() {
    const vest = mat(0x3f6aa0, 0.8), shirt = mat(0xe9ecf2, 0.8), pants = mat(0xb59a6a, 0.8), skin = mat(0xe9b894, 0.7), hair = mat(0x2a2220, 0.9);
    const torso = capsule(0.26, 0.24, shirt); torso.position.y = 0.58; this.body.add(torso);
    const v = capsule(0.275, 0.2, vest); v.position.y = 0.58; v.scale.set(1, 1, 1.02); this.body.add(v);
    const patch = box(this.body, 0.12, 0.08, 0.02, mat(0xffd34d, 0.6), 0.1, 0.72, 0.265, 0.01); void patch;
    this.head.position.y = 1.02; this.body.add(this.head);
    this.head.add(sphere(0.22, skin));
    const h = sphere(0.235, hair, 1, 0.75, 1); h.position.set(0, 0.07, -0.04); this.head.add(h);
    for (let i = 0; i < 4; i++) { const t = sphere(0.07, hair); t.position.set(-0.12 + i * 0.08, 0.2 + (i % 2) * 0.03, -0.03); this.head.add(t); }
    for (const x of [-0.21, 0.21]) { const e = sphere(0.035, mat(0xffffff, 0.3)); e.position.set(x, -0.02, 0.0); this.head.add(e); }
    for (const x of [-0.08, 0.08]) { const e = sphere(0.025, mat(0x15151a, 0.4)); e.position.set(x, 0.0, 0.2); this.head.add(e); }
    this.limbs(vest, shirt, pants, skin, 0.3);
  }

  private roommate() {
    const hoodie = mat(0xff7a3d, 0.85), pants = mat(0x2b3140, 0.8), skin = mat(0xc88a64, 0.7), hair = mat(0xf1d36a, 0.9), cups = mat(0x1d1d24, 0.4, 0.3);
    const torso = capsule(0.23, 0.22, hoodie); torso.position.y = 0.54; this.body.add(torso);
    this.head.position.y = 0.96; this.body.add(this.head);
    this.head.add(sphere(0.2, skin));
    const h = sphere(0.215, hair, 1, 0.7, 1); h.position.set(0, 0.07, -0.05); this.head.add(h);
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.21, 0.025, 8, 24, Math.PI), cups); band.rotation.set(0, Math.PI / 2, 0); band.position.y = 0.02; band.rotation.z = Math.PI / 2; this.head.add(band);
    for (const x of [-0.21, 0.21]) { const c = sphere(0.08, cups, 0.55, 1, 1); c.position.set(x, 0, 0); this.head.add(c); }
    for (const x of [-0.07, 0.07]) { const e = sphere(0.025, mat(0x15151a, 0.4)); e.position.set(x, 0.0, 0.19); this.head.add(e); }
    this.limbs(hoodie, hoodie, pants, skin, 0.25);
  }

  private limbs(arm: THREE.Material, sleeve: THREE.Material, pants: THREE.Material, skin: THREE.Material, spread: number) {
    void sleeve;
    for (const [a, x] of [[this.armL, -spread], [this.armR, spread]] as const) {
      a.position.set(x, 0.68, 0); const m = capsule(0.075, 0.22, arm); m.position.y = -0.15; a.add(m);
      const hand = sphere(0.07, skin); hand.position.y = -0.32; a.add(hand); this.body.add(a);
    }
    for (const [l, x] of [[this.legL, -0.11], [this.legR, 0.11]] as const) {
      l.position.set(x, 0.3, 0); const m = capsule(0.09, 0.14, pants); m.position.y = -0.1; l.add(m);
      box(l, 0.17, 0.09, 0.26, mat(0xf4f4f4, 0.6), 0, -0.3, 0.04, 0.04); this.body.add(l);
    }
  }

  /** Aim the sight cone from (x,y) along (hx,hy), clipped by walls; tint by suspicion. */
  updateCone(x: number, y: number, hx: number, hy: number, meter: number, mute: boolean) {
    const pos = this.coneGeo.getAttribute("position") as THREE.BufferAttribute;
    const col = this.coneGeo.getAttribute("color") as THREE.BufferAttribute;
    const base = Math.atan2(hy, hx), n = this.rays;
    pos.setXYZ(0, x, 0.045, y);
    const c0 = new THREE.Color().setHSL(0.12 - meter * 0.12, 1, 0.55);
    col.setXYZW(0, c0.r, c0.g, c0.b, (mute ? 0.25 : 0.55) + meter * 0.25);
    for (let i = 0; i <= n; i++) {
      const a = base - this.halfAngle + (i / n) * this.halfAngle * 2;
      const dx = Math.cos(a), dy = Math.sin(a);
      const d = rayDistance(this.opaque, x, y, dx, dy, this.spec.range);
      pos.setXYZ(i + 1, x + dx * d, 0.045, y + dy * d);
      col.setXYZW(i + 1, c0.r, c0.g, c0.b, d < this.spec.range ? 0.2 : 0.1);
    }
    pos.needsUpdate = col.needsUpdate = true;
    this.spot.position.set(x, 1.1, y);
    this.spot.target.position.set(x + hx * 4, 0, y + hy * 4);
    this.spot.color.setHSL(0.11 - meter * 0.11, 0.9, 0.78 - meter * 0.1);
    this.spot.intensity = 45 + meter * 35;
  }

  /** heard: the guard noticed noise but has not seen you, so show a question mark. */
  setAlert(meter: number, heard = false) {
    const bucket = Math.round(meter * 40) * 2 + (heard ? 1 : 0);
    this.alert.visible = meter > 0.04;
    if (bucket === this.lastBucket) return;
    this.lastBucket = bucket;
    const g = this.alertCanvas.getContext("2d")!;
    g.clearRect(0, 0, 128, 128);
    const col = new THREE.Color().setHSL(0.13 - meter * 0.13, 1, 0.55).getStyle();
    g.fillStyle = "rgba(10,12,26,.82)"; g.beginPath(); g.arc(64, 64, 52, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "rgba(255,255,255,.18)"; g.lineWidth = 10; g.beginPath(); g.arc(64, 64, 44, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = col; g.lineCap = "round"; g.beginPath(); g.arc(64, 64, 44, -Math.PI / 2, -Math.PI / 2 + meter * Math.PI * 2); g.stroke();
    g.fillStyle = col; g.font = "bold 66px 'Lilita One', sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(heard ? "?" : "!", 64, 68);
    this.alertTex.needsUpdate = true;
  }
}

/** Dotted patrol route on the floor: red where the guard is about to walk, white further ahead. */
export class RouteDots {
  readonly mesh: THREE.InstancedMesh;
  private pts: Array<{ x: number; y: number; arc: number }> = [];
  private segs: Array<{ start: number; len: number }> = [];
  private total = 0;
  private m4 = new THREE.Matrix4();
  private color = new THREE.Color();
  constructor(private route: Waypoint[]) {
    const path = route;
    for (let i = 0; i < path.length; i++) {
      const a = path[i]!, b = path[(i + 1) % path.length]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      this.segs.push({ start: this.total, len });
      this.total += len;
    }
    const gap = 0.62;
    for (let d = 0; d < this.total; d += gap) {
      const si = this.segs.findIndex(s => d >= s.start && d < s.start + s.len);
      const s = this.segs[si]!, a = path[si]!, b = path[(si + 1) % path.length]!;
      const t = (d - s.start) / s.len;
      this.pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, arc: d });
    }
    const geo = new THREE.CircleGeometry(0.13, 14); geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false }), this.pts.length);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 2;
    this.mesh.setColorAt(0, this.color.set(0xffffff));
  }
  update(gx: number, gy: number, next: number, alerted: boolean) {
    const path = this.route, n = path.length;
    const prev = (next + n - 1) % n;
    const seg = this.segs[prev]!;
    const a = path[prev]!;
    const along = Math.min(seg.len, Math.hypot(gx - a.x, gy - a.y));
    const guardArc = seg.start + along;
    for (let i = 0; i < this.pts.length; i++) {
      const p = this.pts[i]!;
      let ahead = p.arc - guardArc;
      if (ahead < -0.25) ahead += this.total;
      const far = Math.min(1, Math.max(0, ahead / 11));
      // red -> amber -> white
      if (far < 0.5) this.color.setRGB(1, 0.2 + far * 1.1, 0.22 + far * 0.3); else this.color.setRGB(1, 0.75 + (far - 0.5) * 0.5, 0.37 + (far - 0.5) * 1.26);
      const visible = ahead >= 0 && ahead < 16 && !alerted;
      const sc = visible ? 1.15 - far * 0.55 : 0.0001;
      this.m4.makeScale(sc, 1, sc); this.m4.setPosition(p.x, 0.035, p.y);
      this.mesh.setMatrixAt(i, this.m4);
      this.mesh.setColorAt(i, this.color);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

export const opaqueRects = (level: Parameters<typeof compile>[0]) => (compile(level) as { opaque: Rect[] }).opaque;
