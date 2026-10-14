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
- Data: the **`forecast-data`** branch, `forecasts/YYYY/lead_NNNh.csv`

## Setup

1. Add two repository secrets (Settings → Secrets and variables → Actions → New repository
   secret): `FORECAST_LAT` and `FORECAST_LON`, in decimal degrees, for example `59.3293` and `18.0686`.
2. Merge to `main`. GitHub only runs scheduled workflows from the default branch.
3. In the Actions tab, open **Collect forecasts** and click **Run workflow** once. This creates the
   `forecast-data` branch. After that the workflow runs every 10 minutes (:02, :12, … :52), and
   the first successful run of each hour saves that hour.

**Privacy.** The repo is public. The coordinates are only stored as secrets: they aren't written
to the CSV, and GitHub masks them in the logs. The forecasts themselves are public on the
`forecast-data` branch. They're values for a model grid cell a few km wide, not for an exact address.

## What is saved

There's one file per time-frame and year: `forecasts/2026/lead_001h.csv`, `lead_003h.csv`, `lead_006h.csv`,
`lead_012h.csv`, `lead_024h.csv`, `lead_048h.csv`, `lead_072h.csv`, `lead_120h.csv` and `lead_168h.csv`.
Each file is a continuous hourly time series, sorted by `valid_time`, with **three rows per hour**:
`met`, `smhi` and `blend`. For example, `lead_024h.csv` holds every hour as it was forecast
24 hours earlier.

Each run fetches both sources and takes the hour it ran in, rounded down (12:02 → 12:00).
From there it adds one hour to each file: 13:00 to `lead_001h`, 12:00 the next day to `lead_024h`,
12:00 a week later to `lead_168h`, and so on. Only the first successful run of each hour is saved;
later runs in the same hour find nothing new and don't commit. So "1 h ahead" is usually 50–60
minutes, and less if GitHub dropped the hour's first runs. `fetched_at` has the exact time.

- **Interpolated hours.** Beyond about 2–3 days both sources use 6 h steps, and SMHI sometimes uses
  2 h steps earlier. Hours between two steps are filled in so every file stays hourly, and
  get `interpolated = 1`:
  - temperature, wind, cloud and the other instant values are a straight line between the two steps;
  - precipitation is the step's total spread evenly over its hours;
  - the precipitation chance and the symbol are the step's own.
  Interpolated hours miss peaks between the steps (for example the afternoon maximum), so they look
  smoother than reality. For a strict evaluation, use only `interpolated = 0`.
- **The sources.** `met` and `smhi` are each source on its own: the met.no row doesn't borrow
  SMHI's thunder. `blend` is what the app shows in **Viktad** mode, using the weights in
  `forecast-sources.js` at the time of the run. It's only saved when both sources answered, and it
  counts as interpolated if either source was.
- **Missing sources.** If one source fails, the other is still saved, and the run shows a warning.
- **No duplicates.** If a run is started by hand in the same hour as a scheduled one, the later
  run's rows for that hour are skipped, so the earliest fetch is kept.

All times are UTC.

| Column | Meaning |
|---|---|
| `valid_time` | the hour the forecast is for |
| `source` | `met`, `smhi` or `blend` |
| `interpolated` | `1` if the hour lies between two of the source's time steps, otherwise `0` |
| `fetched_at` | when it was fetched; the actual time ahead is `valid_time − fetched_at` |
| `issued_at` | the model run time according to the source (met.no `updated_at`, SMHI `referenceTime`) |
| `temp`, `temp_p10`, `temp_p90` | temperature °C, with the 10th/90th percentiles (met.no and blend; empty for SMHI, which has none) |
| `wind`, `wind_p10`, `wind_p90`, `gust` | m/s (same as above for the percentiles) |
| `wind_dir` | degrees, direction the wind comes from |
| `humidity` | % |
| `pressure` | hPa at sea level |
| `cloud` | % (SMHI's octas converted) |
| `precip`, `precip_p10`, `precip_p90` | mm in the hour from `valid_time` |
| `precip_prob` | % chance of precipitation in the source's time step that contains the hour (1 h, or 6 h further ahead) |
| `thunder` | % (only from SMHI) |
| `symbol` | met.no `symbol_code` (SMHI's mapped to the same names) |

An empty field means the source has no value for that hour. A missing hour means no run happened
in the hour it should have been fetched (see Limitations).

The first run on 2026-10-13 saved in an older format, with one monthly file for all time-frames.
Its rows were converted into these files automatically.

## Size

27 rows per run, about 650 rows and 85 KB per day. That's roughly **3.5 MB per file and year, about
30 MB per year in total**, and less as stored by git, since CSV compresses well and each commit only
appends lines. A year's file is about 26,000 rows, which Excel opens easily. GitHub warns at
50 MB per file and recommends repos under 1 GB, so this can run for many years.

The data is plain CSV on its own branch rather than a SQLite file in the repo. A database file
committed every hour would be saved as a full new copy each time, and couldn't be merged. When it's
time to analyse, build a database from the CSVs, with the time-frame as a column:

```sh
git fetch origin forecast-data
git worktree add ../forecast-data forecast-data
cd ../forecast-data
python3 - <<'PY'
import csv, glob, os, re, sqlite3
os.remove('forecasts.db') if os.path.exists('forecasts.db') else None
db = sqlite3.connect('forecasts.db')
for f in sorted(glob.glob('forecasts/*/lead_*.csv')):
    lead = int(re.search(r'lead_(\d+)h', f).group(1))
    rows = list(csv.reader(open(f, newline='')))
    cols = ['lead_h'] + rows[0]
    db.execute(f"CREATE TABLE IF NOT EXISTS forecasts ({', '.join(cols)})")
    db.executemany(f"INSERT INTO forecasts VALUES ({', '.join('?' * len(cols))})",
                   [[lead] + [v if v != '' else None for v in r] for r in rows[1:]])
db.commit()
PY
```

## Next steps

- **Measured values.** Export the thermometer CSV and save it, for example as
  `observations/thermometer.csv` on the same branch, or keep it locally. Readings should be in UTC,
  or the time zone should be known. Then match each reading with forecasts that have the same `valid_time`.
- **Evaluation.** Per `source` and time-frame, compute the bias (mean error), MAE and RMSE, plus how often
  the measured value falls inside `temp_p10`–`temp_p90` (it should be about 80 %). Then split by forecast
  cloud, wind, precipitation, day/night and season. The RMSE per source goes into `weightsFromErrors()`.
- Expect the thermometer to have a bias of its own (placement, sun, a wall nearby). It affects every source
  equally, so comparisons *between* sources and between times ahead still hold.

## Limitations

- GitHub only runs scheduled workflows on a best-effort basis: runs start late, and under load
  many are dropped. On 2026-10-13 only about one hourly slot in six actually ran, which is why
  the workflow now runs every 10 minutes. `fetched_at` records the real time, so late runs are
  fine. An hour where none of the six attempts ran leaves that hour missing in every file.
  If that's still common, trigger the workflow from an outside cron service (for example
  cron-job.org calling GitHub's workflow-dispatch API with a token limited to this repo). Gaps aren't filled afterwards: a later fetch is a
  newer forecast than the one that was available at the time.
- In public repos, GitHub disables scheduled workflows after 60 days without repository activity.
  It emails a warning first, and the workflow can be turned back on from the Actions tab.
