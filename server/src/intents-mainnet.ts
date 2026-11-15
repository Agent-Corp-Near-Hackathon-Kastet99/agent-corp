/** Disconnected 1Click mainnet adapter. It never signs or sends deposits. */
const BASE = "https://1click.chaindefuser.com";

type SwapType = "EXACT_INPUT" | "EXACT_OUTPUT";
export type QuoteRequest = {
  dry: boolean; swapType: SwapType; slippageTolerance: number;
  originAsset: string; destinationAsset: string; amount: string;
  recipient: string; refundTo: string; deadline: string;
};
export type Quote = {
  amountIn: string; amountOut: string; depositAddress?: string | null;
  depositMemo?: string | null; timeEstimate?: number;
  [key: string]: unknown;
};
export type QuoteResponse = { quote: Quote; [key: string]: unknown };
export type SwapStatus = { status: string; [key: string]: unknown };
export type Token = { assetId: string; symbol: string; decimals: number; blockchain: string; [key: string]: unknown };

export class IntentsApiError extends Error {
  constructor(public readonly status: number) { super(`NEAR Intents API returned HTTP ${status}`); }
}

function nonempty(value: string, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Explicit opt-in required; no environment variable or HTTP route enables this client. */
export function createMainnetIntentsClient(options: { enabled: boolean; jwt?: string; fetcher?: typeof fetch }) {
  if (options.enabled !== true) throw new Error("NEAR Intents mainnet is disabled");
  const fetcher = options.fetcher ?? fetch;
  async function request(path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (options.jwt) headers.authorization = `Bearer ${options.jwt}`;
    const response = await fetcher(`${BASE}${path}`, {
      method: body === undefined ? "GET" : "POST", headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new IntentsApiError(response.status);
    return response.json();
  }
  return {
    async tokens(): Promise<Token[]> {
      const data = await request("/v0/tokens");
      if (!Array.isArray(data) || !data.every(t => object(t) && typeof t.assetId === "string" && typeof t.symbol === "string" && Number.isInteger(t.decimals) && typeof t.blockchain === "string")) throw new Error("Invalid Intents tokens response");
      return data as Token[];
    },
    async quote(input: QuoteRequest): Promise<QuoteResponse> {
      for (const key of ["originAsset", "destinationAsset", "recipient", "refundTo", "deadline"] as const) nonempty(input[key], key);
      if (typeof input.dry !== "boolean" || !["EXACT_INPUT", "EXACT_OUTPUT"].includes(input.swapType)) throw new Error("Invalid quote type");
      if (!/^[0-9]+$/.test(input.amount) || BigInt(input.amount) <= 0n) throw new Error("amount must be a positive integer in base units");
      if (!Number.isInteger(input.slippageTolerance) || input.slippageTolerance < 0 || input.slippageTolerance > 10_000) throw new Error("Invalid slippageTolerance");
      if (!Number.isFinite(Date.parse(input.deadline)) || Date.parse(input.deadline) <= Date.now()) throw new Error("deadline must be in the future");
      const data = await request("/v0/quote", { ...input, depositType: "ORIGIN_CHAIN", recipientType: "DESTINATION_CHAIN", refundType: "ORIGIN_CHAIN" });
      if (!object(data) || !object(data.quote) || typeof data.quote.amountIn !== "string" || !/^[0-9]+$/.test(data.quote.amountIn) || typeof data.quote.amountOut !== "string" || !/^[0-9]+$/.test(data.quote.amountOut) || (!input.dry && (typeof data.quote.depositAddress !== "string" || !data.quote.depositAddress.trim()))) throw new Error("Invalid Intents quote response");
      return data as QuoteResponse;
    },
    async status(depositAddress: string, depositMemo?: string): Promise<SwapStatus> {
      nonempty(depositAddress, "depositAddress");
      const query = new URLSearchParams({ depositAddress });
      if (depositMemo !== undefined) query.set("depositMemo", depositMemo);
      const data = await request(`/v0/status?${query}`);
      if (!object(data) || typeof data.status !== "string") throw new Error("Invalid Intents status response");
      return data as SwapStatus;
    },
    async submitDeposit(input: { txHash: string; depositAddress: string; memo?: string; nearSenderAccount?: string }): Promise<unknown> {
      nonempty(input.txHash, "txHash"); nonempty(input.depositAddress, "depositAddress");
      return request("/v0/deposit/submit", input);
    },
  };
}
