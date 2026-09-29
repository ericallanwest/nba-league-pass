"""List USPS ZIP codes that aren't in the Census ZCTA list the map uses, with
NBA.com's League Pass blackout teams for each, writing data/extra_zips.csv.

Source: HRSA's ZIP Code to ZCTA Crosswalk (U.S. Health Resources and Services
Administration; USPS ZIP Codes as of March 2023 via Esri, Census 2022 ZCTAs),
https://data.hrsa.gov/DataDownload/GeoCareNavigator/ZIP%20Code%20to%20ZCTA%20Crosswalk.xlsx

Most of these are PO-box or single-organization ("large volume customer") ZIPs,
which have no delivery area of their own, so the Census doesn't map them.
HRSA assigns each to the ZCTA it sits in; the output records that ZCTA's teams
too, so the two can be compared.

Usage (needs openpyxl and requests):
    python scripts/extra_zips.py [-d 0.4]

Appends as it goes and skips ZIPs already looked up, so an interrupted run
resumes where it stopped.
"""
import argparse
import csv
import io
import os
import sys
import time

import openpyxl
import requests

from nba_blackouts import lookup

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(DATA, "extra_zips.csv")
HRSA = "https://data.hrsa.gov/DataDownload/GeoCareNavigator/ZIP%20Code%20to%20ZCTA%20Crosswalk.xlsx"
FIELDS = ["zip", "po_name", "state", "zip_type", "zcta", "zcta_teams", "nba_teams", "status", "same_as_zcta"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-d", "--delay", type=float, default=0.4, help="seconds between NBA.com requests")
    args = ap.parse_args()

    wb = openpyxl.load_workbook(io.BytesIO(requests.get(HRSA, timeout=120).content), read_only=True)
    rows = wb["ZiptoZCTA"].iter_rows(values_only=True)
    header = next(rows)
    hrsa = [dict(zip(header, r)) for r in rows if r[0]]

    with open(os.path.join(DATA, "all_zctas.txt"), encoding="utf-8") as f:
        zctas = {line.strip() for line in f if line.strip()}
    with open(os.path.join(DATA, "nba_blackouts.csv"), newline="", encoding="utf-8") as f:
        zcta_teams = {r["zip"]: r["team_abbrs"] for r in csv.DictReader(f)}

    extra = sorted((r for r in hrsa if str(r["ZIP_CODE"]).zfill(5) not in zctas), key=lambda r: str(r["ZIP_CODE"]).zfill(5))
    done = set()
    if os.path.exists(OUT):
        with open(OUT, newline="", encoding="utf-8") as f:
            done = {r["zip"] for r in csv.DictReader(f) if r["status"] in ("ok", "http 404")}
    todo = [r for r in extra if str(r["ZIP_CODE"]).zfill(5) not in done]
    print(f"{len(hrsa)} USPS ZIPs, {len(extra)} not in the ZCTA list, {len(todo)} to look up", file=sys.stderr)

    new_file = not os.path.exists(OUT)
    session = requests.Session()
    session.headers["User-Agent"] = "Mozilla/5.0 (blackout-lookup script)"
    with open(OUT, "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        if new_file:
            w.writeheader()
        for i, r in enumerate(todo, 1):
            z = str(r["ZIP_CODE"]).zfill(5)
            zcta = str(r["zcta"]).zfill(5) if r["zcta"] else ""
            teams, status = lookup(session, z)
            got = "|".join(sorted(t.get("abbr", "") for t in teams))
            expected = "|".join(sorted(a for a in zcta_teams.get(zcta, "").split("|") if a))
            w.writerow({
                "zip": z, "po_name": r["PO_NAME"], "state": r["STATE"], "zip_type": r["ZIP_TYPE"],
                "zcta": zcta, "zcta_teams": expected, "nba_teams": got, "status": status,
                "same_as_zcta": "" if status != "ok" or not zcta else ("yes" if got == expected else "no"),
            })
            if i % 100 == 0:
                f.flush()
                print(f"  {i}/{len(todo)}", file=sys.stderr)
            time.sleep(args.delay)

    # one row per ZIP (a retry supersedes a failure), sorted
    with open(OUT, newline="", encoding="utf-8") as f:
        final = {r["zip"]: r for r in csv.DictReader(f)}
    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(final[z] for z in sorted(final))


if __name__ == "__main__":
    main()
