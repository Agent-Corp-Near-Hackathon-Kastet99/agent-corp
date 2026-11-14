export const STAGES = ["awareness", "traffic", "conversion", "retention"] as const;
export type Stage = typeof STAGES[number];
export const ASSET_KINDS = ["key_art", "social_card", "gameplay_clip", "thread", "reddit_post", "email"] as const;
export type AssetKind = typeof ASSET_KINDS[number];
export const METRICS = ["impression", "click", "game_page_view", "wallet_connect", "pass_click", "pass_bought"] as const;

export type Directive = {
  cycle: number;
  diagnosis: string;
  stage: Stage;
  bet: { hypothesis: string; channel: string; audience: string; metric: string; target: number; hours: number };
  assets: AssetKind[];
  budget_usd: number;
};

const fail = (m: string): never => { throw new Error(`directive: ${m}`); };
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, n: string, max = 800) => {
  if (typeof v !== "string" || !v.trim()) fail(`${n} must be a non-empty string`);
  if ((v as string).length > max) fail(`${n} too long`);
  return (v as string).trim();
};

/** Validates model output against the brief; the model cannot invent channels or metrics. */
export function validateDirective(value: unknown, ctx: { cycle: number; channels: string[]; funnel: string[] }): Directive {
  if (!isObject(value)) return fail("expected object");
  if (!STAGES.includes(value.stage as Stage)) fail("stage invalid");
  const bet = value.bet;
  if (!isObject(bet)) return fail("bet missing");
  const channel = str(bet.channel, "bet.channel", 40);
  if (!ctx.channels.includes(channel)) fail(`bet.channel "${channel}" not in brief.channels`);
  const metric = str(bet.metric, "bet.metric", 40);
  if (!ctx.funnel.includes(metric)) fail(`bet.metric "${metric}" not in brief.funnel`);
  const target = Number(bet.target), hours = Number(bet.hours);
  if (!Number.isFinite(target) || target <= 0) fail("bet.target must be positive");
  if (!Number.isFinite(hours) || hours < 1 || hours > 168) fail("bet.hours must be 1-168");
  const budget = Number(value.budget_usd);
  if (!Number.isFinite(budget) || budget < 0) fail("budget_usd invalid");
  const assets = value.assets;
  if (!Array.isArray(assets) || assets.length === 0 || !assets.every(a => ASSET_KINDS.includes(a as never))) fail("assets invalid");
  return {
    cycle: ctx.cycle,
    diagnosis: str(value.diagnosis, "diagnosis", 1200),
    stage: value.stage as Stage,
    bet: { hypothesis: str(bet.hypothesis, "bet.hypothesis"), channel, audience: str(bet.audience, "bet.audience"), metric, target, hours },
    assets: assets as AssetKind[],
    budget_usd: budget,
  };
}
