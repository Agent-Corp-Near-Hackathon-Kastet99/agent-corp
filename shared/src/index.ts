export type JobId = string;
export type AttemptId = string;
export type Subtask = "copy" | "design";
export type JobState = "created" | "paid" | "running" | "complete" | "settled" | "refundable" | "refunded";
/** Integer micro-USD, encoded as decimal so it remains safe beyond JS numbers. */
export type Units = string;

export const MODEL_PIN = "sonnet";
export const LEASE_MS = 45_000;
export const DAILY_CAP_DEFAULT_USD = 2.0;

export const PRICE_TABLE: Record<string, {
  inPerMTok: number;
  outPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}> = {
  // USD / million tokens. Kept here so server display and worker meter agree.
  sonnet: { inPerMTok: 3, outPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
};

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
  | { t: "welcome"; account: string; session: string }
  | { t: "task"; attemptId: AttemptId; jobId: JobId; subtask: Subtask; leaseGeneration: number; maxUnits: Units; prompt: string; pageText: string; model: string }
  | { t: "cancel"; attemptId: AttemptId };

export type WorkerToServer =
  | { t: "login"; account: string; publicKey: string; signature: string; nonce: string }
  | { t: "heartbeat"; attemptId?: AttemptId }
  | { t: "progress"; attemptId: AttemptId; provisionalUnits: Units; elapsedMs: number }
  | { t: "result"; attemptId: AttemptId; leaseGeneration: number; text: string; units: Units; exact: boolean }
  | { t: "failed"; attemptId: AttemptId; leaseGeneration: number; units: Units; exact: boolean; reason: string }
  | { t: "refused"; attemptId: AttemptId; reason: "cap" | "busy" }
  | { t: "usage"; todayUnits: Units; capUnits: Units };
