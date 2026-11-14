/** Mainnet market preview only. This does not initiate a swap or purchase a testnet pass. */
const ASSETS: Record<string, string> = {
  "usdc-near": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
};
const WNEAR = "nep141:wrap.near";
const REFERENCE_NEAR = "1000000000000000000000000";
export async function quotePass(asset: string, _testnetPrice: string, fetcher: typeof fetch = fetch) {
  const originAsset = ASSETS[asset];
  if (!originAsset) return { available: false, reason: "Choose usdc-near for a mainnet market preview." };
  try {
    const response = await fetcher("https://1click.chaindefuser.com/v0/quote", {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ dry: true, swapType: "EXACT_OUTPUT", slippageTolerance: 100, originAsset, destinationAsset: WNEAR,
        amount: REFERENCE_NEAR, depositType: "ORIGIN_CHAIN", recipientType: "DESTINATION_CHAIN", refundType: "ORIGIN_CHAIN",
        recipient: "preview.near", refundTo: "preview.near", deadline: new Date(Date.now() + 180_000).toISOString() }),
    });
    const result = await response.json() as { quote?: { amountIn?: string; amountOut?: string; timeEstimate?: number }; message?: string };
    if (!response.ok || !result.quote?.amountIn) return { available: false, reason: result.message ?? "No mainnet quote available." };
    return { available: true, network: "mainnet", previewOnly: true, inputAsset: "USDC on NEAR", inputAmount: result.quote.amountIn, inputDecimals: 6,
      outputAsset: "wNEAR", outputAmount: result.quote.amountOut ?? REFERENCE_NEAR, outputDecimals: 24, timeEstimate: result.quote.timeEstimate };
  } catch { return { available: false, reason: "NEAR Intents preview unavailable." }; }
}
