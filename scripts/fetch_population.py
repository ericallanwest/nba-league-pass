"""Write data/zcta_population.csv: total population per ZCTA from the Census
Bureau's American Community Survey 5-year estimates (table B01003).

Tries the newest ACS year first and falls back to older ones until one is published.
"""
import csv
import datetime
import os
import sys

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "zcta_population.csv")


def main():
    for year in range(datetime.date.today().year - 1, 2019, -1):
        r = requests.get(
            f"https://api.census.gov/data/{year}/acs/acs5",
            params={"get": "B01003_001E", "for": "zip code tabulation area:*"},
            timeout=120,
        )
        if r.status_code == 200:
            break
        print(f"ACS {year}: HTTP {r.status_code}", file=sys.stderr)
    else:
        raise SystemExit("no ACS 5-year data found")

    header, *rows = r.json()
    pop, zcta = header.index("B01003_001E"), header.index("zip code tabulation area")
    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["zip", "population", "acs_year"])
        for row in sorted(rows, key=lambda x: x[zcta]):
            w.writerow([row[zcta], row[pop], year])
    print(f"wrote {OUT}: {len(rows)} ZCTAs from ACS {year} 5-year")


if __name__ == "__main__":
    main()
