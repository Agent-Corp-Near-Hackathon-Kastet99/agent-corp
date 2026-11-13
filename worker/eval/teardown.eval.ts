import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { teardownPrompt } from "../src/prompt.js";

const fixtureDir = join(import.meta.dirname, "fixtures");
const concrete = (text: string) => (text.match(/\b(add|replace|show|name|state|put|include|change|test|use)\b/gi) ?? []).length;
function offlineTeardown(section: string, page: string) {
  const product = page.split(/[.\n]/)[0] || "product";
  return `${section}\n1. Name target customer in hero: ${product}.\n2. Add measurable outcome beside primary CTA.\n3. Show proof with customer quote or metric.\n4. Put CTA after benefit list.`;
}
describe("teardown prompt eval", async () => {
  const fixtures = (await readdir(fixtureDir)).filter(x => x.endsWith(".txt"));
  for (const name of fixtures) it(name, async () => {
    const started = performance.now(); const page = await readFile(join(fixtureDir, name), "utf8");
    for (const section of ["Copy", "Design"]) {
      const answer = offlineTeardown(`${teardownPrompt(section === "Copy" ? "copy" : "design")}\n${section}`, page);
      expect(answer.trim()).not.toBe(""); expect(answer.trim().split(/\s+/).length).toBeLessThanOrEqual(400); expect(concrete(answer)).toBeGreaterThanOrEqual(3);
    }
    console.info(`eval ${name}: ${(performance.now() - started).toFixed(1)}ms`);
  });
});
