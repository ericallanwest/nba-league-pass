"""Describe the USPS ZIP codes that aren't Census ZCTAs: what each one is for
(PO boxes at a post office, or a single organization), writing
data/extra_zip_details.csv.

Sources:
- ZIP list and containing ZCTA: HRSA's ZIP Code to ZCTA Crosswalk
  (USPS ZIPs as of March 2023 via Esri; Census 2022 ZCTAs).
- ZIP class and names: USPS city/state data bundled in the `zipcodes`
  package. USPS lists single-organization ("unique") ZIPs under the
  organization's name as a non-preferred place name (20505 "Central
  Intelligence Agency"); names that are really place nicknames (also used on
  regular ZIPs in the same state, like "Schdy" or "NYC") are dropped.

Usage (needs openpyxl, requests and zipcodes):
    python scripts/extra_zip_details.py
"""
import collections
import csv
import io
import os

import openpyxl
import requests
import zipcodes

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(DATA, "extra_zip_details.csv")
HRSA = "https://data.hrsa.gov/DataDownload/GeoCareNavigator/ZIP%20Code%20to%20ZCTA%20Crosswalk.xlsx"
FIELDS = ["zip", "category", "names", "post_office", "state", "hrsa_type", "usps_class", "zcta"]



def main():
    wb = openpyxl.load_workbook(io.BytesIO(requests.get(HRSA, timeout=120).content), read_only=True)
    rows = wb["ZiptoZCTA"].iter_rows(values_only=True)
    header = next(rows)
    hrsa = [dict(zip(header, r)) for r in rows if r[0]]
    with open(os.path.join(DATA, "all_zctas.txt"), encoding="utf-8") as f:
        zctas = {line.strip() for line in f if line.strip()}
    extra = sorted((r for r in hrsa if str(r["ZIP_CODE"]).zfill(5) not in zctas), key=lambda r: str(r["ZIP_CODE"]).zfill(5))

    usps = {m["zip_code"]: m for m in zipcodes.list_all()}
    # place names and nicknames used by regular ZIPs, per state
    places = collections.defaultdict(set)
    for m in usps.values():
        if m["zip_code_type"] in ("STANDARD", "PO BOX"):
            places[m["state"]].update(n.lower() for n in [m["city"], *m["acceptable_cities"], *m["unacceptable_cities"]])

    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        for r in extra:
            z = str(r["ZIP_CODE"]).zfill(5)
            m = usps.get(z, {})
            cls = m.get("zip_code_type", "")
            names = [n for n in m.get("unacceptable_cities", []) if n.lower() not in places[r["STATE"]]]
            if cls == "PO BOX":
                category = "PO boxes"
            elif cls == "UNIQUE":
                generic = names and all("reply" in n.lower() or "brm" in n.lower() for n in names)
                category = "business reply mail" if generic else "organization" if names else "organization (unnamed)"
            elif cls == "MILITARY":
                category = "military"
            else:
                category = "delivery area" if r["ZIP_TYPE"] == "Zip Code Area" else "other"
            w.writerow({
                "zip": z, "category": category, "names": "; ".join(names), "post_office": r["PO_NAME"],
                "state": r["STATE"], "hrsa_type": r["ZIP_TYPE"], "usps_class": cls,
                "zcta": str(r["zcta"]).zfill(5) if r["zcta"] else "",
            })
    print(f"wrote {OUT}: {len(extra)} ZIPs")


if __name__ == "__main__":
    main()
