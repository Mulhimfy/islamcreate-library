# IslamCreate Library — data pipeline

Builds the library behind [islamcreate.com/library](https://islamcreate.com/library/): the 8,500+ public books of al-Maktaba al-Shamela 4, every line full-text indexed, served as plain static files. There is no search server — the browser fetches a few small dictionary files per query and intersects page lists on the device.

```
Shamela 4 extraction (Hugging Face) ──► build.mjs ──► static sites on Cloudflare Pages
                                          │
   catalog   books ordered floor by floor, every page numbered (gpid)
   text      gzip chunks of 128 pages per book
   index     dictionary buckets (inline page lists) + long lists / bitmaps
```

## Layout of a build

| Site | Files | |
|---|---|---|
| `main` | `manifest.json`, `catalog.json`, `b/<id>.json`, `b/<id>.toc.json` | build id and hosts; every book; one book's card and page labels; its table of contents |
| `idx` | `i/<bucket>.gz` | every term whose clitic-stripped key hashes to the bucket, with its page list inline when short |
| `lst<n>` | `l/<part>-<k>.gz` | a long page list, as varint gaps or as a bitmap over all pages |
| `txt<n>` | `t/<id>/<k>.gz` | pages `k·128 …` of a book: pages joined by `\f`, headings start with `\u0001`, footnotes follow a `\u001e` line |

Terms are normalised by `pipeline/normalize.mjs` (harakat, tatweel and letter variants folded; honorific ligatures such as ﷺ spelled out). The site ships the same file; a query that is normalised differently would miss.

## Run

```bash
node pipeline/build.mjs --src <dataset dir> --out out [--limit 400]   # --limit: a slice of every category
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node pipeline/deploy.mjs --out out
```

The GitHub Actions workflow *Build the library* downloads the dataset, builds on a 4-core runner and deploys.

## Source

[AuthenticIlm/Shamela4_Full_DB](https://huggingface.co/datasets/AuthenticIlm/Shamela4_Full_DB), a full extraction of al-Maktaba al-Shamela 4. The texts are classical works in the public domain; editions and apparatus belong to their editors and publishers. Hidden books are left out.
