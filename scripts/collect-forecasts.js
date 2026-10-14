#!/usr/bin/env node
// ── PROGNOSARKIV ─────────────────────────────────────────────────────────────
// Hämtar met.no och SMHI för en plats och sparar vad de förutsäger för ett
// antal prognoslängder framåt (1h, 3h, … 168h), så att prognoserna senare kan
// jämföras mot uppmätta värden. Körs varje timme av
// .github/workflows/collect-forecasts.yml. Se docs/forecast-archive.md.
//
//   FORECAST_LAT=59.33 FORECAST_LON=18.07 node scripts/collect-forecasts.js <utkatalog>
//
// En fil per prognoslängd och år, <utkatalog>/forecasts/ÅÅÅÅ/lead_024h.csv,
// med tre rader per timme (met, smhi, blend). Varje körning lägger till en
// timme i varje fil, så filerna blir löpande tidsserier sorterade på
// valid_time. Koordinaterna skrivs aldrig till fil eller logg.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const FS = require('../forecast-sources.js');

const H = 3600e3;
const LEADS_H = [1, 3, 6, 12, 24, 48, 72, 120, 168];
const USER_AGENT = 'weather_app-forecast-archive/1.0 github.com/erikae-9/weather_app';

// [kolumn, nyckel i blend().blended, decimaler]
const VALUE_COLUMNS = [
  ['temp', 'temp', 1], ['temp_p10', 'temp_p10', 1], ['temp_p90', 'temp_p90', 1],
  ['wind', 'wind', 1], ['wind_p10', 'wind_p10', 1], ['wind_p90', 'wind_p90', 1],
  ['gust', 'gust', 1], ['wind_dir', 'wind_direction', 0],
  ['humidity', 'humidity', 0], ['pressure', 'pressure', 1], ['cloud', 'cloud', 0],
  ['precip', 'precip_amount', 2], ['precip_p10', 'precip_min', 2], ['precip_p90', 'precip_max', 2],
  ['precip_prob', 'precip_prob', 0], ['thunder', 'thunder', 0],
];
// SMHI har inga percentiler för temperatur och vind. blend() fyller då
// bandet med själva prognosvärdet (bra för appen), men här ska det vara tomt
// så att SMHI inte ser ut att ha ett band med noll spridning.
const NO_BAND = { smhi: new Set(['temp_p10', 'temp_p90', 'wind_p10', 'wind_p90']) };
const HEADER = ['valid_time', 'source', 'interpolated', 'fetched_at', 'issued_at',
  ...VALUE_COLUMNS.map(c => c[0]), 'symbol'];
const SOURCES = ['met', 'smhi', 'blend'];     // radordning inom en timme
const col = name => HEADER.indexOf(name);

const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const isoOrEmpty = s => (s ? iso(Date.parse(s)) : '');

function fmt(v, decimals) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '';
  return String(Number(v.toFixed(decimals)));     // utan avslutande nollor, -0 → 0
}

// Modellkörningens tid enligt källan (inte när vi hämtade den)
function issuedAt(raw) {
  const met = isoOrEmpty(raw.met?.properties?.meta?.updated_at);
  const smhi = isoOrEmpty(raw.smhi?.referenceTime ?? raw.smhi?.createdTime);
  return { met, smhi, blend: [met, smhi].sort().pop() || '' };
}

// Rena källor körs var för sig (met.no-raden ska inte låna SMHI:s åska).
// Viktad görs bara när båda finns – med en källa vore den samma som den källan.
// Prognoslängd räknas från hämtningstiden avrundad nedåt till hel timme:
// hämtat 12:02 → 1h = 13:00, 168h = samma tid om en vecka.
//
// Varje giltighetstid samplas som ett 1h-steg, så att alla längder får ett
// värde varje timme. Där källan har längre steg (6h efter 2–3 dygn) blir
// momentanvärden linjärt interpolerade och nederbörden fördelas jämnt över
// steget – raden får då interpolated = 1.
//
// Returnerar [{ lead, row }].
function buildRows(raw, fetchedMs) {
  const base = Math.floor(fetchedMs / H) * H;
  const issued = issuedAt(raw);
  const sources = {};
  if (raw.met) sources.met = FS.normalizeMet(raw.met);
  if (raw.smhi) sources.smhi = FS.normalizeSmhi(raw.smhi);
  const runs = [];
  if (sources.met) runs.push(['met', { met: sources.met }]);
  if (sources.smhi) runs.push(['smhi', { smhi: sources.smhi }]);
  if (sources.met && sources.smhi) runs.push(['blend', sources]);

  const grid = LEADS_H.map(lead => ({ t: base + lead * H, stepH: 1 }));
  const items = [];
  for (const [mode, subset] of runs) {
    const { blended: b } = FS.blend(subset, grid, FS.MODES[mode].weights, fetchedMs);
    const native = Object.values(subset).map(src => new Set(src.points.map(p => p.t)));
    grid.forEach(({ t }, i) => {
      if (b.temp[i] === null) return;
      items.push({ lead: LEADS_H[i], row: [
        iso(t), mode, native.every(times => times.has(t)) ? 0 : 1, iso(fetchedMs), issued[mode],
        ...VALUE_COLUMNS.map(([column, key, dec]) =>
          (NO_BAND[mode]?.has(column) ? '' : fmt(b[key][i], dec))),
        b.symbol[i] ?? '',
      ] });
    });
  }
  return items;
}

