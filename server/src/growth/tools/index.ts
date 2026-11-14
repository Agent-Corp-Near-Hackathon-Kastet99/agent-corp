import type { Fetch } from "../http.js";
import type { GrowthEnv } from "../env.js";
import { postiz } from "./postiz.js";
import { bluesky } from "./bluesky.js";
import { telegram, discord } from "./chat.js";
import { fal } from "./fal.js";
import { exa } from "./exa.js";
import { posthog } from "./posthog.js";
import { resend } from "./resend.js";
import { instantly } from "./instantly.js";

export type Tools = {
  postiz?: ReturnType<typeof postiz>;
  bluesky?: ReturnType<typeof bluesky>;
  telegram?: ReturnType<typeof telegram>;
  discord?: ReturnType<typeof discord>;
  fal?: ReturnType<typeof fal>;
  exa?: ReturnType<typeof exa>;
  posthog?: ReturnType<typeof posthog>;
  resend?: ReturnType<typeof resend>;
  instantly?: ReturnType<typeof instantly>;
};

/** A tool exists only when its credentials are present; absent tools make the engine skip or dry-run that step. */
export function makeTools(env: GrowthEnv, f: Fetch = fetch): Tools {
  const t: Tools = {};
  if (env.POSTIZ_API_KEY) t.postiz = postiz(env, f);
  if (env.BLUESKY_HANDLE && env.BLUESKY_APP_PASSWORD) t.bluesky = bluesky(env, f);
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) t.telegram = telegram(env, f);
  if (env.DISCORD_WEBHOOK_URL) t.discord = discord(env, f);
  if (env.FAL_KEY) t.fal = fal(env, f);
  if (env.EXA_API_KEY) t.exa = exa(env, f);
  if (env.POSTHOG_KEY || env.POSTHOG_PERSONAL_API_KEY) t.posthog = posthog(env, f);
  if (env.RESEND_API_KEY && env.RESEND_FROM) t.resend = resend(env, f);
  if (env.INSTANTLY_API_KEY) t.instantly = instantly(env, f);
  return t;
}
