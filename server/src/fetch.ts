import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

const RAW_LIMIT = 2 * 1024 * 1024;
const TEXT_LIMIT = 50 * 1024;
const TIMEOUT = 10_000;

export class UnsafeUrlError extends Error {}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const p = address.split(".").map(Number); const [a, b] = p;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 0 || b === 168)) return false;
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
    if (a === 203 && b === 0) return false;
    return true;
  }
  if (family === 6) {
    const n = address.toLowerCase();
    return !(n === "::" || n === "::1" || n.startsWith("fe8") || n.startsWith("fe9") || n.startsWith("fea") || n.startsWith("feb") || n.startsWith("fc") || n.startsWith("fd") || n.startsWith("ff") || n.startsWith("::ffff:"));
  }
  return false;
}

async function safeLookup(hostname: string) {
  const records = await lookup(hostname, { all: true, verbatim: true });
  if (!records.length || records.some(({ address }) => !isPublicAddress(address))) throw new UnsafeUrlError("URL resolves to unsafe address");
  return records[0]!;
}

function textFromHtml(html: string) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ").trim().slice(0, TEXT_LIMIT);
}

export async function fetchPage(input: string): Promise<{ url: string; text: string }> {
  let url: URL;
  try { url = new URL(input); } catch { throw new UnsafeUrlError("invalid URL"); }
  for (let redirect = 0; redirect <= 3; redirect++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new UnsafeUrlError("only http/https URLs allowed");
    const result = await request(url);
    if (result.redirect) { url = new URL(result.redirect, url); continue; }
    return { url: url.toString(), text: textFromHtml(result.body) };
  }
  throw new UnsafeUrlError("too many redirects");
}

async function request(url: URL): Promise<{ body: string; redirect?: string }> {
  const pinned = await safeLookup(url.hostname);
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.get(url, { timeout: TIMEOUT, lookup: (_host, _opts, callback) => callback(null, pinned.address, pinned.family) }, res => {
      const status = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) { res.resume(); return resolve({ body: "", redirect: res.headers.location }); }
      if (status < 200 || status >= 300) { res.resume(); return reject(new Error(`fetch returned ${status}`)); }
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", (part: Buffer) => { size += part.length; if (size > RAW_LIMIT) req.destroy(new Error("response exceeds 2MB")); else chunks.push(part); });
      res.on("end", () => resolve({ body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("timeout", () => req.destroy(new Error("fetch timeout")));
    req.once("error", reject);
  });
}
