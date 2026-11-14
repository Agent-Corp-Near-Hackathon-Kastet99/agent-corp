import { http, type Fetch } from "./http.js";
import type { GrowthEnv } from "./env.js";

export type JsonRequest<T> = {
  label: string;
  system: string;
  prompt: string;
  validate: (v: unknown) => T;
  /** Deterministic stand-in for dry-run. Returns the RAW JSON shape a model would reply with; it goes through `validate` exactly like real output. */
  dry: () => unknown;
  images?: { mime: string; base64: string }[];
  maxTokens?: number;
};
export type JsonResult<T> = { value: T; costUsd: number };
export interface Llm {
  readonly live: boolean;
  readonly model: string;
  json<T>(req: JsonRequest<T>): Promise<JsonResult<T>>;
}

export class DryLlm implements Llm {
  readonly live = false;
  readonly model = "dry-run";
  async json<T>(req: JsonRequest<T>): Promise<JsonResult<T>> {
    return { value: req.validate(req.dry()), costUsd: 0 };
  }
}

/** Pull the first JSON object out of a model reply (tolerates prose or ``` fences around it). */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in model reply");
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * Anthropic Messages API. Token prices are CONFIGURED ESTIMATES (GROWTH_LLM_*_PER_MTOK, defaults 3/15 USD):
 * they feed the budget gate, they are not read from Anthropic billing.
 */
export class AnthropicLlm implements Llm {
  readonly live = true;
  readonly model: string;
  private readonly inPerMtok: number;
  private readonly outPerMtok: number;
  constructor(private readonly env: GrowthEnv, private readonly f: Fetch = fetch) {
    if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY missing");
    this.model = env.GROWTH_MODEL ?? "claude-sonnet-5-5";
    this.inPerMtok = Number(env.GROWTH_LLM_IN_PER_MTOK ?? "3");
    this.outPerMtok = Number(env.GROWTH_LLM_OUT_PER_MTOK ?? "15");
    if (!Number.isFinite(this.inPerMtok) || !Number.isFinite(this.outPerMtok) || this.inPerMtok < 0 || this.outPerMtok < 0) throw new Error("invalid GROWTH_LLM_*_PER_MTOK");
  }

  private async call(system: string, content: unknown[], maxTokens: number) {
    const r = await http<{ content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } }>(this.f, "https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": this.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" },
      json: { model: this.model, max_tokens: maxTokens, system, messages: [{ role: "user", content }] },
      timeoutMs: 120_000,
    });
    const text = (r.content ?? []).filter(b => b.type === "text").map(b => b.text ?? "").join("");
    const cost = ((r.usage?.input_tokens ?? 0) * this.inPerMtok + (r.usage?.output_tokens ?? 0) * this.outPerMtok) / 1_000_000;
    return { text, cost };
  }

  async json<T>(req: JsonRequest<T>): Promise<JsonResult<T>> {
    const system = `${req.system}\n\nReply with ONE JSON object and nothing else. No markdown fences, no commentary.`;
    const content: unknown[] = [
      ...(req.images ?? []).map(i => ({ type: "image", source: { type: "base64", media_type: i.mime, data: i.base64 } })),
      { type: "text", text: req.prompt },
    ];
    let cost = 0;
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const turn = attempt === 0 ? content : [...content, { type: "text", text: `Your previous reply was invalid (${lastError}). Reply again with only the corrected JSON object.` }];
      const { text, cost: c } = await this.call(system, turn, req.maxTokens ?? 2000);
      cost += c;
      try { return { value: req.validate(extractJson(text)), costUsd: cost }; }
      catch (e) { lastError = e instanceof Error ? e.message.slice(0, 200) : "invalid"; }
    }
    throw new Error(`${req.label}: model did not return valid JSON (${lastError})`);
  }
}
