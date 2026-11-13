import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { JobState, Subtask } from "@agentcorp/shared";

export type JobRow = { id: string; url: string; page_text: string; state: JobState; paid_at: number | null; refund_opens_at: number; teardown_copy: string | null; teardown_design: string | null; receipt_json: string | null };
export type AttemptRow = { attempt_id: string; job_id: string; subtask: Subtask; worker: string; lease_generation: number; status: string; units: string; usage_credited: number; lease_until: number };
export class Db {
  readonly sql: DatabaseSync;
  constructor(path = ":memory:") { this.sql = new DatabaseSync(path); this.sql.exec("PRAGMA journal_mode = WAL"); this.migrate(); }
  private migrate() { this.sql.exec(`
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY,url TEXT NOT NULL,page_text TEXT NOT NULL,state TEXT NOT NULL,paid_at INTEGER,refund_opens_at INTEGER NOT NULL,teardown_copy TEXT,teardown_design TEXT,receipt_json TEXT);
    CREATE TABLE IF NOT EXISTS attempts (attempt_id TEXT PRIMARY KEY,job_id TEXT NOT NULL,subtask TEXT NOT NULL,worker TEXT NOT NULL,lease_generation INTEGER NOT NULL,status TEXT NOT NULL,units TEXT NOT NULL DEFAULT '0',usage_credited INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS results (attempt_id TEXT PRIMARY KEY,text TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY,account TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS points (account TEXT PRIMARY KEY,points INTEGER NOT NULL DEFAULT 0);
  `); }
  createJob(id: string, url: string, pageText: string, now: number, refundMs: number) { this.sql.prepare("INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?)").run(id,url,pageText,"created",null,now+refundMs,null,null,null); }
  getJob(id: string) { return this.sql.prepare("SELECT * FROM jobs WHERE id=?").get(id) as JobRow | undefined; }
  jobsOpen() { return this.sql.prepare("SELECT * FROM jobs WHERE state NOT IN ('settled','refunded')").all() as JobRow[]; }
  setState(id: string, state: JobState) { this.sql.prepare("UPDATE jobs SET state=? WHERE id=?").run(state,id); }
  paid(id: string, now: number) { this.sql.prepare("UPDATE jobs SET state='paid', paid_at=? WHERE id=?").run(now,id); }
  createAttempt(jobId: string, subtask: Subtask, worker: string, generation: number, leaseUntil: number) { const id=randomUUID(); this.sql.prepare("INSERT INTO attempts VALUES (?,?,?,?,?,?,?,?,?)").run(id,jobId,subtask,worker,generation,"running","0",0,leaseUntil); return this.attempt(id)!; }
  attempt(id: string) { return this.sql.prepare("SELECT * FROM attempts WHERE attempt_id=?").get(id) as AttemptRow | undefined; }
  attempts(jobId: string, subtask?: Subtask) { return this.sql.prepare(subtask ? "SELECT * FROM attempts WHERE job_id=? AND subtask=? ORDER BY lease_generation" : "SELECT * FROM attempts WHERE job_id=? ORDER BY lease_generation").all(...(subtask?[jobId,subtask]:[jobId])) as AttemptRow[]; }
  touch(id: string, until: number) { this.sql.prepare("UPDATE attempts SET lease_until=? WHERE attempt_id=? AND status='running'").run(until,id); }
  fail(id: string, units: string) { this.sql.prepare("UPDATE attempts SET status='failed',units=? WHERE attempt_id=? AND status='running'").run(units,id); }
  creditOnce(id: string) { return this.sql.prepare("UPDATE attempts SET usage_credited=1 WHERE attempt_id=? AND usage_credited=0").run(id).changes === 1; }
  done(id: string, units: string, text: string) { this.sql.exec("BEGIN IMMEDIATE"); try { this.sql.prepare("UPDATE attempts SET status='done',units=? WHERE attempt_id=?").run(units,id); this.sql.prepare("INSERT OR REPLACE INTO results VALUES (?,?,?)").run(id,text,Date.now()); this.sql.exec("COMMIT"); } catch (e) { this.sql.exec("ROLLBACK"); throw e; } }
  saveTeardown(id: string, copy: string, design: string) { this.sql.prepare("UPDATE jobs SET teardown_copy=?,teardown_design=?,state='complete' WHERE id=?").run(copy,design,id); }
  receipt(id: string, receipt: unknown) { this.sql.prepare("UPDATE jobs SET receipt_json=?,state='settled' WHERE id=?").run(JSON.stringify(receipt),id); }
  close() { this.sql.close(); }
}
