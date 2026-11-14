import { download, http, type Fetch } from "../http.js";
import type { GrowthEnv } from "../env.js";

/** fal.ai synchronous endpoint. Price per image is a configured ESTIMATE (not read from fal's pricing page). */
export function fal(env: GrowthEnv, f: Fetch = fetch) {
  const model = env.GROWTH_FAL_MODEL ?? "fal-ai/flux/schnell";
  const estimate = Number(env.GROWTH_FAL_IMAGE_USD ?? "0.05");
  if (!Number.isFinite(estimate) || estimate < 0) throw new Error("GROWTH_FAL_IMAGE_USD must be a non-negative number");
  return {
    model,
    estimateUsd: estimate,
    async image(prompt: string, size: "landscape_16_9" | "square_hd" | "portrait_16_9" = "landscape_16_9") {
      if (!env.FAL_KEY) throw new Error("FAL_KEY missing");
      const r = await http<{ images?: { url: string; content_type?: string }[]; seed?: number }>(f, `https://fal.run/${model}`, {
        method: "POST", headers: { authorization: `Key ${env.FAL_KEY}` }, json: { prompt, image_size: size, num_images: 1 }, timeoutMs: 120_000,
      });
      const img = r?.images?.[0];
      if (!img?.url) throw new Error("fal: no image returned");
      const file = await download(f, img.url);
      return { ...file, mime: img.content_type ?? file.mime, seed: r.seed, model };
    },
  };
}
