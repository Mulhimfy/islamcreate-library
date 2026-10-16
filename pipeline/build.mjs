// Builds the static library from the Shamela 4 extraction.
//
//   node pipeline/build.mjs --src <dataset dir> --out <dir> [--limit N] [--workers 4]
//
// 1. catalog  read every book's metadata, drop hidden ones, order the
//             books floor by floor and number every page (gpid)
// 2. text     workers turn pages into gzip text chunks and per-book term
//             lists, spread over hash partitions on disk
// 3. index    workers merge each partition into dictionary buckets with
//             inline postings, and posting files for frequent terms
// 4. manifest the catalog, per-floor summary and the file plan
//
// Output: <out>/main (manifest, catalog, book files, large postings),
// <out>/idx (dictionary buckets), <out>/txt<n> (text chunks), each a
// directory deployed as its own static site.
import { readdir, readFile, writeFile, mkdir, rm, stat, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { parseArgs } from 'node:util';
import { CATEGORIES, GROUPS } from './categories.mjs';
import { NORM_VERSION, completionKey } from './normalize.mjs';

const { values: opt } = parseArgs({
  options: {
    src: { type: 'string' },
    out: { type: 'string' },
    tmp: { type: 'string' },
    limit: { type: 'string', default: '0' },
    workers: { type: 'string', default: '4' },
    buckets: { type: 'string', default: '16384' },
    parts: { type: 'string', default: '64' },
    'inline-max': { type: 'string', default: '16384' },
    'chunk-pages': { type: 'string', default: '128' },
    'shard-files': { type: 'string', default: '19000' },
    hosts: { type: 'string', default: '{}' },
  },
});
const SRC = opt.src;
const OUT = opt.out;
const TMP = opt.tmp || join(OUT, '..', 'tmp');
const WORKERS = Number(opt.workers);
const P = {
  buckets: Number(opt.buckets),
  parts: Number(opt.parts),
  inlineMax: Number(opt['inline-max']),
  chunkPages: Number(opt['chunk-pages']),
};
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s]`, ...a);

/* ── 1. catalog ─────────────────────────────────────────────────────────── */
const catDirs = (await readdir(SRC)).filter((d) => /^\d\d__/.test(d)).sort();
let books = [];
let hidden = 0;
let empty = 0;
for (const cd of catDirs) {
  const cat = Number(cd.slice(0, 2));
  if (!CATEGORIES[cat]) throw new Error(`unknown category folder ${cd}`);
  for (const bd of (await readdir(join(SRC, cd))).filter((d) => /^\d+__/.test(d))) {
    const dir = join(SRC, cd, bd);
    if (!existsSync(join(dir, 'pages.jsonl'))) continue;
    const meta = JSON.parse(await readFile(join(dir, 'book_metadata.json'), 'utf8'));
    const man = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    if (meta.is_hidden) { hidden++; continue; }
    const pages = man.files.find((f) => f.path === 'pages.jsonl')?.rows ?? man.page_count;
    if (!pages) { empty++; continue; }
    const size = (await stat(join(dir, 'pages.jsonl'))).size;
    books.push({ id: meta.book_id, shamela: meta.shamela_id, dir, cat, catAr: cd.slice(4).replace(/-/g, ' '), meta, pages, size });
  }
}
log(`${books.length} books (${hidden} hidden, ${empty} empty skipped)`);

// Floor by floor, category by category, oldest author first.
const catOrder = new Map(GROUPS.flatMap((g) => g.cats).map((c, i) => [c, i]));
const death = (b) => {
  const d = b.meta.main_author_death_hijri;
  return d && d > 0 && d < 2000 ? d : 9999;
};
books.sort((a, b) => catOrder.get(a.cat) - catOrder.get(b.cat) || death(a) - death(b) || a.id - b.id);
if (Number(opt.limit)) {
  // A test build keeps a slice of every category so each floor has books.
  const per = Math.max(1, Math.ceil(Number(opt.limit) / 40));
  const seen = new Map();
  books = books.filter((b) => { const n = seen.get(b.cat) || 0; seen.set(b.cat, n + 1); return n < per; });
  log(`limited to ${books.length} books`);
}

let gpid = 0;
let shard = 0;
let shardFiles = 0;
for (const b of books) {
  b.gpid = gpid;
  gpid += b.pages;
  const files = Math.ceil(b.pages / P.chunkPages);
  if (shardFiles + files > Number(opt['shard-files'])) { shard++; shardFiles = 0; }
  b.shard = shard;
  shardFiles += files;
}
const totalPages = gpid;
const shards = shard + 1;
log(`${totalPages} pages, ${shards} text shard(s)`);

/* ── 2. text ────────────────────────────────────────────────────────────── */
await rm(OUT, { recursive: true, force: true });
await rm(TMP, { recursive: true, force: true });
for (const d of ['main/b', 'lst/l', 'idx/i', ...Array.from({ length: shards }, (_, s) => `txt${s}/t`)]) await mkdir(join(OUT, d), { recursive: true });
await mkdir(TMP, { recursive: true });

// Contiguous ranges of equal bytes, so every worker's postings stay in
// gpid order and the index merge can simply concatenate them.
const total = books.reduce((s, b) => s + b.size, 0);
const ranges = [];
let acc = 0;
let start = 0;
for (let i = 0; i < books.length; i++) {
  acc += books[i].size;
  if (acc >= (total * (ranges.length + 1)) / WORKERS && ranges.length < WORKERS - 1) {
    ranges.push([start, i + 1]);
    start = i + 1;
  }
}
ranges.push([start, books.length]);

const plan = books.map(({ meta, ...b }) => ({ ...b, card: (meta.betaka_text || '').replace(/\r\n?/g, '\n').trim(), toc: join(b.dir, 'toc.jsonl') }));
await writeFile(join(TMP, 'plan.json'), JSON.stringify({ books: plan, P, out: OUT, tmp: TMP }));

function run(script, args) {
  return new Promise((resolve, reject) => {
    const child = fork(new URL(script, import.meta.url).pathname, args, { execArgv: ['--max-old-space-size=3584'] });
    let result;
    child.on('message', (m) => { if (m.log) log(m.log); else result = m; });
    child.on('exit', (code) => (code === 0 ? resolve(result) : reject(new Error(`${script} ${args.join(' ')} exited ${code}`))));
  });
}

const textStats = await Promise.all(ranges.map(([a, b], w) => run('./text-worker.mjs', [String(w), String(a), String(b), join(TMP, 'plan.json')])));
const perBook = Object.assign({}, ...textStats.map((s) => s.books));
const sum = (k) => textStats.reduce((s, x) => s + x[k], 0);
log(`text: ${sum('words')} words, ${(sum('raw') / 1e9).toFixed(2)} GB → ${(sum('gz') / 1e9).toFixed(2)} GB gzip in ${sum('chunks')} chunks`);

/* ── 3. index ───────────────────────────────────────────────────────────── */
const idxWorkers = Math.min(WORKERS, P.parts);
const idxStats = await Promise.all(
  Array.from({ length: idxWorkers }, (_, w) => run('./index-worker.mjs', [String(w), String(idxWorkers), String(ranges.length), String(totalPages), join(TMP, 'plan.json')])),
);
const isum = (k) => idxStats.reduce((s, x) => s + x[k], 0);
// Long lists go to as many sites as their file count needs, by partition.
const listShards = Math.max(1, Math.ceil(isum('large') / Number(opt['shard-files'])));
for (let l = 0; l < listShards; l++) await mkdir(join(OUT, `lst${l}`, 'l'), { recursive: true });
for (const f of await readdir(join(OUT, 'lst/l'))) {
  const part = Number(f.split('-')[0]);
  await rename(join(OUT, 'lst/l', f), join(OUT, `lst${part % listShards}`, 'l', f));
}
await rm(join(OUT, 'lst'), { recursive: true });
log(`index: ${isum('terms')} terms, buckets ${(isum('bucketBytes') / 1e6).toFixed(0)} MB (max ${Math.max(...idxStats.map((s) => s.bucketMax))} B), ${isum('large')} large lists ${(isum('largeBytes') / 1e6).toFixed(0)} MB`);

/* ── 3b. keyword completion ─────────────────────────────────────────────── */
// k/<key>.json: the most frequent terms whose first two letters (article
// aside) are <key>, as [term, pages], most pages first.
const KW_PER_FILE = 3000;
const byKey = new Map();
for (let p = 0; p < P.parts; p++) {
  const file = join(TMP, `kw-${p}.json`);
  if (!existsSync(file)) continue;
  for (const [t, df] of JSON.parse(await readFile(file, 'utf8'))) {
    // Arabic words only: a key per letter pair stays well inside the
    // file limit of the main site.
    const core = t.startsWith('ال') && t.length > 3 ? t.slice(2) : t;
    if (!/^[\u0621-\u064A\u0671-\u06D3]{2}/.test(core)) continue;
    const k = completionKey(t);
    let list = byKey.get(k);
    if (!list) byKey.set(k, (list = []));
    list.push([t, df]);
  }
  await rm(file);
}
await mkdir(join(OUT, 'main/k'), { recursive: true });
let kwTerms = 0;
for (const [k, list] of byKey) {
  list.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const top = list.slice(0, KW_PER_FILE);
  kwTerms += top.length;
  await writeFile(join(OUT, 'main/k', `${k}.json`), JSON.stringify(top));
}
log(`keywords: ${kwTerms} terms in ${byKey.size} files`);

/* ── 4. catalog & manifest ──────────────────────────────────────────────── */
const authors = new Map();
const authorIdx = (m) => {
  const key = m.main_author_id ?? `n:${m.main_author_name_ar}`;
  if (!authors.has(key)) authors.set(key, { i: authors.size, name: (m.main_author_name_ar || '').trim(), death: m.main_author_death_hijri > 0 && m.main_author_death_hijri < 2000 ? m.main_author_death_hijri : 0 });
  return authors.get(key).i;
};
const catStats = new Map();
const catalogBooks = books.map((b) => {
  const s = perBook[b.id];
  const c = catStats.get(b.cat) || { books: 0, pages: 0, words: 0, first: b.gpid, last: 0 };
  c.books++;
  c.pages += b.pages;
  c.words += s.words;
  c.last = b.gpid + b.pages;
  catStats.set(b.cat, c);
  // id, title, author, category, pages, first gpid, text shard, volumes, words
  return [b.id, b.meta.title_ar.trim(), authorIdx(b.meta), b.cat, b.pages, b.gpid, b.shard, s.volumes, s.words];
});
const catalog = {
  v: 1,
  groups: GROUPS.map((g) => ({ ...g, cats: g.cats.filter((c) => catStats.has(c)) })),
  cats: Object.fromEntries([...catStats].map(([c, s]) => [c, { ar: books.find((b) => b.cat === c).catAr, en: CATEGORIES[c], ...s }])),
  authors: [...authors.values()].map((a) => [a.name, a.death]),
  books: catalogBooks,
};
await writeFile(join(OUT, 'main/catalog.json'), JSON.stringify(catalog));

const build = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
const manifest = {
  v: 1,
  build,
  norm: NORM_VERSION,
  buckets: P.buckets,
  parts: P.parts,
  chunkPages: P.chunkPages,
  books: books.length,
  pages: totalPages,
  words: sum('words'),
  authors: authors.size,
  shards,
  listShards,
  keywords: KW_PER_FILE,
  hosts: JSON.parse(opt.hosts),
  source: 'Shamela 4 full extraction (AuthenticIlm/Shamela4_Full_DB)',
};
await writeFile(join(OUT, 'main/manifest.json'), JSON.stringify(manifest, null, 1));

// Data never changes under a URL within a build; the client asks for
// ?v=<build>, so a year of caching is safe. The manifest itself is short.
const headers = (extra = '') => `/*\n  Access-Control-Allow-Origin: *\n  Cache-Control: public, max-age=31536000, immutable\n  X-Content-Type-Options: nosniff\n${extra}`;
// Rules stack, so the manifest detaches the year-long cache before
// setting its own (a repeated header would be sent twice, joined).
await writeFile(join(OUT, 'main/_headers'), headers('/manifest.json\n  ! Cache-Control\n  Cache-Control: public, max-age=300\n'));
await writeFile(join(OUT, 'idx/_headers'), headers());
for (let s = 0; s < shards; s++) await writeFile(join(OUT, `txt${s}/_headers`), headers());
for (let l = 0; l < listShards; l++) await writeFile(join(OUT, `lst${l}/_headers`), headers());

const summary = { manifest, text: { raw: sum('raw'), gz: sum('gz'), chunks: sum('chunks') }, index: { terms: isum('terms'), bucketBytes: isum('bucketBytes'), bucketMax: Math.max(...idxStats.map((s) => s.bucketMax)), large: isum('large'), largeBytes: isum('largeBytes') } };
await writeFile(join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
await rm(TMP, { recursive: true, force: true });
log('done', JSON.stringify(summary.index));
