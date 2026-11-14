/** Export only demo contributor keys for local worker sessions, never owner/oracle keys. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { KeyPair, type KeyPairString } from "near-api-js";
import { ROOT } from "../src/config.js";
import { loadKeys } from "../src/credentials.js";
const keys = loadKeys();
const dir = join(ROOT, ".keys", "workers");
await mkdir(dir, { recursive: true, mode: 0o700 });
for (const role of ["alice", "bob"] as const) {
  const entry = keys.accounts[role];
  const pair = KeyPair.fromString(entry.privateKey as KeyPairString);
  const file = join(dir, `${role}.json`);
  try {
    await writeFile(file, JSON.stringify({ account_id: entry.accountId, public_key: pair.getPublicKey().toString(), private_key: entry.privateKey }), { flag: "wx", mode: 0o600 });
    console.log(`Created ${file}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    console.log(`Preserved existing ${file}`);
  }
}
