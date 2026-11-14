import { http, type Fetch } from "../http.js";
import type { GrowthEnv } from "../env.js";

/** Telegram Bot API: post into OUR channel/chat only (chat id comes from env, never from the model). */
export function telegram(env: GrowthEnv, f: Fetch = fetch) {
  return {
    async post(text: string): Promise<{ messageId: string; url?: string }> {
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing");
      const r = await http<{ ok: boolean; result?: { message_id: number; chat?: { username?: string } } }>(
        f, `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        { method: "POST", json: { chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: false } });
      if (!r.ok || !r.result) throw new Error("telegram: send failed");
      const user = r.result.chat?.username;
      return { messageId: String(r.result.message_id), url: user ? `https://t.me/${user}/${r.result.message_id}` : undefined };
    },
  };
}

/** Discord webhook into OUR server. `?wait=true` returns the created message so we can record a real id. */
export function discord(env: GrowthEnv, f: Fetch = fetch) {
  return {
    async post(text: string): Promise<{ messageId: string }> {
      const hook = env.DISCORD_WEBHOOK_URL;
      if (!hook) throw new Error("DISCORD_WEBHOOK_URL missing");
      if (!/^https:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/webhooks\//i.test(hook)) throw new Error("DISCORD_WEBHOOK_URL is not a Discord webhook");
      const r = await http<{ id?: string }>(f, `${hook}${hook.includes("?") ? "&" : "?"}wait=true`, { method: "POST", json: { content: text, allowed_mentions: { parse: [] } } });
      if (!r?.id) throw new Error("discord: unexpected response");
      return { messageId: r.id };
    },
  };
}
