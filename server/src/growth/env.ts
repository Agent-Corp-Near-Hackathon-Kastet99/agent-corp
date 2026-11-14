import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../config.js";

export const ENV_KEYS = [
  "ANTHROPIC_API_KEY", "GROWTH_MODEL", "GROWTH_LLM_IN_PER_MTOK", "GROWTH_LLM_OUT_PER_MTOK",
  "POSTIZ_API_KEY", "POSTIZ_BASE_URL", "POSTIZ_X_INTEGRATION_ID", "POSTIZ_LINKEDIN_INTEGRATION_ID",
  "BLUESKY_HANDLE", "BLUESKY_APP_PASSWORD", "BLUESKY_SERVICE",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "DISCORD_WEBHOOK_URL",
  "FAL_KEY", "GROWTH_FAL_MODEL", "GROWTH_FAL_IMAGE_USD",
  "EXA_API_KEY",
  "POSTHOG_KEY", "POSTHOG_HOST", "POSTHOG_PERSONAL_API_KEY", "POSTHOG_PROJECT_ID",
  "RESEND_API_KEY", "RESEND_FROM",
  "INSTANTLY_API_KEY",
  "GROWTH_EXPENSE_PAYEE", "GROWTH_EXPENSE_USD_PER_NEAR", "GROWTH_EXPENSE_WRITES",
  "GROWTH_DRY_RUN", "GROWTH_BOARD_WRITES", "GROWTH_ADMIN_TOKEN", "GROWTH_CLIP_PATH", "GROWTH_AUTO_HOURS",
] as const;
export type GrowthEnv = Partial<Record<typeof ENV_KEYS[number], string>>;

/** Minimal dotenv parser: KEY=value, optional quotes, # comments. No expansion, no export prefix tricks. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) value = value.slice(1, -1);
    else value = value.startsWith("#") ? "" : value.replace(/\s+#.*$/, "");
    out[m[1]!] = value;
  }
  return out;
}

/**
 * Reads only the known growth keys. The process environment wins over the file.
 * Reads `.env.growth` (growth-only keys); other dotenv files in the repo are never touched.
 */
export function loadGrowthEnv(base: NodeJS.ProcessEnv = process.env, file = join(ROOT, ".env.growth")): GrowthEnv {
  const fromFile = existsSync(file) ? parseDotenv(readFileSync(file, "utf8")) : {};
  const env: GrowthEnv = {};
  for (const key of ENV_KEYS) {
    const v = base[key] ?? fromFile[key];
    if (v !== undefined && v.trim() !== "") env[key] = v.trim();
  }
  return env;
}

/**
 * Dry-run is the default. Live external effects need an explicit GROWTH_DRY_RUN=off, so a missing
 * or mistyped value can never publish anything.
 */
export const isDryRun = (env: GrowthEnv) => (env.GROWTH_DRY_RUN ?? "on").toLowerCase() !== "off";
