"""Compute drive times from each ZIP to its closest NBA arenas with the
OpenRouteService Matrix API, writing data/drive_times.csv.

For each ZIP, the 6 arenas closest in a straight line are routed, and the 5
shortest drives are kept, plus the drive to any team blacked out there that
isn't among them (NBA territories reach past the closest arenas, e.g. the
Grizzlies across Kentucky). A ZIP already routed but missing a blacked-out
team's drive gets just that team routed and added. The free plan's matrix quota is about 50 requests a
day (ORS reports "limit 50"), each up to 3,500 routes, so every request is packed
full: neighbouring ZIPs against the union of their candidate arenas. That fits
roughly 350 ZIPs per request, so all ~33,000 ZIPs take about two days from
scratch, and a daily run keeps up after that.

Usage (needs a free key from openrouteservice.org):
    ORS_API_KEY=... python scripts/drive_times.py [--max-requests 450]

Output rows: zip, drives. drives is "ABBR:minutes:miles|..." (driving time and
distance) sorted by drive time, or empty if ORS couldn't route the ZIP (e.g. no
road near its center point). Rows in the older "ABBR:minutes" form, without
distance, are routed again.
Appends as it goes and skips ZIPs already done, so a run cut short by the
daily quota resumes where it stopped.

To make the most of the quota:
- each ZIP's point is first snapped to the nearest road (ORS snap API, a
  separate quota), since a point ORS can't place on a road makes it reject the
  whole request;
- when a request is still rejected, the ZIP ORS names is dropped and the rest
  retried (one extra request), instead of splitting the batch in half repeatedly;
- ZIPs are ordered by their nearest arenas so each request's arena list stays short.
"""
import argparse
import csv
import math
import os
import re
import sys
import time

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(DATA, "drive_times.csv")
API = "https://api.openrouteservice.org/v2/matrix/driving-car"
SNAP_API = "https://api.openrouteservice.org/v2/snap/driving-car"

