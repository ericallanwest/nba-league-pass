"""Fetch the NBA regular-season schedule and each game's national broadcasters.

Writes data/schedule.csv, one row per regular-season game:
  game_id, date (ET), time (ET), away, home, label, national, national_blackout,
  nba_tv, home_tv, away_tv

League Pass blacks out live games on ESPN, ABC, NBC, Peacock and Amazon Prime
Video everywhere; NBA TV games stay watchable (subject to local blackouts), so
national_blackout is 1 when any national broadcaster other than NBA TV is listed.

Runs weekly in GitHub Actions (.github/workflows/schedule.yml) to pick up
national TV changes and the NBA Cup games scheduled after the group stage.
"""
import csv
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

import requests

# cdn.nba.com answers 403 to GitHub's runners too; the same file is mirrored on
# NBA's public S3 bucket, which doesn't.
URLS = ["https://nba-prod-us-east-1-mediaops-stats.s3.amazonaws.com/NBA/staticData/scheduleLeagueV2.json",
        "https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json"]
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "schedule.csv"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept": "application/json",
    "Referer": "https://www.nba.com/",
    "Origin": "https://www.nba.com",
}

# Canonical names for the networks League Pass blacks out nationally.
BLACKOUT = [("prime", "Prime Video"), ("amazon", "Prime Video"),
            ("peacock", "Peacock"), ("nbc sports network", "NBCSN"),
            ("espn", "ESPN"), ("abc", "ABC"), ("nbc", "NBC"),
            ("telemundo", "Telemundo")]  # NBCSN and Telemundo simulcast Peacock games


def canonical(name):
    low = name.lower()
    if "nba tv" in low or low == "nbatv":
        return "NBA TV"
    for key, canon in BLACKOUT:
        if key in low:
            return canon
    return name


def names(game, *keys, scope=None):
    b = game.get("broadcasters") or {}
    out = []
    for k in keys:
        for x in b.get(k) or []:
            if scope and x.get("broadcasterScope") not in (None, "", scope):
                continue
            n = (x.get("broadcasterDisplay") or x.get("broadcasterAbbreviation") or "").strip()
            if n and "league pass" not in n.lower() and n not in out:
                out.append(n)
    return out


def main():
    for url in URLS:
        r = requests.get(url, headers=HEADERS, timeout=60)
        print(r.status_code, url)
        if r.ok:
            break
    r.raise_for_status()
    sched = r.json()["leagueSchedule"]
    print("season", sched.get("seasonYear"), "league", sched.get("leagueId"))

    teams = [row["abbr"] for row in csv.DictReader(open(ROOT / "data" / "teams.csv"))]
    rows, raw_national, sample = [], Counter(), None
    for day in sched["gameDates"]:
        for g in day["games"]:
            gid = g["gameId"]
            if not gid.startswith("002"):   # 001 preseason, 004 playoffs, 006 Cup final
                continue
            if sample is None and (g.get("broadcasters") or {}).get("nationalBroadcasters"):
                sample = g
            national = names(g, "nationalBroadcasters", "nationalOttBroadcasters", scope="natl")
            raw_national.update(national)
            canon = []
            for n in map(canonical, national):
                if n not in canon:
                    canon.append(n)
            et = g.get("gameDateTimeEst") or g.get("gameDateEst") or ""
            rows.append({
                "game_id": gid,
                "date": et[:10],
                "time": et[11:16] if g.get("gameStatusText", "").upper() != "TBD" else "",
                "away": g["awayTeam"].get("teamTricode") or "TBD",
                "home": g["homeTeam"].get("teamTricode") or "TBD",
                "label": " ".join(x for x in (g.get("gameLabel"), g.get("gameSubLabel")) if x),
                "national": ";".join(canon),
                "national_blackout": int(any(n != "NBA TV" for n in canon)),
                "nba_tv": int("NBA TV" in canon),
                "home_tv": ";".join(names(g, "homeTvBroadcasters", "homeOttBroadcasters")),
                "away_tv": ";".join(names(g, "awayTvBroadcasters", "awayOttBroadcasters")),
            })

    rows.sort(key=lambda r: (r["date"], r["time"], r["game_id"]))
    with open(OUT, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)

    # Log the structure and counts so the run output can be checked.
    if sample:
        print("\nbroadcaster keys:", sorted(sample["broadcasters"]))
        print("sample national entry:", json.dumps(sample["broadcasters"]["nationalBroadcasters"][0]))
    print(f"\n{len(rows)} regular-season games -> {OUT}")
    print("\nnational broadcaster names as listed:")
    for n, c in raw_national.most_common():
        print(f"  {c:5d}  {n}  ->  {canonical(n)}")
    unknown = [n for n in raw_national if canonical(n) == n and n not in {c for _, c in BLACKOUT} | {"NBA TV"}]
    if unknown:
        print("::warning::unrecognized national broadcasters (counted as blackouts):", unknown)

    games, nat, tv, tbd = Counter(), Counter(), Counter(), 0
    by_net = defaultdict(Counter)
    for r in rows:
        if "TBD" in (r["away"], r["home"]) or r["away"] not in teams or r["home"] not in teams:
            tbd += 1
        for t in (r["away"], r["home"]):
            games[t] += 1
            nat[t] += r["national_blackout"]
            tv[t] += r["nba_tv"]
            for n in r["national"].split(";"):
                if n:
                    by_net[t][n] += 1
    print(f"\ngames with a TBD/unknown team: {tbd}")
    nets = ["ESPN", "ABC", "NBC", "Peacock", "Prime Video", "NBA TV"]
    print("\nteam  games  natl-blackout  " + "  ".join(f"{n:>7}" for n in nets))
    for t in sorted(teams, key=lambda t: -nat[t]):
        print(f"{t:4}  {games[t]:5d}  {nat[t]:13d}  " + "  ".join(f"{by_net[t][n]:7d}" for n in nets))
    off = {t: games[t] for t in teams if games[t] != 82}
    if off:
        print("::warning::teams without 82 games (Cup knockout slots may still be TBD):", off)
    if len(rows) != 1230:
        print(f"::warning::expected 1230 regular-season games, got {len(rows)}")


if __name__ == "__main__":
    sys.exit(main())
