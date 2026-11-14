import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { HouseLevel, LootSpec } from "../../src/levels.js";
import { compile } from "../../web/sneak-core.js";
import { floorTexture, glintTexture, rng, screenTexture, softDot, labelTexture, type FloorTheme } from "./textures.js";

type Rect = { kind: string; x: number; y: number; w: number; h: number };
type Occluder = { obj: THREE.Object3D; box: THREE.Box3; mats: THREE.Material[]; opacity: number };
type LootObj = { group: THREE.Group; model: THREE.Object3D; glow: THREE.Sprite; glints: THREE.Sprite[]; lift: number; spec: LootSpec; taken: boolean; phase: number };

const mats = new Map<string, THREE.MeshStandardMaterial>();
export function mat(color: THREE.ColorRepresentation, rough = 0.75, metal = 0, emissive?: THREE.ColorRepresentation, ei = 0) {
  const key = `${new THREE.Color(color).getHexString()}|${rough}|${metal}|${emissive === undefined ? "" : new THREE.Color(emissive).getHexString()}|${ei}`;
  let m = mats.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
    if (emissive !== undefined) { m.emissive = new THREE.Color(emissive); m.emissiveIntensity = ei; }
    mats.set(key, m);
  }
  return m;
}

export function box(parent: THREE.Object3D, w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0, radius = 0.03) {
  const geo = radius > 0 ? new RoundedBoxGeometry(w, h, d, 2, Math.min(radius, w / 2.1, h / 2.1, d / 2.1)) : new THREE.BoxGeometry(w, h, d);
  const mesh = new THREE.Mesh(geo, m);
  mesh.position.set(x, y + h / 2, z);
  mesh.castShadow = mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}
function cyl(parent: THREE.Object3D, rt: number, rb: number, h: number, m: THREE.Material, x = 0, y = 0, z = 0, seg = 16) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
  mesh.position.set(x, y + h / 2, z);
  mesh.castShadow = mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}
function ball(parent: THREE.Object3D, r: number, m: THREE.Material, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), m);
  mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz);
  mesh.castShadow = mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

export const WALL_HEIGHT = 1.15;

export class World {
  scene = new THREE.Scene();
  loot: LootObj[] = [];
  private occluders: Occluder[] = [];
  private screens: Array<{ tick: (t: number) => void }> = [];
  private flicker: THREE.PointLight[] = [];
  private leds: THREE.Mesh[] = [];
  private portals: Array<{ ring: THREE.Mesh; arrows: THREE.Group }> = [];
  private ray = new THREE.Ray();
  private tmp = new THREE.Vector3();
  private glintTex = glintTexture();
  private dust: THREE.InstancedMesh | null = null;

  constructor(readonly level: HouseLevel) {
    const c = compile(level) as { rects: Rect[]; cols: number; rows: number };
    const s = this.scene;
    s.background = new THREE.Color(0x0e1830);
    s.fog = new THREE.Fog(0x0e1830, 34, 70);
    this.lights();
    this.ground(c);
    this.floors();
    for (const r of c.rects) this.place(r);
    this.officeDecor();
    this.growthOfficeDecor();
    this.garden();
    this.addLoot();
    this.buildExit();
    this.dustMotes();
  }

  // ---------------------------------------------------------------- lighting
  private lights() {
    const s = this.scene;
    // The house lights are off: moonlight outside, and inside only screens, nightlights and flashlights.
    s.add(new THREE.HemisphereLight(0x5f7fc4, 0x141c30, 0.62));
    const moon = new THREE.DirectionalLight(0xa9c4ff, 1.35);
    moon.position.set(4, 22, 2);
    moon.target.position.set(13, 0, 9.5);
    moon.castShadow = true;
    moon.shadow.mapSize.set(2048, 2048);
    const cam = moon.shadow.camera;
    cam.left = -18; cam.right = 18; cam.top = 15; cam.bottom = -15; cam.near = 1; cam.far = 50;
    moon.shadow.bias = -0.0004; moon.shadow.normalBias = 0.03; moon.shadow.radius = 4;
    s.add(moon, moon.target);

    const glow = (x: number, z: number, color: number, intensity: number, dist = 5, y = 1.3) => {
      const l = new THREE.PointLight(color, intensity, dist, 1.6);
      l.position.set(x, y, z);
      s.add(l);
      return l;
    };
    this.flicker.push(glow(5.5, 3.2, 0x6fa8ff, 14, 6, 2.0));    // living room TV
    glow(16, 3.7, 0x7fe0ff, 10, 5);                              // office monitors
    glow(14.8, 3.2, 0xffb35c, 7, 5, 1.2);                        // office string lights
    glow(19.8, 3.2, 0xcfe8ff, 6, 4);                             // open fridge glow
    glow(5, 11.3, 0x7fffe0, 6, 5, 1.0);                          // bathroom nightlight
    glow(20, 11.2, 0xb59cff, 5, 5, 1.0);                         // bedroom charger glow
    glow(11, 15, 0xffd9a0, 16, 7, 1.8); glow(15, 15, 0xffd9a0, 16, 7, 1.8); // garden lamps stay on
  }

