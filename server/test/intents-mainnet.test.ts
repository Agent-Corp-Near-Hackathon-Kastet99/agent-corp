import { describe, expect, it, vi } from "vitest";
import { createMainnetIntentsClient, IntentsApiError, type QuoteRequest } from "../src/intents-mainnet.js";

const quote: QuoteRequest = { dry: false, swapType: "EXACT_OUTPUT", slippageTolerance: 100, originAsset: "asset-in", destinationAsset: "asset-out", amount: "1000000000000000000000000", recipient: "alice.near", refundTo: "alice.near", deadline: "2099-01-01T00:00:00Z" };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

describe("disconnected mainnet Intents client", () => {
  it("requires opt-in before making any request", () => {
    const fetcher = vi.fn();
    expect(() => createMainnetIntentsClient({ enabled: false, fetcher })).toThrow("disabled");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("requests an exact-output quote with explicit destination and refund", async () => {
    const fetcher = vi.fn(async () => json({ quote: { amountIn: "123", amountOut: quote.amount, depositAddress: "deposit.near", depositMemo: "42" } }));
    const client = createMainnetIntentsClient({ enabled: true, jwt: "secret", fetcher });
    expect((await client.quote(quote)).quote.depositMemo).toBe("42");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://1click.chaindefuser.com/v0/quote");
    expect(init.headers).toMatchObject({ authorization: "Bearer secret" });
    expect(JSON.parse(String(init.body))).toMatchObject({ ...quote, depositType: "ORIGIN_CHAIN", recipientType: "DESTINATION_CHAIN", refundType: "ORIGIN_CHAIN" });
  });
  it("preserves memo in status and deposit notification", async () => {
    const fetcher = vi.fn(async () => json({ status: "PROCESSING" }));
    const client = createMainnetIntentsClient({ enabled: true, fetcher });
    await client.status("address+1", "memo/1");
    await client.submitDeposit({ depositAddress: "address+1", txHash: "hash", memo: "memo/1" });
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0][0]).toContain("depositAddress=address%2B1&depositMemo=memo%2F1");
    expect(JSON.parse(String(calls[1][1].body))).toMatchObject({ txHash: "hash", memo: "memo/1" });
  });
  it("rejects invalid requests, malformed quotes and API failures", async () => {
    const fetcher = vi.fn(async () => json({ quote: { amountIn: "1", amountOut: "2" } }));
    const client = createMainnetIntentsClient({ enabled: true, fetcher });
    await expect(client.quote({ ...quote, amount: "0" })).rejects.toThrow("amount");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(client.quote(quote)).rejects.toThrow("Invalid Intents quote");
    const failing = createMainnetIntentsClient({ enabled: true, fetcher: async () => json({}, 429) });
    await expect(failing.tokens()).rejects.toBeInstanceOf(IntentsApiError);
  });
});
