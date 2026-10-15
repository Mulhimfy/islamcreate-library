"""Downloads the Shamela 4 extraction from Hugging Face.

    python3 pipeline/download.py <dir> [limit]

With a limit, only the metadata of every book comes down first; the
same selection build.mjs makes (the oldest authors of every category)
then decides whose pages to fetch.
"""
import json
import math
import os
import sys

from huggingface_hub import snapshot_download

REPO = "AuthenticIlm/Shamela4_Full_DB"
dest, limit = sys.argv[1], int(sys.argv[2] if len(sys.argv) > 2 else 0)

if not limit:
    snapshot_download(REPO, repo_type="dataset", local_dir=dest, max_workers=16)
    sys.exit(0)

snapshot_download(REPO, repo_type="dataset", local_dir=dest, max_workers=16,
                  allow_patterns=["*/book_metadata.json", "*/manifest.json", "*/toc.jsonl"])
per = max(1, math.ceil(limit / 40))
picked = []
for cat in sorted(os.listdir(dest)):
    if not cat[:2].isdigit():
        continue
    books = []
    for book in os.listdir(os.path.join(dest, cat)):
        try:
            meta = json.load(open(os.path.join(dest, cat, book, "book_metadata.json")))
        except FileNotFoundError:
            continue
        if meta.get("is_hidden"):
            continue
        d = meta.get("main_author_death_hijri") or 0
        books.append((d if 0 < d < 2000 else 9999, meta["book_id"], f"{cat}/{book}"))
    picked += [p for _, _, p in sorted(books)[:per]]
print(f"{len(picked)} books selected")
snapshot_download(REPO, repo_type="dataset", local_dir=dest, max_workers=16,
                  allow_patterns=[f"{p}/pages.jsonl" for p in picked])