  // ---------------------------------------------------------------- ground and floors
  private ground(c: { cols: number; rows: number }) {
    const grass = floorTexture("grass");
    grass.repeat.set(30, 30);
    const big = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshStandardMaterial({ map: grass, roughness: 1 }));
    big.rotation.x = -Math.PI / 2; big.position.set(c.cols / 2, -0.02, c.rows / 2); big.receiveShadow = true;
    this.scene.add(big);
    // trees around the plot
    const r = rng(77);
    const n = 70;
    const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.28, 2, 6), mat(0x3a2a22), n);
    const crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0x1f5a45, roughness: 1, flatShading: true }), n * 2);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      let x = 0, z = 0;
      // never south of the plot: the camera looks from there and a crown would fill the screen
      do { x = -10 + r() * 46; z = -10 + r() * 28; } while (x > -1.5 && x < c.cols + 1.5 && z > -1.5);
      const k = 0.9 + r() * 1.1;
      m4.compose(p.set(x, k, z), q, sc.set(k, k, k)); trunk.setMatrixAt(i, m4);
      m4.compose(p.set(x, 2.2 * k + 0.6, z), q, sc.set(1.5 * k, 1.3 * k, 1.5 * k)); crown.setMatrixAt(i * 2, m4);
      m4.compose(p.set(x + 0.2, 3.2 * k + 0.6, z), q, sc.set(1.0 * k, 1.0 * k, 1.0 * k)); crown.setMatrixAt(i * 2 + 1, m4);
    }
    trunk.castShadow = crown.castShadow = true;
    this.scene.add(trunk, crown);
  }

  private floors() {
    const themeLevel = new Map<string, FloorTheme>();
    const place = (x: number, y: number, w: number, h: number, theme: FloorTheme) => {
      const tex = floorTexture(theme).clone();
      tex.needsUpdate = true;
      tex.repeat.set(w / 2, h / 2);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: theme === "hall" ? 0.5 : 0.85 }));
      m.rotation.x = -Math.PI / 2; m.position.set(x + w / 2, 0.005, y + h / 2); m.receiveShadow = true;
      this.scene.add(m);
    };
    for (const room of this.level.rooms) { place(room.x, room.y, room.w, room.h, room.theme); themeLevel.set(room.name, room.theme); }
    // doorway thresholds
    this.level.rows.forEach((row, y) => [...row].forEach((ch, x) => {
      if (ch !== "d") return;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat(0x8a5a35, 0.6));
      m.rotation.x = -Math.PI / 2; m.position.set(x + 0.5, 0.012, y + 0.5); m.receiveShadow = true;
      this.scene.add(m);
    }));
    // house slab edge so the building sits on the lawn
    const slab = new THREE.Mesh(new RoundedBoxGeometry(22.6, 0.12, 13.6, 2, 0.05), mat(0x9a8f83, 0.9));
    slab.position.set(13, -0.06, 7.5); slab.receiveShadow = true;
    this.scene.add(slab);
  }

  // ---------------------------------------------------------------- tile -> object
  private register(obj: THREE.Object3D, minHeight = 0) {
    const meshes: THREE.Mesh[] = [];
    obj.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    const clones: THREE.Material[] = [];
    for (const m of meshes) {
      const apply = (src: THREE.Material) => { const c = src.clone(); c.transparent = true; clones.push(c); return c; };
      m.material = Array.isArray(m.material) ? m.material.map(apply) : apply(m.material);
    }
    obj.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(obj);
    if (minHeight) bb.max.y = Math.max(bb.max.y, minHeight);
    this.occluders.push({ obj, box: bb, mats: clones, opacity: 1 });
  }

  private place(r: Rect) {
    const g = new THREE.Group();
    g.position.set(r.x + r.w / 2, 0, r.y + r.h / 2);
    switch (r.kind) {
      case "wall": return this.wall(r);
      case "bush": return this.bushes(r);
      case "hedge": this.hedge(g, r); break;
      case "closet": this.closet(g, r); break;
      case "couch": this.couch(g, r); break;
      case "tv": this.tv(g, r); break;
      case "desk": this.desk(g, r); break;
      case "counter": this.counter(g, r); break;
      case "fridge": this.fridge(g); break;
      case "rack": this.rack(g); break;
      case "shelf": this.shelf(g, r); break;
      case "plant": this.plant(g); break;
      case "fixture": this.fixture(g, r); break;
      case "beanbag": this.beanbag(g); break;
      default: return;
    }
    this.scene.add(g);
    if (["fridge", "rack", "shelf"].includes(r.kind)) this.register(g);
  }

  private wallTexture() {
    const c = document.createElement("canvas"); c.width = 8; c.height = 128;
    const g = c.getContext("2d")!;
    const gr = g.createLinearGradient(0, 128, 0, 0);
    gr.addColorStop(0, "#6a4630"); gr.addColorStop(0.1, "#6a4630"); gr.addColorStop(0.11, "#efe0bd"); gr.addColorStop(1, "#d9c49b");
    g.fillStyle = gr; g.fillRect(0, 0, 8, 128);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }
  private wallMat?: THREE.MeshStandardMaterial;
  private wall(r: Rect) {
    this.wallMat ??= new THREE.MeshStandardMaterial({ map: this.wallTexture(), roughness: 0.9 });
    const top = mat(0xfff1cc, 0.8);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(r.w, WALL_HEIGHT, r.h), [this.wallMat, this.wallMat, top, this.wallMat, this.wallMat, this.wallMat]);
    mesh.position.set(r.x + r.w / 2, WALL_HEIGHT / 2, r.y + r.h / 2);
    mesh.castShadow = mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.register(mesh);
  }

  private bushes(r: Rect) {
    const count = Math.ceil((r.w * r.h) / 0.4);
    const rand = rng(r.x * 31 + r.y * 17 + r.w);
    const inst = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.5, 1), new THREE.MeshStandardMaterial({ color: 0x2d7f45, roughness: 1, flatShading: true }), count);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const sc = 0.55 + rand() * 0.45;
      m4.compose(p.set(r.x + rand() * r.w, 0.28 + rand() * 0.2, r.y + rand() * r.h), q.setFromEuler(new THREE.Euler(rand() * 3, rand() * 3, 0)), s.set(sc, sc * 0.9, sc));
      inst.setMatrixAt(i, m4);
      inst.setColorAt(i, col.setHSL(0.33 + rand() * 0.04, 0.5 + rand() * 0.2, 0.2 + rand() * 0.12));
    }
    inst.castShadow = inst.receiveShadow = true;
    this.scene.add(inst);
  }

  private hedge(g: THREE.Group, r: Rect) {
    const rand = rng(r.x * 13 + r.y * 7);
    const n = Math.ceil(r.w * r.h * 3.2);
    const inst = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.42, 1), new THREE.MeshStandardMaterial({ color: 0x3a9b4a, roughness: 1, flatShading: true }), n);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const sc = 0.6 + rand() * 0.5;
      m4.compose(p.set((rand() - 0.5) * (r.w - 0.3), 0.22 + rand() * 0.14, (rand() - 0.5) * (r.h - 0.3)), q.setFromEuler(new THREE.Euler(rand() * 3, rand() * 3, 0)), s.set(sc, sc * 0.75, sc));
      inst.setMatrixAt(i, m4);
      inst.setColorAt(i, col.setHSL(0.31 + rand() * 0.05, 0.55, 0.27 + rand() * 0.14));
    }
    inst.castShadow = inst.receiveShadow = true;
    g.add(inst);
    // little white blossoms
    for (let i = 0; i < r.w * r.h * 2; i++) ball(g, 0.05, mat(0xfff5d6, 0.6, 0, 0xfff5d6, 0.4), (rand() - 0.5) * (r.w - 0.3), 0.55 + rand() * 0.1, (rand() - 0.5) * (r.h - 0.3));
  }

  private closet(g: THREE.Group, r: Rect) {
    const wood = mat(0x8d5b3b, 0.7);
    box(g, 0.92, 1.5, 0.06, wood, 0, 0, -0.43);
    box(g, 0.06, 1.5, 0.92, wood, -0.43, 0, 0);
    box(g, 0.06, 1.5, 0.92, wood, 0.43, 0, 0);
    box(g, 0.84, 0.04, 0.05, mat(0xb9b9c4, 0.3, 0.8), 0, 1.15, -0.3, 0.01);
    const colors = [0x6f5bd6, 0xe0703a, 0x35b6a3, 0xd9d9e8];
    colors.forEach((c, i) => box(g, 0.14, 0.62, 0.05, mat(c, 0.9), -0.3 + i * 0.2, 0.55, -0.3, 0.04));
    // no shadow inside: a dark patch under the player reads as a glitch
    g.traverse(o => { (o as THREE.Mesh).castShadow = false; });
    // Back panel always faces nearest wall; doors face room.
    if (r.y === 5) g.rotation.y = Math.PI;
    else if (r.x === 9) g.rotation.y = Math.PI / 2;
  }

  private couch(g: THREE.Group, r: Rect) {
    const body = mat(0xe0a33a, 0.85), cush = mat(0xf2bb55, 0.9), pill = mat(0x2fb5a8, 0.9);
    const w = r.w - 0.1;
    box(g, w, 0.32, r.h - 0.12, body, 0, 0.05, 0, 0.08);
    box(g, w, 0.55, 0.28, body, 0, 0.1, r.h / 2 - 0.26, 0.1);
    box(g, 0.24, 0.5, r.h - 0.12, body, -w / 2 + 0.12, 0.08, 0, 0.1);
    box(g, 0.24, 0.5, r.h - 0.12, body, w / 2 - 0.12, 0.08, 0, 0.1);
    const seat = (w - 0.55) / Math.max(1, Math.round(r.w - 1));
    for (let i = 0; i < Math.round(r.w - 1); i++) box(g, seat - 0.04, 0.16, 0.6, cush, -w / 2 + 0.27 + seat / 2 + i * seat, 0.36, -0.05, 0.07);
    box(g, 0.32, 0.3, 0.1, pill, -w / 2 + 0.5, 0.5, 0.18, 0.05).rotation.set(-0.3, 0.3, 0.1);
  }

  private tv(g: THREE.Group, r: Rect) {
    box(g, r.w - 0.1, 0.42, 0.7, mat(0x3a2a24, 0.7), 0, 0, 0, 0.05);
    box(g, r.w - 1.0, 0.04, 0.3, mat(0x1b1b20, 0.4, 0.5), 0, 0.42, 0.05, 0.01);
    const sw = r.w - 0.9;
    box(g, sw, 0.95, 0.07, mat(0x0c0c10, 0.4), 0, 0.46, 0.05, 0.03);
    const scr = screenTexture("news");
    this.screens.push({ tick: scr.tick });
    const face = new THREE.Mesh(new THREE.PlaneGeometry(sw - 0.1, 0.85), new THREE.MeshStandardMaterial({ map: scr.texture, emissiveMap: scr.texture, emissive: 0xffffff, emissiveIntensity: 1.1, roughness: 0.3 }));
    face.position.set(0, 0.46 + 0.475, 0.09); g.add(face);
    // soundbar
    box(g, r.w - 1.4, 0.1, 0.12, mat(0x15151a, 0.5), 0, 0.42, 0.3, 0.03);
  }

  private desk(g: THREE.Group, r: Rect) {
    const wood = mat(0xc89864, 0.6), leg = mat(0x3d3d46, 0.4, 0.6);
    box(g, r.w - 0.1, 0.07, r.h - 0.14, wood, 0, 0.7, 0, 0.03);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(g, 0.07, 0.7, 0.07, leg, sx * (r.w / 2 - 0.12), 0, sz * (r.h / 2 - 0.14), 0.01);
    // dual monitors, facing south
    [-0.45, 0.45].forEach((dx, i) => {
      box(g, 0.78, 0.5, 0.05, mat(0x0d0d12, 0.4), dx, 0.9, -0.25, 0.02);
      const t = screenTexture(i ? "chart" : "code");
      this.screens.push({ tick: t.tick });
      const face = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.44), new THREE.MeshStandardMaterial({ map: t.texture, emissiveMap: t.texture, emissive: 0xffffff, emissiveIntensity: 1, roughness: 0.3 }));
      face.position.set(dx, 0.9 + 0.25, -0.222); face.rotation.y = 0; g.add(face);
      box(g, 0.08, 0.2, 0.08, leg, dx, 0.77, -0.25, 0.01);
    });
    box(g, 0.7, 0.03, 0.22, mat(0x20232b, 0.5), -0.1, 0.77, 0.12, 0.01);
    cyl(g, 0.07, 0.06, 0.1, mat(0xf2f2f2, 0.5), 0.75, 0.77, 0.1);
    box(g, 0.14, 0.14, 0.01, mat(0xffe36a, 0.6), -0.85, 0.77, 0.15, 0.0).rotation.y = 0.3;
  }

  private counter(g: THREE.Group, r: Rect) {
    const cab = mat(0x4b6fa5, 0.7), top = mat(0xece7da, 0.35), dark = mat(0x23262d, 0.4, 0.4);
    box(g, r.w - 0.04, 0.82, r.h - 0.12, cab, 0, 0, 0, 0.04);
    box(g, r.w, 0.07, r.h - 0.04, top, 0, 0.82, 0, 0.02);
    for (let i = 0; i < r.w; i++) box(g, 0.78, 0.5, 0.02, mat(0x3e5d8d, 0.8), -r.w / 2 + 0.5 + i, 0.12, r.h / 2 - 0.05, 0.01);
    if (r.h === 1 && r.y <= 2) { // wall run: sink + stove
      if (r.w >= 3) {
        box(g, 0.7, 0.03, 0.46, dark, -0.8, 0.9, 0, 0.02);
        cyl(g, 0.03, 0.03, 0.22, mat(0xc8ced8, 0.2, 0.9), -0.8, 0.9, -0.28);
        for (const [bx, bz] of [[0.65, -0.12], [0.95, -0.12], [0.65, 0.16], [0.95, 0.16]] as const) cyl(g, 0.11, 0.11, 0.02, dark, bx, 0.89, bz);
      }
    } else { // island: fruit bowl + stools
      cyl(g, 0.17, 0.12, 0.08, mat(0xf4efe6, 0.5), 0.1, 0.89, 0.05);
      [[0.0, 0.02], [0.12, 0.1], [0.2, -0.04]].forEach(([fx, fz], i) => ball(g, 0.065, mat([0xf2543d, 0xf6c13b, 0x77c046][i]!, 0.5), fx! + 0.05, 1.0, fz! + 0.05));
    }
  }

  private fridge(g: THREE.Group) {
    const steel = mat(0xd0d7e0, 0.35, 0.6);
    box(g, 0.92, 1.8, 0.86, steel, 0, 0, 0, 0.06);
    box(g, 0.9, 0.025, 0.02, mat(0x6a707c, 0.5), 0, 1.08, 0.44, 0);
    box(g, 0.04, 0.55, 0.05, mat(0x9aa2b0, 0.3, 0.8), 0.32, 1.2, 0.46, 0.01);
    box(g, 0.04, 0.35, 0.05, mat(0x9aa2b0, 0.3, 0.8), 0.32, 0.6, 0.46, 0.01);
    [0xff5d6c, 0x5db2ff, 0xffd34d, 0x77d6a5].forEach((c, i) => box(g, 0.1, 0.1, 0.02, mat(c, 0.6), -0.3 + (i % 2) * 0.16, 1.25 + Math.floor(i / 2) * 0.16, 0.44, 0.02));
    box(g, 0.28, 0.36, 0.01, mat(0xfff7e0, 0.9), -0.12, 1.45, 0.44, 0);
  }

  private rack(g: THREE.Group) {
    box(g, 0.92, 1.65, 0.9, mat(0x161a24, 0.45, 0.4), 0, 0, 0, 0.04);
    for (let i = 0; i < 7; i++) {
      box(g, 0.8, 0.14, 0.02, mat(0x242a38, 0.5, 0.4), 0, 0.14 + i * 0.2, 0.46, 0.01);
      for (let j = 0; j < 5; j++) {
        const led = box(g, 0.04, 0.04, 0.02, mat(j % 2 ? 0x30e68a : 0x4aa8ff, 0.4, 0, j % 2 ? 0x30e68a : 0x4aa8ff, 2), -0.28 + j * 0.1, 0.18 + i * 0.2, 0.475, 0.01);
        this.leds.push(led);
      }
    }
    const l = new THREE.PointLight(0x4aa8ff, 3, 3, 2); l.position.set(0, 0.9, 0.9); g.add(l);
  }

  private shelf(g: THREE.Group, r: Rect) {
    const frame = mat(0x6e4a34, 0.8), rand = rng(r.x * 5 + r.y);
    const w = r.w - 0.1;
    box(g, w, 1.55, 0.06, frame, 0, 0, -0.4, 0.01);
    for (const sx of [-1, 1]) box(g, 0.05, 1.55, 0.9, frame, sx * (w / 2 - 0.02), 0, 0, 0.01);
    for (let i = 0; i < 5; i++) {
      box(g, w, 0.04, 0.9, frame, 0, 0.05 + i * 0.36, 0, 0.01);
      let x = -w / 2 + 0.1;
      while (x < w / 2 - 0.15) {
        const bw = 0.06 + rand() * 0.07, bh = 0.2 + rand() * 0.12;
        box(g, bw, bh, 0.22, mat(new THREE.Color().setHSL(rand(), 0.55, 0.5), 0.8), x + bw / 2, 0.09 + i * 0.36, 0.05, 0.005);
        x += bw + 0.01;
      }
    }
  }

  private plant(g: THREE.Group) {
    const rand = rng(Math.floor(g.position.x * 7 + g.position.z * 3));
    cyl(g, 0.24, 0.17, 0.3, mat(0xc25a36, 0.8), 0, 0, 0);
    cyl(g, 0.22, 0.22, 0.02, mat(0x3a2418, 1), 0, 0.29, 0);
    const leaf = mat(0x2f9a4d, 0.7), leaf2 = mat(0x42b85f, 0.7);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + rand();
      const m = ball(g, 0.2, i % 2 ? leaf : leaf2, Math.cos(a) * 0.2, 0.62 + rand() * 0.2, Math.sin(a) * 0.2, 1, 0.45, 0.55);
      m.rotation.set(0, -a, 0.55 + rand() * 0.3);
    }
  }

  private fixture(g: THREE.Group, r: Rect) {
    const porcelain = mat(0xf4f6fa, 0.25);
    if (r.w >= 2) {
      box(g, r.w - 0.2, 0.78, 0.72, mat(0x7a5a47, 0.7), 0, 0, 0.0, 0.04);
      box(g, r.w - 0.14, 0.05, 0.78, mat(0xe8edf5, 0.3), 0, 0.78, 0, 0.02);
      ball(g, 0.2, porcelain, -0.45, 0.8, 0, 1, 0.25, 0.8);
      ball(g, 0.2, porcelain, 0.45, 0.8, 0, 1, 0.25, 0.8);
      cyl(g, 0.025, 0.025, 0.2, mat(0xc8ced8, 0.2, 0.9), -0.45, 0.82, -0.2);
      cyl(g, 0.025, 0.025, 0.2, mat(0xc8ced8, 0.2, 0.9), 0.45, 0.82, -0.2);
      const mir = box(g, r.w - 0.6, 0.6, 0.03, mat(0xbfe4ff, 0.05, 0.9, 0x6fc3ff, 0.35), 0, 1.05, -0.45, 0.01);
      mir.castShadow = false;
    } else {
      cyl(g, 0.22, 0.17, 0.34, porcelain, 0, 0, 0.1);
      ball(g, 0.25, porcelain, 0, 0.4, 0.12, 1, 0.4, 1.15);
      box(g, 0.44, 0.5, 0.2, porcelain, 0, 0.1, -0.3, 0.05);
    }
  }

  private beanbag(g: THREE.Group) {
    const hue = Math.round(g.position.x + g.position.z) % 2 ? 0xff8a3d : 0x2fb5a8;
    const body = mat(hue, 0.95);
    const b = ball(g, 0.48, body, 0, 0.3, 0, 1, 0.62, 1);
    b.rotation.y = g.position.x;
    ball(g, 0.3, mat(hue, 0.95), 0.12, 0.5, -0.08, 1, 0.45, 1);
    box(g, 0.16, 0.05, 0.1, mat(0xfff3d0, 0.9), -0.2, 0.58, 0.2, 0.02).rotation.y = 0.5;
  }

  /** Main startup office: tie-dye rug, fairy lights, lava lamp. */
  private officeDecor() {
    const room = this.level.rooms.find(r => r.theme === "office");
    if (!room) return;
    const rand = rng(1234);
    // tie-dye rug with a generic startup badge in the middle
    const rug = document.createElement("canvas"); rug.width = rug.height = 512;
    const g = rug.getContext("2d")!;
    const conic = (g as CanvasRenderingContext2D & { createConicGradient?: (a: number, x: number, y: number) => CanvasGradient }).createConicGradient?.(0, 256, 256);
    if (conic) { ["#ff5d8f", "#ffb347", "#ffe66d", "#5ee6a8", "#4aa8ff", "#a77bff", "#ff5d8f"].forEach((c, i, a) => conic.addColorStop(i / (a.length - 1), c)); g.fillStyle = conic; } else g.fillStyle = "#ff8fb1";
    g.beginPath(); g.arc(256, 256, 250, 0, Math.PI * 2); g.fill();
    for (let i = 0; i < 6; i++) { g.strokeStyle = `rgba(255,255,255,${0.22 - i * 0.025})`; g.lineWidth = 14; g.beginPath(); g.arc(256, 256, 60 + i * 38, 0, Math.PI * 2); g.stroke(); }
    g.fillStyle = "#0e3a5a"; g.beginPath(); g.arc(256, 256, 78, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "#5ce6b4"; g.lineWidth = 9; g.beginPath(); g.arc(256, 256, 66, 0, Math.PI * 2); g.stroke();
    g.fillStyle = "#ffffff"; g.font = "bold 70px 'Lilita One', sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("ALT", 256, 262);
    const rugTex = new THREE.CanvasTexture(rug); rugTex.colorSpace = THREE.SRGBColorSpace;
    const rugMesh = new THREE.Mesh(new THREE.CircleGeometry(1.4, 48), new THREE.MeshStandardMaterial({ map: rugTex, roughness: 1 }));
    rugMesh.rotation.x = -Math.PI / 2; rugMesh.rotation.z = 0.4; rugMesh.position.set(room.x + 3.1, 0.018, room.y + 1.65); rugMesh.receiveShadow = true;
    this.scene.add(rugMesh);

    // Compression poster on the north wall
    const poster = document.createElement("canvas"); poster.width = 512; poster.height = 204;
    const p = poster.getContext("2d")!;
    const grd = p.createLinearGradient(0, 0, 512, 204); grd.addColorStop(0, "#0a2748"); grd.addColorStop(1, "#146a7a");
    p.fillStyle = grd; p.fillRect(0, 0, 512, 204);
    p.textAlign = "center"; p.textBaseline = "middle";
    p.font = "bold 34px 'Lilita One', sans-serif"; p.fillStyle = "#ffffff"; p.fillText("THE BEST", 256, 70);
    p.font = "bold 26px 'Lilita One', sans-serif"; p.fillStyle = "#8ff2cb"; p.fillText("MIDDLE-OUT COMPRESSION", 256, 112);
    p.font = "bold 26px 'Lilita One', sans-serif"; p.fillStyle = "#8ff2cb"; p.fillText("ALGORITHM", 256, 145);
    p.strokeStyle = "rgba(255,255,255,.35)"; p.lineWidth = 3; p.strokeRect(6, 6, 500, 192);
    const posterTex = new THREE.CanvasTexture(poster); posterTex.colorSpace = THREE.SRGBColorSpace;
    const frame = box(this.scene, 2.0, 0.82, 0.04, mat(0x2a2018, 0.6), 16.0, 0.34, 2.03, 0.01);
    frame.castShadow = false;
    const pm = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.76), new THREE.MeshStandardMaterial({ map: posterTex, emissiveMap: posterTex, emissive: 0xffffff, emissiveIntensity: 0.55, roughness: 0.6 }));
    pm.position.set(16.0, 0.75, 2.06); this.scene.add(pm);

    // prayer flags above the poster
    const colors = [0x3a7bff, 0xffffff, 0xff4d5e, 0x3fd18a, 0xffd34d];
    for (let i = 0; i < 9; i++) {
      const t = i / 8, x = 14.2 + t * 2.7, sag = Math.sin(t * Math.PI) * 0.1;
      const sh = new THREE.Shape(); sh.moveTo(-0.1, 0); sh.lineTo(0.1, 0); sh.lineTo(0, -0.2); sh.closePath();
      const f = new THREE.Mesh(new THREE.ShapeGeometry(sh), new THREE.MeshStandardMaterial({ color: colors[i % colors.length]!, roughness: 0.9, side: THREE.DoubleSide, emissive: colors[i % colors.length]!, emissiveIntensity: 0.12 }));
      f.position.set(x, 1.1 - sag, 2.05); this.scene.add(f);
    }

    // fairy lights strung along the north and south walls of the office
    const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.045, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), 28);
    const m4 = new THREE.Matrix4(), col = new THREE.Color(); const palette = [0xffd27a, 0xff8fb1, 0x8fe3ff, 0xb6ff9a];
    let n = 0;
    for (const z of [room.y + 0.42, room.y + room.h - 0.3]) {
      for (let i = 0; i < 14; i++) {
        const t = i / 13, x = room.x + 0.3 + t * (room.w - 0.6), y = 1.02 - Math.sin(t * Math.PI) * 0.16;
        m4.setPosition(x, y, z); bulbs.setMatrixAt(n, m4); bulbs.setColorAt(n, col.set(palette[(i + n) % palette.length]!)); n++;
        if (i % 4 === 1) {
          const h = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDot("rgba(255,214,140,.85)", "rgba(255,214,140,0)"), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.7 }));
          h.scale.setScalar(0.55); h.position.set(x, y, z); this.scene.add(h);
        }
      }
    }
    this.scene.add(bulbs);

    // lava lamp and kombucha on the desk (desk spans x15..17, y4..5)
    const lamp = new THREE.Group(); lamp.position.set(16.75, 0.77, 4.3); this.scene.add(lamp);
    cyl(lamp, 0.07, 0.04, 0.05, mat(0x2a2d36, 0.5, 0.6), 0, 0, 0);
    const glass = cyl(lamp, 0.05, 0.075, 0.26, mat(0xff4fa0, 0.3, 0, 0xff4fa0, 1.6), 0, 0.05, 0);
    glass.castShadow = false;
    ball(lamp, 0.035, mat(0xffe27a, 0.3, 0, 0xffe27a, 2), 0, 0.16, 0);
    cyl(lamp, 0.02, 0.05, 0.06, mat(0x2a2d36, 0.5, 0.6), 0, 0.31, 0);
    const jar = this.scene; cyl(jar, 0.07, 0.07, 0.17, mat(0xd8a24a, 0.2, 0, 0xd8a24a, 0.35), 15.4, 0.77, 4.4);
    void rand;
  }

  /** Former bedroom converted into an office: desks, bong and Conjoined Triangles of Success. */
  private growthOfficeDecor() {
    const room = this.level.rooms.find(r => r.name === "Growth office");
    if (!room) return;
    // Conjoined Triangles of Success, as a glowing wall sculpture.
    const triMat = mat(0xf7c948, 0.35, 0.45, 0xf7c948, 1.2);
    const tri = (x: number, z: number, flip = false) => {
      const shape = new THREE.Shape(); shape.moveTo(-0.45, 0); shape.lineTo(0.45, 0); shape.lineTo(0, flip ? -0.68 : 0.68); shape.closePath();
      const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), triMat); mesh.position.set(x, 0.78, z); this.scene.add(mesh);
    };
    tri(room.x + 1.65, room.y + 0.04); tri(room.x + 2.35, room.y + 0.04, true); tri(room.x + 3.05, room.y + 0.04);
    // Shared two-seat workstation: separate task lights make both desks legible.
    for (const x of [room.x + 3.55, room.x + 4.35]) {
      const lamp = new THREE.Group(); lamp.position.set(x, 0.77, room.y + 1.35); this.scene.add(lamp);
      cyl(lamp, 0.025, 0.035, 0.28, mat(0x303746, 0.4, 0.5), 0, 0, 0);
      ball(lamp, 0.07, mat(0xffe7a2, 0.25, 0, 0xffd27a, 1.4), 0, 0.31, 0);
    }
    // Glass bong by desk.
    const bong = new THREE.Group(); bong.position.set(room.x + 4.5, 0.72, room.y + 1.25); this.scene.add(bong);
    cyl(bong, 0.12, 0.16, 0.28, mat(0x4bd9d2, 0.18, 0, 0x3bcbc4, 0.75), 0, 0, 0);
    cyl(bong, 0.045, 0.07, 0.34, mat(0x74f7e6, 0.12, 0, 0x4bd9d2, 0.9), 0.03, 0.27, 0);
    cyl(bong, 0.085, 0.085, 0.05, mat(0x313846, 0.45, 0.5), 0.03, 0.59, 0);
  }

  // ---------------------------------------------------------------- garden decoration
  private garden() {
    const rand = rng(99);
    // stepping stones from the start to the front door
    for (let i = 0; i < 9; i++) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.4, 0.06, 10), mat(0xa9a79d, 0.9));
      m.position.set(13 + (rand() - 0.5) * 0.5, 0.03, 17.2 - i * 0.45);
      m.rotation.y = rand() * 3; m.receiveShadow = true; m.castShadow = true; this.scene.add(m);
    }
    // flowers
    const n = 90;
    const flowers = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.07, 0), new THREE.MeshStandardMaterial({ roughness: 0.6, emissiveIntensity: 0.25, emissive: 0x442244 }), n);
    const m4 = new THREE.Matrix4(), col = new THREE.Color();
    const palette = [0xff7aa8, 0xffd35c, 0xffffff, 0xb08cff, 0xff9a52];
    for (let i = 0; i < n; i++) {
      let x = 0, z = 0;
      do { x = 1.2 + rand() * 23.6; z = 14.3 + rand() * 3.4; } while ((x > 5 && x < 9 && z > 15 && z < 17) || (x > 18 && x < 22 && z > 15 && z < 17) || Math.abs(x - 13) < 0.9);
      m4.setPosition(x, 0.08, z); flowers.setMatrixAt(i, m4); flowers.setColorAt(i, col.set(palette[Math.floor(rand() * palette.length)]!));
    }
    this.scene.add(flowers);
    // lamp posts
    for (const x of [11, 15]) {
      cyl(this.scene, 0.05, 0.06, 1.6, mat(0x2a2d36, 0.5, 0.6), x, 0, 14.9);
      const bulb = ball(this.scene, 0.14, mat(0xffe2a8, 0.3, 0, 0xffd28a, 2.4), x, 1.68, 14.9);
      bulb.castShadow = false;
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDot("rgba(255,214,140,.9)", "rgba(255,214,140,0)"), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      halo.scale.set(1.5, 1.5, 1); halo.position.set(x, 1.68, 14.9); this.scene.add(halo);
    }
    // front entrance is also a valid extraction point.
    const mattex = labelTexture("WELCOME / EXIT", "#f7e2b6", "#7a4b2a", "bold 38px 'Lilita One', sans-serif", 256, 96);
    const matMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.6), new THREE.MeshStandardMaterial({ map: mattex, roughness: 1 }));
    matMesh.rotation.x = -Math.PI / 2; matMesh.position.set(13, 0.02, 13.75); matMesh.receiveShadow = true; this.scene.add(matMesh);
    // trash bin by the exit
    cyl(this.scene, 0.22, 0.2, 0.55, mat(0x4d7a6a, 0.6), 24.45, 0, 6.2);
  }

  // ---------------------------------------------------------------- loot
  private lootModel(spec: LootSpec): THREE.Object3D {
    const g = new THREE.Group();
    switch (spec.kind) {
      case "ram": {
        box(g, 0.66, 0.2, 0.035, mat(0x16a05a, 0.4, 0.1, 0x16a05a, 0.55), 0, -0.1, 0, 0.01);
        for (let i = 0; i < 4; i++) box(g, 0.1, 0.1, 0.045, mat(0x10161d, 0.3, 0.3), -0.22 + i * 0.15, -0.05, 0, 0.01);
        box(g, 0.64, 0.025, 0.04, mat(0xf2c14e, 0.25, 0.9, 0xf2c14e, 0.4), 0, -0.1, 0, 0);
        box(g, 0.66, 0.02, 0.05, mat(0xeaeef5, 0.3, 0.7), 0, 0.08, 0, 0);
        g.scale.setScalar(1.35);
        break;
      }
      case "gpu": {
        box(g, 0.6, 0.26, 0.12, mat(0x15171d, 0.3, 0.5), 0, -0.13, 0, 0.02);
        for (const x of [-0.14, 0.14]) { cyl(g, 0.1, 0.1, 0.02, mat(0x30343f, 0.4, 0.6), x, 0, 0.065, 16).rotation.x = Math.PI / 2; }
        box(g, 0.5, 0.025, 0.02, mat(0x74e08b, 0.4, 0, 0x74e08b, 1.4), 0, -0.02, 0.07, 0);
        break;
      }
      case "paper": {
        box(g, 0.46, 0.025, 0.6, mat(0xf8f5ea, 0.8), 0, 0, 0, 0.01);
        for (let i = 0; i < 5; i++) box(g, 0.34, 0.006, 0.02, mat(0x8a93a6, 0.9), 0, 0.016, -0.2 + i * 0.1, 0);
        cyl(g, 0.05, 0.05, 0.01, mat(0xd7a63a, 0.3, 0.8), 0.14, 0.016, 0.22);
        g.rotation.x = -0.6;
        break;
      }
      case "merch": {
        const hoodie = mat(0xff5574, 0.88);
        box(g, 0.52, 0.46, 0.08, hoodie, 0, -0.23, 0, 0.06);
        ball(g, 0.15, hoodie, 0, 0.04, 0, 1, 0.75, 1);
        box(g, 0.1, 0.16, 0.06, hoodie, -0.3, -0.13, 0, 0.02);
        box(g, 0.1, 0.16, 0.06, hoodie, 0.3, -0.13, 0, 0.02);
        cyl(g, 0.03, 0.03, 0.18, mat(0xd0b25a, 0.3, 0.9), 0.26, -0.05, 0).rotation.z = 1.2;
        break;
      }
      case "watch": {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.05, 10, 24), mat(0xe8c15a, 0.2, 0.95));
        ring.castShadow = true; g.add(ring);
        const face = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.03, 20), mat(0x1c4c8f, 0.25, 0.4, 0x2c6cd0, 0.5));
        face.rotation.x = Math.PI / 2; g.add(face);
        box(g, 0.025, 0.12, 0.015, mat(0xffffff, 0.3), 0, 0.04, 0.03, 0);
        break;
      }
      case "supplements": {
        [[-0.16, 0x3fd1c9], [0, 0xff9f4d], [0.16, 0x8f7bff]].forEach(([x, c]) => {
          cyl(g, 0.07, 0.07, 0.24, mat(c as number, 0.35), x as number, -0.12, 0);
          cyl(g, 0.075, 0.075, 0.05, mat(0xffffff, 0.4), x as number, 0.1, 0);
        });
        break;
      }
      case "condoms": {
        const pack = mat(0x101820, 0.45, 0.15);
        box(g, 0.44, 0.32, 0.12, pack, 0, -0.16, 0, 0.02);
        const label = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.2), new THREE.MeshStandardMaterial({ map: labelTexture("JENSEN 100", "#f3ca45", "#141820", "bold 19px sans-serif", 192, 96), roughness: 0.75 }));
        label.position.set(0, -0.01, 0.065); g.add(label);
        break;
      }
    }
    return g;
  }

  private addLoot() {
    const lifts: Record<string, number> = { "ram-1": 1.05, "ram-2": 1.15, gpu: 1.1, termsheet: 0.95, merch: 1.2, condoms: 0.85, nootropics: 0.6 };
    const glowTex = softDot("rgba(255,224,120,.95)", "rgba(255,200,80,0)");
    this.level.loot.forEach((spec, i) => {
      const group = new THREE.Group();
      group.position.set(spec.x, 0, spec.y);
      const model = this.lootModel(spec);
      const lift = lifts[spec.id] ?? 0.9;
      model.position.y = lift;
      group.add(model);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: spec.required ? 0.95 : 0.6 }));
      glow.scale.setScalar(spec.required ? 2.0 : 1.3); glow.position.y = lift;
      group.add(glow);
      const glints = [0, 1, 2].map(() => {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glintTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
        s.scale.setScalar(0.35); group.add(s); return s;
      });
      this.scene.add(group);
      this.loot.push({ group, model, glow, glints, lift, spec, taken: false, phase: i * 1.7 });
    });
  }

  setLootTaken(i: number, taken: boolean) {
    const l = this.loot[i]!; l.taken = taken; l.group.visible = !taken;
  }
  lootWorldPos(i: number) { const l = this.loot[i]!; return new THREE.Vector3(l.spec.x, l.lift, l.spec.y); }

  // ---------------------------------------------------------------- exit
  private buildExit() {
    this.addPortal(this.level.exit.x, this.level.exit.y, this.level.exit.r);
    for (const exit of this.level.alternateExits ?? []) this.addPortal(exit.x, exit.y, exit.r);
  }

  /** Every entrance/exit uses same glowing extraction indicator. */
  private addPortal(x: number, y: number, r: number) {
    const exit = new THREE.Group();
    exit.position.set(x, 0, y);
    const green = mat(0x39e08a, 0.4, 0, 0x39e08a, 1.6);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 0.8, 0.07, 8, 40), green);
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.05;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(r * 0.8, 36), new THREE.MeshBasicMaterial({ color: 0x39e08a, transparent: true, opacity: 0.18, depthWrite: false }));
    disc.rotation.x = -Math.PI / 2; disc.position.y = 0.03;
    const arrows = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const sh = new THREE.Shape(); sh.moveTo(-0.3, 0); sh.lineTo(0, 0.3); sh.lineTo(0.3, 0); sh.lineTo(0.3, -0.12); sh.lineTo(0, 0.18); sh.lineTo(-0.3, -0.12); sh.closePath();
      const a = new THREE.Mesh(new THREE.ShapeGeometry(sh), new THREE.MeshBasicMaterial({ color: 0x7dffb8, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }));
      a.rotation.x = -Math.PI / 2; a.rotation.z = Math.PI / 2; a.position.set(-0.2 - i * 0.0, 0.06, 0); a.userData.i = i;
      arrows.add(a);
    }
    const light = new THREE.PointLight(0x39e08a, 12, 5, 2); light.position.set(-0.4, 1.4, 0);
    exit.add(ring, disc, arrows, light);
    this.portals.push({ ring, arrows });
    this.scene.add(exit);
  }

  private dustMotes() {
    const n = 90, rand = rng(5);
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { pos[i * 3] = 3 + rand() * 20; pos[i * 3 + 1] = 0.3 + rand() * 1.4; pos[i * 3 + 2] = 2 + rand() * 11; }
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.dust = null;
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffe9c0, size: 0.05, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending }));
    pts.userData.motes = true;
    this.scene.add(pts);
  }

  // ---------------------------------------------------------------- per frame
  update(time: number, dt: number, camera: THREE.Camera, target: THREE.Vector3, objective: THREE.Vector3 | null) {
    for (const s of this.screens) s.tick(time);
    this.flicker.forEach(l => { l.intensity = 12 + Math.sin(time * 11) * 2.5 + Math.sin(time * 3.1) * 3; });
    this.leds.forEach((led, i) => { (led.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.2 + Math.sin(time * 6 + i * 1.7) * 1.1; });
    for (const l of this.loot) {
      if (l.taken) continue;
      l.model.position.y = l.lift + Math.sin(time * 2.2 + l.phase) * 0.06;
      l.model.rotation.y = time * 1.4 + l.phase;
      (l.glow.material as THREE.SpriteMaterial).opacity = (l.spec.required ? 0.75 : 0.45) + Math.sin(time * 3 + l.phase) * 0.18;
      l.glints.forEach((s, k) => {
        const t = (time * 0.9 + l.phase + k * 0.33) % 1;
        const a = (k / 3) * Math.PI * 2 + time * 0.6;
        s.position.set(Math.cos(a) * 0.28, l.lift + Math.sin(a * 1.3) * 0.2, Math.sin(a) * 0.28);
        s.scale.setScalar(0.12 + Math.sin(t * Math.PI) * 0.3);
        (s.material as THREE.SpriteMaterial).opacity = Math.sin(t * Math.PI);
      });
    }
    // Every extraction portal pulses the same way.
    this.portals.forEach(({ ring, arrows }) => {
      ring.scale.setScalar(1 + Math.sin(time * 4) * 0.05);
      arrows.children.forEach((a, i) => { a.position.x = -0.35 + ((time * 0.8 + i * 0.33) % 1) * 0.7; ((a as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = Math.sin(((time * 0.8 + i * 0.33) % 1) * Math.PI) * 0.9; });
    });
    void objective;

    // fade whatever stands between the camera and the player
    this.ray.origin.copy(camera.position);
    this.ray.direction.subVectors(target, camera.position);
    const dist = this.ray.direction.length();
    this.ray.direction.divideScalar(dist);
    for (const o of this.occluders) {
      const hit = this.ray.intersectBox(o.box, this.tmp);
      const blocking = hit !== null && this.tmp.distanceTo(camera.position) < dist - 0.2;
      const want = blocking ? 0.16 : 1;
      o.opacity += (want - o.opacity) * Math.min(1, dt * 9);
      for (const m of o.mats) { m.opacity = o.opacity; m.depthWrite = o.opacity > 0.95; }
    }
    void this.dust;
  }
}
