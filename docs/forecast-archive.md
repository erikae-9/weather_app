# Forecast archive

Every hour a GitHub Action saves what met.no, SMHI and the app's weighted forecast (**Viktad**)
predict for one location, 1 hour to 1 week ahead. Neither API serves old forecasts, so this is the
only way to later check them against measured values. The plan is to use readings from a local
thermometer, and to find out where each source does better or worse (time ahead, cloud, wind,
rain, season). That's also the input to step 4 in
[multi-source-forecast.md](multi-source-forecast.md#4-weights-from-data-next-step).

- Script: [`scripts/collect-forecasts.js`](../scripts/collect-forecasts.js)
- Workflow: [`.github/workflows/collect-forecasts.yml`](../.github/workflows/collect-forecasts.yml)
- Tests: `node --test tests/*.test.js`
- Data: the **`forecast-data`** branch, `forecasts/YYYY-MM.csv`

## Setup

1. Add two repository secrets (Settings → Secrets and variables → Actions → New repository
   secret): `FORECAST_LAT` and `FORECAST_LON`, in decimal degrees, for example `59.3293` and `18.0686`.
2. Merge to `main`. GitHub only runs scheduled workflows from the default branch.
3. In the Actions tab, open **Collect forecasts** and click **Run workflow** once. This creates the
   `forecast-data` branch. After that the workflow runs at :17 every hour.

**Privacy.** The repo is public. The coordinates are only stored as secrets: they aren't written
to the CSV, and GitHub masks them in the logs. The forecasts themselves are public on the
`forecast-data` branch. They're values for a model grid cell a few km wide, not for an exact address.

## What is saved

On each run the script fetches both sources and takes the hour it ran in, rounded down (12:17 → 12:00).
From there it saves the forecast for **1, 3, 6, 12, 24, 48, 72, 120 and 168 h** ahead.
After a while every hour has been forecast 1 h, 3 h, … 1 week in advance.

- Beyond about 2–3 days both sources use 6 h steps. So long time-frames are only saved when the
  target time falls on a step (00/06/12/18 UTC), about 4 per day instead of 24.
- `met` and `smhi` are each source on its own: the met.no row doesn't borrow SMHI's thunder.
  `blend` is what the app shows in **Viktad** mode, using the weights in `forecast-sources.js`
  at the time of the run. It's only saved when both sources answered.
- If one source fails, the other is still saved, and the run shows a warning.

One row per source, time ahead and run. All times are UTC.

| Column | Meaning |
|---|---|
| `valid_time` | the time the forecast is for |
| `lead_h` | hours ahead (from the hour the run was in) |
| `source` | `met`, `smhi` or `blend` |
| `fetched_at` | when it was fetched; the actual time ahead is `valid_time − fetched_at` |
| `issued_at` | the model run time according to the source (met.no `updated_at`, SMHI `referenceTime`) |
| `step_h` | length of the source's time step at `valid_time` (1, 2, 6 …); precipitation covers `[valid_time, valid_time + step_h)` |
| `temp`, `temp_p10`, `temp_p90` | temperature °C, with the 10th/90th percentiles (met.no and blend; SMHI has none) |
| `wind`, `wind_p10`, `wind_p90`, `gust` | m/s |
| `wind_dir` | degrees, direction the wind comes from |
| `humidity` | % |
| `pressure` | hPa at sea level |
| `cloud` | % (SMHI's octas converted) |
| `precip`, `precip_p10`, `precip_p90` | mm/h, mean rate over the step |
| `precip_prob`, `thunder` | % (thunder only from SMHI) |
| `symbol` | met.no `symbol_code` (SMHI's mapped to the same names) |

An empty field means the source has no value. If a run is started by hand in the same hour as a
scheduled one, there can be two rows for the same `valid_time`, `lead_h` and `source`. Keep the one
with the earliest `fetched_at`.

## Size

About 18 rows per run on average, ~430 rows and ~57 KB per day. That's roughly **1.7 MB per
monthly file and 20 MB per year**, and less as stored by git, since CSV compresses well and each
commit only appends lines. GitHub warns at 50 MB per file and recommends repos under 1 GB, so this
can run for many years.

The data is plain CSV on its own branch rather than a SQLite file in the repo. A database file
committed every hour would be saved as a full new copy each time, and couldn't be merged. When it's
time to analyse, build a database from the CSVs:

```sh
git fetch origin forecast-data
git worktree add ../forecast-data forecast-data
cd ../forecast-data
rm -f forecasts.db
for f in forecasts/*.csv; do
  # the first file creates the table from its header; later files skip theirs
  if [ -f forecasts.db ]; then skip='--skip 1'; else skip=''; fi
  sqlite3 forecasts.db ".import --csv $skip $f forecasts"
done
```

## Next steps

- **Measured values.** Export the thermometer CSV and save it, for example as
  `observations/thermometer.csv` on the same branch, or keep it locally. Readings should be in UTC,
  or the time zone should be known. Then match each reading with forecasts that have the same `valid_time`.
- **Evaluation.** Per `source` × `lead_h`, compute the bias (mean error), MAE and RMSE, plus how often
  the measured value falls inside `temp_p10`–`temp_p90` (it should be about 80 %). Then split by forecast
  cloud, wind, precipitation, day/night and season. The RMSE per source goes into `weightsFromErrors()`.
- Expect the thermometer to have a bias of its own (placement, sun, a wall nearby). It affects every source
  equally, so comparisons *between* sources and between times ahead still hold.

## Limitations

- GitHub often starts scheduled runs 5–30 min late, and occasionally skips one. `fetched_at` records
  the real time, so late runs are fine. A skipped run just leaves a gap.
- In public repos, GitHub disables scheduled workflows after 60 days without repository activity.
  It emails a warning first, and the workflow can be turned back on from the Actions tab.
