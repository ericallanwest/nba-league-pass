#!/usr/bin/env bash
# Used by the GitHub Actions workflows: commit the given data files, then pull
# the branch, rebuild the site JSON on top of whatever landed meanwhile, and push.
# Each workflow owns its own CSVs, so the rebase never conflicts; the JSON is
# always regenerated after pulling rather than merged.
# Usage: scripts/publish.sh "commit message" file...
set -uo pipefail
msg=$1; shift
branch=${GITHUB_REF_NAME:?}

[ $# -gt 0 ] && git add "$@"
git commit -q -m "$msg" || true
for attempt in 1 2 3 4 5; do
  git pull -q --rebase origin "$branch" || exit 1
  python scripts/build_site_data.py
  git add docs/data/blackouts.json
  rebuilt=0
  git commit -q -m "Rebuild site data" && rebuilt=1
  git push -q origin "HEAD:$branch" && exit 0
  # someone pushed in between; drop our rebuild and redo it on top of theirs
  [ $rebuilt = 1 ] && git reset -q --hard HEAD~1
  sleep $((attempt * 5))
done
exit 1