const leadFile = (outDir, validIso, lead) =>
  path.join(outDir, 'forecasts', validIso.slice(0, 4), `lead_${String(lead).padStart(3, '0')}h.csv`);

// Lägger till rader sist i respektive fil. En timme som redan finns för en
// källa (t.ex. manuell körning samma timme som en schemalagd) hoppas över,
// så den tidigast hämtade prognosen behålls. Returnerar antal skrivna rader.
function appendRows(outDir, items) {
  const byFile = new Map();
  for (const { lead, row } of items) {
    const file = leadFile(outDir, row[col('valid_time')], lead);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(row);
  }
  const key = r => `${r[col('valid_time')]},${r[col('source')]}`;
  let written = 0;
  for (const [file, rows] of byFile) {
    const exists = fs.existsSync(file);
    const seen = new Set(exists
      ? fs.readFileSync(file, 'utf8').split('\n').slice(1).filter(Boolean).map(l => key(l.split(',')))
      : []);
    const fresh = rows.filter(r => !seen.has(key(r)) && seen.add(key(r)));
    if (!fresh.length) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lines = (exists ? [] : [HEADER]).concat(fresh).map(r => r.join(','));
    fs.appendFileSync(file, lines.join('\n') + '\n');
    written += fresh.length;
  }
  return written;
}

// Engångsflytt av rader i det första formatet (forecasts/ÅÅÅÅ-MM.csv, alla
// längder i en fil) till filerna per längd. De raderna låg alltid på någon
// källas tidsaxel; viktad räknas som interpolerad om met- eller SMHI-raden
// från samma körning saknas. Kan tas bort när den har körts.
function migrateOldFiles(outDir) {
  const dir = path.join(outDir, 'forecasts');
  if (!fs.existsSync(dir)) return 0;
  const names = fs.readdirSync(dir).filter(n => /^\d{4}-\d{2}\.csv$/.test(n));
  const old = [];
  for (const name of names) {
    const [head, ...lines] = fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n');
    const cols = head.split(',');
    for (const line of lines) {
      old.push(Object.fromEntries(line.split(',').map((v, i) => [cols[i], v])));
    }
  }
  const have = new Set(old.map(o => `${o.valid_time},${o.lead_h},${o.fetched_at},${o.source}`));
  const items = old.map(o => {
    const id = `${o.valid_time},${o.lead_h},${o.fetched_at}`;
    const interpolated = o.source === 'blend' && !(have.has(`${id},met`) && have.has(`${id},smhi`)) ? 1 : 0;
    return { lead: Number(o.lead_h), row: HEADER.map(c =>
      c === 'interpolated' ? interpolated : (NO_BAND[o.source]?.has(c) ? '' : o[c] ?? '')) };
  });
  // Sorterat på giltighetstid och källa; vid dubbletter först den tidigast hämtade
  const order = r => [r[col('valid_time')], SOURCES.indexOf(r[col('source')]), r[col('fetched_at')]];
  items.sort((x, y) => {
    const a = order(x.row), b = order(y.row);
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
  });
  const written = appendRows(outDir, items);
  for (const name of names) fs.unlinkSync(path.join(dir, name));
  return written;
}

// Felmeddelanden får inte innehålla URL:en, eftersom den innehåller koordinaterna
async function fetchJson(name, url, headers = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(30e3) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt >= 2) throw new Error(`${name}: ${e.message}`);
      await new Promise(r => setTimeout(r, 5e3));
    }
  }
}

function readCoord(name, limit) {
  const v = Number(process.env[name]);
  if (!process.env[name] || !Number.isFinite(v) || Math.abs(v) > limit) {
    throw new Error(`${name} saknas eller är ogiltig (sätt den som repository secret)`);
  }
  return v;
}

async function main() {
  const outDir = process.argv[2] || 'data';
  const lat = readCoord('FORECAST_LAT', 90);
  const lon = readCoord('FORECAST_LON', 180);
  const fetchedMs = Date.now();

  // met.no tillåter högst 4 decimaler och kräver en User-Agent som identifierar appen
  const [met, smhi] = await Promise.allSettled([
    fetchJson('met.no',
      `https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`,
      { 'User-Agent': USER_AGENT }),
    fetchJson('SMHI',
      `https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/geotype/point/lon/${lon.toFixed(6)}/lat/${lat.toFixed(6)}/data.json`),
  ]);
  for (const r of [met, smhi]) {
    if (r.status === 'rejected') console.log(`::warning::${r.reason.message}`);
  }
  const raw = {
    met: met.status === 'fulfilled' ? met.value : null,
    smhi: smhi.status === 'fulfilled' ? smhi.value : null,
  };
  if (!raw.met && !raw.smhi) throw new Error('Ingen källa svarade');

  const migrated = migrateOldFiles(outDir);
  if (migrated) console.log(`${migrated} rader flyttade från det gamla formatet`);
  const written = appendRows(outDir, buildRows(raw, fetchedMs));
  console.log(`${written} rader → ${path.join(outDir, 'forecasts')}`);
}

if (require.main === module) {
  main().catch(e => { console.error(`::error::${e.message}`); process.exit(1); });
}

module.exports = { LEADS_H, HEADER, buildRows, appendRows, migrateOldFiles, fmt };
