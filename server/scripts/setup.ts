import { ROOT, loadConfig, constraintsFromConfig, toYocto, fmt } from "../src/config.js";
import { SetupJournal } from "../src/credentials.js";
/**
 * One-time testnet setup. Creates a fresh set of accounts, deploys the contract and gives the
 * two agents scoped function-call keys. Writes everything to .keys/testnet.json (git-ignored).
 *
 *   pnpm setup:testnet
 *
 * By default the master account is funded by the public testnet faucet. To use an account you
 * already fund, set MASTER_ACCOUNT_ID and MASTER_PRIVATE_KEY (needs about 9 NEAR).
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Account, KeyPair, type KeyPairString } from "near-api-js";
import { EXPLORER, provider, call, view } from "../src/near.js";
import { KEYS_PATH, keysExist, loadKeys, saveKeys, type KeyFile, type Role, type KeyEntry } from "../src/credentials.js";

const journal = new SetupJournal(`${KEYS_PATH}.setup-${Date.now()}.json`);
const FAUCET = "https://helper.testnet.near.org/account";
/** NEAR sent to each account at creation. The contract needs ~2.9 NEAR for code storage. */
const FUNDING: Record<Role | "contract", string> = {
  contract: "4", owner: "0.3", oracle: "0.5", ceo: "0.3", alice: "0.2", bob: "0.2", customer: "2.3", vendor: "0.1",
};
export const AGENT_METHODS = {
  oracle: ["record_contribution", "record_contribution_once", "pay_expense", "close_distribution", "finalize"],
  ceo: ["record_expense", "create_proposal"],
} as const;

const log = (step: string, detail = "") => console.log(`• ${step}${detail ? `  ${detail}` : ""}`);
const newKey = () => KeyPair.fromRandom("ed25519");

async function master(): Promise<{ accountId: string; privateKey: string }> {
  if (process.env.MASTER_ACCOUNT_ID && process.env.MASTER_PRIVATE_KEY) {
    log("Using existing master account", process.env.MASTER_ACCOUNT_ID);
    const entry = { accountId: process.env.MASTER_ACCOUNT_ID, privateKey: process.env.MASTER_PRIVATE_KEY };
    journal.record("master", entry);
    return entry;
  }
  const key = newKey();
  const accountId = `agentcorp-${randomBytes(4).toString("hex")}.testnet`;
  journal.record("master", { accountId, privateKey: key.toString() });
  const res = await fetch(FAUCET, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: key.getPublicKey().toString() }),
  });
  if (!res.ok) throw new Error(`Faucet refused (${res.status}): ${(await res.text()).slice(0, 200)}\nSet MASTER_ACCOUNT_ID and MASTER_PRIVATE_KEY to use your own funded testnet account.`);
  log("Created master account via faucet", accountId);
  return { accountId, privateKey: key.toString() };
}

/** Agents get function-call keys limited to this contract and their own methods. No deposits possible. */
async function addAgentKeys(contractId: string, accounts: Record<Role, KeyEntry>) {
  for (const role of ["oracle", "ceo"] as const) {
    const key = newKey();
    const full = new Account(accounts[role].accountId, provider, accounts[role].privateKey as KeyPairString);
    accounts[role].agentKey = key.toString();
    accounts[role].agentMethods = [...AGENT_METHODS[role]];
    journal.record(role, accounts[role]);
    await full.addFunctionCallAccessKey({ publicKey: key.getPublicKey(), contractId, methodNames: [...AGENT_METHODS[role]] });
    accounts[role].agentKey = key.toString();
    accounts[role].agentMethods = [...AGENT_METHODS[role]];
    log(`Added scoped key for ${role} agent`, AGENT_METHODS[role].join(", "));
  }
}

async function main() {
  if (process.argv.includes("--rekey")) {
    const keys = loadKeys();
    await addAgentKeys(keys.contractId, keys.accounts);
    saveKeys(keys);
    return;
  }
  if (keysExist() && !process.argv.includes("--force")) {
    console.error(`${KEYS_PATH} already exists. Setup is done; run "pnpm demo".\nTo create a brand-new deployment run: pnpm setup:testnet --force`);
    process.exit(1);
  }
  const config = loadConfig();
  const wasm = readFileSync(process.env.AGENTCORP_WASM ?? join(ROOT, "contract", "res", "agent_corp.wasm"));

  const m = await master();
  const masterAccount = new Account(m.accountId, provider, m.privateKey as KeyPairString);
  const balance = await masterAccount.getBalance();
  const needed = Object.values(FUNDING).reduce((sum, v) => sum + toYocto(v), 0n) + toYocto("0.3");
  log("Master balance", `${fmt(balance)} NEAR (need ${fmt(needed)})`);
  if (balance < needed) throw new Error("Master account balance too low for setup.");

  const sub = async (prefix: string, near: string) => {
    const key = newKey();
    journal.record(prefix, { accountId: `${prefix}.${m.accountId}`, privateKey: key.toString() });
    await masterAccount.createSubAccount({ accountOrPrefix: prefix, publicKey: key.getPublicKey(), nearToTransfer: toYocto(near) });
    const accountId = `${prefix}.${m.accountId}`;
    log(`Created ${prefix}`, `${accountId} (${near} NEAR)`);
    return { accountId, privateKey: key.toString() };
  };

  const contract = await sub("contract", FUNDING.contract);
  const accounts = {} as Record<Role, KeyEntry>;
  for (const role of ["owner", "oracle", "ceo", "alice", "bob", "customer", "vendor"] as Role[]) {
    accounts[role] = await sub(role, FUNDING[role]);
  }

  const contractAccount = new Account(contract.accountId, provider, contract.privateKey as KeyPairString);
  await contractAccount.deployContract(wasm);
  log("Deployed contract", `${wasm.length} bytes`);
  const init = await call(contractAccount, contract.accountId, "new", {
    owner: accounts.owner.accountId,
    oracle: accounts.oracle.accountId,
    ceo: accounts.ceo.accountId,
    constraints: constraintsFromConfig(config),
    demo_mode: true,
    initially_paused: config.kill_switch,
  });
  log("Initialised contract (demo_mode: true)", init.explorerUrl);

  await addAgentKeys(contract.accountId, accounts);

  const keys: KeyFile = { network: "testnet", contractId: contract.accountId, contract, master: m, accounts };
  saveKeys(keys);

  const onChain = await view<{ paused: boolean; demo_mode: boolean }>(contract.accountId, "get_config");
  if (onChain.paused !== config.kill_switch) throw new Error("Initial kill switch mismatch");
  console.log(`\nSetup complete.\n  contract: ${contract.accountId}\n  explorer: ${EXPLORER}/address/${contract.accountId}\n  paused: ${onChain.paused}, demo_mode: ${onChain.demo_mode}\n  keys: ${KEYS_PATH} (git-ignored)\n\nNext: pnpm demo`);
}

main().catch(error => { console.error(`Recovery journal (private): ${journal.file}`); console.error(`\nSetup failed: ${error instanceof Error ? error.message : error}`); process.exit(1); });
