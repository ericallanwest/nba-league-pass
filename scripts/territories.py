"""Compute each team's 75-mile territory ring, writing data/territories.csv.

NBA territory rules measure 75 miles from the home city's limits, not from the
arena. The ring drawn on the map is the smallest circle holding every point
within 75 miles of those limits: the city's minimum enclosing circle, widened
by 75 miles.

City limits: Census Bureau TIGER/Line 2025 places (Toronto: OpenStreetMap, via
Nominatim). Pieces of a city more than ISLAND_MILES from its main body (San
Francisco's Farallon Islands) are left out, since they'd pull the ring out to sea.

Usage (needs pyshp, requests and shapely):
    python scripts/territories.py
"""
import csv
import io
import math
import os
import zipfile

import requests
import shapefile
import shapely
from shapely.geometry import shape
from shapely.ops import transform

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(DATA, "territories.csv")
TIGER = "https://www2.census.gov/geo/tiger/TIGER2025/PLACE/tl_2025_{fips}_place.zip"
NOMINATIM = "https://nominatim.openstreetmap.org/search"
TERRITORY_MILES = 75
ISLAND_MILES = 10

# team -> (state FIPS, TIGER place name); the city in the team's name
HOME = {
    "ATL": ("13", "Atlanta"), "BOS": ("25", "Boston"), "BKN": ("36", "New York"), "CHA": ("37", "Charlotte"),
    "CHI": ("17", "Chicago"), "CLE": ("39", "Cleveland"), "DAL": ("48", "Dallas"), "DEN": ("08", "Denver"),
    "DET": ("26", "Detroit"), "GSW": ("06", "San Francisco"), "HOU": ("48", "Houston"),
    "IND": ("18", "Indianapolis city (balance)"), "LAC": ("06", "Los Angeles"), "LAL": ("06", "Los Angeles"),
    "MEM": ("47", "Memphis"), "MIA": ("12", "Miami"), "MIL": ("55", "Milwaukee"), "MIN": ("27", "Minneapolis"),
    "NOP": ("22", "New Orleans"), "NYK": ("36", "New York"), "OKC": ("40", "Oklahoma City"), "ORL": ("12", "Orlando"),
    "PHI": ("42", "Philadelphia"), "PHX": ("04", "Phoenix"), "POR": ("41", "Portland"), "SAC": ("06", "Sacramento"),
    "SAS": ("48", "San Antonio"), "UTA": ("49", "Salt Lake City"), "WAS": ("11", "Washington"),
}
TORONTO = {"q": "Toronto, Ontario, Canada", "format": "geojson", "polygon_geojson": 1, "limit": 1, "featureType": "city"}


def local(lat0, lon0):
    """Equirectangular miles around (lat0, lon0), and back; accurate enough across one city."""
    k = 69.172 * math.cos(math.radians(lat0))
    return (lambda x, y: ((x - lon0) * k, (y - lat0) * 69.0)), (lambda x, y: (x / k + lon0, y / 69.0 + lat0))


def places(fips, cache={}):
    if fips not in cache:
        z = zipfile.ZipFile(io.BytesIO(requests.get(TIGER.format(fips=fips), timeout=300).content))
        base = next(n[:-4] for n in z.namelist() if n.endswith(".shp"))
        r = shapefile.Reader(shp=io.BytesIO(z.read(base + ".shp")), shx=io.BytesIO(z.read(base + ".shx")),
                             dbf=io.BytesIO(z.read(base + ".dbf")))
        cache[fips] = {rec["NAME"]: shape(sh.__geo_interface__) for sh, rec in zip(r.shapes(), r.records())}
    return cache[fips]


def ring(city):
    fwd, back = local(city.centroid.y, city.centroid.x)
    parts = [transform(fwd, p) for p in getattr(city, "geoms", [city])]
    main = max(parts, key=lambda p: p.area)
    kept = shapely.MultiPolygon([p for p in parts if p.distance(main) <= ISLAND_MILES])
    center = shapely.minimum_bounding_circle(kept).centroid
    lon, lat = back(center.x, center.y)
    return lat, lon, shapely.minimum_bounding_radius(kept)


def main():
    with open(os.path.join(DATA, "teams.csv"), newline="", encoding="utf-8") as f:
        abbrs = [t["abbr"] for t in csv.DictReader(f)]
    rows = []
    for abbr in abbrs:
        if abbr == "TOR":
            r = requests.get(NOMINATIM, params=TORONTO, headers={"User-Agent": "nba-league-pass map"}, timeout=60)
            city, name = shape(r.json()["features"][0]["geometry"]), "Toronto (OpenStreetMap)"
        else:
            fips, name = HOME[abbr]
            city = places(fips)[name]
        lat, lon, r = ring(city)
        rows.append({"abbr": abbr, "city": name, "lat": round(lat, 5), "lon": round(lon, 5),
                     "city_radius_mi": round(r, 1), "ring_radius_mi": round(r + TERRITORY_MILES, 1)})
        print(f"{abbr}: {name}, ring {r + TERRITORY_MILES:.1f} mi")
    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)


if __name__ == "__main__":
    main()
