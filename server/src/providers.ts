import { MODEL_ID_RE, MODEL_PIN, PRICE_TABLE, PROVIDER_ID_RE, priceUnits, validPrice, validTokenUsage, type AcceptedModel, type Price, type ProviderOffer, type TokenUsage, type UsageBasis } from "@agentcorp/shared";

/** Owner policy for contributed inference: which provider models may be assigned, at what list
 * price, and which kinds of usage report may become on-chain contribution units. */
export type WorkerPolicy = { models: AcceptedModel[]; creditBases: ReadonlySet<UsageBasis>; allowUnverified: boolean };

/** Providers whose own final cost figure is trusted as exact. Every other provider reports tokens. */
export const PROVIDER_COST_PROVIDERS: ReadonlySet<string> = new Set(["claude"]);

export const DEFAULT_WORKER_POLICY: WorkerPolicy = {
  models: [{ provider: "claude", model: MODEL_PIN, price: PRICE_TABLE[MODEL_PIN]! }],
  creditBases: new Set<UsageBasis>(["provider-cost"]),
  allowUnverified: false,
};

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Validates config.yaml `worker_policy`. Absent means Claude only, exact costs only. */
export function workerPolicy(raw: unknown): WorkerPolicy {
  if (raw === undefined || raw === null) return DEFAULT_WORKER_POLICY;
  const fail = (why: string): never => { throw new Error(`config.yaml: worker_policy ${why}`); };
  if (!object(raw)) return fail("must be a mapping");
  const bases = raw.credit_bases ?? ["provider-cost"];
  if (!Array.isArray(bases) || !bases.every(basis => basis === "provider-cost" || basis === "list-price")) return fail("credit_bases may contain provider-cost and list-price only");
  if (raw.allow_unverified !== undefined && typeof raw.allow_unverified !== "boolean") return fail("allow_unverified must be true or false");
  if (!Array.isArray(raw.models) || !raw.models.length || raw.models.length > 100) return fail("models must list 1-100 provider models");
  const seen = new Set<string>();
  const models = raw.models.map((entry: unknown, index: number): AcceptedModel => {
    if (!object(entry) || typeof entry.provider !== "string" || !PROVIDER_ID_RE.test(entry.provider) || typeof entry.model !== "string" || !MODEL_ID_RE.test(entry.model)) return fail(`models[${index}] needs a valid provider and model`);
    const key = `${entry.provider}\n${entry.model}`;
    if (seen.has(key)) return fail(`models[${index}] is listed twice`);
    seen.add(key);
    const rates = entry.usd_per_mtok;
    const price: Price | undefined = rates === undefined ? PRICE_TABLE[entry.model]
      : object(rates) ? { inPerMTok: rates.input as number, outPerMTok: rates.output as number, cacheReadPerMTok: rates.cache_read as number, cacheWritePerMTok: rates.cache_write as number } : undefined;
    if (!validPrice(price)) return fail(`models[${index}] needs usd_per_mtok with input, output, cache_read and cache_write (no built-in price for ${entry.model})`);
    return { provider: entry.provider, model: entry.model, price };
  });
  return { models, creditBases: new Set(bases as UsageBasis[]), allowUnverified: raw.allow_unverified === true };
}

/** A worker that predates the handshake runs Claude only. */
const LEGACY_OFFER: ProviderOffer = { id: "claude", costSource: "provider-cost", confinement: "tools-disabled", verified: true };

function validOffers(raw: unknown): ProviderOffer[] {
  if (raw === undefined) return [LEGACY_OFFER];
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 20).filter((offer): offer is ProviderOffer => object(offer) && typeof offer.id === "string" && PROVIDER_ID_RE.test(offer.id)
    && (offer.costSource === "provider-cost" || offer.costSource === "list-price") && typeof offer.verified === "boolean"
    && ["tools-disabled", "permission-denied", "read-only-mode"].includes(String(offer.confinement))
    && (offer.models === undefined || Array.isArray(offer.models) && offer.models.length <= 200 && offer.models.every(model => typeof model === "string" && MODEL_ID_RE.test(model))));
}

/** Capability and model handshake: policy models, in owner order, that this worker can run.
 * An offer claiming its own cost figure is only believed for providers known to report one. */
export function acceptOffers(policy: WorkerPolicy, raw: unknown): AcceptedModel[] {
  const offers = new Map(validOffers(raw)
    .filter(offer => (offer.verified || policy.allowUnverified) && (offer.costSource === "provider-cost") === PROVIDER_COST_PROVIDERS.has(offer.id))
    .map(offer => [offer.id, offer] as const));
  return policy.models.filter(({ provider, model }) => { const offer = offers.get(provider); return !!offer && (!offer.models || offer.models.includes(model)); });
}

export type Settlement = { units: string; exact: boolean; basis: UsageBasis; creditable: boolean; usage?: TokenUsage };
const MAX_REPORT_UNITS = 5_000_000n;

/** Turns a worker report into what the ledger may record. Returns undefined for a report that
 * contradicts itself. Token counts are never accepted as a cost: list-price units are recomputed
 * here from the owner's price, and an exact cost is only accepted from a cost-reporting provider. */
export function settleReport(policy: WorkerPolicy, target: AcceptedModel, report: { units: unknown; exact: unknown; basis?: unknown; usage?: unknown }): Settlement | undefined {
  if (typeof report.units !== "string" || !/^\d+$/.test(report.units) || BigInt(report.units) > MAX_REPORT_UNITS || typeof report.exact !== "boolean") return undefined;
  const basis = report.basis ?? (report.exact ? "provider-cost" : "estimate");
  if (basis !== "provider-cost" && basis !== "list-price" && basis !== "estimate") return undefined;
  if (report.usage !== undefined && !validTokenUsage(report.usage)) return undefined;
  const usage = report.usage as TokenUsage | undefined;
  if (report.exact !== (basis === "provider-cost")) return undefined;
  if (basis === "provider-cost") {
    if (!PROVIDER_COST_PROVIDERS.has(target.provider)) return undefined;
    return { units: report.units, exact: true, basis, creditable: policy.creditBases.has(basis), ...(usage ? { usage } : {}) };
  }
  if (basis === "list-price") {
    if (!usage || PROVIDER_COST_PROVIDERS.has(target.provider)) return undefined;
    const units = priceUnits(target.price, usage);
    if (BigInt(units) > MAX_REPORT_UNITS) return undefined;
    return { units, exact: false, basis, creditable: policy.creditBases.has(basis), usage };
  }
  return { units: report.units, exact: false, basis, creditable: false, ...(usage ? { usage } : {}) };
}
