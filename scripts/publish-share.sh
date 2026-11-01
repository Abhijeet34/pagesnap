#!/bin/sh
# Publishes share/ to the GitHub Pages repo that serves the receiver page,
# then waits until the live site serves exactly these bytes.
# Pushes with your own git credentials; the working clone is deleted on exit.
set -eu

repo=https://github.com/Abhijeet34/pagesnap-share.git
site=https://abhijeet34.github.io/pagesnap-share/
root=$(cd "$(dirname "$0")/.." && pwd)

# Publishing only committed files means every live version maps to a commit
# here; uncommitted edits would be silently left out, so they stop the run.
if [ -n "$(git -C "$root" status --porcelain -- share)" ]; then
  echo "share/ has uncommitted changes; commit them first." >&2
  exit 1
fi
rev=$(git -C "$root" rev-parse --short HEAD)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git clone -q --depth 1 "$repo" "$work/repo"
git -C "$root" archive HEAD share | tar -x -C "$work"

# README.md and .nojekyll belong to the Pages repo, not to share/.
rsync -a --delete --exclude .git --exclude README.md --exclude .nojekyll "$work/share/" "$work/repo/"
if [ -z "$(git -C "$work/repo" status --porcelain)" ]; then
  echo "Nothing to push; the repo already matches share/ at $rev."
else
  git -C "$work/repo" add -A
  git -C "$work/repo" commit -q -m "chore: publish receiver from pagesnap $rev"
  git -C "$work/repo" push -q origin HEAD
  echo "Pushed share/ at $rev."
fi

# Pages takes a minute or two to rebuild; the query string skips its CDN cache.
echo "Waiting for $site to serve it..."
tries=0
while :; do
  stale=
  for f in "$work"/share/*; do
    name=$(basename "$f")
    path=$name
    [ "$name" = index.html ] && path=
    live=$(curl -fsS "$site$path?v=$rev-$tries" | shasum -a 256 | cut -d' ' -f1) || live=
    [ "$live" = "$(shasum -a 256 < "$f" | cut -d' ' -f1)" ] || stale="$stale $name"
  done
  [ -z "$stale" ] && break
  tries=$((tries + 1))
  if [ "$tries" -ge 40 ]; then
    echo "Still stale after 10 minutes:$stale. Check the repo's Actions tab." >&2
    exit 1
  fi
  sleep 15
done
echo "Live: every file at $site matches share/."
