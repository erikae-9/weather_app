// Kör: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('../scripts/collect-forecasts.js');

const H = 3600e3;
const T0 = Date.parse('2026-10-13T12:00:00Z');
const iso = ms => new Date(ms).toISOString().replace('.000', '');
const at = (h, min = 0) => T0 + h * H + min * 60e3;

// Som met.no: timsteg de första 60 h, sedan 6h-steg (00/06/12/18 UTC) till 10 dygn
function metJson() {
  const hours = [];
  for (let h = 0; h <= 60; h++) hours.push(h);
  for (let h = 66; h <= 240; h += 6) hours.push(h);
  return { properties: {
    meta: { updated_at: '2026-10-13T11:52:31Z' },
    timeseries: hours.map((h, i) => {
      const block = { summary: { symbol_code: 'cloudy' },
        details: { precipitation_amount: 0.6, precipitation_amount_min: 0, precipitation_amount_max: 1.2,
                   probability_of_precipitation: 30 } };
      const step = (hours[i + 1] ?? h + 6) - h;
      return { time: iso(at(h)), data: {
        instant: { details: { air_temperature: 10 + h / 10, air_temperature_percentile_10: 9 + h / 10,
          air_temperature_percentile_90: 11 + h / 10, wind_speed: 4, wind_from_direction: 200,
          relative_humidity: 80, air_pressure_at_sea_level: 1010, cloud_area_fraction: 75 } },
        ...(step === 1 ? { next_1_hours: block } : { next_6_hours: block }),
      } };
    }),
  } };
}

// Som SMHI snow1g: timsteg de första 48 h, sedan 6h-steg
function smhiJson() {
  const hours = [];
  for (let h = 0; h <= 48; h++) hours.push(h);
  for (let h = 54; h <= 240; h += 6) hours.push(h);
  return {
    referenceTime: '2026-10-13T11:00:00Z',
    timeSeries: hours.map((h, i) => ({
      time: iso(at(h)), intervalParametersStartTime: iso(at(i ? hours[i - 1] : h - 1)),
      data: { air_temperature: 12 + h / 10, wind_speed: 6, wind_from_direction: 220, relative_humidity: 90,
        air_pressure_at_mean_sea_level: 1006, cloud_area_fraction: 8, thunderstorm_probability: 5,
        precipitation_amount_mean: 0.2, precipitation_amount_min: 0.4, precipitation_amount_max: 1,
        probability_of_precipitation: 20, symbol_code: 6 },
    })),
  };
}

const RAW = { met: metJson(), smhi: smhiJson() };
const col = name => C.HEADER.indexOf(name);
const pick = (rows, source) => rows.filter(r => r[col('source')] === source);

test('varje rad har lika många fält som rubriken', () => {
  const rows = C.buildRows(RAW, at(0, 17));
  assert.ok(rows.length > 0);
  for (const r of rows) assert.equal(r.length, C.HEADER.length);
  assert.deepEqual([...new Set(rows.map(r => r[col('source')]))], ['met', 'smhi', 'blend']);
});

test('prognoslängd räknas från hämtningstimmen; långa längder bara på tidsaxeln', () => {
  // Hämtat 12:17 → 12:00 + 168 h = 12:00 UTC, som ligger på 6h-axeln
  const rows = pick(C.buildRows(RAW, at(0, 17)), 'met');
  assert.deepEqual(rows.map(r => r[col('lead_h')]), C.LEADS_H);
  const week = rows.find(r => r[col('lead_h')] === 168);
  assert.equal(week[col('valid_time')], '2026-10-20T12:00:00Z');
  assert.equal(week[col('fetched_at')], '2026-10-13T12:17:00Z');
  assert.equal(week[col('issued_at')], '2026-10-13T11:52:31Z');
  assert.equal(week[col('step_h')], 6);
  assert.equal(week[col('temp')], '26.8');

  // Hämtat 13:17 → 13:00 + 72 h ligger mellan två 6h-steg och hoppas över
  const later = pick(C.buildRows(RAW, at(1, 17)), 'met');
  assert.deepEqual(later.map(r => r[col('lead_h')]), [1, 3, 6, 12, 24, 48]);
});

test('ren källa lånar inget från den andra; viktad är medel av båda', () => {
  const rows = C.buildRows(RAW, at(0, 17));
  const row = (source, lead) => pick(rows, source).find(r => r[col('lead_h')] === lead);
  assert.equal(row('met', 1)[col('thunder')], '');          // åska finns bara hos SMHI
  assert.equal(row('smhi', 1)[col('thunder')], '5');
  assert.equal(row('smhi', 1)[col('cloud')], '100');        // 8 oktas → 100 %
  assert.equal(row('met', 1)[col('temp')], '10.1');
  assert.equal(row('smhi', 1)[col('temp')], '12.1');
  assert.equal(row('blend', 1)[col('temp')], '11.1');
  // SMHI saknar percentiler: tomt, inte medelvärdet
  for (const c of ['temp_p10', 'temp_p90', 'wind_p10', 'wind_p90']) assert.equal(row('smhi', 1)[col(c)], '', c);
  assert.equal(row('met', 1)[col('temp_p10')], '9.1');
  assert.notEqual(row('smhi', 1)[col('precip_p90')], '');   // nederbördsbandet finns hos SMHI
});

test('utan SMHI blir det bara met.no-rader', () => {
  const rows = C.buildRows({ met: RAW.met, smhi: null }, at(0, 17));
  assert.deepEqual([...new Set(rows.map(r => r[col('source')]))], ['met']);
});

test('appendRows skriver rubriken en gång per månadsfil', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-'));
  const rows = C.buildRows(RAW, at(0, 17));
  const file = C.appendRows(dir, rows, at(0, 17));
  C.appendRows(dir, rows, at(1, 17));
  assert.equal(path.relative(dir, file), path.join('forecasts', '2026-10.csv'));
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  assert.equal(lines[0], C.HEADER.join(','));
  assert.equal(lines.length, 1 + 2 * rows.length);
  assert.equal(lines.filter(l => l.startsWith('valid_time')).length, 1);
});

test('fmt: tomt för saknat, avrundat utan onödiga nollor', () => {
  assert.equal(C.fmt(null, 1), '');
  assert.equal(C.fmt(NaN, 1), '');
  assert.equal(C.fmt(12.04, 1), '12');
  assert.equal(C.fmt(-0.04, 1), '0');
  assert.equal(C.fmt(1012.345, 1), '1012.3');
});
