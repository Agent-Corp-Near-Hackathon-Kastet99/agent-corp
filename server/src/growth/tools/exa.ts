import { http, type Fetch } from "../http.js";
import type { GrowthEnv } from "../env.js";

export type ExaResult = { title: string; url: string; text?: string; publishedDate?: string };

export function exa(env: GrowthEnv, f: Fetch = fetch) {
  return {
    async search(query: string, n = 8): Promise<ExaResult[]> {
      if (!env.EXA_API_KEY) throw new Error("EXA_API_KEY missing");
      const r = await http<{ results?: { title?: string; url?: string; text?: string; publishedDate?: string }[] }>(f, "https://api.exa.ai/search", {
        method: "POST", headers: { "x-api-key": env.EXA_API_KEY }, json: { query, numResults: Math.min(Math.max(n, 1), 10), contents: { text: { maxCharacters: 600 } } },
      });
      return (r.results ?? []).filter(x => typeof x.url === "string").map(x => ({ title: x.title ?? x.url!, url: x.url!, text: x.text, publishedDate: x.publishedDate }));
    },
  };
}
