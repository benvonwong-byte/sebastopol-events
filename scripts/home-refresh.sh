#!/bin/zsh
# Reads every feed from a home connection and pushes the listings.
#
# Eventbrite and a few group sites refuse GitHub's servers. This script runs
# on a Mac each morning, before GitHub's own build, and pushes
# data/events.json. The push redeploys the site, and GitHub's run reuses
# these results for any source that blocks it (see "last good read" in
# scripts/fetch-events.mjs).
#
# It works in its own clone, so it never touches anyone's working copy.
# Install: scripts/install-home-refresh.sh. Logs: /tmp/sebastopol-refresh.*.log

set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

CLONE="${SEBASTOPOL_CLONE:-$HOME/.sebastopol-refresh/sebastopol-events}"
REPO_URL="https://github.com/benvonwong-byte/sebastopol-events.git"
DATA=(data/events.json data/geocache.json data/orgs.json docs/needs-a-feed.md)

echo "$(date '+%F %T') sebastopol refresh: start"

if [[ ! -d "$CLONE/.git" ]]; then
  mkdir -p "${CLONE:h}"
  git clone -q "$REPO_URL" "$CLONE"
fi
cd "$CLONE"
git fetch -q origin main
git reset -q --hard origin/main

node scripts/geocode-orgs.mjs
node scripts/fetch-events.mjs
node scripts/needs-feed.mjs

# Commit only the data files, on top of whatever main is now, so a script
# change pushed while the fetch ran is never undone. Two tries in case
# GitHub's own run pushes in between.
for attempt in 1 2; do
  git fetch -q origin main
  git reset -q --mixed origin/main
  git add "${DATA[@]}"
  if git diff --cached --quiet; then
    echo "$(date '+%F %T') sebastopol refresh: nothing changed"
    exit 0
  fi
  git commit -q -m "data: listings read from a home connection, $(date +%F)"
  if git push -q origin HEAD:main; then
    echo "$(date '+%F %T') sebastopol refresh: pushed $(git rev-parse --short HEAD)"
    exit 0
  fi
  echo "$(date '+%F %T') sebastopol refresh: push rejected, retrying"
done
echo "$(date '+%F %T') sebastopol refresh: gave up after two pushes" >&2
exit 1
