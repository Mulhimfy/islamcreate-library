// Prints the pages.jsonl paths a limited build will use: the books
// build.mjs keeps with --limit (the oldest authors of every category).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [dir, limit] = process.argv.slice(2);
const per = Math.max(1, Math.ceil(Number(limit) / 40));
for (const cat of readdirSync(dir).filter((d) => /^\d\d__/.test(d)).sort()) {
  const books = [];
  for (const b of readdirSync(join(dir, cat))) {
    const f = join(dir, cat, b, 'book_metadata.json');
    if (!existsSync(f)) continue;
    const m = JSON.parse(readFileSync(f, 'utf8'));
    if (m.is_hidden) continue;
    const d = m.main_author_death_hijri;
    books.push([d > 0 && d < 2000 ? d : 9999, m.book_id, `${cat}/${b}/pages.jsonl`]);
  }
  books.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [, , p] of books.slice(0, per)) console.log(p);
}
