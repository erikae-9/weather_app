# weather_app

Weather forecast for a chosen place, from met.no and SMHI.

- `index.html` is the app: Översikt, Diagram and Timme för timme, with day tabs that set the period.
- `js/core.js` holds data handling, weather icons and SVG charts; `js/app.js` holds place, source and period.
- `forecast-sources.js` combines met.no and SMHI (see `docs/multi-source-forecast.md`).
- `drafts/` holds the design drafts that led to the current layout.
- Add `?demo=1` to the address to see the app with synthetic example data.

Tests: `node --test tests/*.test.js`
