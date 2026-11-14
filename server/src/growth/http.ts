export type Fetch = typeof fetch;

export class HttpError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) { super(message); }
}

/** Origin only: URLs often carry secrets in the path (Telegram bot token, Discord webhook token). */
export const safeOrigin = (url: string) => { try { return new URL(url).origin; } catch { return "invalid-url"; } };

export type HttpInit = Omit<RequestInit, "body"> & { json?: unknown; body?: BodyInit; timeoutMs?: number };

/** fetch + timeout + JSON parsing. Errors never contain request headers or full URLs. */
export async function http<T = unknown>(f: Fetch, url: string, init: HttpInit = {}): Promise<T> {
  const { json, timeoutMs = 30_000, headers, ...rest } = init;
  const h = new Headers(headers);
  let body = init.body;
  if (json !== undefined) { body = JSON.stringify(json); if (!h.has("content-type")) h.set("content-type", "application/json"); }
  let res: Response;
  try {
    res = await f(url, { ...rest, headers: h, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new Error(`${init.method ?? "GET"} ${safeOrigin(url)} failed: ${e instanceof Error ? e.name : "error"}`);
  }
  const text = await res.text();
  if (!res.ok) throw new HttpError(`${init.method ?? "GET"} ${safeOrigin(url)} → ${res.status}: ${text.slice(0, 300)}`, res.status, text.slice(0, 2000));
  if (!text) return undefined as T;
  try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
}

export async function download(f: Fetch, url: string, maxBytes = 25_000_000): Promise<{ bytes: Uint8Array; mime: string }> {
  if (!/^https:\/\//i.test(url)) throw new Error("download: https URL required");
  const res = await f(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`download ${safeOrigin(url)} → ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) throw new Error("download too large");
  return { bytes: buf, mime: res.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream" };
}