CANDIDATES = 6        # arenas routed per ZIP, by straight-line distance (one spare over KEEP)
KEEP = 5              # drives kept per ZIP
MAX_ROUTES = 3500     # ORS limit on sources x destinations per request
SNAP_CHUNK = 1000     # points per snap request; a failed one is retried in halves down to SNAP_MIN
SNAP_MIN = 125
SNAP_RADIUS = 5000    # meters to look for a road around a ZIP's point
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
        self.first = True

    def __call__(self, origins, arenas):
        """(minutes, miles) by road from each origin (lat, lon) to each arena, or None if unroutable.
        Raises Unroutable if ORS rejects the batch (typically one bad location)."""
        body = {
            "locations": [[lon, lat] for lat, lon in origins] + [a["route"] for a in arenas],
            "sources": list(range(len(origins))),
            "destinations": list(range(len(origins), len(origins) + len(arenas))),
            "metrics": ["duration", "distance"],
            "units": "mi",
        }
        for attempt in range(5):
            if self.left <= 0:
                raise Budget()
            self.left -= 1
            self.routes += len(origins) * len(arenas)
            r = self.session.post(API, json=body, timeout=120)
            time.sleep(self.pause)
            if r.status_code == 200:
                if self.first:  # how much of the daily quota is left, and when it resets
                    print(f"Matrix quota at the start: {describe(r)}", file=sys.stderr)
                    self.first = False
                d = r.json()
                return [[None if s is None or m is None else (round(s / 60), round(m)) for s, m in zip(srow, mrow)]
                        for srow, mrow in zip(d["durations"], d["distances"])]
            if "quota" in r.text.lower():  # daily quota, sent as 403 or 429
                raise Budget(describe(r))
            if "routable point" in r.text:  # a location with no road nearby, whatever the status code
                raise Unroutable(r.text[:300])
            if r.status_code == 429:  # per-minute rate limit
                time.sleep(60)
                continue
            if r.status_code >= 500:
                time.sleep(10 * (attempt + 1))
                continue
            if r.status_code in (401, 403):
                raise SystemExit(f"ORS rejected the API key: HTTP {r.status_code} {r.text[:200]}")
            raise Unroutable(r.text[:300])
        raise Unroutable("retries exhausted")

    def snap(self, points):
        """Each (lat, lon) moved to the nearest road within SNAP_RADIUS, or kept as is
        when ORS finds none. Best effort: any failure keeps the original points."""
        out = list(points)
        failed = []

        def attempt(start, n):
            chunk = points[start:start + n]
            body = {"locations": [[lon, lat] for lat, lon in chunk], "radius": SNAP_RADIUS}
            try:
                r = self.session.post(SNAP_API, json=body, timeout=120)
                time.sleep(self.pause)
                if "quota" in r.text.lower():
                    raise Budget()
                r.raise_for_status()
                snapped = r.json()["locations"]
            except (requests.RequestException, ValueError, KeyError) as e:
                if n > SNAP_MIN:  # retry in halves
                    attempt(start, n // 2)
                    attempt(start + n // 2, n - n // 2)
                else:
                    failed.append(f"{n} points ({e})")
                return
            for i, s in enumerate(snapped):
                if s and s.get("location"):
                    out[start + i] = (s["location"][1], s["location"][0])

        try:
            for start in range(0, len(points), SNAP_CHUNK):
                if len(failed) >= 5:  # the service is down; don't spend the run on it
                    break
                attempt(start, min(SNAP_CHUNK, len(points) - start))
        except Budget:
            print("::warning::ORS snap quota used up; routing the rest from the Census points", file=sys.stderr)
        if failed:
            print(f"::warning::Couldn't snap {len(failed)} chunks ({failed[0]}); those route from the Census points",
                  file=sys.stderr)
        return out


class Budget(Exception):
    pass


def describe(r):
    """Status, ORS's rate-limit headers (reset as UTC time) and the start of the body, for the log."""
    h = {k.lower(): v for k, v in r.headers.items()}
    parts = [f"HTTP {r.status_code}"]
    for k in ("x-ratelimit-limit", "x-ratelimit-remaining"):
        if k in h:
            parts.append(f"{k[12:]} {h[k]}")
    if h.get("x-ratelimit-reset", "").isdigit():
        t = int(h["x-ratelimit-reset"])
        reset = time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(t / 1000 if t > 1e11 else t))  # seconds or ms
        parts.append(f"resets {reset}")
    if r.status_code != 200:
        parts.append(r.text[:200].replace("\n", " "))
    return ", ".join(parts)


class Unroutable(Exception):
    def __init__(self, text):
        super().__init__(text)
        # ORS names the location it couldn't place: "... of specified coordinate 12: ..."
        m = re.search(r"coordinate (\d+)", text)
        self.index = int(m.group(1)) if m else None


def keep(drives, blacked):
    """The KEEP shortest drives, plus any longer one to a team blacked out at the ZIP,
    as the CSV's "ABBR:minutes:miles|..." text."""
    drives = sorted(drives)
    kept = drives[:KEEP] + [d for d in drives[KEEP:] if d[2] in blacked]
    return "|".join(f"{abbr}:{m}:{mi}" for m, mi, abbr in kept)


def unroutable(z):
    """The row for a ZIP ORS couldn't route: empty, or what it had before for a ZIP
    that was only getting a blacked-out team's drive added."""
    return z["zip"], keep(z["have"], z["blacked"]) if z["have"] else ""


def route(matrix, batch, teams):
    """Yield (zip, drives) for a batch of ZIPs. On a rejection, drop the ZIP ORS
    names and retry the rest; if it names none, halve the batch, so one
    unroutable ZIP doesn't sink its neighbours."""
    arena_idx = sorted({i for z in batch for i in z["cands"]})
    arenas = [teams[i] for i in arena_idx]
    try:
        minutes = matrix([(z["lat"], z["lon"]) for z in batch], arenas)
    except Unroutable as e:
        if len(batch) == 1:
            print(f"  {batch[0]['zip']}: unroutable ({e})", file=sys.stderr)
            yield unroutable(batch[0])
            return
        if e.index is not None and e.index < len(batch):
            print(f"  {batch[e.index]['zip']}: unroutable ({e})", file=sys.stderr)
            yield unroutable(batch[e.index])
            yield from route(matrix, batch[:e.index] + batch[e.index + 1:], teams)
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
        drives = z["have"] + [(*col[i], teams[i]["abbr"]) for i in z["cands"] if col[i] is not None]
        yield z["zip"], keep(drives, z["blacked"])


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
    """Fill each request with up to MAX_ROUTES routes: consecutive ZIPs (sorted so
    neighbours share candidate arenas) against the union of their candidates. The
    daily quota counts requests (about 50 a day on the free plan), not routes, so
    the extra pairs a shared arena list routes cost nothing."""
    batch, arenas = [], set()
    for z in todo:
        union = arenas | set(z["cands"])
        if batch and (len(batch) + 1) * len(union) > MAX_ROUTES:
            yield batch
            batch, union = [], set(z["cands"])
        batch.append(z)
        arenas = union
    if batch:
        yield batch


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-requests", type=int, default=450, help="stop after this many API calls (ORS stops the run itself at its daily quota)")
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
    idx = {t["abbr"]: i for i, t in enumerate(teams)}
    blackouts = {r["zip"]: {a for a in r["team_abbrs"].split("|") if a}
                 for r in read_csv("nba_blackouts.csv") if r["status"] == "ok"}
    done = {}  # zip -> its drives, as (minutes, miles, abbr)
    if os.path.exists(OUT):
        # rows without driving distance (the older ABBR:minutes form) get routed again
        for r in csv.DictReader(open(OUT, newline="", encoding="utf-8")):
            parts = [d.split(":") for d in r["drives"].split("|") if d]
            if all(len(p) == 3 for p in parts):
                done[r["zip"]] = [(int(m), int(mi), abbr) for abbr, m, mi in parts]

    todo, skipped, adding = [], [], 0
    for r in read_csv("zcta_centroids.csv"):
        z = r["zip"]
        blacked = blackouts.get(z, set())
        if z in done:
            have = done[z]
            # an unroutable ZIP (no drives) stays that way
            missing = blacked - {abbr for _, _, abbr in have} if have else set()
            if not missing:
                continue
            cands, adding = sorted(idx[a] for a in missing), adding + 1
        elif states.get(z) in NO_DRIVE_STATES:
            skipped.append(z)
            continue
        else:
            have = []
            lat, lon = float(r["lat"]), float(r["lon"])
            by_dist = sorted(range(len(teams)), key=lambda i: miles(lat, lon, teams[i]["lat"], teams[i]["lon"]))
            cands = by_dist[:CANDIDATES] + sorted(idx[a] for a in blacked if idx[a] not in by_dist[:CANDIDATES])
        todo.append({"zip": z, "lat": float(r["lat"]), "lon": float(r["lon"]), "cands": cands,
                     "have": have, "blacked": blacked})
    # by nearest arenas, so a request's ZIPs share most of their candidates and it
    # holds as many ZIPs as it can (this beats routing the populous ZIPs first now
    # that a day's 50 requests cover nearly every ZIP)
    todo.sort(key=lambda z: (z["cands"][:2], z["lat"]))
    print(f"{len(done) - adding} done, {len(skipped)} with no road route, {len(todo)} to route "
          f"({adding} of them only for a blacked-out team's drive)", file=sys.stderr)

    new_file = not os.path.exists(OUT)
    matrix = Matrix(key, args.max_requests, args.pause)
    if todo or args.check_arenas:
        try:
            check_arenas(matrix, teams)
        except Budget as e:
            print(f"::warning::ORS quota used up before the arena check; re-run tomorrow (ORS: {e})", file=sys.stderr)
            return
    if args.check_arenas:
        return
    snapped = matrix.snap([(z["lat"], z["lon"]) for z in todo])
    moved = 0
    for z, (lat, lon) in zip(todo, snapped):
        moved += (lat, lon) != (z["lat"], z["lon"])
        z["lat"], z["lon"] = lat, lon
    print(f"Snapped {moved} of {len(todo)} ZIP points to the nearest road", file=sys.stderr)
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
        except Budget as e:
            # not an error: progress is saved, and the next run resumes
            print(f"::warning::ORS quota or request budget used up after {matrix.routes} routes, "
                  f"with {len(todo) - n} ZIPs left; re-run tomorrow to continue"
                  + (f" (ORS: {e})" if str(e) else ""), file=sys.stderr)

    # tidy: one row per ZIP, sorted
    with open(OUT, newline="", encoding="utf-8") as f:
        rows = {r["zip"]: r for r in csv.DictReader(f)}
    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["zip", "drives"])
        w.writeheader()
        w.writerows(rows[z] for z in sorted(rows))


if __name__ == "__main__":
    main()
