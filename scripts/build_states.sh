#!/usr/bin/env bash
# Build docs/data/states.json: lower-48 state (and DC) boundaries from the
# Census Bureau's 2025 cartographic boundary file (1:500,000), the same vintage
# as the ZIP areas. Unlike TIGER/Line, these are clipped to the shoreline, so
# no lines run through the Great Lakes or coastal waters. Boundaries are
# simplified to 5% of their points and written as lines, each shared border
# once, to keep the file small.
# Needs Node (npx fetches mapshaper).
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -sSfL -o "$tmp/states.zip" https://www2.census.gov/geo/tiger/GENZ2025/shp/cb_2025_us_state_500k.zip
unzip -q "$tmp/states.zip" -d "$tmp"
npx --yes mapshaper@0.7 "$tmp/cb_2025_us_state_500k.shp" \
  -filter '["AK","HI","PR","VI","GU","MP","AS"].indexOf(STUSPS) == -1' \
  -simplify 5% keep-shapes \
  -lines \
  -filter-fields \
  -o docs/data/states.json format=geojson geojson-type=FeatureCollection precision=0.0001
