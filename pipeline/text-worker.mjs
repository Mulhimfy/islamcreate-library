// Text worker: books [from, to) of the plan, in gpid order.
//
// Per book it writes
//   txt<shard>/t/<id>/<k>.gz   pages k·P … k·P+P-1, gzip; pages are joined
//                              by \f, lines by \n; a heading line starts
//                              with \u0001; footnotes follow a \u001e line
//   main/b/<id>.json           card, table of contents, page labels
// and appends, for every distinct term of the book, the pages it is on to
// the term's hash partition: tmp/part-<worker>-<partition>.bin.
import { readFileSync, openSync, writeSync, closeSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Writer } from './lib/bytes.mjs';
import { tokens, bucketOf } from './normalize.mjs';

const [w, from, to] = process.argv.slice(2, 5).map(Number);
const { books, P, out, tmp } = JSON.parse(readFileSync(process.argv[5], 'utf8'));

const parts = Array.from({ length: P.parts }, (_, p) => ({ fd: openSync(join(tmp, `part-${w}-${p}.bin`), 'w'), w: new Writer(1 << 20) }));
const flush = (part, force) => {
  if (part.w.len && (force || part.w.len > 1 << 20)) {
    writeSync(part.fd, part.w.view);
    part.w.reset();
  }
};

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
const TITLE_RE = /<span\b[^>]*?(?:data-type=['"]?title['"]?|class=['"]title['"])[^>]*>([\s\S]*?)<\/span>/g;

/** Shamela's light HTML → plain lines; headings become \u0001 lines. */
function clean(html) {
  if (!html) return '';
  return html
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=\s]+/g, '')
    .replace(TITLE_RE, (m, t) => `\r\u0001${t.replace(/<[^>]+>/g, '').replace(/[\r\n]+/g, ' ').trim()}\r`)
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m, k) => ENTITIES[k])
    .split(/\r\n?|\n/)
    .map((l) => l.replace(/[ \t ]+$/g, '').replace(/^[ \t ]+/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
    .replace(/\u0001\n/g, '\n');
}

const stats = { words: 0, raw: 0, gz: 0, chunks: 0, books: {} };

for (let bi = from; bi < to; bi++) {
  const b = books[bi];
  const rows = readFileSync(join(b.dir, 'pages.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((x, y) => x.sequence_num - y.sequence_num);
  if (rows.length !== b.pages) process.send({ log: `book ${b.id}: ${rows.length} rows, manifest says ${b.pages}` });

  const terms = new Map();
  const pageLabels = [];
  const pageIds = new Map();
  const vols = new Set();
  let words = 0;
  let chunk = [];
  const tdir = join(out, `txt${b.shard}`, 't', String(b.id));
  mkdirSync(tdir, { recursive: true });

  const flushChunk = (k) => {
    const raw = Buffer.from(chunk.join('\f'));
    const gz = gzipSync(raw, { level: 6 });
    writeFileSync(join(tdir, `${k}.gz`), gz);
    stats.raw += raw.length;
    stats.gz += gz.length;
    stats.chunks++;
    chunk = [];
  };

  // The manifest's count numbers the gpids; pad or trim to it.
  for (let i = 0; i < b.pages; i++) {
    const r = rows[i] || { body: '', footnotes: null, part: null, page_num: null };
    const body = clean(r.body);
    const notes = clean(r.footnotes);
    const text = notes ? `${body}\n\u001e\n${notes}` : body;
    chunk.push(text);
    if (chunk.length === P.chunkPages) flushChunk(Math.floor(i / P.chunkPages));
    if (r.page_id != null) pageIds.set(r.page_id, i);
    const part = r.part ?? '';
    if (part !== '') vols.add(part);
    pageLabels.push([part, r.page_num ?? '']);

    const toks = tokens(text);
    words += toks.length;
    for (const t of toks) {
      let list = terms.get(t);
      if (!list) terms.set(t, (list = []));
      if (list[list.length - 1] !== i) list.push(i);
    }
  }
  if (chunk.length) flushChunk(Math.floor((b.pages - 1) / P.chunkPages));

  // Partition records: term, the book's first gpid, then the local pages.
  for (const [t, list] of terms) {
    const part = parts[bucketOf(t, P.buckets) % P.parts];
    const wr = part.w;
    wr.str(t);
    wr.varint(b.gpid);
    wr.varint(list.length);
    let prev = 0;
    for (const p of list) {
      wr.varint(p - prev);
      prev = p;
    }
    flush(part, false);
  }

  // Page labels as runs: [first page, volume, first printed number, length].
  const runs = [];
  for (let i = 0; i < pageLabels.length; i++) {
    const [vol, num] = pageLabels[i];
    const n = Number(num);
    const last = runs[runs.length - 1];
    if (last && last[1] === vol && Number.isFinite(n) && num !== '' && last[2] !== '' && last[2] + last[3] === n) last[3]++;
    else runs.push([i, vol, num === '' || !Number.isFinite(n) ? '' : n, 1]);
  }

  // Table of contents: [page, depth, heading], in reading order.
  const toc = [];
  try {
    const items = readFileSync(b.toc, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const byId = new Map(items.map((t) => [t.title_id, t]));
    const depth = (t) => {
      let d = 0;
      for (let p = t.parent_id; p != null && byId.has(p) && d < 8; p = byId.get(p).parent_id) d++;
      return d;
    };
    for (const t of items) {
      const page = pageIds.get(t.page_id);
      if (page == null || !t.title_text) continue;
      toc.push([page, depth(t), t.title_text.trim(), t.shamela_title_id ?? t.title_id]);
    }
    toc.sort((x, y) => x[0] - y[0] || x[3] - y[3]);
  } catch {}

  writeFileSync(
    join(out, 'main', 'b', `${b.id}.json`),
    JSON.stringify({ id: b.id, shamela: b.shamela, pages: b.pages, gpid: b.gpid, shard: b.shard, card: b.card || '', labels: runs, toc: toc.map((t) => t.slice(0, 3)) }),
  );

  stats.words += words;
  stats.books[b.id] = { words, volumes: vols.size };
  if ((bi - from) % 200 === 0) process.send({ log: `worker ${w}: ${bi - from}/${to - from} books` });
}

for (const part of parts) {
  flush(part, true);
  closeSync(part.fd);
}
process.send(stats);
