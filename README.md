# weather_app

Weather forecast for a chosen place, from met.no and SMHI.

- `index.html` is the app: Översikt, Diagram and Timme för timme, with day tabs that set the period.
- `js/core.js` holds data handling, weather icons and SVG charts; `js/app.js` holds place, source and period.
- `js/warnings.js` reads SMHI's weather warnings and shows the ones whose area contains the chosen place. `?varningar=alla` shows every current warning in Sweden, to check that the service answers.
- `widget.html` is a compact page for a home-screen widget app. The place goes in the address (`?plats=…&lat=…&lon=…`, optionally `&storlek=4x2|2x4|auto`, `&kalla=smhi|blend`, `&tema=ljus|mork`, `&bakgrund=genomskinlig`). It draws the card in a fixed 4×2 frame by default (four cells wide, two tall) (for screenshot widget apps such as AnyWidget), with a button to the full site below; the footer of the app shows a ready link for the current place.
- `manifest.webmanifest` and `icons/` let the site be added to the home screen as an app.
- `forecast-sources.js` combines met.no and SMHI (see `docs/multi-source-forecast.md`).
- `drafts/` holds the design drafts that led to the current layout.
- Add `?demo=1` to the address to see the app with synthetic example data.

Tests: `node --test tests/*.test.js`
