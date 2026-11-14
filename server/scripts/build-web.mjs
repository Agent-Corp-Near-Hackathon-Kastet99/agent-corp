import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const entry = fileURLToPath(new URL('../client/wallet.ts', import.meta.url));
await build({ entryPoints: [entry], outfile: fileURLToPath(new URL('../web/wallet.js', import.meta.url)), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'eof' });
const game = fileURLToPath(new URL('../client/game/main.ts', import.meta.url));
await build({ entryPoints: [game], outfile: fileURLToPath(new URL('../web/game3d.js', import.meta.url)), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'none' });
console.log('Built testnet wallet client and 3D game');
