"""Build the compact JSON the web map loads, from the CSVs in data/.

Usage:
    python scripts/build_site_data.py            # writes docs/data/blackouts.json

Output shape (arrays instead of objects to keep the file small):
    {
      "updated": "YYYY-MM-DD",
      "teams": [{"abbr", "city", "name", "arena", "lat", "lon", "color"}, ...],
      "population_source": "ACS 2024 5-year" | null,
      "zips": [[zip, lat, lon, team_idx_list | null, "Town, ST", population | null, drives | null], ...]
    }
drives is [[team_idx, minutes, miles | null], ...] for the closest arenas by
drive time (miles by road; null in older rows computed without distance),
[] if the ZIP can't be routed, and null if drive times haven't been computed.
team_idx_list is [] for a ZIP NBA.com says has no blackout, and null for a ZIP
with no data (not yet looked up, or unknown to NBA.com).

ZIPs in Alaska, Puerto Rico and the other territories are left off the map (no
ZIP there is blacked out: NBA.com reports no local teams for Alaska and doesn't
recognize the rest); "hidden" maps each such ZIP to its state so a ZIP search
can explain why it isn't shown.
"""
import csv
import datetime
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(ROOT, "docs", "data", "blackouts.json")
HIDDEN_STATES = {"AK", "PR", "VI", "GU", "MP", "AS"}


def read_csv(name, optional=False):
    path = os.path.join(DATA, name)
    if optional and not os.path.exists(path):
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def main():
    teams = read_csv("teams.csv")
    idx = {t["abbr"]: i for i, t in enumerate(teams)}

    blackouts, finished = {}, set()
    for r in read_csv("nba_blackouts.csv"):
        # ok, or 404 = ZIP unknown to NBA.com; anything else still needs a lookup
        if r["status"] in ("ok", "http 404"):
            finished.add(r["zip"])
        if r["status"] == "ok":
            abbrs = [a for a in r["team_abbrs"].split("|") if a]
            unknown = [a for a in abbrs if a not in idx]
            if unknown:
                raise SystemExit(f"ZIP {r['zip']}: team(s) {unknown} missing from data/teams.csv")
            blackouts[r["zip"]] = [idx[a] for a in abbrs]

    place_rows = read_csv("zcta_places.csv", optional=True)
    places = {r["zip"]: f"{r['town']}, {r['state']}" for r in place_rows if r["town"]}
    hidden = {r["zip"]: r["state"] for r in place_rows if r["state"] in HIDDEN_STATES}
    shown_blackouts = [z for z in hidden if blackouts.get(z)]
    if shown_blackouts:
        raise SystemExit(f"ZIPs {shown_blackouts[:5]} in hidden states are blacked out; revisit HIDDEN_STATES")
    pop_rows = read_csv("zcta_population.csv", optional=True)
    # the Census API uses negative sentinel values for "no estimate"
    population = {r["zip"]: int(r["population"]) for r in pop_rows if r["population"].lstrip("-").isdigit() and int(r["population"]) >= 0}

    drives = {}
    for r in read_csv("drive_times.csv", optional=True):
        parts = [d.split(":") for d in r["drives"].split("|") if d]
        drives[r["zip"]] = [[idx[p[0]], int(p[1]), int(p[2]) if len(p) > 2 else None] for p in parts]

    zips = []
    for r in read_csv("zcta_centroids.csv"):
        z = r["zip"]
        if z in hidden:
            continue
        zips.append([z, round(float(r["lat"]), 4), round(float(r["lon"]), 4), blackouts.get(z), places.get(z, ""), population.get(z), drives.get(z)])

    out = {
        "updated": datetime.date.today().isoformat(),
        "teams": [
            {k: t[k] for k in ("abbr", "city", "name", "arena", "color")}
            | {"lat": float(t["lat"]), "lon": float(t["lon"])}
            for t in teams
        ],
        "population_source": f"ACS {pop_rows[0]['acs_year']} 5-year" if pop_rows else None,
        "zips": zips,
        "hidden": hidden,
        "lookup_remaining": sum(z[0] not in finished for z in zips),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))

    looked_up = sum(z[3] is not None for z in zips)
    print(f"wrote {OUT}: {len(zips)} ZIPs, {looked_up} with blackout data")


if __name__ == "__main__":
    main()
