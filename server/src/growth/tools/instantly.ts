import { http, type Fetch } from "../http.js";
import type { GrowthEnv } from "../env.js";

export type Sequence = { subject: string; body: string; delayDays: number }[];

/**
 * Instantly API v2: creates a campaign and NEVER activates it. There is deliberately no launch method:
 * launching cold email is an L2 human decision outside this harness (warm-up, compliance).
 * The request schema below follows Instantly's v2 campaign model from memory/community servers and was
 * NOT verified against official docs this session; test in a sandbox account before relying on it.
 */
export function instantly(env: GrowthEnv, f: Fetch = fetch) {
  return {
    async createCampaignPaused(name: string, sequence: Sequence): Promise<{ id: string }> {
      if (!env.INSTANTLY_API_KEY) throw new Error("INSTANTLY_API_KEY missing");
      if (sequence.length === 0) throw new Error("instantly: empty sequence");
      const days = { "1": true, "2": true, "3": true, "4": true, "5": true };
      const r = await http<{ id?: string }>(f, "https://api.instantly.ai/api/v2/campaigns", {
        method: "POST", headers: { authorization: `Bearer ${env.INSTANTLY_API_KEY}` },
        json: {
          name,
          campaign_schedule: { schedules: [{ name: "Weekdays", timing: { from: "09:00", to: "17:00" }, days, timezone: "America/Chicago" }] },
          sequences: [{ steps: sequence.map(s => ({ type: "email", delay: s.delayDays, variants: [{ subject: s.subject, body: s.body }] })) }],
        },
      });
      if (!r?.id) throw new Error("instantly: unexpected response");
      return { id: r.id };
    },
  };
}
