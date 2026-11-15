// Builds the public Foundry/Stack landing (f-stack.ai): landing page at "/", the playable game at "/game",
// Investor Dashboard at "/investor". /api/* is proxied to the HTTPS game backend.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../server/scripts/build-web.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'landing-site', 'dist');
const backend = process.env.GAME_BACKEND_ORIGIN;
if (!backend || !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(backend)) throw new Error('Set GAME_BACKEND_ORIGIN to an HTTPS origin');
const web = join(root, 'server', 'web');
await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'shared'), { recursive: true });
for (const file of ['game.html', 'game3d.js', 'game.css', 'style.css', 'chain.js', 'wallet.js', 'wallet-callback.html', 'wallet.css', 'investor.html', 'investor.js', 'landing.css', 'landing.js', 'hackathon.js', 'foundry-stack-agents-v12.mp4', 'kostiantyn-ostapenko.jpg']) await cp(join(web, file), join(out, file));
await cp(join(web, 'landing.html'), join(out, 'index.html'));
await cp(join(root, 'shared', 'src', 'money.js'), join(out, 'shared', 'money.js'));
const chain = join(out, 'chain.js');
await writeFile(chain, (await readFile(chain, 'utf8')).replace('${link("/ledger", "Ledger", "ledger")}', '').replace('class="brand" href="/"', 'class="brand" href="/"'));
await writeFile(join(out, 'vercel.json'), JSON.stringify({ cleanUrls: true, rewrites: [{ source: '/api/:path*', destination: `${backend}/api/:path*` }] }, null, 2));
console.log(`Built landing site in ${out} → API ${backend}`);
