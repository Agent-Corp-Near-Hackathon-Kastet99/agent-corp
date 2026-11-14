import { mkdir, open, readFile, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

export type UsageState = { date: string; usedUnits: string; pendingUnits?: string; updatedAt: string };
const utcDate = (date = new Date()) => date.toISOString().slice(0, 10);
const nonnegative = (units: bigint) => { if (units < 0n) throw new Error("units must be non-negative"); };

/** One process, one active reservation. Exact cost settles precisely; interrupted work charges conservatively. */
export class DailyCap {
  file: string;
  readonly lock: string;
  #state!: UsageState;
  #locked = false;
  #handle?: FileHandle;
  #reserved?: bigint;
  constructor(readonly capUnits: bigint, root = process.env.AGENT_CORP_HOME ?? join(process.env.HOME ?? ".", ".agent-corp"), private readonly now = () => new Date()) {
    nonnegative(capUnits);
    this.file = join(root, `usage-${utcDate(now())}.json`);
    this.lock = join(root, "worker.lock");
  }
  async acquire(): Promise<void> {
    if (this.#locked) throw new Error("worker cap already acquired");
    await mkdir(dirname(this.file), { recursive: true });
    try { this.#handle = await open(this.lock, "wx", 0o600); this.#locked = true; }
    catch { throw new Error("another agent-corp worker process is already running (after a crash, remove worker.lock only after confirming its process stopped)"); }
    try { await this.save(this.recover(await this.read(this.file))); }
    catch (error) { await this.release(); throw error; }
  }
  async release(): Promise<void> {
    if (this.#reserved !== undefined) await this.abandon();
    if (this.#locked) {
      this.#locked = false;
      await this.#handle?.close(); this.#handle = undefined;
      await rm(this.lock, { force: true });
    }
  }
  get usedUnits(): bigint { return BigInt(this.#state.usedUnits); }
  get remainingUnits(): bigint { return this.capUnits - this.usedUnits - BigInt(this.#state.pendingUnits ?? "0"); }
  async available(): Promise<bigint> { this.assertLocked(); await this.rollover(); return this.remainingUnits; }
  async cancelReservation(): Promise<void> {
    this.assertLocked();
    const next = { ...this.#state }; delete next.pendingUnits;
    await this.save(next); this.#reserved = undefined;
  }
  async reserve(max: bigint): Promise<boolean> {
    this.assertLocked(); nonnegative(max);
    if (this.#reserved !== undefined) return false;
    this.#reserved = max; // claim before any asynchronous persistence
    try {
      await this.rollover();
      if (max > this.remainingUnits) { this.#reserved = undefined; return false; }
      await this.save({ ...this.#state, pendingUnits: max.toString() });
      return true;
    } catch (error) { this.#reserved = undefined; throw error; }
  }
  async checkpoint(units: bigint): Promise<boolean> {
    this.assertLocked(); nonnegative(units);
    if (this.#reserved === undefined) throw new Error("no active reservation");
    const pending = BigInt(this.#state.pendingUnits ?? this.#reserved);
    await this.save({ ...this.#state, pendingUnits: (units > pending ? units : pending).toString() });
    return units <= this.#reserved && this.usedUnits + units <= this.capUnits;
  }
  async commit(units: bigint): Promise<void> {
    this.assertLocked(); nonnegative(units);
    const next = { ...this.#state, usedUnits: (this.usedUnits + units).toString() };
    delete next.pendingUnits;
    await this.save(next); // memory and reservation change only after atomic persistence
    this.#reserved = undefined;
  }
  async abandon(): Promise<void> {
    this.assertLocked();
    if (this.#reserved !== undefined) await this.commit(BigInt(this.#state.pendingUnits ?? this.#reserved));
  }
  private assertLocked() { if (!this.#locked) throw new Error("worker cap not acquired"); }
  private recover(state: UsageState): UsageState {
    const next = { ...state };
    if (next.pendingUnits !== undefined) {
      next.usedUnits = (BigInt(next.usedUnits) + BigInt(next.pendingUnits)).toString();
      delete next.pendingUnits;
    }
    return next;
  }
  private async rollover(): Promise<void> {
    const date = utcDate(this.now());
    if (this.#state.date === date) return;
    // Active work settles against its start date. Only new reservations cross UTC days.
    const file = join(dirname(this.file), `usage-${date}.json`);
    await this.save(this.recover(await this.read(file)), file);
  }
  private async read(file: string): Promise<UsageState> {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as UsageState;
      if (parsed.date !== utcDate(this.now()) || !/^\d+$/.test(parsed.usedUnits)
          || parsed.pendingUnits !== undefined && !/^\d+$/.test(parsed.pendingUnits)) throw new Error("invalid usage state");
      return parsed;
    } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return { date: utcDate(this.now()), usedUnits: "0", updatedAt: this.now().toISOString() };
  }
  private async save(value: UsageState, file = this.file): Promise<void> {
    const next = { ...value, updatedAt: this.now().toISOString() };
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    await rename(temp, file);
    this.#state = next; this.file = file;
  }
}
