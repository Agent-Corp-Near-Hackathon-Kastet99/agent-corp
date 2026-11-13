import { mkdir, open, readFile, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

export type UsageState = { date: string; usedUnits: string; pendingUnits?: string; updatedAt: string };
const utcDate = (date = new Date()) => date.toISOString().slice(0, 10);

export class DailyCap {
  readonly file: string;
  readonly lock: string;
  #state!: UsageState;
  #locked = false;
  #handle?: FileHandle;
  constructor(readonly capUnits: bigint, root = process.env.AGENT_CORP_HOME ?? join(process.env.HOME ?? ".", ".agent-corp"), private readonly now = () => new Date()) {
    this.file = join(root, `usage-${utcDate(now())}.json`);
    this.lock = join(root, "worker.lock");
  }

  async acquire(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    try { this.#handle = await open(this.lock, "wx", 0o600); this.#locked = true; }
    catch { throw new Error("another agent-corp worker process is already running"); }
    try {
      this.#state = await this.read();
      await this.write(); // normalize stale/missing state immediately
    } catch (error) { await this.release(); throw error; }
  }
  async release(): Promise<void> {
    if (this.#locked) {
      this.#locked = false;
      await this.#handle?.close();
      this.#handle = undefined;
      await rm(this.lock, { force: true });
    }
  }
  get usedUnits(): bigint { return BigInt(this.#state.usedUnits); }
  get remainingUnits(): bigint { return this.capUnits - this.usedUnits - BigInt(this.#state.pendingUnits ?? "0"); }
  async reserve(max: bigint): Promise<boolean> {
    await this.rollover();
    if (max > this.remainingUnits) return false;
    this.#state.pendingUnits = "0";
    await this.write();
    return true;
  }
  async checkpoint(units: bigint): Promise<boolean> {
    await this.rollover();
    if (this.usedUnits + units > this.capUnits) return false;
    this.#state.pendingUnits = units.toString();
    await this.write();
    return true;
  }
  async commit(units: bigint): Promise<void> {
    await this.rollover();
    if (this.usedUnits + units > this.capUnits) throw new Error("daily cap exceeded");
    this.#state.usedUnits = (this.usedUnits + units).toString();
    delete this.#state.pendingUnits;
    await this.write();
  }
  async abandon(): Promise<void> { await this.rollover(); delete this.#state.pendingUnits; await this.write(); }
  private async rollover(): Promise<void> {
    const date = utcDate(this.now());
    if (this.#state.date === date) return;
    (this as { file: string }).file = join(dirname(this.file), `usage-${date}.json`);
    this.#state = await this.read();
    await this.write();
  }
  private async read(): Promise<UsageState> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as UsageState;
      if (parsed.date === utcDate(this.now()) && /^\d+$/.test(parsed.usedUnits)) return parsed;
    } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return { date: utcDate(this.now()), usedUnits: "0", updatedAt: this.now().toISOString() };
  }
  private async write(): Promise<void> {
    this.#state.updatedAt = this.now().toISOString();
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(this.#state)}\n`, { mode: 0o600 });
    await rename(temp, this.file);
  }
}
