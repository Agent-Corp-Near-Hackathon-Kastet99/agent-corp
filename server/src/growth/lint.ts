import type { GrowthPolicy } from "./policy.js";

/** Per-channel hard character limits. Unknown channels fall back to no length check. */
export const CHANNEL_LIMITS: Record<string, number> = { bluesky: 300, x: 280, telegram: 4096, discord: 2000 };

export type LintInput = { text: string; channel?: string; isReply?: boolean };
export type LintResult = { ok: boolean; violations: string[] };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const URL_RE = /https?:\/\/\S+/i;
const COMMERCE_RE = /\b(pass|tnear|buy|buying|bought|purchase|price|priced|pay|paid)\b/i;

/**
 * Deterministic content rules from policy.yaml. Cannot judge truthfulness (fabricated metrics,
 * testimonials) — an LLM critic handles that in a later phase. Everything outgoing runs through this,
 * including drafts, so a bad draft is blocked before a human is asked to approve it.
 */
export function contentLint(input: LintInput, policy: GrowthPolicy): LintResult {
  const violations: string[] = [];
  const text = input.text ?? "";
  if (!text.trim()) violations.push("empty text");

  for (const term of policy.content_rules.forbid_terms) {
    // Prefix match on a word boundary: "dividend" also catches "dividends"; "earn" does not catch "learn".
    if (new RegExp(`\\b${escape(term)}`, "i").test(text)) violations.push(`forbidden term: "${term}"`);
  }

  const label = policy.content_rules.testnet_label;
  const labelWords = label.split(/[^A-Za-z]+/).filter(Boolean);
  const hasLabel = labelWords.length > 0 && labelWords.every(w => new RegExp(`\\b${escape(w)}\\b`, "i").test(text));
  if (COMMERCE_RE.test(text) && !hasLabel) violations.push(`mentions buying/price without the "${label}" label`);

  const limit = input.channel ? CHANNEL_LIMITS[input.channel] : undefined;
  if (limit !== undefined && [...text].length > limit) violations.push(`over ${input.channel} limit of ${limit} characters`);

  if (input.channel === "x" && policy.content_rules.x_links === "reply_only" && !input.isReply && URL_RE.test(text)) {
    violations.push("link in a top-level X post (policy: links go in a reply)");
  }

  return { ok: violations.length === 0, violations };
}
