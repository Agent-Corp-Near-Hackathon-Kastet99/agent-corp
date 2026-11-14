import { http, type Fetch } from "../http.js";
import type { GrowthEnv } from "../env.js";

export function posthog(env: GrowthEnv, f: Fetch = fetch) {
  const host = (env.POSTHOG_HOST ?? "https://us.i.posthog.com").replace(/\/$/, "");
  return {
    /** Server-side capture with the project (public) key. */
    async capture(event: string, distinctId: string, properties: Record<string, unknown> = {}) {
      if (!env.POSTHOG_KEY) throw new Error("POSTHOG_KEY missing");
      await http(f, `${host}/capture/`, { method: "POST", json: { api_key: env.POSTHOG_KEY, event, distinct_id: distinctId, properties } });
    },
    /** Unique-visitor counts per funnel event over the last N days via HogQL (needs a personal API key). */
    async funnel(steps: string[], days: number): Promise<Record<string, number>> {
      if (!env.POSTHOG_PERSONAL_API_KEY || !env.POSTHOG_PROJECT_ID) throw new Error("POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID missing");
      if (!/^\d+$/.test(env.POSTHOG_PROJECT_ID)) throw new Error("POSTHOG_PROJECT_ID must be numeric");
      if (!steps.every(s => /^[a-z_]+$/.test(s))) throw new Error("funnel step names must be [a-z_]");
      if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("days must be 1-90");
      const list = steps.map(s => `'${s}'`).join(", ");
      const query = `SELECT event, count(DISTINCT person_id) FROM events WHERE timestamp > now() - INTERVAL ${days} DAY AND event IN (${list}) GROUP BY event`;
      const r = await http<{ results?: [string, number][] }>(f, `${host.replace("i.posthog", "posthog")}/api/projects/${env.POSTHOG_PROJECT_ID}/query/`, {
        method: "POST", headers: { authorization: `Bearer ${env.POSTHOG_PERSONAL_API_KEY}` }, json: { query: { kind: "HogQLQuery", query } },
      });
      const out: Record<string, number> = Object.fromEntries(steps.map(s => [s, 0]));
      for (const [event, n] of r.results ?? []) if (event in out) out[event] = Number(n) || 0;
      return out;
    },
  };
}
