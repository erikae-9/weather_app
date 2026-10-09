// Kör: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const FS = require('../forecast-sources.js');

// Facit: vad appens tidigare processWeatherData gav för MET nedan (sparat innan
// den ersattes av buildForecast). feels_like/rolling3h räknas fortfarande i appen.
const LEGACY = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'met-legacy-output.json'), 'utf8'));

// ── Testdata ──
const T0 = Date.parse('2026-10-09T12:00:00Z');
const iso = h => new Date(T0 + h * 3600e3).toISOString().replace('.000', '');

function metEntry(h, { temp, p10, p90, wind = 4, dir = 200, step = 1, amount = 0, min, max, prob = 10, symbol = 'cloudy' }) {
  const block = { summary: { symbol_code: symbol },
    details: { precipitation_amount: amount, precipitation_amount_min: min ?? amount,
               precipitation_amount_max: max ?? amount, probability_of_precipitation: prob } };
  return { time: iso(h), data: {
    instant: { details: {
      air_temperature: temp, air_temperature_percentile_10: p10, air_temperature_percentile_90: p90,
      wind_speed: wind, wind_speed_percentile_10: wind - 1, wind_speed_percentile_90: wind + 1,
      wind_speed_of_gust: wind * 2, wind_from_direction: dir, relative_humidity: 80,
      air_pressure_at_sea_level: 1010, cloud_area_fraction: 75, ultraviolet_index_clear_sky: 0.5 } },
    ...(step === 1 ? { next_1_hours: block } : {}),
    next_6_hours: { details: { probability_of_precipitation: step === 6 ? prob : 40 }, summary: { symbol_code: symbol },
                    ...(step === 6 ? { details: block.details } : {}) },
  } };
}

const MET = { properties: { timeseries: [
  metEntry(0, { temp: 10, p10: 9, p90: 11, amount: 0.2, min: 0, max: 0.5, prob: 30, dir: 350 }),
  metEntry(1, { temp: 11, p10: 10, p90: 12, amount: 0.0, prob: 20 }),
  metEntry(2, { temp: 12, p10: 11, p90: 13, amount: 1.0, min: 0.4, max: 2.0, prob: 60, symbol: 'rain' }),
  metEntry(3, { temp: 12, p10: 11, p90: 13, step: 6, amount: 3.0, min: 1, max: 6, prob: 70, symbol: 'rain' }),
  metEntry(9, { temp: 8,  p10: 6,  p90: 10, step: 6, amount: 0.6, prob: 25 }),
] } };

// SMHI: timvärden, nederbörd (mm) avser intervallet (intervalParametersStartTime, time]
function smhiEntry(h, { temp, wind = 6, dir = 10, amount = 0, prob = 20, thunder = 5, sym = 6, intervalH = 1 }) {
  return { time: iso(h), intervalParametersStartTime: iso(h - intervalH), data: {
    air_temperature: temp, wind_speed: wind, wind_speed_of_gust: wind * 2, wind_from_direction: dir,
    relative_humidity: 90, air_pressure_at_mean_sea_level: 1006, cloud_area_fraction: 8,
    thunderstorm_probability: thunder, precipitation_amount_mean: amount,
    precipitation_amount_min: amount / 2, precipitation_amount_max: amount * 2,
    probability_of_precipitation: prob, symbol_code: sym } };
}
const SMHI = { timeSeries: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(h =>
  smhiEntry(h, { temp: 10 + h * 0.5 + 2, amount: h === 3 ? 2 : 0.5, prob: 40, thunder: h })) };

const NOW = T0;

test('met.no-läget ger samma data som appens tidigare processWeatherData', () => {
  const fc = FS.buildForecast('met', { met: MET }, { nowMs: NOW });
  assert.deepEqual(fc.times.map(t => t.toISOString()), LEGACY.times);
  for (const [k, a] of Object.entries(LEGACY.data)) {
    if (k === 'feels_like' || k === 'rolling3h') continue;
    const b = fc.data[k];
    assert.equal(b.length, a.length, k);
    a.forEach((v, i) => {
      if (typeof v === 'number') assert.ok(Math.abs(v - b[i]) < 1e-9, `${k}[${i}]: ${v} ≠ ${b[i]}`);
      else assert.equal(b[i], v, `${k}[${i}]`);
    });
  }
});

