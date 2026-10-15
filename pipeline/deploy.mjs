// Deploys a build to Cloudflare Pages, one project per output directory.
//
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node pipeline/deploy.mjs --out <dir> [--prefix islamcreate-lib]
//
// The shards (idx, lst<n>, txt<n>) go first; then their hosts are written
// into main/manifest.json and main goes last, so a reader never gets a
// manifest that points at files not yet there.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values: opt } = parseArgs({ options: { out: { type: 'string' }, prefix: { type: 'string', default: 'islamcreate-lib' }, only: { type: 'string', default: '' } } });
const { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT } = process.env;
if (!TOKEN || !ACCOUNT) throw new Error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required');
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/pages/projects`;

async function api(path, init = {}) {
  const res = await fetch(API + path, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function ensureProject(name) {
  let r = await api(`/${name}`);
  if (r.status === 404 || r.body?.errors?.some((e) => e.code === 8000007)) {
    r = await api('', { method: 'POST', body: JSON.stringify({ name, production_branch: 'main' }) });
    if (!r.body.success) throw new Error(`create ${name}: ${JSON.stringify(r.body.errors)}`);
    console.log(`created project ${name}`);
  } else if (!r.body.success) throw new Error(`get ${name}: ${JSON.stringify(r.body.errors)}`);
  return `https://${r.body.result.subdomain}`;
}

function deploy(dir, name) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`deploying ${dir} → ${name} (attempt ${attempt})`);
    const r = spawnSync('npx', ['--yes', 'wrangler@4', 'pages', 'deploy', dir, '--project-name', name, '--branch', 'main', '--commit-dirty=true'], { stdio: 'inherit', env: process.env });
    if (r.status === 0) return;
  }
  throw new Error(`deploy ${name} failed`);
}

const dirs = (await readdir(opt.out, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
const shards = dirs.filter((d) => d !== 'main' && (!opt.only || opt.only.split(',').includes(d)));
const hosts = {};
for (const d of dirs.filter((d) => d !== 'main')) hosts[d] = await ensureProject(`${opt.prefix}-${d}`);
for (const d of shards) deploy(join(opt.out, d), `${opt.prefix}-${d}`);

const main = await ensureProject(opt.prefix);
const mf = join(opt.out, 'main', 'manifest.json');
const manifest = JSON.parse(await readFile(mf, 'utf8'));
manifest.hosts = hosts;
await writeFile(mf, JSON.stringify(manifest, null, 1));
if (!opt.only || opt.only.split(',').includes('main')) deploy(join(opt.out, 'main'), opt.prefix);
console.log(JSON.stringify({ main, hosts }, null, 1));
