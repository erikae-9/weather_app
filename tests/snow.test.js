// Kör: node --test tests/
// Snöuppskattningen: andel som snö, cm per mm, och SMHI:s snöandel genom kedjan.
const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.window = globalThis;
globalThis.ForecastSources = require('../forecast-sources.js');
require('../js/core.js');
const WX = globalThis.WX;
const FS = globalThis.ForecastSources;

// Minimal weatherData med valda värden per steg (1 h)
function wd({ temp, mm, sym, frozen }) {
  const n = temp.length;
  return { n, data: { temp, precip_step: mm, symbols: sym || Array(n).fill('cloudy'), frozen: frozen || Array(n).fill(null) } };
}

test('snöandel: SMHI:s värde går före symbol och temperatur', () => {
  const w = wd({ temp: [3, 3], mm: [1, 1], sym: ['rain', 'rain'], frozen: [80, null] });
  assert.equal(WX.snowShare(w, 0), 0.8);   // SMHI säger 80 % trots regnsymbol och +3°
  assert.equal(WX.snowShare(w, 1), 0);     // utan SMHI: regnsymbolen
});

test('snöandel: symbol, och temperatur när symbolen saknar nederbördstyp', () => {
  const w = wd({ temp: [1, 1, -3, 0.5, 4], mm: [1, 1, 1, 1, 1], sym: ['snow', 'sleet', 'cloudy', 'cloudy', 'cloudy'] });
  assert.equal(WX.snowShare(w, 0), 1);
  assert.equal(WX.snowShare(w, 1), 0.5);
  assert.equal(WX.snowShare(w, 2), 1);      // −3°: helt snö
  assert.equal(WX.snowShare(w, 3), 0.5);    // +0,5°: hälften
  assert.equal(WX.snowShare(w, 4), 0);      // +4°: regn
});

test('cm per mm beror på temperaturen', () => {
  assert.equal(WX.snowRatio(0), 0.7);
  assert.equal(WX.snowRatio(-5), 1.0);
  assert.equal(WX.snowRatio(-12), 1.5);
  assert.equal(WX.snowRatio(-20), 1.5);
  assert.ok(WX.snowRatio(-3) > 0.7 && WX.snowRatio(-3) < 1.0);
});

test('summering och text, med "blandat med regn"', () => {
  const allSnow = WX.snowEstimate(wd({ temp: [-5, -5], mm: [4, 6], sym: ['snow', 'snow'] }), 0, 2);
  assert.equal(Math.round(allSnow.cm), 10);
  assert.equal(WX.snowText(allSnow), 'ungefär 10 cm snö');
  assert.equal(WX.snowText(allSnow, true), '≈ 10 cm snö');
  const mixed = WX.snowEstimate(wd({ temp: [-5, 4], mm: [4, 6], sym: ['snow', 'rain'] }), 0, 2);
  assert.equal(WX.snowText(mixed), 'ungefär 4 cm snö, blandat med regn');
  assert.equal(WX.snowText(WX.snowEstimate(wd({ temp: [5], mm: [8], sym: ['rain'] }), 0, 1)), '');
});

test('SMHI:s snöandel följer med till prognosen, även i met.no-läget', () => {
  const T0 = Date.parse('2026-11-20T00:00:00Z'), iso = h => new Date(T0 + h * 3600e3).toISOString();
  const smhi = { timeSeries: [1, 2].map(h => ({ time: iso(h), intervalParametersStartTime: iso(h - 1), data: {
    air_temperature: -2, precipitation_amount_mean: 1, precipitation_amount_min: 0.5, precipitation_amount_max: 2,
    probability_of_precipitation: 90, precipitation_frozen_part: h === 1 ? 100 : 40, symbol_code: 26 } })) };
  assert.deepEqual(FS.normalizeSmhi(smhi).periods.map(p => p.frozen), [100, 40]);
  const met = { properties: { timeseries: [0, 1].map(h => ({ time: iso(h), data: {
    instant: { details: { air_temperature: -2, wind_speed: 3, wind_from_direction: 180 } },
    next_1_hours: { summary: { symbol_code: 'snow' }, details: { precipitation_amount: 1, probability_of_precipitation: 90 } } } })) } };
  const b = FS.buildForecast('met', { met, smhi }, { nowMs: T0 });
  assert.deepEqual(b.data.frozen, [100, 40]);   // met.no-stegen [0,1) och [1,2) får SMHI:s (0,1] och (1,2]
  const noSmhi = FS.buildForecast('met', { met }, { nowMs: T0 });
  assert.deepEqual(noSmhi.data.frozen, [null, null]);
});
