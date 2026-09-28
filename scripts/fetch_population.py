"""Write data/zcta_population.csv: total population per ZCTA from the Census
Bureau's American Community Survey 5-year estimates (table B01003).

Reads the ACS table-based summary file (a bulk download, no API key needed),
trying the newest year first and falling back until one is published.
"""
import csv
import datetime
import io
import os
import sys

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "zcta_population.csv")
URL = ("https://www2.census.gov/programs-surveys/acs/summary_file/{y}/"
       "table-based-SF/data/5YRData/acsdt5y{y}-b01003.dat")
ZCTA_PREFIX = "860Z200US"  # GEO_ID prefix for 2020-vintage ZCTAs


def main():
    for year in range(datetime.date.today().year - 1, 2019, -1):
        r = requests.get(URL.format(y=year), timeout=300)
        if r.status_code == 200:
            break
        print(f"ACS {year}: HTTP {r.status_code}", file=sys.stderr)
    else:
        raise SystemExit("no ACS 5-year summary file found")

    rows = []
    for rec in csv.DictReader(io.StringIO(r.text), delimiter="|"):
        if rec["GEO_ID"].startswith(ZCTA_PREFIX):
            rows.append((rec["GEO_ID"][len(ZCTA_PREFIX):], rec["B01003_E001"]))
    if not rows:
        raise SystemExit(f"no ZCTA rows in {URL.format(y=year)}")

    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["zip", "population", "acs_year"])
        for z, pop in sorted(rows):
            w.writerow([z, pop, year])
    print(f"wrote {OUT}: {len(rows)} ZCTAs from ACS {year} 5-year")


if __name__ == "__main__":
    main()
