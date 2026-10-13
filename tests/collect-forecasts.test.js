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
const rowsOf = (items, source, lead) =>
  items.filter(it => it.row[col('source')] === source && (lead === undefined || it.lead === lead)).map(it => it.row);
const one = (items, source, lead) => rowsOf(items, source, lead)[0];

test('varje källa får en rad per prognoslängd, oavsett vilken timme körningen sker', () => {
  for (const offset of [0, 1, 2, 5]) {
    const items = C.buildRows(RAW, at(offset, 17));
    for (const it of items) assert.equal(it.row.length, C.HEADER.length);
    for (const source of ['met', 'smhi', 'blend']) {
      assert.deepEqual(items.filter(it => it.row[col('source')] === source).map(it => it.lead), C.LEADS_H, `${source} +${offset}`);
    }
  }
});

test('prognoslängd räknas från hämtningstimmen; tidsstämplar och källans körning', () => {
  // Hämtat 12:17 → 12:00 + 168 h = 12:00 UTC, som ligger på 6h-axeln
  const week = one(C.buildRows(RAW, at(0, 17)), 'met', 168);
  assert.equal(week[col('valid_time')], '2026-10-20T12:00:00Z');
  assert.equal(week[col('fetched_at')], '2026-10-13T12:17:00Z');
  assert.equal(week[col('issued_at')], '2026-10-13T11:52:31Z');
  assert.equal(week[col('interpolated')], 0);
  assert.equal(week[col('temp')], '26.8');
  assert.equal(week[col('precip')], '0.1');                 // 0.6 mm på 6 h → 0.1 mm/h
});

test('timmar mellan källans tidssteg interpoleras och flaggas', () => {
  // Hämtat 13:17 → 13:00 + 168 h ligger mellan 6h-stegen 168 h (26.8) och 174 h (27.4)
  const items = C.buildRows(RAW, at(1, 17));
  const week = one(items, 'met', 168);
  assert.equal(week[col('valid_time')], '2026-10-20T13:00:00Z');
  assert.equal(week[col('interpolated')], 1);
  assert.equal(week[col('temp')], '26.9');
  assert.equal(week[col('precip')], '0.1');
  assert.equal(week[col('symbol')], 'cloudy');
  assert.equal(one(items, 'met', 24)[col('interpolated')], 0);
  assert.equal(one(items, 'met', 1)[col('precip')], '0.6');  // timsteg: hela 0.6 mm på en timme

  // Hämtat 14:17 → +48 h = 50 h: met.no har timsteg där, SMHI 6h-steg (48 → 54)
  const later = C.buildRows(RAW, at(2, 17));
  assert.equal(one(later, 'met', 48)[col('interpolated')], 0);
  assert.equal(one(later, 'smhi', 48)[col('interpolated')], 1);
  assert.equal(one(later, 'blend', 48)[col('interpolated')], 1);
});

test('ren källa lånar inget från den andra; viktad är medel av båda', () => {
  const items = C.buildRows(RAW, at(0, 17));
  assert.equal(one(items, 'met', 1)[col('thunder')], '');          // åska finns bara hos SMHI
  assert.equal(one(items, 'smhi', 1)[col('thunder')], '5');
  assert.equal(one(items, 'smhi', 1)[col('cloud')], '100');        // 8 oktas → 100 %
  assert.equal(one(items, 'met', 1)[col('temp')], '10.1');
  assert.equal(one(items, 'smhi', 1)[col('temp')], '12.1');
  assert.equal(one(items, 'blend', 1)[col('temp')], '11.1');
  // SMHI saknar percentiler: tomt, inte medelvärdet
  for (const c of ['temp_p10', 'temp_p90', 'wind_p10', 'wind_p90']) assert.equal(one(items, 'smhi', 1)[col(c)], '', c);
  assert.equal(one(items, 'met', 1)[col('temp_p10')], '9.1');
  assert.notEqual(one(items, 'smhi', 1)[col('precip_p90')], '');   // nederbördsbandet finns hos SMHI
});

test('utan SMHI blir det bara met.no-rader', () => {
  const items = C.buildRows({ met: RAW.met, smhi: null }, at(0, 17));
  assert.deepEqual([...new Set(items.map(it => it.row[col('source')]))], ['met']);
});

