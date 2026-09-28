"""Compute drive times from each ZIP to its closest NBA arenas with the
OpenRouteService Matrix API, writing data/drive_times.csv.

For each ZIP, the 8 arenas closest in a straight line are routed, and the 5
shortest drives are kept. ZIPs are grouped by their set of candidate arenas so
requests don't route pairs nobody needs; the free plan's daily quota covers
roughly half the country, so a full run takes two days.

Usage (needs a free key from openrouteservice.org):
    ORS_API_KEY=... python scripts/drive_times.py [--max-requests 450]

Output rows: zip, drives. drives is "ABBR:minutes|..." sorted by drive time,
or empty if ORS couldn't route the ZIP (e.g. no road near its center point).
Appends as it goes and skips ZIPs already done, so a run cut short by the
daily quota resumes where it stopped.
"""
import argparse
import csv
import math
import os
import sys
import time

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(DATA, "drive_times.csv")
API = "https://api.openrouteservice.org/v2/matrix/driving-car"

CANDIDATES = 8        # arenas routed per ZIP, by straight-line distance
KEEP = 5              # drives kept per ZIP
MAX_ROUTES = 3500     # ORS limit on sources x destinations per request
# no road connection to any arena
NO_DRIVE_STATES = {"AK", "HI", "PR", "VI", "GU", "AS", "MP"}


def miles(lat1, lon1, lat2, lon2):
    r = math.pi / 180
    a = (math.sin((lat2 - lat1) * r / 2) ** 2
         + math.cos(lat1 * r) * math.cos(lat2 * r) * math.sin((lon2 - lon1) * r / 2) ** 2)
    return 3958.8 * 2 * math.asin(math.sqrt(a))


