"""Look up NBA League Pass local blackout teams for a list of US ZIP codes.

Uses the same JSON endpoint the form on nba.com/league-pass-purchase calls.

Usage:
    python nba_blackouts.py zips.txt                 # one ZIP per line (or a CSV whose first column is the ZIP)
    python nba_blackouts.py zips.txt -o out.csv -d 0.5

The output CSV is appended to as it goes, so if the run is interrupted,
re-running the same command skips ZIPs already done.
"""
import argparse
import csv
import os
import re
import sys
import time

import requests

API = "https://content-api-prod.nba.com/public/1/leagues/nba/blackouts"
FIELDS = ["zip", "num_teams", "team_abbrs", "team_names", "team_ids", "status"]


def load_zips(path):
    # grab the first 5-digit token from each line
    zips = []
    with open(path, encoding="utf-8-sig") as f:
        for line in f:
            m = re.search(r"\b(\d{5})\b", line)
            if m:
                zips.append(m.group(1))
    return list(dict.fromkeys(zips))  # dedupe, keep order


def already_done(out_path):
    if not os.path.exists(out_path):
        return set()
    with open(out_path, newline="", encoding="utf-8") as f:
        # 404 = ZIP unknown to NBA.com (e.g. Puerto Rico); no point retrying
        return {r["zip"] for r in csv.DictReader(f) if r.get("status") in ("ok", "http 404")}


def lookup(session, z, retries=4):
    err = "retries exhausted"
    for attempt in range(retries):
        try:
            r = session.get(API, params={"zip": z}, timeout=20)
            if r.status_code == 200:
                return r.json().get("results", []), "ok"
            if r.status_code in (429, 500, 502, 503, 504):
                time.sleep(2 ** attempt * 5)
                continue
            return [], f"http {r.status_code}"
        except (requests.RequestException, ValueError) as e:
            time.sleep(2 ** attempt * 5)
            err = str(e)
    return [], f"error: {err}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("zipfile")
    ap.add_argument("-o", "--out", default="nba_blackouts.csv")
    ap.add_argument("-d", "--delay", type=float, default=0.5, help="seconds between requests")
    args = ap.parse_args()

    zips = load_zips(args.zipfile)
    done = already_done(args.out)
    todo = [z for z in zips if z not in done]
    print(f"{len(zips)} ZIPs, {len(done)} already done, {len(todo)} to go", file=sys.stderr)

    new_file = not os.path.exists(args.out)
    session = requests.Session()
    session.headers["User-Agent"] = "Mozilla/5.0 (blackout-lookup script)"

    with open(args.out, "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        if new_file:
            w.writeheader()
        for i, z in enumerate(todo, 1):
            teams, status = lookup(session, z)
            w.writerow({
                "zip": z,
                "num_teams": len(teams),
                "team_abbrs": "|".join(t.get("abbr", "") for t in teams),
                "team_names": "|".join(f"{t.get('city', '')} {t.get('name', '').title()}".strip() for t in teams),
                "team_ids": "|".join(str(t.get("teamId", "")) for t in teams),
                "status": status,
            })
            if i % 100 == 0:
                f.flush()
                print(f"  {i}/{len(todo)}", file=sys.stderr)
            time.sleep(args.delay)


if __name__ == "__main__":
    main()
