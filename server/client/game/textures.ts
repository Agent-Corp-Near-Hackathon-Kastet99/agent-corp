import * as THREE from "three";

/** Tiny seeded RNG so textures look identical on every load. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function make(size: number, draw: (g: CanvasRenderingContext2D, size: number) => void, repeat = true) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  draw(g, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function speckle(g: CanvasRenderingContext2D, size: number, n: number, r: () => number, colors: string[], max = 2.2) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = colors[Math.floor(r() * colors.length)]!;
    g.globalAlpha = 0.05 + r() * 0.18;
    g.fillRect(r() * size, r() * size, 1 + r() * max, 1 + r() * max);
  }
  g.globalAlpha = 1;
}

export type FloorTheme = "living" | "office" | "kitchen" | "hall" | "bath" | "foyer" | "bedroom" | "grass";

/** Every floor texture covers 2x2 tiles, except grass which covers 4x4. */
export function floorTexture(theme: FloorTheme): THREE.CanvasTexture {
  const r = rng(theme.length * 977 + theme.charCodeAt(0));
  switch (theme) {
    case "hall": // warm wood planks
      return make(512, (g, s) => {
        const rows = 16, h = s / rows;
        for (let i = 0; i < rows; i++) {
          let x = -r() * 120;
          while (x < s) {
            const w = 130 + r() * 150;
            const l = 52 + r() * 8;
            g.fillStyle = `hsl(${26 + r() * 6}, ${52 + r() * 10}%, ${l}%)`;
            g.fillRect(x, i * h, w, h);
            g.fillStyle = "rgba(60,30,10,.45)"; g.fillRect(x, i * h, 2, h);
            x += w;
          }
          g.fillStyle = "rgba(60,30,10,.35)"; g.fillRect(0, i * h, s, 2);
        }
        speckle(g, s, 1400, r, ["#5a3216", "#ffd9a0"], 3);
      });
    case "living": // deep teal carpet
      return make(256, (g, s) => {
        g.fillStyle = "#2f6f78"; g.fillRect(0, 0, s, s);
        speckle(g, s, 5000, r, ["#1f4a52", "#6bb5bd", "#2f6f78"], 1.6);
      });
    case "office": // slate carpet tiles
      return make(256, (g, s) => {
        g.fillStyle = "#39435f"; g.fillRect(0, 0, s, s);
        speckle(g, s, 4000, r, ["#222a40", "#6b7aa6"], 1.5);
        g.strokeStyle = "rgba(20,26,44,.8)"; g.lineWidth = 2;
        for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(i * s / 4, 0); g.lineTo(i * s / 4, s); g.moveTo(0, i * s / 4); g.lineTo(s, i * s / 4); g.stroke(); }
      });
    case "kitchen": // terracotta + cream checker
      return make(256, (g, s) => {
        const n = 4, c = s / n;
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { g.fillStyle = (x + y) % 2 ? "#cf5b3e" : "#f3e5c4"; g.fillRect(x * c, y * c, c, c); }
        speckle(g, s, 2500, r, ["#7a3320", "#fff7e0"], 2);
        g.strokeStyle = "rgba(90,50,30,.35)"; g.lineWidth = 2;
        for (let i = 0; i <= n; i++) { g.beginPath(); g.moveTo(i * c, 0); g.lineTo(i * c, s); g.moveTo(0, i * c); g.lineTo(s, i * c); g.stroke(); }
      });
    case "bath": // navy tile
      return make(256, (g, s) => {
        const n = 8, c = s / n;
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { g.fillStyle = (x + y) % 2 ? "#1d3d78" : "#2a5aa6"; g.fillRect(x * c, y * c, c, c); }
        g.strokeStyle = "rgba(220,235,255,.7)"; g.lineWidth = 2;
        for (let i = 0; i <= n; i++) { g.beginPath(); g.moveTo(i * c, 0); g.lineTo(i * c, s); g.moveTo(0, i * c); g.lineTo(s, i * c); g.stroke(); }
      });
    case "foyer": // slate stone
      return make(256, (g, s) => {
        const n = 2, c = s / n;
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { g.fillStyle = `hsl(222, 14%, ${52 + r() * 10}%)`; g.fillRect(x * c, y * c, c, c); }
        speckle(g, s, 3500, r, ["#2c3140", "#c9d0e0"], 2.4);
        g.strokeStyle = "rgba(30,34,48,.8)"; g.lineWidth = 3;
        for (let i = 0; i <= n; i++) { g.beginPath(); g.moveTo(i * c, 0); g.lineTo(i * c, s); g.moveTo(0, i * c); g.lineTo(s, i * c); g.stroke(); }
      });
    case "bedroom": // lavender carpet
      return make(256, (g, s) => {
        g.fillStyle = "#7b6aa8"; g.fillRect(0, 0, s, s);
        speckle(g, s, 5000, r, ["#4f4178", "#b8a8e6"], 1.6);
      });
    case "grass": // moonlit lawn with mowing stripes
      return make(512, (g, s) => {
        for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? "#2f6a3a" : "#37783f"; g.fillRect(i * s / 8, 0, s / 8, s); }
        for (let i = 0; i < 9000; i++) {
          const x = r() * s, y = r() * s;
          g.strokeStyle = r() > 0.5 ? "rgba(120,200,110,.35)" : "rgba(10,50,25,.35)";
          g.lineWidth = 1; g.beginPath(); g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 3, y - 3 - r() * 4); g.stroke();
        }
      });
  }
}

