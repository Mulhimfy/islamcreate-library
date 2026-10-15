#!/usr/bin/env bash
# Downloads the Shamela 4 extraction with git: one pack for the small
# files and the LFS batch API for the large ones, instead of one Hub API
# call per file (anonymous calls are capped at 3,000 per five minutes and
# the dataset has 34,000 files).
#
#   pipeline/download.sh <dir> [limit]
#
# With a limit, every file but pages.jsonl comes down, then only the pages
# of the books build.mjs will pick (the oldest authors of each category).
set -euo pipefail
dest=$1
limit=${2:-0}
repo=https://huggingface.co/datasets/AuthenticIlm/Shamela4_Full_DB
git lfs install --skip-repo >/dev/null
if [ "$limit" = "0" ]; then
  git clone --depth 1 "$repo" "$dest"
else
  GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 "$repo" "$dest"
  node "$(dirname "$0")/select.mjs" "$dest" "$limit" > "$dest/.picked"
  echo "$(wc -l < "$dest/.picked") books picked"
  (cd "$dest" && git lfs pull --include="$(paste -sd, .picked)")
fi
rm -rf "$dest/.git"
