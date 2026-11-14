import { ACCOUNT_RE } from "@agentcorp/shared";
import { toYocto } from "../../shared/src/money.js";
export { ACCOUNT_RE } from "@agentcorp/shared";
export { toYocto, fmt, YOCTO } from "../../shared/src/money.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { workerPolicy } from "./providers.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type OwnerConfig = {
  network: "testnet";
  kill_switch: boolean;
  pass_price_near: string;
  expense_reserve_pct: number;
  period_days: number;
  max_expense_per_period_near: string;
  vendors: { category: string; amount_near: string; payee: string; reference: string }[];
  /** Off-chain policy for contributed inference; see providers.ts. Absent means Claude only. */
  worker_policy?: unknown;
};

export const EXPENSE_CATEGORIES = ["hosting", "domain", "api", "payment_fee", "contractor", "other"] as const;

export function validateConfig(value: unknown): OwnerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("config.yaml: expected mapping");
  const c = value as OwnerConfig;
  if (c.network !== "testnet") throw new Error("config.yaml: only network: testnet is supported");
  if (typeof c.kill_switch !== "boolean") throw new Error("config.yaml: kill_switch must be true or false");
  if (!Number.isFinite(c.expense_reserve_pct) || c.expense_reserve_pct < 0 || c.expense_reserve_pct > 100
      || !/^\d+(?:\.\d{1,2})?$/.test(String(c.expense_reserve_pct))) throw new Error("config.yaml: expense_reserve_pct must be 0-100 with at most two decimal places");
  const secs = c.period_days * 86400;
  if (!Number.isSafeInteger(secs) || secs <= 0 || secs > 31_536_000) throw new Error("config.yaml: period_days must yield 1 second to 1 year");
  if (typeof c.pass_price_near !== "string" || toYocto(c.pass_price_near) <= 0n) throw new Error("config.yaml: positive pass_price_near string required");
  if (typeof c.max_expense_per_period_near !== "string") throw new Error("config.yaml: max_expense_per_period_near string required");
  toYocto(c.max_expense_per_period_near);
  const vendors = c.vendors ?? [];
  if (!Array.isArray(vendors)) throw new Error("config.yaml: vendors must be an array");
  const identities = new Set<string>();
  for (const v of vendors) {
    if (!v || !EXPENSE_CATEGORIES.includes(v.category as typeof EXPENSE_CATEGORIES[number])
        || typeof v.amount_near !== "string" || toYocto(v.amount_near) <= 0n
        || typeof v.payee !== "string" || !(v.payee === "vendor" || ACCOUNT_RE.test(v.payee))
        || typeof v.reference !== "string" || !v.reference.trim() || Buffer.byteLength(v.reference) > 200) {
      throw new Error("config.yaml: invalid vendor category, amount, payee or reference");
    }
    const key = JSON.stringify([v.category, v.payee, v.reference]);
    if (identities.has(key)) throw new Error("config.yaml: duplicate standing expense");
    identities.add(key);
  }
  workerPolicy(c.worker_policy);
  return structuredClone({ ...c, vendors });
}

export function loadConfig(): OwnerConfig {
  return validateConfig(parse(readFileSync(join(ROOT, "config.yaml"), "utf8")));
}

/** On-chain constraints derived from config.yaml. */
export function constraintsFromConfig(c: OwnerConfig) {
  return {
    pass_price: toYocto(c.pass_price_near).toString(),
    expense_reserve_bps: Math.round(c.expense_reserve_pct * 100),
    period_secs: String(Math.round(c.period_days * 24 * 3600)),
    max_expense_per_period: toYocto(c.max_expense_per_period_near).toString(),
  };
}