test('varje källas egna serier finns för Båda-läget', () => {
  const fc = FS.buildForecast('blend', { met: MET, smhi: SMHI }, { nowMs: NOW });
  assert.deepEqual(fc.data.temp_src_met, [10, 11, 12, 12, 8]);
  assert.equal(fc.data.wind_src_smhi[0], 6);
  assert.equal(fc.data.gust_src_met[0], 8);
  assert.equal(fc.data.humidity_src_smhi[0], 90);
  // met.no steg 0: min 0, max 0.5 mm på 1 h
  assert.equal(fc.data.precip_p10_src_met[0], 0);
  assert.equal(fc.data.precip_p90_src_met[0], 0.5);
  assert.equal(fc.data.precip_step_src_met[0], 0.2);
});

test('met.no-läget hämtar fortfarande åska från SMHI', () => {
  const fc = FS.buildForecast('met', { met: MET, smhi: SMHI }, { nowMs: NOW });
  assert.deepEqual(fc.data.temp, [10, 11, 12, 12, 8]);        // SMHI påverkar inte temp
  assert.deepEqual(fc.data.thunder, [0, 1, 2, 3, 9]);          // men ger åska
  assert.deepEqual(fc.data.weight_src_smhi, [0, 0, 0, 0, 0]);
});

test('SMHI-läget använder SMHI:s tidsaxel och nederbörd för perioden före', () => {
  const fc = FS.buildForecast('smhi', { met: MET, smhi: SMHI }, { nowMs: NOW });
  assert.equal(fc.times.length, 10);
  assert.equal(fc.data.temp[0], 12);
  // Steget 02→03 täcks av SMHI-värdet vid 03 (intervall 02–03, 2 mm)
  assert.equal(fc.data.precip_step[2], 2);
  assert.equal(fc.data.cloud[0], 100);                         // 8 oktas → 100 %
  assert.equal(fc.data.symbols[0], 'cloudy');                  // 00–01 täcks av värdet vid 01
  assert.equal(fc.data.uv[0], 0.5);                            // UV saknas hos SMHI → met.no
  assert.equal(fc.data.precip_step[9], null);                  // sista steget otäckt
  assert.equal(fc.data.symbols[9], 'unknown');
});

test('viktat läge: medel, och bandet vidgas när källorna är oense', () => {
  const fc = FS.buildForecast('blend', { met: MET, smhi: SMHI }, { nowMs: NOW });
  // t=0: met 10 (9–11), SMHI 12 (inga percentiler) → medel 11
  assert.equal(fc.data.temp[0], 11);
  const lo = fc.data.temp_p10[0], hi = fc.data.temp_p90[0];
  // Ensam källspridning: viktat medel av p10 = (9+12)/2 = 10.5 → 0.5 under medel.
  // Oenighet: sd 1 → 1.28. I kvadratur: ~1.37
  assert.ok(Math.abs((11 - lo) - Math.hypot(0.5, 1.2816)) < 1e-9);
  assert.ok(Math.abs((hi - 11) - Math.hypot(0.5, 1.2816)) < 1e-9);
  // Vindriktning 350° och 10° → 0° (inte 180°)
  const d = fc.data.wind_direction[0];
  assert.ok(Math.min(d, 360 - d) < 1e-6, `riktning ${d}`);
  // Sannolikhet: linjär pool (30 + 40) / 2
  assert.equal(fc.data.precip_prob[0], 35);
  assert.deepEqual([fc.data.weight_src_met[0], fc.data.weight_src_smhi[0]], [0.5, 0.5]);
  assert.equal(fc.data.temp_src_met[0], 10);
  assert.equal(fc.data.temp_src_smhi[0], 12);
});

test('viktat läge: 6h-steg summerar SMHI:s timvärden', () => {
  const fc = FS.buildForecast('blend', { met: MET, smhi: SMHI }, { nowMs: NOW });
  // met.no-steget 03–09: SMHI-perioderna 03–04 … 08–09 à 0.5 mm → 3 mm; met.no 3 mm
  assert.equal(fc.data.step_hours[3], 6);
  assert.equal(fc.data.precip_step[3], 3);
  // Sista met.no-steget (09–15) saknar SMHI-täckning → bara met.no
  assert.equal(fc.data.precip_step[4], 0.6);
  assert.equal(fc.data.temp[4], 8.0 * 0.5 + 16.5 * 0.5);     // punktvärdet vid 09 finns hos båda
});

test('vikter som beror på prognoslängd', () => {
  const weights = { met: { default: [[0, 3], [2, 1]] }, smhi: { default: 1 } };
  const fc = FS.buildForecast('blend', { met: MET, smhi: SMHI }, { nowMs: NOW, weights });
  assert.equal(fc.data.weight_src_met[0], 0.75);                // 3:1
  assert.equal(fc.data.weight_src_met[1], 2 / 3);               // 2:1
  assert.equal(fc.data.weight_src_met[2], 0.5);                 // 1:1
  assert.equal(FS.evalCurve([[0, 3], [2, 1]], 10), 1);
});

