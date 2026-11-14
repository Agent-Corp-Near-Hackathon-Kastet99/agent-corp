import { expect, it } from "vitest";
import { quotePass } from "../src/intents.js";
it("requests a dry mainnet reference quote without creating a payment", async () => {
  let sent: Record<string, unknown> = {};
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ quote: { amountIn: "1200000", amountOut: "1000000000000000000000000" } }), { status: 200 });
  }) as typeof fetch;
  const quote = await quotePass("usdc-near", "999", fetcher);
  expect(sent).toMatchObject({ dry: true, swapType: "EXACT_OUTPUT", amount: "1000000000000000000000000" });
  expect(quote).toMatchObject({ available: true, previewOnly: true, network: "mainnet", inputAmount: "1200000" });
  expect((await quotePass("unknown", "999", fetcher)).available).toBe(false);
});
