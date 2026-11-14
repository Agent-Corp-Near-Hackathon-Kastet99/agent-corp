/** Keyboard + floating touch/mouse joystick + hold-to-run button. */
export class Input {
  private keys = new Set<string>();
  private stick = { id: -1, ox: 0, oy: 0, x: 0, y: 0 };
  private runPointer = -1;
  private shift = false;
  enabled = true;
  /** Fires on the first user input of any kind (used to dismiss hints). */
  onFirstInput?: () => void;
  private fired = false;

  constructor(private zone: HTMLElement, private runBtn: HTMLElement, private stickBase: HTMLElement, private stickKnob: HTMLElement) {
    const map: Record<string, string> = { ArrowUp: "u", w: "u", W: "u", ArrowDown: "d", s: "d", S: "d", ArrowLeft: "l", a: "l", A: "l", ArrowRight: "r", d: "r", D: "r" };
    addEventListener("keydown", e => {
      if (e.key === "Shift") { this.shift = true; this.poke(); return; }
      const k = map[e.key];
      if (k) { this.keys.add(k); this.poke(); e.preventDefault(); }
    });
    addEventListener("keyup", e => { if (e.key === "Shift") this.shift = false; const k = map[e.key]; if (k) this.keys.delete(k); });
    addEventListener("blur", () => { this.keys.clear(); this.shift = false; this.stick.id = -1; this.stick.x = this.stick.y = 0; this.runPointer = -1; this.stickBase.hidden = true; this.runBtn.classList.remove("down"); });

    zone.addEventListener("pointerdown", e => {
      if (this.stick.id !== -1 || !this.enabled) return;
      if ((e.target as HTMLElement).closest("button,a")) return;
      this.stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: 0, y: 0 };
      zone.setPointerCapture(e.pointerId);
      this.stickBase.hidden = false;
      this.stickBase.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
      this.stickKnob.style.transform = "translate(0px, 0px)";
      this.poke();
    });
    zone.addEventListener("pointermove", e => {
      if (e.pointerId !== this.stick.id) return;
      const R = 58;
      let dx = e.clientX - this.stick.ox, dy = e.clientY - this.stick.oy;
      const d = Math.hypot(dx, dy);
      if (d > R) { dx = (dx / d) * R; dy = (dy / d) * R; }
      this.stick.x = dx / R; this.stick.y = dy / R;
      this.stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.stick.id) return;
      this.stick.id = -1; this.stick.x = this.stick.y = 0; this.stickBase.hidden = true;
    };
    zone.addEventListener("pointerup", end); zone.addEventListener("pointercancel", end);

    runBtn.addEventListener("pointerdown", e => { e.preventDefault(); e.stopPropagation(); this.runPointer = e.pointerId; runBtn.setPointerCapture(e.pointerId); runBtn.classList.add("down"); this.poke(); });
    const up = (e: PointerEvent) => { if (e.pointerId === this.runPointer) { this.runPointer = -1; runBtn.classList.remove("down"); } };
    runBtn.addEventListener("pointerup", up); runBtn.addEventListener("pointercancel", up); runBtn.addEventListener("lostpointercapture", up);
    zone.addEventListener("contextmenu", e => e.preventDefault());
  }

  private poke() { if (!this.fired) { this.fired = true; this.onFirstInput?.(); } }

  /** Quantised so the recorded input log stays small and identical on the server. */
  read() {
    if (!this.enabled) return { mx: 0, my: 0, run: false };
    let x = this.stick.x, y = this.stick.y;
    const kx = (this.keys.has("r") ? 1 : 0) - (this.keys.has("l") ? 1 : 0), ky = (this.keys.has("d") ? 1 : 0) - (this.keys.has("u") ? 1 : 0);
    if (kx || ky) { x = kx; y = ky; }
    const q = (v: number) => Math.max(-100, Math.min(100, Math.round(v * 20) * 5));
    return { mx: q(x), my: q(y), run: this.shift || this.runPointer !== -1 };
  }
}
