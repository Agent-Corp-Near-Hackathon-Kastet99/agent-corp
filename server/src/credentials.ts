import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, ACCOUNT_RE } from "./config.js";

const keysDir = join(ROOT, ".keys");
function defaultKeysPath(): string {
  const activePath = join(keysDir, "active");
  if (!existsSync(activePath)) return join(keysDir, "testnet.json");
  const name = readFileSync(activePath, "utf8").trim();
  if (!/^[a-zA-Z0-9._-]+\.json$/.test(name)) throw new Error("Invalid .keys/active deployment name");
  return join(keysDir, name);
}
export const KEYS_PATH = process.env.AGENTCORP_KEYS ?? defaultKeysPath();
/** Wallet names in the key file. `oracle` and `ceo` are the two on-chain agents. */
export type Role = "owner" | "oracle" | "ceo" | "alice" | "bob" | "customer" | "vendor";
export type KeyEntry = {
  accountId: string;
  /** Full-access key. For `oracle` and `ceo` it is used by setup only, never by the agents. */
  privateKey: string;
  /** Function-call key limited to this contract and the agent's own methods. */
  agentKey?: string;
  agentMethods?: string[];
};
export type KeyFile = {
  network: "testnet";
  contractId: string;
  contract?: KeyEntry;
  master: { accountId: string; privateKey: string };
  accounts: Record<Role, KeyEntry>;
};

/** Atomic, private writes are shared by completed credentials and setup recovery journals. */
export function savePrivate(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}
export function keysExist(): boolean { return existsSync(KEYS_PATH); }
export function loadKeys(): KeyFile {
  if (!keysExist()) throw new Error(`No key file at ${KEYS_PATH}. Run: pnpm setup:testnet`);
  const keys = JSON.parse(readFileSync(KEYS_PATH, "utf8")) as KeyFile;
  if (keys.network !== "testnet" || typeof keys.contractId !== "string" || !ACCOUNT_RE.test(keys.contractId)
      || !keys.accounts || !["owner", "oracle", "ceo", "alice", "bob", "customer", "vendor"].every(role => {
        const entry = keys.accounts[role as Role];
        return entry && ACCOUNT_RE.test(entry.accountId) && typeof entry.privateKey === "string" && entry.privateKey.startsWith("ed25519:");
      })) throw new Error("Invalid testnet credentials");
  return keys;
}
export function saveKeys(keys: KeyFile): void { savePrivate(KEYS_PATH, keys); }

/** Preserve each generated secret BEFORE attempting remote mutations; retained on failure. */
export class SetupJournal {
  private entries: Record<string, KeyEntry> = {};
  constructor(readonly file: string) {}
  record(role: string, entry: KeyEntry): void {
    const next = { ...this.entries, [role]: structuredClone(entry) };
    savePrivate(this.file, { network: "testnet", accounts: next });
    this.entries = next;
  }
}
