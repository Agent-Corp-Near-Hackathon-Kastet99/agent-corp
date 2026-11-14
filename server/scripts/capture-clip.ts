/**
 * Record a gameplay clip with Playwright, for the designer role (GROWTH_CLIP_PATH=<out>).
 *   pnpm --filter @agentcorp/server exec tsx scripts/capture-clip.ts --url https://game.example/house-01 \
 *     --out ../.data/growth/house01.webm --seconds 25 --keys "ArrowRight:600,ArrowUp:400,Space:100"
 * Keys are "Key:holdMs" steps replayed in a loop. UNTESTED against the real game (Playwright is not a
 * dependency; install it separately: npm i -D playwright && npx playwright install chromium).
 */
import { mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";

const arg = (name: string, d?: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const url = arg("url");
const out = resolve(arg("out", ".data/growth/clip.webm")!);
const seconds = Math.min(Math.max(Number(arg("seconds", "25")), 3), 60);
const steps = (arg("keys", "") ?? "").split(",").filter(Boolean).map(s => { const [key, ms] = s.split(":"); return { key: key!, ms: Math.min(Number(ms) || 200, 5000) }; });
if (!url || !/^https?:\/\//.test(url)) { console.error("--url (http/https) required"); process.exit(2); }

const moduleName = "playwright";
let pw: { chromium: { launch(o: object): Promise<{ newContext(o: object): Promise<{ newPage(): Promise<{ goto(u: string): Promise<unknown>; keyboard: { down(k: string): Promise<void>; up(k: string): Promise<void> }; video(): { path(): Promise<string> } | null; waitForTimeout(ms: number): Promise<void> }>; close(): Promise<void> }>; close(): Promise<void> }> } };
try { pw = await import(moduleName); } catch { console.error("playwright is not installed. Run: npm i -D playwright && npx playwright install chromium"); process.exit(3); }

const dir = dirname(out); mkdirSync(dir, { recursive: true });
const browser = await pw.chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir, size: { width: 1280, height: 720 } } });
const page = await ctx.newPage();
await page.goto(url);
const end = Date.now() + seconds * 1000;
await page.waitForTimeout(800);
while (Date.now() < end) {
  if (steps.length === 0) { await page.waitForTimeout(500); continue; }
  for (const s of steps) { if (Date.now() >= end) break; await page.keyboard.down(s.key); await page.waitForTimeout(s.ms); await page.keyboard.up(s.key); await page.waitForTimeout(120); }
}
const video = page.video();
await ctx.close();                       // Playwright finalizes the file when the context closes
const tmp = video ? await video.path() : undefined;
await browser.close();
if (!tmp) { console.error("no video produced"); process.exit(4); }
renameSync(tmp, out);
console.log(`clip written: ${out}`);