def read_csv(name):
    with open(os.path.join(DATA, name), newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


class Matrix:
    """ORS matrix calls, with pacing, retries and a request budget."""

    def __init__(self, key, max_requests, pause):
        self.session = requests.Session()
        self.session.headers["Authorization"] = key
        self.left = max_requests
        self.routes = 0
        self.pause = pause

    def __call__(self, origins, arenas):
        """Minutes from each origin (lat, lon) to each arena, or None if unroutable.
        Raises Unroutable if ORS rejects the batch (typically one bad location)."""
        body = {
            "locations": [[lon, lat] for lat, lon in origins] + [a["route"] for a in arenas],
            "sources": list(range(len(origins))),
            "destinations": list(range(len(origins), len(origins) + len(arenas))),
            "metrics": ["duration"],
        }
        for attempt in range(5):
            if self.left <= 0:
                raise Budget()
            self.left -= 1
            self.routes += len(origins) * len(arenas)
            r = self.session.post(API, json=body, timeout=120)
            time.sleep(self.pause)
            if r.status_code == 200:
                return [[None if s is None else round(s / 60) for s in row] for row in r.json()["durations"]]
            if "quota" in r.text.lower():  # daily quota, sent as 403 or 429
                raise Budget()
            if r.status_code == 429:  # per-minute rate limit
                time.sleep(60)
                continue
            if r.status_code >= 500:
                time.sleep(10 * (attempt + 1))
                continue
            if r.status_code in (401, 403):
                raise SystemExit(f"ORS rejected the API key: HTTP {r.status_code} {r.text[:200]}")
            raise Unroutable(r.text[:200])
        raise Unroutable("retries exhausted")


class Budget(Exception):
    pass


class Unroutable(Exception):
    pass


def route(matrix, batch, teams):
    """Yield (zip, drives) for a batch of ZIPs, halving the batch on a rejection
    so one unroutable ZIP doesn't sink its neighbours."""
    arena_idx = sorted({i for z in batch for i in z["cands"]})
    arenas = [teams[i] for i in arena_idx]
    try:
        minutes = matrix([(z["lat"], z["lon"]) for z in batch], arenas)
    except Unroutable as e:
        if len(batch) == 1:
            print(f"  {batch[0]['zip']}: unroutable ({e})", file=sys.stderr)
            yield batch[0]["zip"], ""
            return
        mid = len(batch) // 2
        yield from route(matrix, batch[:mid], teams)
        yield from route(matrix, batch[mid:], teams)
        return
    if len(batch) >= 20:
        for j, a in enumerate(arenas):
            if all(row[j] is None for row in minutes):
                print(f"::warning::No route from any of {len(batch)} ZIPs to {a['abbr']}; "
                      f"set route_lat/route_lon in data/teams.csv to a point on a road by the arena", file=sys.stderr)
    for z, row in zip(batch, minutes):
        col = {i: m for i, m in zip(arena_idx, row)}
        drives = sorted((col[i], teams[i]["abbr"]) for i in z["cands"] if col[i] is not None)[:KEEP]
        yield z["zip"], "|".join(f"{abbr}:{m}" for m, abbr in drives)


def check_arenas(matrix, teams):
    """Route every arena to every other one (one request). An arena that no other
    arena can reach, or be reached from, would silently drop out of every ZIP's
    results, so stop before routing anything."""
    try:
        minutes = matrix([(t["route"][1], t["route"][0]) for t in teams], teams)
    except Unroutable as e:
        raise SystemExit(f"::error::ORS rejected an arena point ({e}); "
                         "set route_lat/route_lon in data/teams.csv to a point on a public road by the arena")
    n = len(teams)
    bad = [t["abbr"] for i, t in enumerate(teams)
           if all(minutes[i][j] is None for j in range(n) if j != i)
           and all(minutes[j][i] is None for j in range(n) if j != i)]
    if bad:
        raise SystemExit(f"::error::No route to or from {', '.join(bad)}; set route_lat/route_lon in "
                         "data/teams.csv to a point on a public road by the arena")
    print(f"All {n} arenas reachable", file=sys.stderr)


def batches(todo):
    """Group ZIPs (already sorted by candidate arenas) so that
    ZIP count x distinct arenas stays within MAX_ROUTES."""
    batch, arenas = [], set()
    for z in todo:
        grown = arenas | set(z["cands"])
        if batch and (len(batch) + 1) * len(grown) > MAX_ROUTES:
            yield batch
            batch, grown = [], set(z["cands"])
        batch.append(z)
        arenas = grown
    if batch:
        yield batch


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-requests", type=int, default=450, help="stop after this many API calls (free plan: 500/day)")
    ap.add_argument("--pause", type=float, default=1.6, help="seconds between calls (free plan: 40/minute)")
    ap.add_argument("--check-arenas", action="store_true", help="only check that every arena is reachable")
    args = ap.parse_args()
    key = os.environ.get("ORS_API_KEY")
    if not key:
        raise SystemExit("set ORS_API_KEY")

    teams = [{**t, "lat": float(t["lat"]), "lon": float(t["lon"])} for t in read_csv("teams.csv")]
    for t in teams:
        # route to a point on a public road by the arena when the arena's own point doesn't snap to one
        t["route"] = [float(t["route_lon"]), float(t["route_lat"])] if t.get("route_lat") else [t["lon"], t["lat"]]
    states = {r["zip"]: r["state"] for r in read_csv("zcta_places.csv")}
    done = set()
    if os.path.exists(OUT):
        done = {r["zip"] for r in csv.DictReader(open(OUT, newline="", encoding="utf-8"))}

    todo, skipped = [], []
    for r in read_csv("zcta_centroids.csv"):
        if r["zip"] in done:
            continue
        if states.get(r["zip"]) in NO_DRIVE_STATES:
            skipped.append(r["zip"])
            continue
        lat, lon = float(r["lat"]), float(r["lon"])
        by_dist = sorted(range(len(teams)), key=lambda i: miles(lat, lon, teams[i]["lat"], teams[i]["lon"]))
        todo.append({"zip": r["zip"], "lat": lat, "lon": lon, "cands": by_dist[:CANDIDATES]})
    # ZIPs with the same candidate arenas share requests with no wasted routes
    todo.sort(key=lambda z: (sorted(z["cands"]), z["lat"]))
    print(f"{len(done)} done, {len(skipped)} with no road route, {len(todo)} to route", file=sys.stderr)

    new_file = not os.path.exists(OUT)
    matrix = Matrix(key, args.max_requests, args.pause)
    if todo or args.check_arenas:
        try:
            check_arenas(matrix, teams)
        except Budget:
            print("::warning::ORS quota used up before the arena check; re-run tomorrow", file=sys.stderr)
            return
    if args.check_arenas:
        return
    n = 0
    with open(OUT, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if new_file:
            w.writerow(["zip", "drives"])
        for z in skipped:
            w.writerow([z, ""])
        try:
            for batch in batches(todo):
                for row in route(matrix, batch, teams):
                    w.writerow(row)
                    n += 1
                f.flush()
                print(f"  {n}/{len(todo)} routed, {matrix.routes} routes used, {matrix.left} requests left", file=sys.stderr)
        except Budget:
            # not an error: progress is saved, and the next run resumes
            print(f"::warning::ORS quota or request budget used up after {matrix.routes} routes, "
                  f"with {len(todo) - n} ZIPs left; re-run tomorrow to continue", file=sys.stderr)

    # tidy: one row per ZIP, sorted
    with open(OUT, newline="", encoding="utf-8") as f:
        rows = {r["zip"]: r for r in csv.DictReader(f)}
    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["zip", "drives"])
        w.writeheader()
        w.writerows(rows[z] for z in sorted(rows))


if __name__ == "__main__":
    main()
