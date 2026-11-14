import { record, tokens } from "./common.js";
import { readCliVersion, resolveExecutablePath } from "./probe.js";
import type { Parsed, ProviderAdapter } from "./types.js";

/** Pi message usage as bb's Pi bridge records it. Pi's `cost` is computed from its own model
 * catalogue, not billed by a provider, so only the token counts are used. */
export function parsePi(event: Record<string, unknown>): Parsed {
  if (event.type !== "agent_end" || !Array.isArray(event.messages)) return {};
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let text: string | undefined, seen = false;
  for (const message of event.messages.map(record)) {
    if (message?.role !== "assistant") continue;
    const raw = record(message.usage), usage = raw ? tokens(raw.input, raw.output, raw.cacheRead, raw.cacheWrite) : undefined;
    if (!usage) return { error: "Pi reported malformed usage" };
    seen = true;
    for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += usage[key];
    const parts = Array.isArray(message.content) ? message.content.map(record).filter(part => part?.type === "text" && typeof part.text === "string").map(part => part!.text as string) : [];
    if (parts.length) text = parts.join("");
  }
  return seen ? { total, final: true, ...(text !== undefined ? { text } : {}) } : { error: "Pi finished without usage" };
}

const NOT_ENABLED = "Pi runs are not enabled: its headless flags, sign-in files and sandbox were never exercised (Pi was not installed on the reference machine)";

/** Discovery and metering only. bb drives Pi over its RPC mode with tools enabled, which this
 * worker must not do, and no confined one-shot launch has been verified. */
export const pi: ProviderAdapter = {
  id: "pi", displayName: "Pi", costSource: "list-price", confinement: "tools-disabled", verified: false,
  signInCommand: "pi (then /login)", installUrl: "https://github.com/badlogic/pi-mono",
  async health() {
    const executable = await resolveExecutablePath("pi");
    if (!executable) return { status: "not_installed" };
    return { status: "unsupported_install", version: await readCliVersion("pi") ?? undefined, executable, message: NOT_ENABLED };
  },
  launch: async () => { throw new Error(NOT_ENABLED); },
  parser: () => ({ event: parsePi }),
};
