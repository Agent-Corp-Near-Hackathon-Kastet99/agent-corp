/**
 * Meteor Wallet's selector adapter still imports the legacy `utils` namespace
 * from near-api-js. Agent Corp uses near-api-js v7, which exposes no such
 * namespace. The adapter only needs this decoder while creating a transaction.
 */
export const utils = {
  key_pair: { KeyType: { ED25519: 0, SECP256K1: 1 } },
  serialize: {
    base_decode(value: string) {
      return base58Decode(value);
    },
  },
};

/** NEAR RPC block hashes use base58, not base64. */
export function base58Decode(value: string): Uint8Array {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes: number[] = [];
  for (const char of value) {
    let carry = alphabet.indexOf(char);
    if (carry < 0) throw new Error(`Invalid base58 character: ${char}`);
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const zeros = value.match(/^1*/)?.[0].length ?? 0;
  return Uint8Array.from([...Array(zeros).fill(0), ...bytes.reverse()]);
}
