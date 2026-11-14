import { http, type Fetch } from "../http.js";
import type { GrowthEnv } from "../env.js";

/** Resend: transactional/opt-in only. Its AUP forbids cold email; recipients are checked by the caller against the opt-in list. */
export function resend(env: GrowthEnv, f: Fetch = fetch) {
  return {
    async send(to: string, subject: string, text: string): Promise<{ id: string }> {
      if (!env.RESEND_API_KEY || !env.RESEND_FROM) throw new Error("RESEND_API_KEY / RESEND_FROM missing");
      const r = await http<{ id?: string }>(f, "https://api.resend.com/emails", {
        method: "POST", headers: { authorization: `Bearer ${env.RESEND_API_KEY}` }, json: { from: env.RESEND_FROM, to: [to], subject, text },
      });
      if (!r?.id) throw new Error("resend: unexpected response");
      return { id: r.id };
    },
  };
}
