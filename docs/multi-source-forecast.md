# Multi-source forecast (draft)

Draft of how the app could combine met.no and SMHI (snow1g) into one weighted
forecast, and let the user switch between **met.no**, **SMHI**, **Viktad** (weighted) and
**Båda** (both sources side by side).

The code is in [`forecast-sources.js`](../forecast-sources.js), loaded by `index.html`, and tests
are in [`tests/forecast-sources.test.js`](../tests/forecast-sources.test.js)
(`node --test tests/forecast-sources.test.js`).

**Deployment:** `forecast-sources.js` must be published next to `index.html`.

## Structure

```
met.no JSON ──► normalizeMet  ──┐
                                ├─► sample onto one time grid ─► blend(weights) ─► weatherData
SMHI JSON   ──► normalizeSmhi ──┘
```

1. **Adapters** turn each API response into one shared shape:
   - `points`: values at a moment in time (temperature, wind, direction, humidity, pressure, cloud, UV, thunder)
   - `periods`: values over a time span `[start, end)` (precipitation amount/min/max, probability, symbol)

   Keeping these separate matters because the two APIs disagree on what a precipitation value
   covers. met.no's `next_1_hours` covers the hour *after* the timestamp. SMHI gives the interval
   explicitly: `intervalParametersStartTime` to `time`, which is the hour *before*.
2. **Grid.** Choose one time axis. Weighted mode uses met.no's axis (hourly, then 6 h steps), so
   the persistence calibration against met.no's 6 h blocks still works.
3. **Sampling.** Each source is mapped onto that grid:
   - point values are interpolated linearly, and wind direction is interpolated as a vector
   - periods are summed by overlap, so a 6 h met.no step adds up six SMHI hourly values
4. **Blend.** Per grid step and per parameter, a weighted mean over the sources that have a value.
5. **Output** has the same shape as `weatherData` in `index.html`, so the charts, table and cards
   don't need to change.

**Switching forecast is just a different set of weights:**

| Mode     | Time axis | Weights                 |
|----------|-----------|-------------------------|
| `met`    | met.no    | `{ met: 1, smhi: 0 }`   |
| `smhi`   | SMHI      | `{ met: 0, smhi: 1 }`   |
| `blend`  | met.no    | `{ met: 1, smhi: 1 }`   |
| `both`   | met.no    | as `blend`; the graphs use each source's own series (`*_src_met`, `*_src_smhi`) |

If none of the selected sources has a parameter at all, it is borrowed from another source. That's
how met.no mode keeps SMHI's thunder probability (as it does today), and how SMHI mode gets UV
from met.no. Gaps in *time* are not patched this way: if SMHI ends earlier, SMHI mode shows
"—" there.

In met.no mode, the test shows the output is identical to today's `processWeatherData`. Switching
to this structure changes nothing until you pick another mode.

## Weighting

Each layer can be added on its own:

### 1. How each kind of value is combined

| Parameter                         | Method                                   | Why |
|-----------------------------------|------------------------------------------|-----|
| temp, wind, pressure, humidity, cloud, gust | weighted mean                  | ordinary numbers |
| wind direction                    | weighted **vector** mean                 | 350° and 10° should give 0°, not 180° |
| precipitation amount              | weighted mean of the period amounts      | |
| precip. / thunder probability     | weighted mean ("linear pool")            | keeps the probabilities calibrated; multiplying sources would push them toward 0/100 |
| weather symbol                    | taken from the most heavily weighted source | symbols can't be averaged |

### 2. Uncertainty band (p10–p90) that widens when sources disagree

The band combines two things:

- **each source's own uncertainty**: the weighted mean of the sources' p10 and p90 (met.no has
  percentiles; SMHI counts as a single point)
- **disagreement between sources**: the weighted standard deviation between the sources' means,
  times 1.28 (the z-score for p10/p90)

These are added in quadrature: `lo = mean − √((mean − p10)² + (1.28·sd)²)`. When the sources
agree, the band is just their own spread. When they disagree, it widens, which is the behaviour
you want. With a single source the formula gives back exactly that source's band.

For each source, `data.temp_src_met`, `data.temp_src_smhi` and so on are also produced, so the
charts could draw them as thin lines next to the weighted one.

### 3. Weights by lead time and parameter

A weight can be a constant or a curve over lead time in hours (linear in between), set per parameter:

```js
const weights = {
  met:  { default: [[0, 1.5], [48, 1.0]] },        // stronger the first two days, then equal
  smhi: { default: 1, precip_prob: [[0, 1], [72, 1.5]] },
};
ForecastSources.buildForecast('blend', raw, { weights });
```

The numbers above only show the syntax. The draft's default is **equal weights**, because I don't
have data saying either model is better here. Equal weights are a reasonable starting point:
an average of two comparable models is usually at least as good as either one.

### 4. Weights from data (next step)

`weightsFromErrors({ met: rmse, smhi: rmse })` gives `w ∝ 1/RMSE²`, the standard way to weight
by past error. To get the RMSE values:

1. Save each fetched forecast, at least the first 48 h per source (for example in `localStorage`,
   keyed by location and fetch time). Neither API serves old forecasts, so the app has to keep them.
