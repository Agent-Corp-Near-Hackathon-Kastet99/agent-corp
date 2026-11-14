import { http, type Fetch } from "../http.js";
import type { GrowthEnv } from "../env.js";

type Session = { accessJwt: string; did: string; at: number };

/** Byte-offset link facets so URLs are clickable (AT Protocol facets use UTF-8 byte indexes). */
export function linkFacets(text: string) {
  const enc = new TextEncoder();
  const out: { index: { byteStart: number; byteEnd: number }; features: { $type: string; uri: string }[] }[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s)]+/gi)) {
    const start = enc.encode(text.slice(0, m.index)).length;
    out.push({ index: { byteStart: start, byteEnd: start + enc.encode(m[0]).length }, features: [{ $type: "app.bsky.richtext.facet#link", uri: m[0] }] });
  }
  return out;
}

/** Bluesky AT Protocol over plain XRPC (no SDK dependency). App password only, never the account password. */
export function bluesky(env: GrowthEnv, f: Fetch = fetch, now: () => number = Date.now) {
  const service = (env.BLUESKY_SERVICE ?? "https://bsky.social").replace(/\/$/, "");
  let session: Session | undefined;
  async function login(): Promise<Session> {
    if (!env.BLUESKY_HANDLE || !env.BLUESKY_APP_PASSWORD) throw new Error("BLUESKY_HANDLE / BLUESKY_APP_PASSWORD missing");
    if (session && now() - session.at < 4 * 60_000) return session;
    const r = await http<{ accessJwt: string; did: string }>(f, `${service}/xrpc/com.atproto.server.createSession`, {
      method: "POST", json: { identifier: env.BLUESKY_HANDLE, password: env.BLUESKY_APP_PASSWORD },
    });
    session = { accessJwt: r.accessJwt, did: r.did, at: now() };
    return session;
  }
  return {
    async post(text: string, images: { bytes: Uint8Array; mime: string; alt?: string }[] = []): Promise<{ uri: string; url: string }> {
      if ([...text].length > 300) throw new Error("bluesky: over 300 characters");
      const s = await login();
      const auth = { authorization: `Bearer ${s.accessJwt}` };
      const blobs: { alt: string; image: unknown }[] = [];
      for (const img of images.slice(0, 4)) {
        const up = await http<{ blob: unknown }>(f, `${service}/xrpc/com.atproto.repo.uploadBlob`, {
          method: "POST", headers: { ...auth, "content-type": img.mime }, body: img.bytes as BodyInit, timeoutMs: 60_000,
        });
        blobs.push({ alt: img.alt ?? "", image: up.blob });
      }
      const record: Record<string, unknown> = { $type: "app.bsky.feed.post", text, createdAt: new Date(now()).toISOString(), langs: ["en"] };
      const facets = linkFacets(text);
      if (facets.length) record.facets = facets;
      if (blobs.length) record.embed = { $type: "app.bsky.embed.images", images: blobs };
      const r = await http<{ uri: string }>(f, `${service}/xrpc/com.atproto.repo.createRecord`, {
        method: "POST", headers: auth, json: { repo: s.did, collection: "app.bsky.feed.post", record },
      });
      const rkey = r.uri.split("/").pop();
      return { uri: r.uri, url: `https://bsky.app/profile/${env.BLUESKY_HANDLE}/post/${rkey}` };
    },
  };
}
