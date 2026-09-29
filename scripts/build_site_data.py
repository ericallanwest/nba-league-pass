"""Build the compact JSON the web map loads, from the CSVs in data/.

Usage:
    python scripts/build_site_data.py            # writes docs/data/blackouts.json

Output shape (arrays instead of objects to keep the file small):
    {
      "updated": "YYYY-MM-DD",
      "teams": [{"abbr", "city", "name", "arena", "lat", "lon", "color", "ring"}, ...],
      "population_source": "ACS 2024 5-year" | null,
      "zips": [[zip, lat, lon, team_idx_list | null, "Town, ST", population | null, drives | null], ...]
    }
ring is [lat, lon, miles]: the team's 75-mile territory circle (data/territories.csv,
see scripts/territories.py), absent if that file is missing.
drives is [[team_idx, minutes, miles | null], ...] for the closest arenas by
drive time (miles by road; null in older rows computed without distance),
[] if the ZIP can't be routed, and null if drive times haven't been computed.
team_idx_list is [] for a ZIP NBA.com says has no blackout, and null for a ZIP
with no data (not yet looked up, or unknown to NBA.com).

ZIPs in Alaska, Puerto Rico and the other territories are left off the map (no
ZIP there is blacked out: NBA.com reports no local teams for Alaska and doesn't
recognize the rest); "hidden" maps each such ZIP to its state so a ZIP search
can explain why it isn't shown. "po_only" lists PO-box-only ZIPs (USPS type
PO BOX) with no residents, so the popup can say why the population is 0.

USPS ZIPs that aren't Census ZCTAs (data/extra_zip_*.csv, see
scripts/extra_zip_details.py): delivery-area ZIPs newer than the ZCTAs are
added as points once data/extra_zip_areas.csv places them ("post_census" maps
each to its organization name, if any), with their parent ZCTA's point moved and
population reduced as that file says. Until then they're search-only like the rest. The rest (PO
boxes, single-organization ZIPs, ...) have no area, so they go in a separate
docs/data/extra_zips.json that the ZIP search loads on demand:
    {zip: [category, names, post office, state, containing ZIP, teams]}
where teams is a team_idx_list, -1 if NBA.com doesn't know the ZIP, or null
if it hasn't been looked up yet.
"""
import csv
import datetime
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(ROOT, "docs", "data", "blackouts.json")
EXTRA_OUT = os.path.join(ROOT, "docs", "data", "extra_zips.json")
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
    rings = {r["abbr"]: [float(r["lat"]), float(r["lon"]), float(r["ring_radius_mi"])]
             for r in read_csv("territories.csv", optional=True)}

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
    # PO-box-only ZIPs with no residents: their Census area is little more than the post office
    po_only = sorted(r["zip"] for r in place_rows if r.get("usps_type") == "PO BOX" and population.get(r["zip"]) == 0)

    drives = {}
    for r in read_csv("drive_times.csv", optional=True):
        parts = [d.split(":") for d in r["drives"].split("|") if d]
        drives[r["zip"]] = [[idx[p[0]], int(p[1]), int(p[2]) if len(p) > 2 else None] for p in parts]

    # USPS ZIPs that aren't Census ZCTAs: NBA.com's answer for each, and what they are
    extra_teams, extra_finished = {}, set()
    for r in read_csv("extra_zips.csv", optional=True):
        if r["status"] == "ok":
            extra_teams[r["zip"]] = [idx[a] for a in r["nba_teams"].split("|") if a]
            extra_finished.add(r["zip"])
        elif r["status"] == "http 404":
            extra_finished.add(r["zip"])
    details = {r["zip"]: r for r in read_csv("extra_zip_details.csv", optional=True)}
    areas = {r["zip"]: r for r in read_csv("extra_zip_areas.csv", optional=True)}
    moved = {r["parent"]: (float(r["parent_lat"]), float(r["parent_lon"])) for r in areas.values() if r["parent_lat"]}
    carved = {}  # parent ZCTA -> population now in its newer USPS ZIPs
    for r in areas.values():
        if r["population"]:
            carved[r["parent"]] = carved.get(r["parent"], 0) + int(float(r["population"]))

    zips = []
    for r in read_csv("zcta_centroids.csv"):
        z = r["zip"]
        if z in hidden:
            continue
        lat, lon = moved.get(z, (float(r["lat"]), float(r["lon"])))
        pop = population.get(z)
        if pop is not None and z in carved:
            pop = max(0, pop - carved[z])
        zips.append([z, round(lat, 4), round(lon, 4), blackouts.get(z), places.get(z, ""), pop, drives.get(z)])
    for z, r in sorted(areas.items()):
        d = details[z]
        zips.append([z, float(r["lat"]), float(r["lon"]), extra_teams.get(z), f"{d['post_office']}, {d['state']}",
                     int(float(r["population"])) if r["population"] else None, None])
        if z in extra_finished:
            finished.add(z)

    out = {
        "updated": datetime.date.today().isoformat(),
        "teams": [
            {k: t[k] for k in ("abbr", "city", "name", "arena", "color")}
            | {"lat": float(t["lat"]), "lon": float(t["lon"])}
            | ({"ring": rings[t["abbr"]]} if t["abbr"] in rings else {})
            for t in teams
        ],
        "population_source": f"ACS {pop_rows[0]['acs_year']} 5-year" if pop_rows else None,
        "zips": zips,
        "hidden": hidden,
        "po_only": po_only,
        "post_census": {z: details[z]["names"] for z in sorted(areas)},
        "lookup_remaining": sum(z[0] not in finished for z in zips),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))

    extra = {}
    for z, d in details.items():
        if z in areas or d["state"] in HIDDEN_STATES:
            continue
        teams = extra_teams.get(z, -1 if z in extra_finished else None)
        extra[z] = [d["category"], d["names"], d["post_office"], d["state"], d["zcta"], teams]
    if details:
        with open(EXTRA_OUT, "w", encoding="utf-8") as f:
            json.dump(extra, f, separators=(",", ":"))

    looked_up = sum(z[3] is not None for z in zips)
    print(f"wrote {OUT}: {len(zips)} ZIPs ({len(areas)} newer USPS areas), {looked_up} with blackout data; "
          f"{len(extra)} search-only ZIPs")


if __name__ == "__main__":
    main()
