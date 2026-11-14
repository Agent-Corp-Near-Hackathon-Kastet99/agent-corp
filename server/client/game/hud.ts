const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

const fmt = (ms: number) => { const s = ms / 1000; return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`; };

export type ResultView = {
  won: boolean; ms: number; targetMs: number; lootPct: number; loot: number; lootTotal: number; score: number;
  medals: { undetected: boolean; time: boolean; loot: boolean }; best?: number; verified: boolean | null;
};

export class Hud {
  root: HTMLElement;
  private objective: HTMLElement;
  private guardMarks: HTMLElement[] = [];
  private toastEl: HTMLElement;
  private toastTimer = 0;
  private lastText = "";

  constructor(root: HTMLElement) {
    this.root = root;
    root.innerHTML = `
      <div class="hud-top">
        <div class="game-logo" aria-label="Alt-Ram Sam">ALT-RAM <em>SAM</em></div>
      </div>
      <div class="hud-objective"><span id="hud-objective-text"></span></div>
      <div class="marker objective" id="marker-objective"><span class="marker-pill" id="marker-label">RAM</span><i class="marker-arrow"></i></div>
      <div class="marker guard" id="marker-g0"><i class="marker-arrow"></i><b>!</b></div>
      <div class="marker guard" id="marker-g1"><i class="marker-arrow"></i><b>!</b></div>
      <div class="hud-toast" id="hud-toast"></div>
      <div class="hud-float" id="hud-float"></div>
      <div class="hud-flash" id="hud-flash"></div>
      <div class="stick-base" id="stick-base" hidden><div class="stick-knob" id="stick-knob"></div></div>
      <button class="run-btn" id="run-btn" aria-label="Hold to run"><svg viewBox="0 0 64 64"><path d="M10 40c0-5 3-8 8-8l10-1 8-12c2-3 7-3 9 0l6 9c2 3 0 6-3 6l-6 1 3 10 9 3c3 1 4 5 1 7-1 1-3 1-5 0l-12-4c-3-1-5-3-6-6l-1-6-6 1-6 6c-2 2-5 2-7 0-2-1-3-3-3-5z" fill="currentColor"/></svg><span>RUN<small>louder</small></span></button>
      <div class="hint" id="hud-hint"><span id="hud-hint-copy"></span><span class="hint-sprint"><b>SPRINT</b><span class="sprint-track"><i id="hud-sprint"></i></span></span></div>
      <div class="overlay intro" id="ov-intro" hidden></div>
      <div class="overlay busted" id="ov-busted" hidden></div>
      <div class="overlay results" id="ov-results" hidden></div>
      <div class="overlay locked" id="ov-locked" hidden></div>`;
    this.objective = $("#marker-objective", root);
    this.guardMarks = [$("#marker-g0", root), $("#marker-g1", root)];
    this.toastEl = $("#hud-toast", root);
  }

  setTarget(_ms: number) {}
  update(o: { ms: number; loot: number; lootTotal: number; ram: number; ramTotal: number; objectiveText: string; late: boolean; sprint: number; sprintMax: number }) {
    $("#hud-sprint", this.root).style.width = `${Math.round((o.sprint / o.sprintMax) * 100)}%`;
    if (o.objectiveText !== this.lastText) { this.lastText = o.objectiveText; $("#hud-objective-text", this.root).textContent = o.objectiveText; const el = $(".hud-objective", this.root); el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop"); }
  }
  bump() {}

  /** Position an edge marker. (nx, ny) are NDC coordinates; behind = target is behind the camera. */
  mark(kind: "objective" | number, nx: number, ny: number, label: string | null, show = true) {
    const el = kind === "objective" ? this.objective : this.guardMarks[kind]!;
    if (!show) { el.style.display = "none"; return; }
    el.style.display = "";
    const w = innerWidth, h = innerHeight, mx = 54, my = kind === "objective" ? 96 : 70;
    let sx = (nx * 0.5 + 0.5) * w, sy = (-ny * 0.5 + 0.5) * h;
    const inside = sx > mx && sx < w - mx && sy > my && sy < h - my;
    el.classList.toggle("onscreen", inside);
    if (label !== null && kind === "objective") $("#marker-label", el).textContent = label;
    if (inside) {
      el.style.transform = `translate(${sx}px, ${sy - (kind === "objective" ? 62 : 50)}px)`;
      $(".marker-arrow", el).style.transform = kind === "objective" ? "rotate(180deg)" : "rotate(180deg)";
      el.classList.toggle("far", false);
    } else {
      const cx = w / 2, cy = h / 2, dx = sx - cx, dy = sy - cy;
      const k = Math.min((w / 2 - mx) / Math.abs(dx || 1e-6), (h / 2 - my) / Math.abs(dy || 1e-6));
      sx = cx + dx * k; sy = cy + dy * k;
      el.style.transform = `translate(${sx}px, ${sy}px)`;
      $(".marker-arrow", el).style.transform = `rotate(${(Math.atan2(dy, dx) * 180) / Math.PI + 90}deg)`;
    }
  }
  hideMarkers() { this.objective.style.display = "none"; this.guardMarks.forEach(m => (m.style.display = "none")); }

  toast(text: string, ms = 2600) {
    this.toastEl.textContent = text; this.toastEl.classList.add("show");
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove("show"), ms);
  }
  hint(text: string) { $("#hud-hint-copy", this.root).textContent = text; }

  float(sx: number, sy: number, text: string, cls = "") {
    const el = document.createElement("div");
    el.className = `float ${cls}`; el.textContent = text; el.style.left = `${sx}px`; el.style.top = `${sy}px`;
    $("#hud-float", this.root).appendChild(el);
    setTimeout(() => el.remove(), 1500);
  }
  flash(color = "rgba(255,60,80,.45)") {
    const el = $("#hud-flash", this.root);
    el.style.background = `radial-gradient(circle at 50% 50%, transparent 35%, ${color} 100%)`;
    el.classList.remove("go"); void el.offsetWidth; el.classList.add("go");
  }

  // ----------------------------------------------------------------- overlays
  private show(id: string, html: string) { const el = $(`#${id}`, this.root); el.innerHTML = html; el.hidden = false; return el; }
  hideAll() { this.root.querySelectorAll(".overlay").forEach(o => ((o as HTMLElement).hidden = true)); }

  intro(best: number | undefined, onStart: () => void) {
    const el = this.show("ov-intro", `
      <div class="card intro-card">
        <span class="stamp">MISSION 01</span>
        <h1>ALT-RAM <em>SAM</em></h1>
        <p class="sub">Founder HQ · 11:47 PM · RAM is $400 a stick</p>
        <ul class="brief">
          <li><b>1</b><span>Steal <strong>both RAM sticks</strong>. Anything shiny is bonus loot.</span></li>
          <li><b>2</b><span>Stay out of the <strong>cones</strong>. Red dots show where they walk next.</span></li>
          <li><b>3</b><span><strong>Hide</strong> in hedges and closets. Extract through any glowing exit.</span></li>
        </ul>
        <div class="keys"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> sneak <kbd>Shift</kbd> sprint <em>(3 sec · loud)</em></div>
        <button class="big" id="go">START HEIST</button>
      </div>`);
    const go = () => { removeEventListener("keydown", key); this.hideAll(); onStart(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
    $("#go", el).addEventListener("click", go);
    addEventListener("keydown", key);
  }

  busted(quip: string, onRetry: () => void) {
    const el = this.show("ov-busted", `
      <div class="iris"></div>
      <div class="busted-card"><div class="busted-stamp">BUSTED!</div><p>${quip}</p><a class="big" href="/store">SMOKE ESCAPE <small>1 tNEAR</small></a><button class="ghost retry" id="retry">RETRY <small>Enter</small></button></div>`);
    const go = () => { removeEventListener("keydown", key); el.hidden = true; onRetry(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
    $("#retry", el).addEventListener("click", go);
    setTimeout(() => addEventListener("keydown", key), 250);
  }

  results(r: ResultView, onRetry: () => void) {
    const medal = (ok: boolean, name: string, detail: string, icon: string) => `<div class="medal ${ok ? "got" : "miss"}"><i>${ok ? icon : "✕"}</i><div><b>${name}</b><small>${detail}</small></div></div>`;
    const el = this.show("ov-results", `
      <div class="ring">
        <div class="ring-inner">
          <h2>GREAT JOB!</h2>
          <div class="medals">
            ${medal(r.medals.undetected, "Undetected", r.medals.undetected ? "Ghost" : "They saw you", "👻")}
            ${medal(r.medals.time, "Speed", `${fmt(r.ms)} / ${fmt(r.targetMs)}`, "⚡")}
            ${medal(r.medals.loot, "Loot", `${r.loot}/${r.lootTotal} (${r.lootPct}%)`, "💰")}
          </div>
          <div class="score"><span>SCORE</span><b>${r.score.toLocaleString()}</b></div>
          <p class="verify">${r.verified === true ? "✓ Run verified by the server" : r.verified === false ? "Run could not be verified" : "Verifying run…"}${r.best ? ` · Best ${fmt(r.best)}` : ""}</p>
          <div class="btns"><button class="big" id="again">PLAY AGAIN <small>Enter</small></button><a class="ghost" href="/store">Store</a></div>
        </div>
      </div>`);
    const go = () => { removeEventListener("keydown", key); el.hidden = true; onRetry(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
    $("#again", el).addEventListener("click", go);
    setTimeout(() => addEventListener("keydown", key), 400);
  }
  setVerified(ok: boolean, best?: number) {
    const el = this.root.querySelector(".verify");
    if (el) el.textContent = `${ok ? "✓ Run verified by the server" : "Run could not be verified"}${best ? ` · Best ${fmt(best)}` : ""}`;
  }

  locked(message: string) {
    this.show("ov-locked", `<div class="card"><span class="stamp">PASS REQUIRED</span><h1>ALT-RAM <em>SAM</em></h1><p>${message}</p><a class="big link" href="/store">GET A PASS</a></div>`);
  }
}
