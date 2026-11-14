import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "../config.js";

export type OptIn = { email: string; ts: number };
const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const MAX = 2000;

/** Consent record: the only recipients Resend may be used for. Stored with the time the person opted in. */
export class OptInStore {
  private rows: OptIn[] = [];
  constructor(
    private readonly now: () => number = Date.now,
    private readonly file = join(process.env.GROWTH_DIR ?? join(ROOT, ".data", "growth"), "optin.json"),
  ) {
    if (existsSync(file)) {
      const v: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(v) || !v.every(r => r && typeof r.email === "string" && Number.isFinite(r.ts))) throw new Error("Invalid opt-in file");
      this.rows = v as OptIn[];
    }
  }
  static valid(email: unknown): email is string { return typeof email === "string" && EMAIL.test(email.trim()); }
  has(email: string) { return this.rows.some(r => r.email === email.trim().toLowerCase()); }
  /** Returns true if newly added. Throws when full or invalid. */
  add(email: string): boolean {
    if (!OptInStore.valid(email)) throw new Error("invalid email");
    const e = email.trim().toLowerCase();
    if (this.has(e)) return false;
    if (this.rows.length >= MAX) throw new Error("waitlist full");
    const next = [...this.rows, { email: e, ts: this.now() }];
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.rows = next;
    return true;
  }
  count() { return this.rows.length; }
}
