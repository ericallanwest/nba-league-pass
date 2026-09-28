# NBA League Pass Blackout Map

Interactive web map (GitHub Pages, served from `docs/`) showing which NBA teams are locally blacked out on NBA League Pass for each US ZIP code. Successor to the [Tableau Public version](https://public.tableau.com/app/profile/ericallanwest/viz/NBALeaguePassBlackoutMap/NBALeaguePassBlackoutMap).

## Data

- `data/all_zctas.txt`: 33,791 ZIP Code Tabulation Areas from the Census Bureau's 2025 TIGER/Line ZCTA file (`tl_2025_us_zcta520`).
- `data/zcta_centroids.csv`: internal point (lat/lon) for each ZCTA, from the same file.
- `data/teams.csv`: the 30 teams with NBA.com team IDs, arena locations (for the map markers) and map colors.
- `data/zcta_places.csv`: USPS town, state and county for each ZIP, from the offline data in the [`zipcodes`](https://pypi.org/project/zipcodes/) package (`python scripts/fetch_zcta_places.py`).
- `data/zcta_population.csv`: population per ZCTA from the Census Bureau's ACS 5-year estimates (table B01003), fetched by the **ZCTA population** workflow (`scripts/fetch_population.py`).
- `data/nba_blackouts.csv`: blackout teams per ZIP, from NBA.com's lookup endpoint
  `https://content-api-prod.nba.com/public/1/leagues/nba/blackouts?zip=XXXXX`
  (the endpoint behind the form at nba.com/league-pass-purchase).
  Multiple teams are `|`-separated. `status = http 404` means NBA.com has no record for that ZIP (e.g. all of Puerto Rico).

## Web map

`docs/` is a static site (MapLibre GL, Carto basemap, no build step) that loads `docs/data/blackouts.json`. Rebuild that JSON after the CSVs change:

```bash
python scripts/build_site_data.py
```

To publish, go to **Settings → Pages** and set the source to *Deploy from a branch*, branch `main`, folder `/docs`. To preview locally, run `python -m http.server -d docs` and open http://localhost:8000.

Views can be shared by URL: `#teams=NYK,BKN&zip=10001`.

## Refreshing the data

The **Blackout lookup** GitHub Actions workflow (`.github/workflows/blackout-lookup.yml`) runs the lookup below in chunks of 2,500 ZIPs, rebuilding the site JSON and committing after each chunk. It stops after about 5.5 hours, so re-run it (Actions → Blackout lookup → Run workflow) until the job summary reports 0 ZIPs remaining. Re-runs also retry any ZIPs that failed.

To run it locally instead:

```bash
python scripts/nba_blackouts.py data/all_zctas.txt -o data/nba_blackouts.csv -d 0.5
```

The script appends as it goes and skips ZIPs already in the output, so an interrupted run can be resumed by re-running the same command. At the end of each run the CSV is deduplicated to one row per ZIP (the latest lookup wins) and sorted. To do a fresh pull, write to a new output file.