test('weightsFromErrors ger w ∝ 1/RMSE²', () => {
  const w = FS.weightsFromErrors({ met: 1, smhi: 2 });
  assert.ok(Math.abs(w.met - 0.8) < 1e-12);
  assert.ok(Math.abs(w.smhi - 0.2) < 1e-12);
});

test('SMHI-adaptern läser ett riktigt snow1g-svar', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'smhi-snow1g-sample.json'), 'utf8'));
  const src = FS.normalizeSmhi(raw);
  const p = src.points[0];
  assert.equal(p.t, Date.parse('2025-09-04T13:00:00Z'));
  assert.equal(p.temp, 24.6);
  assert.equal(p.wind, 2.8);
  assert.equal(p.gust, 8.4);
  assert.equal(p.wind_direction, 204);
  assert.equal(p.pressure, 1010.5);
  assert.equal(p.cloud, 62.5);                                 // 5 oktas
  assert.equal(p.thunder, 0);
  // Första posten har sitt eget intervall (12–13) och tas med
  assert.deepEqual(src.periods[0], {
    start: Date.parse('2025-09-04T12:00:00Z'), end: Date.parse('2025-09-04T13:00:00Z'),
    amount: 0, min: 0, max: 0, prob: 0, symbol: 'partlycloudy_day',
  });
  assert.equal(src.periods.length, 2);
});

test('SMHI-intervall längre än tidssteget fördelas över met.no:s timmar', () => {
  // Ett 3h-intervall 03–06 med 3 mm → 1 mm per timme på en timaxel
  const smhi = { timeSeries: [smhiEntry(6, { temp: 5, amount: 3, intervalH: 3 })] };
  const src = FS.normalizeSmhi(smhi);
  const grid = [3, 4, 5].map(h => ({ t: T0 + h * 3600e3, stepH: 1 }));
  const s = FS.sampleSource(src, grid);
  assert.deepEqual(s.precip_amount, [1, 1, 1]);
});

test('SMHI: mängder är totaler per intervall, min/max görs om till p10/p90', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'smhi-snow1g-intervals.json'), 'utf8'));
  const src = FS.normalizeSmhi(raw);
  const hours = src.periods.map(p => (p.end - p.start) / 3600e3);
  assert.deepEqual(hours, [1, 1, 1, 2, 6, 6, 12, 12]);
  const at = iso => src.periods.find(p => p.end === Date.parse(iso));
  // 12h-intervall: 1.3 mm totalt (inte 1.3 mm/h × 12)
  assert.equal(at('2026-10-16T00:00:00Z').amount, 1.3);
  // 93 % risk: villkorat min (0.4) duger som p10
  assert.deepEqual(pick(at('2026-10-09T11:00:00Z')), { amount: 0.3, min: 0.4, max: 0.4, prob: 93 });
  // 27 % risk: p10 = 0 (oftast torrt), p90 = villkorat max
  assert.deepEqual(pick(at('2026-10-11T21:00:00Z')), { amount: 0.1, min: 0, max: 0.5, prob: 27 });
  // SMHI-läget: tidsaxeln följer intervallen och mm/h räknas ut per steg
  const fc = FS.buildForecast('smhi', { smhi: raw }, { nowMs: Date.parse('2026-10-09T10:00:00Z') });
  const i = fc.times.findIndex(t => t.getTime() === Date.parse('2026-10-15T12:00:00Z'));
  assert.equal(fc.data.step_hours[i], 12);
  assert.equal(fc.data.precip_step[i], 1.3);
  assert.ok(Math.abs(fc.data.precip[i] - 1.3 / 12) < 1e-12);
});

test('smhiBand', () => {
  assert.deepEqual(FS.smhiBand(5, 1.2, 1.8), { lo: 0, hi: 0 });
  assert.deepEqual(FS.smhiBand(50, 1.2, 1.8), { lo: 0, hi: 1.8 });
  assert.deepEqual(FS.smhiBand(95, 1.2, 1.8), { lo: 1.2, hi: 1.8 });
  assert.deepEqual(FS.smhiBand(null, 1.2, 1.8), { lo: null, hi: null });
});

function pick(p) { return { amount: p.amount, min: p.min, max: p.max, prob: p.prob }; }
