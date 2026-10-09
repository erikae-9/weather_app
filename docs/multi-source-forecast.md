# Multi-source forecast (draft)

Draft of how the app could combine met.no and SMHI (snow1g) into one weighted
forecast, and let the user switch between **met.no**, **SMHI** and **Weighted**.

The code is in [`forecast-sources.js`](../forecast-sources.js) and tests are in
[`tests/forecast-sources.test.js`](../tests/forecast-sources.test.js)
(`node --test tests/forecast-sources.test.js`). `index.html` doesn't load the module yet.

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

## Wiring it into `index.html` (sketch)

```js
let forecastMode = localStorage.getItem('forecastMode') || 'met';
let rawForecasts = {};   // { met, smhi }: kept so switching needs no new fetch

// fetchWeather: fetch both raw responses (SMHI may still fail silently)
const [metRes, smhiRes] = await Promise.allSettled([
  fetch(metUrl, { headers }).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),
  fetch(smhiUrl).then(r => r.ok ? r.json() : Promise.reject(new Error(`SMHI HTTP ${r.status}`))),
]);
rawForecasts = {
  met:  metRes.status  === 'fulfilled' ? metRes.value  : null,
  smhi: smhiRes.status === 'fulfilled' ? smhiRes.value : null,
};
applyForecastMode();

function applyForecastMode() {
  // Fall back to met.no if SMHI is missing (for example outside the Nordics)
  const mode = rawForecasts.smhi ? forecastMode : 'met';
  weatherData = ForecastSources.buildForecast(mode, rawForecasts);
  const d = weatherData.data;
  d.feels_like = d.temp.map((t, i) => calculateFeelsLike(t, d.wind[i], d.humidity[i]));
  weatherData.persistenceL = estimatePersistence();   // falls back to 4 without met.no's 6 h blocks
  d.rolling3h = compute3hRollingProb(d.precip_prob, d.step_hours, weatherData.persistenceL);
}

function setForecastMode(mode) {
  forecastMode = mode;
  try { localStorage.setItem('forecastMode', mode); } catch {}
  applyForecastMode();
  setDefaultDayRange();   // the SMHI axis can have different indices
  _refreshAll();
}
```

```html
<!-- e.g. under globalControls, same style as the range tabs -->
<div class="source-tabs" role="tablist" aria-label="Prognoskälla">
  <button class="range-tab" data-source="met"   onclick="setForecastMode('met')">met.no</button>
  <button class="range-tab" data-source="smhi"  onclick="setForecastMode('smhi')">SMHI</button>
  <button class="range-tab" data-source="blend" onclick="setForecastMode('blend')">Viktad</button>
</div>
<script src="forecast-sources.js"></script>
```

`processWeatherData` and `mergeThunder` would then be replaced by `buildForecast`.

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
