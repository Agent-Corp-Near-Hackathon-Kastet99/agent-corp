// Adapted from get-bb/bb (MIT, Copyright (c) 2026 Michael Yong):
// plugins/provider-codex/src/ai/codex-auth.ts and src/codex-home.ts
// See worker/THIRD_PARTY_NOTICES.md. Changes: reports sign-in state only; tokens, account ids
// and e-mail addresses are never returned to the caller.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type CodexAuthState =
  | { state: "missing" | "unreadable" | "malformed" | "unusable"; authPath: string }
  | { state: "ok"; authPath: string; type: "chatgpt" | "apiKey"; expired: boolean };

export function resolveCodexHome(home = homedir(), env: Readonly<Record<string, string | undefined>> = process.env): string {
  return resolve(env.CODEX_HOME?.trim() || join(home, ".codex"));
}

type Json = Record<string, unknown>;
const object = (value: unknown): Json | null => value && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;

function tokenExpired(token: string, now: number): boolean {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return false;
  try {
    const exp = object(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")))?.exp;
    return typeof exp === "number" && now >= exp * 1000;
  } catch { return false; }
}

export function classifyCodexAuth(value: unknown, now = Date.now()): { state: "unusable" } | { state: "ok"; type: "chatgpt" | "apiKey"; expired: boolean } {
  const parsed = object(value);
  if (!parsed) return { state: "unusable" };
  const mode = text(parsed.auth_mode), apiKey = text(parsed.OPENAI_API_KEY);
  if (mode === "apikey" || mode === "apiKey" || (mode === null && apiKey !== null)) {
    return apiKey === null ? { state: "unusable" } : { state: "ok", type: "apiKey", expired: false };
  }
  const access = text(object(parsed.tokens)?.access_token);
  if (access === null) return { state: "unusable" };
  return { state: "ok", type: "chatgpt", expired: tokenExpired(access, now) };
}

export async function readCodexAuthState(authPath = join(resolveCodexHome(), "auth.json")): Promise<CodexAuthState> {
  let raw: string;
  try { raw = await readFile(authPath, "utf8"); }
  catch (error) { return { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable", authPath }; }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { state: "malformed", authPath }; }
  return { ...classifyCodexAuth(value), authPath };
}
