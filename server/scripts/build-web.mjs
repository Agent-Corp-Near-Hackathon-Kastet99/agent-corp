import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const entry = fileURLToPath(new URL('../client/wallet.ts', import.meta.url));
await build({ entryPoints: [entry], outfile: fileURLToPath(new URL('../web/wallet.js', import.meta.url)), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'eof' });
console.log('Built testnet wallet client');
