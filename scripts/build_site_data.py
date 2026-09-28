"""Build the compact JSON the web map loads, from the CSVs in data/.

Usage:
    python scripts/build_site_data.py            # writes docs/data/blackouts.json

Output shape (arrays instead of objects to keep the file small):
    {
      "updated": "YYYY-MM-DD",
      "teams": [{"abbr", "city", "name", "arena", "lat", "lon", "color"}, ...],
      "zips": [[zip, lat, lon, team_idx_list | null], ...]
    }
team_idx_list is [] for a ZIP NBA.com says has no blackout, and null for a ZIP
with no data (not yet looked up, or unknown to NBA.com, e.g. Puerto Rico).
"""
import csv
import datetime
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(ROOT, "docs", "data", "blackouts.json")


def read_csv(name):
    with open(os.path.join(DATA, name), newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def main():
    teams = read_csv("teams.csv")
    idx = {t["abbr"]: i for i, t in enumerate(teams)}

    blackouts = {}
    for r in read_csv("nba_blackouts.csv"):
        if r["status"] == "ok":
            abbrs = [a for a in r["team_abbrs"].split("|") if a]
            unknown = [a for a in abbrs if a not in idx]
            if unknown:
                raise SystemExit(f"ZIP {r['zip']}: team(s) {unknown} missing from data/teams.csv")
            blackouts[r["zip"]] = [idx[a] for a in abbrs]

    zips = []
    for r in read_csv("zcta_centroids.csv"):
        zips.append([r["zip"], round(float(r["lat"]), 4), round(float(r["lon"]), 4), blackouts.get(r["zip"])])

    out = {
        "updated": datetime.date.today().isoformat(),
        "teams": [
            {k: t[k] for k in ("abbr", "city", "name", "arena", "color")}
            | {"lat": float(t["lat"]), "lon": float(t["lon"])}
            for t in teams
        ],
        "zips": zips,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))

    looked_up = sum(z[3] is not None for z in zips)
    print(f"wrote {OUT}: {len(zips)} ZIPs, {looked_up} with blackout data")


if __name__ == "__main__":
    main()
