import { createApplication } from "./app.js";
import { createGameLedger } from "./game-ledger.js";
import { Store } from "./store.js";

const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; };
const origin = new URL(required("GAME_ORIGIN"));
if (origin.protocol !== "https:" || origin.origin !== origin.href.replace(/\/$/, "")) throw new Error("GAME_ORIGIN must be an HTTPS origin");
const ledger = createGameLedger({ contractId: required("GAME_CONTRACT_ID"), customerId: required("GAME_CUSTOMER_ID"), customerKey: required("GAME_CUSTOMER_KEY"), maxPrice: required("GAME_MAX_PRICE_YOCTO"), purchaseMarker: required("GAME_PURCHASE_MARKER") });
const server = createApplication({ store: new Store(required("AGENTCORP_STATE")), ledger, demoActions: true, gameOnly: true, gameOrigin: origin.origin });
const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
server.listen(port, process.env.HOST ?? "127.0.0.1", () => console.log("Game backend listening"));
