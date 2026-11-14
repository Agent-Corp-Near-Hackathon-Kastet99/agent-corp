import { http, type Fetch } from "../http.js";
import type { GrowthEnv } from "../env.js";

export type Integration = { id: string; name?: string; identifier: string; disabled?: boolean };
export type PostizMedia = { id: string; path: string };
export type PostizType = "draft" | "schedule" | "now";

/**
 * Postiz public API (verified against docs.postiz.com: base URL, raw `Authorization` key, /posts,
 * /upload, /integrations, /analytics). The create-post RESPONSE shape is not documented in the pages
 * read, so parsing is defensive. Channel-specific `settings` (e.g. X reply controls) are passed through
 * untouched; check `integrationSchema` in the Postiz MCP if a platform rejects a post.
 */
export function postiz(env: GrowthEnv, f: Fetch = fetch) {
  const key = env.POSTIZ_API_KEY;
  const base = (env.POSTIZ_BASE_URL ?? "https://api.postiz.com/public/v1").replace(/\/$/, "");
  const need = () => { if (!key) throw new Error("POSTIZ_API_KEY missing"); return { authorization: key }; };
  return {
    async listIntegrations(): Promise<Integration[]> {
      const r = await http<unknown>(f, `${base}/integrations`, { headers: need() });
      return Array.isArray(r) ? r.filter((x): x is Integration => !!x && typeof (x as Integration).id === "string" && typeof (x as Integration).identifier === "string") : [];
    },
    async upload(bytes: Uint8Array, filename: string, mime: string): Promise<PostizMedia> {
      const form = new FormData();
      form.append("file", new Blob([bytes as BlobPart], { type: mime }), filename);
      const r = await http<{ id?: string; path?: string }>(f, `${base}/upload`, { method: "POST", headers: need(), body: form, timeoutMs: 120_000 });
      if (!r?.id || !r.path) throw new Error("postiz upload: unexpected response");
      return { id: r.id, path: r.path };
    },
    async createPost(a: { type: PostizType; date?: string; integrationId: string; provider: string; parts: string[]; media?: PostizMedia[]; settings?: Record<string, unknown> }) {
      if (a.parts.length === 0) throw new Error("postiz: at least one post part required");
      const value = a.parts.map((content, i) => ({ content, image: i === 0 ? (a.media ?? []).map(m => ({ id: m.id, path: m.path })) : [] }));
      const body = {
        type: a.type,
        date: a.date ?? new Date().toISOString(),
        shortLink: false,
        tags: [],
        posts: [{ integration: { id: a.integrationId }, value, settings: { __type: a.provider, ...(a.provider === "x" ? { who_can_reply_post: "everyone" } : {}), ...(a.settings ?? {}) } }],
      };
      const r = await http<unknown>(f, `${base}/posts`, { method: "POST", headers: need(), json: body });
      const first = Array.isArray(r) ? r[0] : r;
      const id = (first as { postId?: unknown; id?: unknown } | undefined)?.postId ?? (first as { id?: unknown } | undefined)?.id;
      return { postId: typeof id === "string" ? id : undefined, raw: r };
    },
    async postAnalytics(postId: string, days = 7): Promise<{ label: string; total: number }[]> {
      const r = await http<unknown>(f, `${base}/analytics/post/${encodeURIComponent(postId)}?date=${days}`, { headers: need() });
      return summarize(r);
    },
    async integrationAnalytics(integrationId: string, days = 7): Promise<{ label: string; total: number }[]> {
      const r = await http<unknown>(f, `${base}/analytics/${encodeURIComponent(integrationId)}?date=${days}`, { headers: need() });
      return summarize(r);
    },
  };
}

/** Docs: array of { label, data: [{ total: string, date }], percentageChange }. Sum totals per label. */
function summarize(r: unknown): { label: string; total: number }[] {
  if (!Array.isArray(r)) return [];
  return r.flatMap(m => {
    const label = (m as { label?: unknown }).label;
    const data = (m as { data?: unknown }).data;
    if (typeof label !== "string" || !Array.isArray(data)) return [];
    const total = data.reduce((s, d) => s + (Number((d as { total?: unknown }).total) || 0), 0);
    return [{ label, total }];
  });
}