2. Fetch observations from the nearest station in the
   [SMHI metobs API](https://opendata.smhi.se/apidocs/metobs/), for example air temperature (parameter 1).
3. Compute the error per source, parameter and lead-time window (0–24 h, 24–72 h, 72 h+) over the
   last 2–4 weeks.

This gives local weights that adapt over time, possibly by season.

## UI plan

Decisions from reviewing the Grafer view. **Status:** built in `index.html`.

**Forecast switch.** Four options in the controls row at the top: met.no, SMHI, Viktad, Båda.
- met.no, SMHI and Viktad look identical apart from the numbers. They never show source names
  or weights.
- **Båda** is the only mode that names the sources, and only in the graphs and the detail panel.
  The day strip, Översikt and Tabell show the Viktad values in Båda mode.

**Graphs.**
- Temperature, wind and precipitation are stacked full width on a shared time axis with equal
  margins, so a given time lines up in all three.
- One crosshair across all three charts, plus a **detail panel** that stays in place under the
  day strip. Hover (desktop) or tap (mobile) moves it; with no hover it shows "now". Plotly's own
  hover boxes are turned off.
- No zoom. Panning moves all three charts together:
  - **Mobile:** a sideways swipe pans the charts, an up/down swipe scrolls the page, and a tap
    sets the crosshair.
  - **Desktop:** click-and-drag pans, and the mouse wheel scrolls the page.
  - Narrowing the time window is done with the day strip and the Period controls.
- Time axis: hour ticks plus weekday labels at midnight, no rotated labels.
- Wind: thin Beaufort threshold lines with names in the margin instead of filled bands.
  Direction arrows go in a fixed row at the top of the chart.
- Precipitation:
  - bars show the amount, with an explicit unit
  - probability moves from the right-hand axis to a risk ribbon under the chart, with a thunder
    row only when thunder reaches the "medium" level
  - the pale P10–90 background bars stay, hidden when the upper end is below 0.1 mm (no whiskers)

**Detail panel content.** One value per measure:

> 💧 0.9 mm (0.4–1.9) · risk 67 % (1 h) / 98 % (3 h) · ⚡ 12 %

- The range is the single "lowest–highest likely" range. For SMHI it is the conditional range
  converted by `smhiBand`, so there is never a second "if it rains" range.
- The range is hidden when it adds nothing, e.g. 0–0.

**Båda mode.**
- One colour per source, the same in all charts, with one shared met.no / SMHI legend.
- Temperature: two lines without bands; "känns som" moves to the panel.
- Wind: two mean-wind lines; gusts move to the panel.
- Precipitation: two narrow bars side by side per step. Thunder is SMHI only, so it stays one
  series.
- Panel: both values, labelled, e.g.
  `💧 met.no 0.8 mm (0.3–1.6) · SMHI 1.1 mm (0–1.8) · risk met.no 67 % · SMHI 74 % · ⚡ 12 %`.
- The module returns per-source temperature, wind, gust, humidity and precipitation (amount,
  range, probability). The app derives each source's feels-like from these.

**Panning sets the period.** The visible window becomes the selected period: the day cards
it covers are highlighted, the date fields and graph header summaries update, and Översikt
and Tabell follow when you open them. The charts are not redrawn while panning.

## How `index.html` uses it

- `fetchWeather` fetches both raw responses in parallel and keeps them in `rawForecasts`.
  SMHI may fail silently (for example outside the Nordics); then only met.no is offered.
- `applyForecastMode` builds `weatherData` with `ForecastSources.buildForecast` (Båda uses the
  weighted build) and adds feels-like, persistence `L` and the 3 h risk, as before.
- Switching mode rebuilds from the stored responses without a new fetch. The selected period is
  kept as times, since SMHI's time axis differs from met.no's.
- The choice is saved in `localStorage` (`weatherAppForecastMode`). The default is met.no.
- The met.no parity test compares against `tests/fixtures/met-legacy-output.json`. That file is
  the old `processWeatherData` output, saved before the function was removed.

## Open questions and things to check

- **SMHI, checked** against `parameter.json` and a point response (fixture in
  `tests/fixtures/smhi-snow1g-sample.json`): field names, cloud cover in oktas, missing value 9999,
  and the interval comes from `intervalParametersStartTime`.
- **SMHI precipitation, settled** with a 10-day response (fixture in
  `tests/fixtures/smhi-snow1g-intervals.json`):
  - The time step grows from 1 h to 2 h, then 6 h, then 12 h.
  - `precipitation_amount_mean` is the **total for the interval**, not mm/h. As a rate, the
    12 h intervals would mean 15–50 mm at 10–30 % probability.
  - `precipitation_amount_min/max` is the range **if it does rain**, across the ensemble members
    that give precipitation. That's why `min` is often larger than `mean` (for example mean 0.1,
    min 1.2, max 1.8 at 8 %). `smhiBand` turns this into an approximate p10/p90 for the whole
    distribution, so it can be compared with met.no's min/max.
  - `precipitation_amount_mean_deterministic` is a single model run rather than the ensemble.
    The draft doesn't use it. It could later become its own source ("SMHI deterministic"), or a
    tie-breaker for the symbol.
- **Thunder probability** is a percent, per the newer `parameter.json`.
- **SMHI probability on 12 h intervals in weighted mode.** When a 12 h SMHI interval is split
  across two of met.no's 6 h steps, each step gets the full 12 h probability, which overstates
  it. The true value lies between `1 − (1 − p)^½` and `p`, and the app's persistence `L` could
  pick a point in between. This only affects weighted mode from about day 4.
- **`periodRisk` in weighted mode** uses met.no's 6 h/12 h blocks as floor and ceiling. In
  weighted mode they can pull the risk toward met.no. Possible fixes: use the blocks only to
  calibrate `L`, or skip the floor/ceiling in that mode.
- **Symbols** from SMHI always get the `_day` suffix. This only matters if day/night icons are
  added later.
- **UI:** show which source is active, and maybe a "Sources disagree" marker when
  `temp_src_met` and `temp_src_smhi` differ by more than about 2 °C.
