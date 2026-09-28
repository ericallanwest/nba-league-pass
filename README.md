# NBA League Pass Blackout Map

Interactive web map (planned for GitHub Pages) showing which NBA teams are locally blacked out on NBA League Pass for each US ZIP code. Successor to the [Tableau Public version](https://public.tableau.com/app/profile/ericallanwest/viz/NBALeaguePassBlackoutMap/NBALeaguePassBlackoutMap).

## Data

- `data/all_zctas.txt`: 33,791 ZIP Code Tabulation Areas from the Census Bureau's 2025 TIGER/Line ZCTA file (`tl_2025_us_zcta520`).
- `data/zcta_centroids.csv`: internal point (lat/lon) for each ZCTA, from the same file.
- `data/nba_blackouts.csv`: blackout teams per ZIP, from NBA.com's lookup endpoint
  `https://content-api-prod.nba.com/public/1/leagues/nba/blackouts?zip=XXXXX`
  (the endpoint behind the form at nba.com/league-pass-purchase).
  Multiple teams are `|`-separated. `status = http 404` means NBA.com has no record for that ZIP (e.g. all of Puerto Rico).

## Refreshing the data

```bash
python scripts/nba_blackouts.py data/all_zctas.txt -o data/nba_blackouts.csv -d 0.5
```

The script appends as it goes and skips ZIPs already in the output, so an interrupted run can be resumed by re-running the same command. To do a fresh pull, write to a new output file.
