import { fmt as near } from "/shared/money.js";
export { near };
// Reads the ledger straight from the contract over NEAR RPC. No server needed for views.

let cached;
/** Deployment info: from the local server if it runs, else from the static deployment.json. */
export async function deployment() {
  if (cached) return cached;
  for (const url of ["/api/deployment", "deployment.json"]) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.contractId) return (cached = data);
    } catch { /* try the next source */ }
  }
  throw new Error("No deployment found. Run `pnpm setup:testnet`, then `pnpm start`.");
}

export async function view(method, args = {}) {
  const dep = await deployment();
  const res = await fetch(dep.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "query",
      params: { request_type: "call_function", finality: "final", account_id: dep.contractId, method_name: method, args_base64: btoa(JSON.stringify(args)) },
    }),
  });
  const data = await res.json();
  if (data.error || data.result?.error) throw new Error(data.result?.error ?? data.error?.data ?? data.error?.message ?? "RPC error");
  return JSON.parse(new TextDecoder().decode(new Uint8Array(data.result.result)));
}

/** Server action (demo wallets, game). Throws with the server's reason on failure. */
export async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Request failed (${res.status})`), { status: res.status, data });
  return data;
}

export const tnear = (yocto, decimals) => `${near(yocto, decimals)} tNEAR`;
export const when = ns => new Date(Number(BigInt(ns) / 1_000_000n)).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
export const esc = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const short = account => (account.length > 28 ? `${account.split(".")[0]}.…${account.slice(-12)}` : account);

export function header(active) {
  const link = (href, label, key) => `<a href="${href}"${active === key ? ' aria-current="page"' : ""}>${label}</a>`;
  const gameSite = active === 'ledger' || active === 'security' ? 'https://ram-heist-game.vercel.app' : '';
  return `<a class="brand" href="/">FOUNDRY STACK</a>
    <nav aria-label="Main">${link("/ledger", "Ledger", "ledger")}${active === 'ledger' || active === 'security' ? link("/investor", "Investor", "investor") : ''}${link(`${gameSite}/store`, "Store", "store")}${link(`${gameSite}/game`, "Game", "game")}</nav>
    <b class="badge">TESTNET · DEMO</b>`;
}
