import * as THREE from "three";
import { glintTexture, softDot } from "./textures.js";

type Particle = { sprite: THREE.Sprite; vx: number; vy: number; vz: number; life: number; max: number; grow: number; gravity: number; size: number; drag: number; active: boolean };

/** A small pool of sprites for dust, sparkles, smoke and bursts. */
export class Particles {
  private pool: Particle[] = [];
  private soft = softDot();
  private glint = glintTexture();
  constructor(scene: THREE.Scene, count = 260) {
    for (let i = 0; i < count; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.soft, transparent: true, depthWrite: false }));
      sprite.visible = false; scene.add(sprite);
      this.pool.push({ sprite, vx: 0, vy: 0, vz: 0, life: 0, max: 1, grow: 0, gravity: 0, size: 0.2, drag: 0, active: false });
    }
  }
  emit(o: { x: number; y: number; z: number; vx?: number; vy?: number; vz?: number; life?: number; size?: number; grow?: number; gravity?: number; drag?: number; color?: number; additive?: boolean; spark?: boolean; opacity?: number }) {
    const p = this.pool.find(q => !q.active);
    if (!p) return;
    p.active = true; p.life = p.max = o.life ?? 0.6; p.size = o.size ?? 0.2; p.grow = o.grow ?? 0; p.gravity = o.gravity ?? 0; p.drag = o.drag ?? 0;
    p.vx = o.vx ?? 0; p.vy = o.vy ?? 0; p.vz = o.vz ?? 0;
    const m = p.sprite.material as THREE.SpriteMaterial;
    m.map = o.spark ? this.glint : this.soft; m.color.set(o.color ?? 0xffffff); m.opacity = o.opacity ?? 1;
    m.blending = o.additive ? THREE.AdditiveBlending : THREE.NormalBlending; m.needsUpdate = true;
    p.sprite.userData.base = o.opacity ?? 1;
    p.sprite.position.set(o.x, o.y, o.z); p.sprite.scale.setScalar(p.size); p.sprite.visible = true;
  }
  burst(x: number, y: number, z: number, n: number, color: number, speed = 2.2, spark = true) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, e = Math.random() * 1.2 + 0.2, s = speed * (0.4 + Math.random() * 0.8);
      this.emit({ x, y, z, vx: Math.cos(a) * s, vy: e * s * 0.9 + 0.8, vz: Math.sin(a) * s, life: 0.5 + Math.random() * 0.5, size: 0.14 + Math.random() * 0.22, gravity: -4.5, drag: 1.5, color, additive: true, spark });
    }
  }
  smoke(x: number, y: number, z: number, n: number) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 0.4 + Math.random() * 0.9;
      this.emit({ x, y, z, vx: Math.cos(a) * s, vy: 0.3 + Math.random() * 0.6, vz: Math.sin(a) * s, life: 0.9 + Math.random() * 0.6, size: 0.4, grow: 1.2, color: 0xcfd3e0, opacity: 0.8, drag: 1.2 });
    }
  }
  update(dt: number) {
    for (const p of this.pool) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) { p.active = false; p.sprite.visible = false; continue; }
      const k = 1 / (1 + p.drag * dt);
      p.vx *= k; p.vz *= k; p.vy = p.vy * k + p.gravity * dt;
      p.sprite.position.x += p.vx * dt; p.sprite.position.y = Math.max(0.02, p.sprite.position.y + p.vy * dt); p.sprite.position.z += p.vz * dt;
      const t = p.life / p.max;
      p.sprite.scale.setScalar(p.size + p.grow * (1 - t) * p.size);
      (p.sprite.material as THREE.SpriteMaterial).opacity = (p.sprite.userData.base as number) * Math.min(1, t * 2.2);
    }
  }
  clear() { for (const p of this.pool) { p.active = false; p.sprite.visible = false; } }
}

/** Expanding rings on the floor (footstep noise, pickups). */
export class Rings {
  private rings: Array<{ mesh: THREE.Mesh; life: number; max: number; from: number; to: number; active: boolean }> = [];
  constructor(scene: THREE.Scene, count = 12) {
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
      mesh.rotation.x = -Math.PI / 2; mesh.visible = false; mesh.renderOrder = 2; scene.add(mesh);
      this.rings.push({ mesh, life: 0, max: 1, from: 0.2, to: 1, active: false });
    }
  }
  emit(x: number, z: number, from: number, to: number, life: number, color: number) {
    const r = this.rings.find(q => !q.active) ?? this.rings[0]!;
    r.active = true; r.life = r.max = life; r.from = from; r.to = to;
    (r.mesh.material as THREE.MeshBasicMaterial).color.set(color);
    r.mesh.position.set(x, 0.05, z); r.mesh.visible = true;
  }
  update(dt: number) {
    for (const r of this.rings) {
      if (!r.active) continue;
      r.life -= dt;
      if (r.life <= 0) { r.active = false; r.mesh.visible = false; continue; }
      const t = 1 - r.life / r.max;
      r.mesh.scale.setScalar(r.from + (r.to - r.from) * (1 - (1 - t) * (1 - t)));
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - t) * 0.7;
    }
  }
  clear() { for (const r of this.rings) { r.active = false; r.mesh.visible = false; } }
}

/** Smooth follow camera with look-ahead, run zoom, shake and a punch-in. */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  private focus = new THREE.Vector3();
  private look = new THREE.Vector3();
  private shake = 0;
  private zoom = 1;
  private punch = 0;
  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(36, aspect, 0.5, 120);
  }
  resize(aspect: number) { this.camera.aspect = aspect; this.camera.updateProjectionMatrix(); }
  kick(amount: number) { this.shake = Math.max(this.shake, amount); }
  setPunch(p: number) { this.punch = p; }
  snap(x: number, z: number) { this.focus.set(x, 0, z); }
  update(dt: number, x: number, z: number, vx: number, vz: number, running: boolean, time: number) {
    const lookAhead = 0.9;
    this.look.set(x + vx * lookAhead * 0.35, 0, z + vz * lookAhead * 0.35);
    this.focus.lerp(this.look, 1 - Math.exp(-dt * 5.5));
    const wantZoom = (running ? 1.1 : 1) * (1 - this.punch * 0.22);
    this.zoom += (wantZoom - this.zoom) * (1 - Math.exp(-dt * 3));
    const dist = 12.5 * this.zoom, pitch = 0.98; // ~56 degrees
    this.shake = Math.max(0, this.shake - dt * 2.4);
    const sx = (Math.sin(time * 61) + Math.sin(time * 37)) * 0.5 * this.shake * 0.18, sz = Math.cos(time * 53) * this.shake * 0.12;
    this.camera.position.set(this.focus.x + sx, Math.sin(pitch) * dist, this.focus.z + Math.cos(pitch) * dist + sz);
    this.camera.lookAt(this.focus.x + sx, 0.4, this.focus.z - 0.5);
  }
}
