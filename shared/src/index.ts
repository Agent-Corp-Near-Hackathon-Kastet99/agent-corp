export type JobId = string;
export type AttemptId = string;
export type Subtask = "copy" | "design";
export type JobState = "created" | "paid" | "running" | "complete" | "settled" | "refundable" | "refunded";
/** Integer micro-USD, encoded as decimal so it remains safe beyond JS numbers. */
export type Units = string;

export const MODEL_PIN = "claude-sonnet-4-5-20250929";
export const LEASE_MS = 45_000;
export const DAILY_CAP_DEFAULT_USD = 2.0;

export const PRICE_TABLE: Record<string, {
  inPerMTok: number;
  outPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}> = {
  // Only prices the project has verified live here. Other providers' prices are owner policy (config.yaml worker_policy).
  // USD / million tokens. Kept here so server display and worker meter agree.
  "claude-sonnet-4-5-20250929": { inPerMTok: 3, outPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  sonnet: { inPerMTok: 3, outPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
};

export type Price = { inPerMTok: number; outPerMTok: number; cacheReadPerMTok: number; cacheWritePerMTok: number };
/** Normalized token usage. `input` excludes cached tokens, `output` includes reasoning tokens. */
export type TokenUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };
/** How reported units were derived.
 * provider-cost: the provider's own authoritative final cost.
 * list-price: authoritative final token counts multiplied by the owner's price table (an inferred cost, never `exact`).
 * estimate: incomplete or provisional usage. */
export type UsageBasis = "provider-cost" | "list-price" | "estimate";
export const USAGE_BASES: readonly UsageBasis[] = ["provider-cost", "list-price", "estimate"];
export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Model ids reach provider argv: no leading dash, no whitespace, no shell metacharacters. */
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99}$/;
/** What a worker says it can run. Untrusted input to the server's own allow-list. */
export type ProviderOffer = {
  id: string;
  version?: string;
  costSource: "provider-cost" | "list-price";
  confinement: "tools-disabled" | "permission-denied" | "read-only-mode";
  /** False until the adapter's signed-in sandboxed run has been exercised end to end. */
  verified: boolean;
  /** Absent when the provider cannot enumerate models; the server's allow-list still applies. */
  models?: string[];
};
export type AcceptedModel = { provider: string; model: string; price: Price };

export function validPrice(value: unknown): value is Price {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  const rate = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100_000;
  return rate(p.inPerMTok) && rate(p.outPerMTok) && rate(p.cacheReadPerMTok) && rate(p.cacheWritePerMTok)
    && (p.inPerMTok as number) > 0 && (p.outPerMTok as number) > 0;
}
export function validTokenUsage(value: unknown): value is TokenUsage {
  if (!value || typeof value !== "object") return false;
  const u = value as Record<string, unknown>;
  return [u.input, u.output, u.cacheRead, u.cacheWrite].every(n => Number.isSafeInteger(n) && (n as number) >= 0);
}
/** List-price micro-USD for normalized usage. Each component rounds up. */
export function priceUnits(price: Price, usage: TokenUsage): Units {
  if (!validPrice(price)) throw new Error("invalid price");
  if (!validTokenUsage(usage)) throw new Error("usage must be non-negative integers");
  return (microUsd(usage.input, price.inPerMTok) + microUsd(usage.output, price.outPerMTok)
    + microUsd(usage.cacheRead, price.cacheReadPerMTok) + microUsd(usage.cacheWrite, price.cacheWritePerMTok)).toString();
}

type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

function microUsd(tokens: number, dollarsPerMTok: number): bigint {
  // $/MTok is also micro-USD/token. Scale decimal prices to avoid float rounding.
  const scaled = BigInt(Math.round(dollarsPerMTok * 1_000_000));
  return (BigInt(tokens) * scaled + 999_999n) / 1_000_000n;
}

export function estimateUnits(model: string, usage: Usage): Units {
  const price = PRICE_TABLE[model];
  if (!price) throw new Error(`unknown model price: ${model}`);
  const n = (value: number | undefined) => {
    if (!Number.isSafeInteger(value ?? 0) || (value ?? 0) < 0) throw new Error("usage must be non-negative integers");
    return value ?? 0;
  };
  return (
    microUsd(n(usage.input_tokens), price.inPerMTok) +
    microUsd(n(usage.output_tokens), price.outPerMTok) +
    microUsd(n(usage.cache_read_input_tokens), price.cacheReadPerMTok) +
    microUsd(n(usage.cache_creation_input_tokens), price.cacheWritePerMTok)
  ).toString();
}

export type ServerToWorker =
  | { t: "challenge"; nonce: string; recipient: "agentcorp" }
  | { t: "welcome"; account: string; session: string; accepted?: AcceptedModel[] }
  | { t: "task"; attemptId: AttemptId; jobId: JobId; subtask: Subtask; leaseGeneration: number; maxUnits: Units; prompt: string; pageText: string; model: string; provider?: string; price?: Price }
  | { t: "cancel"; attemptId: AttemptId };

export type WorkerToServer =
  | { t: "login"; account: string; publicKey: string; signature: string; nonce: string; providers?: ProviderOffer[] }
  | { t: "heartbeat"; attemptId?: AttemptId }
  | { t: "progress"; attemptId: AttemptId; provisionalUnits: Units; elapsedMs: number }
  | { t: "result"; attemptId: AttemptId; leaseGeneration: number; text: string; units: Units; exact: boolean; basis?: UsageBasis; usage?: TokenUsage }
  | { t: "failed"; attemptId: AttemptId; leaseGeneration: number; units: Units; exact: boolean; reason: string; basis?: UsageBasis; usage?: TokenUsage }
  | { t: "refused"; attemptId: AttemptId; reason: "cap" | "busy" | "unsupported" }
  | { t: "usage"; todayUnits: Units; capUnits: Units };

export { ACCOUNT_RE, LOGIN_RECIPIENT, loginPayload } from "./auth.js";

export { fmt, toYocto, YOCTO } from "./money.js";
