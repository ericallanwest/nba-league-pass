"""Write data/zcta_places.csv: the USPS town, state and county for each ZCTA.

Uses the offline USPS ZIP data bundled in the `zipcodes` package (pip install zipcodes).
"""
import csv
import os

import zipcodes

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    with open(os.path.join(ROOT, "data", "zcta_centroids.csv"), newline="", encoding="utf-8") as f:
        zips = [r["zip"] for r in csv.DictReader(f)]
    with open(os.path.join(ROOT, "data", "zcta_places.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["zip", "town", "state", "county"])
        for z in zips:
            m = zipcodes.matching(z)
            w.writerow([z, m[0]["city"], m[0]["state"], m[0]["county"]] if m else [z, "", "", ""])


if __name__ == "__main__":
    main()
