import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'game-site', 'dist');
const backend = process.env.GAME_BACKEND_ORIGIN;
if (!backend || !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(backend)) throw new Error('Set GAME_BACKEND_ORIGIN to an HTTPS origin');
// Keep public deployments reproducible: no machine/IP fallback is allowed here.
// The server must be reachable over HTTPS before this static site is deployed.
await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'shared'), { recursive: true });
for (const file of ['game.html', 'game.js', 'heist-core.js', 'store.html', 'store.js', 'style.css', 'chain.js']) await cp(join(root, 'server', 'web', file), join(out, file));
await cp(join(root, 'shared', 'src', 'money.js'), join(out, 'shared', 'money.js'));
const chain = join(out, 'chain.js');
await writeFile(chain, (await readFile(chain, 'utf8')).replace('${link("/", "Ledger", "ledger")}', '').replace('class="brand" href="/"', 'class="brand" href="/game"'));
await writeFile(join(out, 'vercel.json'), JSON.stringify({ cleanUrls: true, redirects: [{ source: '/', destination: '/game', permanent: false }], rewrites: [{ source: '/api/:path*', destination: `${backend}/api/:path*` }] }, null, 2));
console.log(`Built game site in ${out} → API ${backend}`);
