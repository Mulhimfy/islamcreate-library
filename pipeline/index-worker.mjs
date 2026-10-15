// Index worker: merges hash partitions p ≡ w (mod W) into dictionary
// buckets.
//
// idx/i/<bucket>.gz — gzip of
//   "ILB1", varint count, then per term (sorted):
//     str term, varint df (pages), varint kind,
//     kind 0: varint length, the page gaps inline
//     kind 1: varint file, varint length — gaps in lst<n>/l/<part>-<file>.gz
//     kind 2: varint file, varint length — a bitmap over every gpid there
// A bucket holds every term whose stemKey hashes to it, so the clitic
// forms of a word arrive together.
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Reader, Writer, encodeGaps, gapsSize } from './lib/bytes.mjs';
import { bucketOf } from './normalize.mjs';

const [w, W, textWorkers, N] = process.argv.slice(2, 6).map(Number);
const { P, out, tmp } = JSON.parse(readFileSync(process.argv[6], 'utf8'));
const MAGIC = Buffer.from('ILB1');
const stats = { terms: 0, bucketBytes: 0, bucketMax: 0, large: 0, largeBytes: 0 };

for (let p = w; p < P.parts; p += W) {
  const terms = new Map();
  for (let tw = 0; tw < textWorkers; tw++) {
    const file = join(tmp, `part-${tw}-${p}.bin`);
    const r = new Reader(readFileSync(file));
    while (!r.done) {
      const t = r.str();
      const g = r.varint();
      const n = r.varint();
      let list = terms.get(t);
      if (!list) terms.set(t, (list = []));
      let page = 0;
      for (let i = 0; i < n; i++) {
        page += r.varint();
        list.push(g + page);
      }
    }
    rmSync(file);
  }

  const byBucket = new Map();
  for (const t of terms.keys()) {
    const b = bucketOf(t, P.buckets);
    let l = byBucket.get(b);
    if (!l) byBucket.set(b, (l = []));
    l.push(t);
  }

  let large = 0;
  for (let b = p; b < P.buckets; b += P.parts) {
    const list = (byBucket.get(b) || []).sort();
    const wr = new Writer(1 << 16);
    wr.bytes(MAGIC);
    wr.varint(list.length);
    for (const t of list) {
      const post = terms.get(t);
      wr.str(t);
      wr.varint(post.length);
      const size = gapsSize(post);
      if (size <= P.inlineMax) {
        wr.varint(0);
        wr.varint(size);
        encodeGaps(post, wr);
        continue;
      }
      const bitmapSize = Math.ceil(N / 8);
      let data;
      let kind;
      if (bitmapSize < size) {
        data = Buffer.alloc(bitmapSize);
        for (const g of post) data[g >> 3] |= 1 << (g & 7);
        kind = 2;
      } else {
        data = encodeGaps(post).view;
        kind = 1;
      }
      const k = large++;
      const gz = gzipSync(data, { level: 6 });
      writeFileSync(join(out, 'lst', 'l', `${p}-${k}.gz`), gz);
      stats.large++;
      stats.largeBytes += gz.length;
      wr.varint(kind);
      wr.varint(k);
      wr.varint(data.length);
    }
    const gz = gzipSync(wr.view, { level: 9 });
    writeFileSync(join(out, 'idx', 'i', `${b}.gz`), gz);
    stats.terms += list.length;
    stats.bucketBytes += gz.length;
    stats.bucketMax = Math.max(stats.bucketMax, gz.length);
  }
  process.send({ log: `index ${w}: partition ${p} — ${terms.size} terms` });
}
process.send(stats);
