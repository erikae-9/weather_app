#!/usr/bin/env node
// ── PROGNOSARKIV ─────────────────────────────────────────────────────────────
// Hämtar met.no och SMHI för en plats och sparar vad de förutsäger för ett
// antal prognoslängder framåt (1h, 3h, … 168h), så att prognoserna senare kan
// jämföras mot uppmätta värden. Körs varje timme av
// .github/workflows/collect-forecasts.yml. Se docs/forecast-archive.md.
//
//   FORECAST_LAT=59.33 FORECAST_LON=18.07 node scripts/collect-forecasts.js <utkatalog>
//
// Raderna läggs till i <utkatalog>/forecasts/ÅÅÅÅ-MM.csv (månad = hämtningstid).
// Koordinaterna skrivs aldrig till fil eller logg.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const FS = require('../forecast-sources.js');

const H = 3600e3;
const LEADS_H = [1, 3, 6, 12, 24, 48, 72, 120, 168];
const USER_AGENT = 'weather_app-forecast-archive/1.0 github.com/erikae-9/weather_app';

// [kolumn, nyckel i buildForecast().data, decimaler]
const VALUE_COLUMNS = [
  ['temp', 'temp', 1], ['temp_p10', 'temp_p10', 1], ['temp_p90', 'temp_p90', 1],
  ['wind', 'wind', 1], ['wind_p10', 'wind_p10', 1], ['wind_p90', 'wind_p90', 1],
  ['gust', 'gust', 1], ['wind_dir', 'wind_direction', 0],
  ['humidity', 'humidity', 0], ['pressure', 'pressure', 1], ['cloud', 'cloud', 0],
  ['precip', 'precip', 2], ['precip_p10', 'precip_p10', 2], ['precip_p90', 'precip_p90', 2],
  ['precip_prob', 'precip_prob', 0], ['thunder', 'thunder', 0],
];
// SMHI har inga percentiler för temperatur och vind. buildForecast fyller då
// bandet med själva prognosvärdet (bra för appen), men här ska det vara tomt
// så att SMHI inte ser ut att ha ett band med noll spridning.
const NO_BAND = { smhi: new Set(['temp_p10', 'temp_p90', 'wind_p10', 'wind_p90']) };
const HEADER = ['valid_time', 'lead_h', 'source', 'fetched_at', 'issued_at', 'step_h',
  ...VALUE_COLUMNS.map(c => c[0]), 'symbol'];

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
// hämtat 12:17 → 1h = 13:00, 168h = samma tid om en vecka. Långa längder
// finns bara när giltighetstiden hamnar på källans tidsaxel (6h-steg m.m.).
function buildRows(raw, fetchedMs) {
  const base = Math.floor(fetchedMs / H) * H;
  const issued = issuedAt(raw);
  const runs = [];
  if (raw.met) runs.push(['met', { met: raw.met }]);
  if (raw.smhi) runs.push(['smhi', { smhi: raw.smhi }]);
  if (raw.met && raw.smhi) runs.push(['blend', raw]);

  const rows = [];
  for (const [mode, subset] of runs) {
    const fc = FS.buildForecast(mode, subset, { nowMs: fetchedMs });
    const index = new Map(fc.times.map((t, i) => [t.getTime(), i]));
    for (const lead of LEADS_H) {
      const t = base + lead * H;
      const i = index.get(t);
      if (i === undefined || fc.data.temp[i] === null) continue;
      rows.push([
        iso(t), lead, mode, iso(fetchedMs), issued[mode], fc.data.step_hours[i],
        ...VALUE_COLUMNS.map(([column, key, dec]) =>
          (NO_BAND[mode]?.has(column) ? '' : fmt(fc.data[key][i], dec))),
        fc.data.symbols[i] === 'unknown' ? '' : fc.data.symbols[i],
      ]);
    }
  }
  return rows;
}

function appendRows(outDir, rows, fetchedMs) {
  const file = path.join(outDir, 'forecasts', `${iso(fetchedMs).slice(0, 7)}.csv`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const isNew = !fs.existsSync(file);
  const lines = (isNew ? [HEADER] : []).concat(rows).map(r => r.join(','));
  fs.appendFileSync(file, lines.join('\n') + '\n');
  return file;
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

  const rows = buildRows(raw, fetchedMs);
  const file = appendRows(outDir, rows, fetchedMs);
  console.log(`${rows.length} rader → ${file}`);
}

if (require.main === module) {
  main().catch(e => { console.error(`::error::${e.message}`); process.exit(1); });
}

module.exports = { LEADS_H, HEADER, buildRows, appendRows, fmt };
