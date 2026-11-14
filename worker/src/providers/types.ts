import type { ProviderOffer, TokenUsage } from "@agentcorp/shared";
import type { SandboxGrants } from "../sandbox.js";

/** Same vocabulary as bb's provider health so sign-in guidance reads the same. */
export type HealthStatus = "ready" | "not_installed" | "unauthenticated" | "expired" | "unsupported_version" | "unsupported_install" | "unknown";
export type Health = { status: HealthStatus; version?: string; executable?: string; message?: string };

/** One normalized stream record. Token fields follow shared TokenUsage. */
export type Parsed = {
  /** Additive running estimate; superseded by `step` or `total`. */
  provisional?: TokenUsage;
  /** Additive authoritative usage of one finished model step. */
  step?: TokenUsage;
  /** Authoritative usage of the whole run. */
  total?: TokenUsage;
  /** The provider's own authoritative final cost. Only honoured for costSource "provider-cost". */
  costUsd?: number;
  /** No further usage follows; the run's usage is complete. */
  final?: boolean;
  text?: string;
  /** Appended to the output instead of replacing it (streamed chunks). */
  textDelta?: string;
  error?: string;
  /** Protocol replies to write to the child's stdin, one JSON line each. */
  send?: unknown[];
  /** The exchange is over; close stdin and let the child exit. */
  done?: boolean;
};

export type LaunchContext = { model: string; root: string; home: string; executable: string };
export type Launch = {
  command: string;
  args: string[];
  /** Working directory inside `root`. */
  cwd: string;
  env: Record<string, string>;
  /** Names copied from the worker's own environment (API keys and locale only). */
  passEnv: string[];
  grants: SandboxGrants;
  /** "prompt": write the prompt and close stdin. "argv": prompt is the last argument. "protocol": the parser drives stdin. */
  input: "prompt" | "argv" | "protocol";
  /** Runs after the child exits and before the private root is deleted (credential write-back). */
  settle?: () => Promise<void>;
};
export type Parser = {
  start?(prompt: string): unknown[];
  event(event: Record<string, unknown>): Parsed;
  cancel?(): unknown[];
};

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly costSource: ProviderOffer["costSource"];
  readonly confinement: ProviderOffer["confinement"];
  /** True only after a signed-in, sandboxed run was exercised end to end for this adapter. */
  readonly verified: boolean;
  readonly signInCommand: string;
  readonly installUrl: string;
  health(): Promise<Health>;
  /** Models the CLI can enumerate; undefined when it cannot. */
  models?(): Promise<string[] | undefined>;
  launch(ctx: LaunchContext): Promise<Launch>;
  parser(ctx: { model: string; cwd: string }): Parser;
}