/** Soft radial gradient used for blob shadows and glows. */
export function softDot(inner = "rgba(255,255,255,1)", outer = "rgba(255,255,255,0)") {
  return make(128, (g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, inner); gr.addColorStop(1, outer);
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
  }, false);
}

export function starTexture() {
  return make(128, (g, s) => {
    g.translate(s / 2, s / 2);
    g.fillStyle = "#ffe27a"; g.strokeStyle = "#a86b00"; g.lineWidth = 6; g.lineJoin = "round";
    g.beginPath();
    for (let i = 0; i < 10; i++) { const a = (i * Math.PI) / 5 - Math.PI / 2, rad = i % 2 ? 22 : 54; g.lineTo(Math.cos(a) * rad, Math.sin(a) * rad); }
    g.closePath(); g.fill(); g.stroke();
  }, false);
}

export function glintTexture() {
  return make(128, (g, s) => {
    const c = s / 2;
    const grd = g.createRadialGradient(c, c, 0, c, c, c);
    grd.addColorStop(0, "rgba(255,255,255,1)"); grd.addColorStop(0.15, "rgba(255,250,200,.9)"); grd.addColorStop(1, "rgba(255,230,120,0)");
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
    g.fillStyle = "rgba(255,255,255,.95)";
    g.beginPath(); g.moveTo(c, 4); g.lineTo(c + 5, c - 5); g.lineTo(s - 4, c); g.lineTo(c + 5, c + 5); g.lineTo(c, s - 4); g.lineTo(c - 5, c + 5); g.lineTo(4, c); g.lineTo(c - 5, c - 5); g.closePath(); g.fill();
  }, false);
}

/** Animated screen: draws into its own canvas; call .tick(time). */
export function screenTexture(kind: "news" | "code" | "chart") {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 160;
  const g = c.getContext("2d")!;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const r0 = rng(kind.length * 31);
  const lines = Array.from({ length: 14 }, () => ({ w: 40 + r0() * 150, c: ["#7cf2c6", "#8fb4ff", "#ffd37a", "#ff8fb1"][Math.floor(r0() * 4)]! }));
  let last = -1;
  return {
    texture: tex,
    tick(time: number) {
      const frame = Math.floor(time * 8);
      if (frame === last) return; last = frame;
      if (kind === "news") {
        g.fillStyle = "#12203c"; g.fillRect(0, 0, 256, 160);
        g.fillStyle = "#ff3d57"; g.fillRect(0, 0, 256, 26);
        g.fillStyle = "#fff"; g.font = "bold 18px sans-serif"; g.fillText("AI NEWS  ● LIVE", 8, 19);
        // falling chart
        g.strokeStyle = "#ff6b81"; g.lineWidth = 4; g.beginPath();
        for (let x = 0; x <= 256; x += 16) { const y = 60 + x * 0.25 + Math.sin(x * 0.2 + time * 2) * 10; x ? g.lineTo(x, y) : g.moveTo(x, y); }
        g.stroke();
        g.fillStyle = "#fff"; g.font = "bold 15px sans-serif";
        const text = "  BREAKING: AI BUBBLE?  ·  RAM PRICES UP 400%  ·  FOUNDER HAS NOT SLEPT  ·  ";
        g.fillStyle = "#ffd44d"; g.fillRect(0, 130, 256, 30);
        g.fillStyle = "#222"; g.fillText(text + text, -((time * 60) % (g.measureText(text).width)), 151);
      } else if (kind === "code") {
        g.fillStyle = "#0f1626"; g.fillRect(0, 0, 256, 160);
        lines.forEach((l, i) => { g.fillStyle = l.c; g.globalAlpha = 0.85; g.fillRect(12 + (i % 3) * 14, 10 + i * 10.5, l.w * (0.8 + 0.2 * Math.sin(time * 3 + i)), 5); });
        g.globalAlpha = 1;
        if (Math.floor(time * 2) % 2) { g.fillStyle = "#fff"; g.fillRect(14, 150, 8, 4); }
      } else {
        g.fillStyle = "#101a30"; g.fillRect(0, 0, 256, 160);
        g.fillStyle = "#7cf2c6"; g.font = "bold 14px monospace"; g.fillText("runway: 3 days", 10, 20);
        g.fillStyle = "#ff8fb1"; g.fillRect(10, 40, 40 + (Math.sin(time) + 1) * 80, 14);
        g.fillStyle = "#8fb4ff"; g.fillRect(10, 64, 120, 14);
        g.fillStyle = "#ffd37a"; g.fillRect(10, 88, 200 - (Math.sin(time * 1.3) + 1) * 60, 14);
      }
      tex.needsUpdate = true;
    },
  };
}

export function labelTexture(text: string, fg = "#fff", bg = "rgba(0,0,0,0)", font = "bold 44px 'Lilita One', sans-serif", w = 256, h = 96) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  g.fillStyle = fg; g.font = font; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(text, w / 2, h / 2 + 2);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
