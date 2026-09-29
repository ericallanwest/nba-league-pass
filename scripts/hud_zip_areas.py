"""Place the USPS delivery-area ZIPs that postdate the Census ZCTAs, using
public-domain data only, writing data/extra_zip_areas.csv.

These ZIPs ("delivery area" in data/extra_zip_details.csv) were carved out of
an existing ZCTA (their "parent"). For each one:
- location: the average of the Census tract internal points it covers,
  weighted by its share of addresses in each tract (HUD's USPS ZIP crosswalk,
  ZIP-to-tract; tract points from the Census Gazetteer);
- population: sum over those tracts of the tract's ACS population times the
  share of the tract's residential addresses that are in the ZIP (HUD's
  tract-to-ZIP crosswalk), to be subtracted from the parent's population;
- if the parent's Census point is within 1 mile of the new ZIP's point, the
  parent's point moves to its own HUD-weighted location (its current USPS
  extent), so the two don't sit on top of each other.

Usage (needs a HUD USPS Crosswalk API token, https://www.huduser.gov/portal/dataset/uspszip-api.html):
    HUD_API_TOKEN=... python scripts/hud_zip_areas.py
"""
import csv
import datetime
import io
import math
import os
import sys
import time
import zipfile

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(DATA, "extra_zip_areas.csv")
HUD = "https://www.huduser.gov/hudapi/public/usps"
GAZETTEER = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_Gaz_tracts_national.zip"
ACS = ("https://www2.census.gov/programs-surveys/acs/summary_file/{y}/"
       "table-based-SF/data/5YRData/acsdt5y{y}-b01003.dat")
HIDDEN_STATES = {"AK", "PR", "VI", "GU", "MP", "AS"}
FIELDS = ["zip", "parent", "lat", "lon", "population", "parent_lat", "parent_lon"]
NEAR_MILES = 1.0


def miles(lat1, lon1, lat2, lon2):
    r = math.pi / 180
    a = (math.sin((lat2 - lat1) * r / 2) ** 2
         + math.cos(lat1 * r) * math.cos(lat2 * r) * math.sin((lon2 - lon1) * r / 2) ** 2)
    return 3958.8 * 2 * math.asin(math.sqrt(a))


class Hud:
    def __init__(self, token):
        self.session = requests.Session()
        self.session.headers["Authorization"] = f"Bearer {token}"
        self.cache = {}

    def results(self, kind, query):
        """HUD crosswalk rows: kind 1 = ZIP -> tracts, kind 6 = tract -> ZIPs."""
        key = (kind, query)
        if key not in self.cache:
            for attempt in range(5):
                r = self.session.get(HUD, params={"type": kind, "query": query}, timeout=60)
                if r.status_code == 429 or r.status_code >= 500:
                    time.sleep(10 * (attempt + 1))
                    continue
                if r.status_code in (401, 403):
                    raise SystemExit(f"HUD rejected the token: HTTP {r.status_code} {r.text[:200]}")
                if r.status_code == 404:  # not in the crosswalk
                    self.cache[key] = []
                    break
                r.raise_for_status()
                self.cache[key] = r.json().get("data", {}).get("results", [])
                break
            else:
                raise SystemExit(f"HUD kept failing for type {kind} query {query}")
            time.sleep(0.7)
        return self.cache[key]


def tract_points():
    z = zipfile.ZipFile(io.BytesIO(requests.get(GAZETTEER, timeout=300).content))
    text = z.read(z.namelist()[0]).decode("utf-8")
    rows = csv.DictReader(io.StringIO(text), delimiter="\t")
    return {r["GEOID"]: (float(r["INTPTLAT"]), float(r[next(k for k in r if k.strip() == "INTPTLONG")]))
            for r in rows}


def tract_population():
    for year in range(datetime.date.today().year - 1, 2019, -1):
        r = requests.get(ACS.format(y=year), timeout=600)
        if r.status_code == 200:
            prefix = "1400000US"
            pops = {rec["GEO_ID"][len(prefix):]: int(rec["B01003_E001"])
                    for rec in csv.DictReader(io.StringIO(r.text), delimiter="|")
                    if rec["GEO_ID"].startswith(prefix) and rec["B01003_E001"].lstrip("-").isdigit()}
            print(f"ACS {year}: {len(pops)} tract populations", file=sys.stderr)
            return pops
    raise SystemExit("no ACS tract populations found")


def weighted_point(rows, points):
    """Tract-point average weighted by the ZIP's share of addresses in each tract."""
    pts = [(points[r["geoid"]], float(r.get("tot_ratio") or 0)) for r in rows if r.get("geoid") in points]
    if not pts:
        return None
    total = sum(w for _, w in pts) or len(pts)
    weight = (lambda w: w / total) if sum(w for _, w in pts) else (lambda w: 1 / total)
    return (sum(p[0] * weight(w) for p, w in pts), sum(p[1] * weight(w) for p, w in pts))


def main():
    token = os.environ.get("HUD_API_TOKEN")
    if not token:
        raise SystemExit("set HUD_API_TOKEN")
    hud = Hud(token)

    with open(os.path.join(DATA, "extra_zip_details.csv"), newline="", encoding="utf-8") as f:
        areas = [r for r in csv.DictReader(f)
                 if r["category"] == "delivery area" or r["hrsa_type"] == "Zip Code Area"]
    areas = [r for r in areas if r["state"] not in HIDDEN_STATES and r["zcta"]]
    with open(os.path.join(DATA, "zcta_centroids.csv"), newline="", encoding="utf-8") as f:
        census = {r["zip"]: (float(r["lat"]), float(r["lon"])) for r in csv.DictReader(f)}

    points, pops = tract_points(), tract_population()
    rows, skipped = [], []
    for a in areas:
        z, parent = a["zip"], a["zcta"]
        tracts = hud.results(1, z)
        where = weighted_point(tracts, points)
        if where is None:
            skipped.append(z)
            continue
        # people in the ZIP: each tract's population times the tract's residential share in this ZIP
        people = 0.0
        for t in tracts:
            # in tract-to-ZIP results the ZIP is in "geoid" (the output geography)
            share = next((float(x.get("res_ratio") or 0) for x in hud.results(6, t["geoid"])
                          if str(x.get("zip") or x.get("geoid") or "").zfill(5) == z), 0.0)
            people += pops.get(t["geoid"], 0) * share
        row = {"zip": z, "parent": parent, "lat": round(where[0], 5), "lon": round(where[1], 5),
               "population": round(people), "parent_lat": "", "parent_lon": ""}
        if parent in census and miles(*census[parent], *where) < NEAR_MILES:
            moved = weighted_point(hud.results(1, parent), points)
            if moved and miles(*moved, *where) >= NEAR_MILES:
                row["parent_lat"], row["parent_lon"] = round(moved[0], 5), round(moved[1], 5)
        rows.append(row)
        print(f"  {z} ({a['post_office']}, {a['state']}): {len(tracts)} tracts, pop {row['population']}"
              + (" , parent moved" if row["parent_lat"] else ""), file=sys.stderr)

    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(sorted(rows, key=lambda r: r["zip"]))
    print(f"wrote {OUT}: {len(rows)} ZIPs placed, {sum(1 for r in rows if r['parent_lat'])} parent points moved; "
          f"no HUD data for {len(skipped)}: {' '.join(skipped)}", file=sys.stderr)


if __name__ == "__main__":
    main()