test('appendRows: en fil per längd och år, tre rader per timme, ingen timme två gånger', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-'));
  assert.equal(C.appendRows(dir, C.buildRows(RAW, at(0, 17))), 27);
  assert.equal(C.appendRows(dir, C.buildRows(RAW, at(0, 40))), 0);   // samma timme igen
  assert.equal(C.appendRows(dir, C.buildRows(RAW, at(1, 17))), 27);

  const files = fs.readdirSync(path.join(dir, 'forecasts', '2026')).sort();
  assert.deepEqual(files, C.LEADS_H.map(l => `lead_${String(l).padStart(3, '0')}h.csv`));
  const lines = fs.readFileSync(path.join(dir, 'forecasts', '2026', 'lead_024h.csv'), 'utf8').trimEnd().split('\n');
  assert.equal(lines[0], C.HEADER.join(','));
  assert.deepEqual(lines.slice(1).map(l => l.split(',').slice(0, 2).join(' ')), [
    '2026-10-14T12:00:00Z met', '2026-10-14T12:00:00Z smhi', '2026-10-14T12:00:00Z blend',
    '2026-10-14T13:00:00Z met', '2026-10-14T13:00:00Z smhi', '2026-10-14T13:00:00Z blend',
  ]);
  assert.ok(lines.slice(1).every(l => l.split(',')[col('fetched_at')].endsWith(':17:00Z')));  // första körningen behölls

  // Giltighetstid nästa år → nästa års fil
  const row = C.HEADER.map(() => '');
  row[col('valid_time')] = '2027-01-01T05:00:00Z'; row[col('source')] = 'met';
  C.appendRows(dir, [{ lead: 6, row }]);
  assert.ok(fs.existsSync(path.join(dir, 'forecasts', '2027', 'lead_006h.csv')));
});

test('migrateOldFiles flyttar rader från det gamla formatet', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-'));
  fs.mkdirSync(path.join(dir, 'forecasts'));
  // Utdrag ur den första riktiga körningen, plus en senare körning samma timme (dubblett)
  // och en viktad rad utan SMHI-rad bredvid
  const old = [
    'valid_time,lead_h,source,fetched_at,issued_at,step_h,temp,temp_p10,temp_p90,wind,wind_p10,wind_p90,gust,wind_dir,humidity,pressure,cloud,precip,precip_p10,precip_p90,precip_prob,thunder,symbol',
    '2026-10-13T12:00:00Z,1,met,2026-10-13T11:12:35Z,2026-10-13T10:32:30Z,1,3.7,2.6,4.9,1.7,0.4,2,3.9,159,90,1022.7,97,0,0,0,0,,cloudy',
    '2026-10-13T12:00:00Z,1,smhi,2026-10-13T11:12:35Z,2026-10-13T10:45:00Z,1,3.2,3.2,3.2,1.7,1.7,1.7,4,159,89,1022.7,100,0,0,0,0,3,cloudy',
    '2026-10-13T12:00:00Z,1,blend,2026-10-13T11:12:35Z,2026-10-13T10:45:00Z,1,3.5,2.8,4.1,1.7,1.1,1.9,4,159,89,1022.7,99,0,0,0,0,3,cloudy',
    '2026-10-13T14:00:00Z,3,met,2026-10-13T11:12:35Z,2026-10-13T10:32:30Z,1,3.5,2.2,4.7,1.5,1.3,2.4,3.6,142,92,1021.1,97,0,0,0,0,,cloudy',
    '2026-10-13T14:00:00Z,3,blend,2026-10-13T11:12:35Z,2026-10-13T10:45:00Z,1,3.3,2.5,3.9,1.5,1.4,1.9,3.7,142,92,1021.1,98,0,0,0,0,3,cloudy',
    '2026-10-13T12:00:00Z,1,met,2026-10-13T11:20:00Z,2026-10-13T10:32:30Z,1,9.9,2.6,4.9,1.7,0.4,2,3.9,159,90,1022.7,97,0,0,0,0,,cloudy',
  ];
  fs.writeFileSync(path.join(dir, 'forecasts', '2026-10.csv'), old.join('\n') + '\n');

  assert.equal(C.migrateOldFiles(dir), 5);
  assert.ok(!fs.existsSync(path.join(dir, 'forecasts', '2026-10.csv')));
  const read = f => fs.readFileSync(path.join(dir, 'forecasts', '2026', f), 'utf8').trimEnd().split('\n').map(l => l.split(','));
  const one1 = read('lead_001h.csv');
  assert.deepEqual(one1[0], C.HEADER);
  assert.deepEqual(one1.slice(1).map(r => r[col('source')]), ['met', 'smhi', 'blend']);
  assert.equal(one1[1][col('temp')], '3.7');                  // den tidigare körningen behölls
  assert.equal(one1[2][col('temp_p10')], '');                 // SMHI:s falska band tömt
  assert.deepEqual(one1.slice(1).map(r => r[col('interpolated')]), ['0', '0', '0']);
  const three = read('lead_003h.csv');
  assert.deepEqual(three.slice(1).map(r => r[col('source')] + r[col('interpolated')]), ['met0', 'blend1']);
  assert.equal(C.migrateOldFiles(dir), 0);                    // inget kvar att flytta
});

test('fmt: tomt för saknat, avrundat utan onödiga nollor', () => {
  assert.equal(C.fmt(null, 1), '');
  assert.equal(C.fmt(NaN, 1), '');
  assert.equal(C.fmt(12.04, 1), '12');
  assert.equal(C.fmt(-0.04, 1), '0');
  assert.equal(C.fmt(1012.345, 1), '1012.3');
});
