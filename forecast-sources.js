// ── FLERA PROGNOSKÄLLOR (UTKAST) ─────────────────────────────────────────────
// Fristående modul, ännu inte inkopplad i index.html. Se
// docs/multi-source-forecast.md för hur den är tänkt att användas.
//
// Flöde:
//   1. adapter   – varje källas rå-JSON → gemensamt format
//                  { id, points: [mätvärden vid tidpunkt], periods: [nederbörd för intervall] }
//   2. grid      – välj tidsaxel (met.no:s eller SMHI:s tidssteg)
//   3. sample    – varje källa interpoleras/aggregeras till tidsaxeln
//   4. blend     – viktat medel per parameter och tidssteg; vikterna kan bero
//                  på källa, parameter och prognoslängd (lead time)
//   5. output    – samma form som weatherData i index.html, så att grafer,
//                  tabell och kort fungerar oförändrade
//
// Att "byta prognos" är bara ett annat viktschema: met.no = { met: 1, smhi: 0 },
// SMHI = { met: 0, smhi: 1 }, viktad = båda > 0.

(function (root) {
'use strict';

const H = 3600e3;
const Z90 = 1.2816;            // z-värde för 10:e/90:e percentilen
const MAX_INTERP_GAP_H = 12;   // längre lucka mellan två punkter → ingen interpolation

// ── ADAPTER: met.no locationforecast 2.0 /complete ───────────────────────────

function normalizeMet(json) {
  const points = [], periods = [];
  for (const e of json.properties.timeseries) {
    const t = new Date(e.time).getTime();
    const inst = e.data.instant.details;
    const n1 = e.data.next_1_hours, n6 = e.data.next_6_hours;
    points.push({
      t,
      temp:           inst.air_temperature ?? null,
      temp_p10:       inst.air_temperature_percentile_10 ?? null,
      temp_p90:       inst.air_temperature_percentile_90 ?? null,
      wind:           inst.wind_speed ?? null,
      wind_p10:       inst.wind_speed_percentile_10 ?? null,
      wind_p90:       inst.wind_speed_percentile_90 ?? null,
      gust:           inst.wind_speed_of_gust ?? null,
      wind_direction: inst.wind_from_direction ?? null,
      humidity:       inst.relative_humidity ?? null,
      pressure:       inst.air_pressure_at_sea_level ?? null,
      cloud:          inst.cloud_area_fraction ?? null,
      uv:             inst.ultraviolet_index_clear_sky ?? null,
      thunder:        null,
      // met.no:s egna block-sannolikheter; används bara för persistens-
      // kalibreringen i index.html och blandas inte
      prob6h:  n6?.details?.probability_of_precipitation ?? null,
      prob12h: e.data.next_12_hours?.details?.probability_of_precipitation ?? null,
    });
    // met.no: next_N_hours gäller intervallet [t, t + N h)
    const block = n1 || n6;
    if (block) {
      const hours = n1 ? 1 : 6;
      periods.push({
        start: t, end: t + hours * H,
        amount: block.details?.precipitation_amount ?? null,
        min:    block.details?.precipitation_amount_min ?? null,
        max:    block.details?.precipitation_amount_max ?? null,
        prob:   block.details?.probability_of_precipitation ?? null,
        symbol: block.summary?.symbol_code ?? null,
      });
    }
  }
  return { id: 'met', label: 'met.no', points, periods };
}

// ── ADAPTER: SMHI snow1g v1 punktprognos ────────────────────────────────────
// Strukturen (timeSeries[].time, timeSeries[].data.<parameter>) är densamma
// som fetchSMHIThunder i index.html redan läser. Verifierat mot parameter.json
// och ett punktsvar: namnen nedan, molnighet i oktas, saknat värde = 9999.
// Intervallparametrar (nederbörd, symbol) gäller (intervalParametersStartTime, time].
// Nederbörd (verifierat mot ett 10-dagarssvar med 1h-, 2h-, 6h- och 12h-intervall):
//   - precipitation_amount_mean är total mängd för intervallet, inte mm/h.
//     Som intensitet skulle 12h-intervallen ge 15–50 mm vid 10–30 % risk.
//   - precipitation_amount_min/max är spannet *om det blir nederbörd* (bland
//     de ensemblemedlemmar som ger nederbörd). min är ofta större än mean,
//     t.ex. mean 0.1, min 1.2, max 1.8 vid 8 % risk – se smhiBand nedan.
// thunderstorm_probability är i procent trots enheten "fraction".
const SMHI_PARAMS = {
  temp:           'air_temperature',
  wind:           'wind_speed',
  gust:           'wind_speed_of_gust',
  wind_direction: 'wind_from_direction',
  humidity:       'relative_humidity',
  pressure:       'air_pressure_at_mean_sea_level',
  cloud:          'cloud_area_fraction',
  thunder:        'thunderstorm_probability',
  precip_mean:    'precipitation_amount_mean',
  precip_min:     'precipitation_amount_min',
  precip_max:     'precipitation_amount_max',
  precip_prob:    'probability_of_precipitation',
  symbol:         'symbol_code',
};
const SMHI_CLOUD_IN_OCTAS = true;        // enligt parameter.json

// SMHI Wsymb2 (1–27) → met.no symbol_code, så att getWeatherEmoji/-Description funkar
const SMHI_SYMBOLS = [null,
  'clearsky_day', 'fair_day', 'partlycloudy_day', 'partlycloudy_day', 'cloudy', 'cloudy', 'fog',
  'lightrainshowers_day', 'rainshowers_day', 'heavyrainshowers_day', 'rainshowersandthunder_day',
  'lightsleetshowers_day', 'sleetshowers_day', 'heavysleetshowers_day',
  'lightsnowshowers_day', 'snowshowers_day', 'heavysnowshowers_day',
  'lightrain', 'rain', 'heavyrain', 'rainandthunder',
  'lightsleet', 'sleet', 'heavysleet', 'lightsnow', 'snow', 'heavysnow'];

// SMHI:s min/max gäller bara de fall där det blir nederbörd. Gör om dem
// till ungefärliga p10/p90 för hela fördelningen, som met.no:s min/max:
//   p10: torrt i mer än 10 % av fallen → 0, annars det villkorade minimum
//   p90: nederbörd i mer än 10 % av fallen → det villkorade maximum, annars 0
function smhiBand(prob, min, max) {
  if (prob === null) return { lo: null, hi: null };
  const p = prob / 100;
  return {
    lo: p >= 0.9 ? min : 0,
    hi: p > 0.1 ? max : 0,
  };
}

function normalizeSmhi(json) {
  // 9999 = saknas (parameter.json). Negativa värden behandlas också som
  // saknade (t.ex. precipitation_frozen_part: -9 utan nederbörd) – utom för
  // temperatur.
  const get = (d, key, allowNegative = false) => {
    const v = d?.[SMHI_PARAMS[key]];
    if (v === undefined || v === null || v >= 9999) return null;
    if (!allowNegative && v < 0) return null;
    return v;
  };
  const ts = (json.timeSeries || [])
    .map(e => ({
      t: new Date(e.time).getTime(),
      start: e.intervalParametersStartTime ? new Date(e.intervalParametersStartTime).getTime() : null,
      d: e.data,
    }))
    .sort((a, b) => a.t - b.t);

  const points = ts.map(({ t, d }) => {
    const cloud = get(d, 'cloud');
    return {
      t,
      temp: get(d, 'temp', true), temp_p10: null, temp_p90: null,
      wind: get(d, 'wind'), wind_p10: null, wind_p90: null,
      gust: get(d, 'gust'),
      wind_direction: get(d, 'wind_direction'),
      humidity: get(d, 'humidity'),
      pressure: get(d, 'pressure'),
      cloud: cloud === null ? null : (SMHI_CLOUD_IN_OCTAS ? cloud * 100 / 8 : cloud),
      uv: null,
      thunder: get(d, 'thunder'),
      prob6h: null, prob12h: null,
    };
  });

  const periods = [];
  for (let i = 0; i < ts.length; i++) {
    // Intervallet anges av intervalParametersStartTime; saknas fältet antas
    // det gå från föregående tidpunkt.
    const end = ts[i].t;
    const start = ts[i].start ?? (i > 0 ? ts[i - 1].t : null);
    if (start === null || start >= end) continue;
    const d = ts[i].d;
    const prob = get(d, 'precip_prob');
    const band = smhiBand(prob, get(d, 'precip_min'), get(d, 'precip_max'));
    const code = get(d, 'symbol');
    periods.push({
      start, end,
      amount: get(d, 'precip_mean'),
      min:    band.lo,
      max:    band.hi,
      prob,
      symbol: code === null ? null : (SMHI_SYMBOLS[Math.round(code)] ?? null),
    });
  }
  return { id: 'smhi', label: 'SMHI', points, periods };
}

// ── TIDSAXEL ─────────────────────────────────────────────────────────────────
// En grid är [{ t, stepH }]. met.no:s egen axel ger 1h-steg följt av 6h-steg;
// SMHI:s axel byggs från avståndet till nästa punkt.

function gridFromSource(src) {
  if (src.id === 'met') {
    const byStart = new Map(src.periods.map(p => [p.start, (p.end - p.start) / H]));
    return src.points.map(p => ({ t: p.t, stepH: byStart.get(p.t) ?? null }));
  }
  return src.points.map((p, i, a) => ({
    t: p.t,
    stepH: i + 1 < a.length ? (a[i + 1].t - p.t) / H : (i > 0 ? (p.t - a[i - 1].t) / H : 1),
  }));
}

// ── SAMPLING ─────────────────────────────────────────────────────────────────

const INSTANT_KEYS = ['temp', 'temp_p10', 'temp_p90', 'wind', 'wind_p10', 'wind_p90',
  'gust', 'humidity', 'pressure', 'cloud', 'uv', 'thunder', 'prob6h', 'prob12h'];
const NO_INTERP = new Set(['prob6h', 'prob12h']);   // blockvärden: bara exakt träff

// Hitta index för sista punkten med p.t <= t (binärsökning)
function floorIndex(points, t) {
  let lo = 0, hi = points.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function interpInstant(points, t, key) {
  const i = floorIndex(points, t);
  if (i < 0) return null;
  const a = points[i];
  if (a.t === t) return a[key];
  if (NO_INTERP.has(key)) return null;
  const b = points[i + 1];
  if (!b || (b.t - a.t) > MAX_INTERP_GAP_H * H) return null;
  if (a[key] === null || b[key] === null) return null;
  const f = (t - a.t) / (b.t - a.t);
  return a[key] + f * (b[key] - a[key]);
}

// Vindriktning interpoleras som vektor (350° → 10° ska gå via 0°, inte 180°)
function interpDirection(points, t) {
  const i = floorIndex(points, t);
  if (i < 0) return null;
  const a = points[i];
  if (a.t === t) return a.wind_direction;
  const b = points[i + 1];
  if (!b || (b.t - a.t) > MAX_INTERP_GAP_H * H) return null;
  if (a.wind_direction === null || b.wind_direction === null) return null;
  const f = (t - a.t) / (b.t - a.t);
  return circularWeightedMean([a.wind_direction, b.wind_direction], [1 - f, f]);
}

// Summera nederbörd över [t0, t1) från källans perioder, proportionellt mot
// överlapp. Kräver full täckning – annars null (källan räknas då inte med).
function aggregatePeriods(periods, t0, t1) {
  let covered = 0, amount = 0, min = 0, max = 0, prob = null;
  let haveAmount = true, haveMin = true, haveMax = true;
  let symbol = null, symbolOverlap = 0;
  for (const p of periods) {
    const ov = Math.min(p.end, t1) - Math.max(p.start, t0);
    if (ov <= 0) continue;
    const frac = ov / (p.end - p.start);
    covered += ov;
    if (p.amount === null) haveAmount = false; else amount += p.amount * frac;
    // min/max saknas hos vissa steg → falla tillbaka på medelvärdet
    const pmin = p.min ?? p.amount, pmax = p.max ?? p.amount;
    if (pmin === null) haveMin = false; else min += pmin * frac;
    if (pmax === null) haveMax = false; else max += pmax * frac;
    // Sannolikhet över ett längre fönster: högsta ingående är ett golv.
    // (index.html:s unionProb vore mer korrekt men kräver persistens-L.)
    if (p.prob !== null) prob = prob === null ? p.prob : Math.max(prob, p.prob);
    if (p.symbol && ov > symbolOverlap) { symbol = p.symbol; symbolOverlap = ov; }
  }
  if (covered < (t1 - t0) * 0.99) return null;
  return {
    amount: haveAmount ? amount : null,
    min: haveMin ? min : null,
    max: haveMax ? max : null,
    prob, symbol,
  };
}

function sampleSource(src, grid) {
  const out = { precip_amount: [], precip_min: [], precip_max: [], precip_prob: [],
                symbol: [], wind_direction: [] };
  for (const k of INSTANT_KEYS) out[k] = [];
  for (const { t, stepH } of grid) {
    for (const k of INSTANT_KEYS) out[k].push(interpInstant(src.points, t, k));
    out.wind_direction.push(interpDirection(src.points, t));
    const agg = stepH ? aggregatePeriods(src.periods, t, t + stepH * H) : null;
    out.precip_amount.push(agg?.amount ?? null);
    out.precip_min.push(agg?.min ?? null);
    out.precip_max.push(agg?.max ?? null);
    out.precip_prob.push(agg?.prob ?? null);
    out.symbol.push(agg?.symbol ?? null);
  }
  return out;
}

// ── VIKTER ───────────────────────────────────────────────────────────────────
// Ett viktschema per källa är antingen ett tal, eller
//   { default: kurva, <parameter>: kurva, … }
// där en kurva är ett tal eller brytpunkter [[leadH, vikt], …] som
// interpoleras linjärt (konstant utanför ändpunkterna).
// Parametergrupper: temp, wind, gust, wind_direction, precip, precip_prob,
// thunder, humidity, pressure, cloud, uv, symbol.

function evalCurve(curve, leadH) {
  if (typeof curve === 'number') return curve;
  if (!Array.isArray(curve) || !curve.length) return 0;
  if (leadH <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [h1, w1] = curve[i];
    if (leadH <= h1) {
      const [h0, w0] = curve[i - 1];
      return w0 + (w1 - w0) * (leadH - h0) / (h1 - h0);
    }
  }
  return curve[curve.length - 1][1];
}

function weightFor(scheme, srcId, param, leadH) {
  const s = scheme[srcId];
  if (s === undefined || s === null) return 0;
  if (typeof s === 'number' || Array.isArray(s)) return Math.max(0, evalCurve(s, leadH));
  const curve = s[param] ?? s.default ?? 0;
  return Math.max(0, evalCurve(curve, leadH));
}

// Datadrivna vikter: invers kvadratisk felvikt (w ∝ 1/RMSE²). errors är
// { met: rmse, smhi: rmse } från en verifiering mot observationer.
function weightsFromErrors(errors) {
  const out = {};
  for (const [id, rmse] of Object.entries(errors)) {
    out[id] = rmse > 0 ? 1 / (rmse * rmse) : 0;
  }
  const sum = Object.values(out).reduce((a, b) => a + b, 0);
  if (sum > 0) for (const id in out) out[id] /= sum;
  return out;
}

// ── BLANDNING ────────────────────────────────────────────────────────────────

function circularWeightedMean(degs, ws) {
  let sx = 0, sy = 0;
  for (let i = 0; i < degs.length; i++) {
    if (degs[i] === null || !ws[i]) continue;
    const r = degs[i] * Math.PI / 180;
    sx += ws[i] * Math.cos(r); sy += ws[i] * Math.sin(r);
  }
  if (Math.hypot(sx, sy) < 1e-9) return null;
  return (Math.atan2(sy, sx) * 180 / Math.PI + 360) % 360;
}

// Källor med värde och vikt > 0. Om ingen viktad källa över huvud taget har
// parametern (t.ex. åska saknas hos met.no, UV saknas hos SMHI) lånas den
// från en källa som har den – så att met.no-läget fortsatt får SMHI:s åska,
// som idag. Luckor i tid (en källa tar slut tidigare) lappas däremot inte.
const hasValue = v => v !== null && v !== undefined;
function participants(ids, sampled, key, i, wts) {
  const weightedIds = ids.filter(id => wts[id] > 0);
  const lacksParam = !weightedIds.some(id => sampled[id][key].some(hasValue));
  if (!lacksParam) {
    return weightedIds.filter(id => hasValue(sampled[id][key][i])).map(id => ({ id, w: wts[id] }));
  }
  const donor = ids.find(id => hasValue(sampled[id][key][i]));
  return donor ? [{ id: donor, w: 1 }] : [];
}

function wmean(parts, sampled, key, i) {
  if (!parts.length) return null;
  let sw = 0, s = 0;
  for (const { id, w } of parts) { sw += w; s += w * sampled[id][key][i]; }
  return s / sw;
}

// Viktat medel + spridningsband. Bandet kombinerar
//   (a) källornas egen osäkerhet: viktat medel av deras p10/p90, och
//   (b) oenighet mellan källorna: viktad standardavvikelse mellan medelvärdena
// i kvadratur. Med en enda källa blir (b) = 0 och bandet är exakt källans.
function blendWithSpread(parts, sampled, key, loKey, hiKey, i, floorZero) {
  if (!parts.length) return { mean: null, lo: null, hi: null };
  let sw = 0, sm = 0, slo = 0, shi = 0;
  for (const { id, w } of parts) {
    const m = sampled[id][key][i];
    sw += w; sm += w * m;
    slo += w * (sampled[id][loKey][i] ?? m);
    shi += w * (sampled[id][hiKey][i] ?? m);
  }
  const mean = sm / sw, qlo = slo / sw, qhi = shi / sw;
  let between = 0;
  for (const { id, w } of parts) between += w * (sampled[id][key][i] - mean) ** 2;
  const zD = Z90 * Math.sqrt(between / sw);
  let lo = mean - Math.hypot(Math.max(0, mean - qlo), zD);
  const hi = mean + Math.hypot(Math.max(0, qhi - mean), zD);
  if (floorZero) lo = Math.max(0, lo);
  return { mean, lo, hi };
}

function blend(sources, grid, scheme, nowMs) {
  const ids = Object.keys(sources);
  const sampled = {};
  for (const id of ids) sampled[id] = sampleSource(sources[id], grid);

  const n = grid.length;
  const out = {
    temp: [], temp_p10: [], temp_p90: [], wind: [], wind_p10: [], wind_p90: [],
    gust: [], wind_direction: [], precip_amount: [], precip_min: [], precip_max: [],
    precip_prob: [], thunder: [], humidity: [], pressure: [], cloud: [], uv: [],
    symbol: [], prob6h: [], prob12h: [],
    weight_share: Object.fromEntries(ids.map(id => [id, []])),  // för UI: källans andel (temp)
  };

  for (let i = 0; i < n; i++) {
    const leadH = Math.max(0, (grid[i].t - nowMs) / H);
    const w = param => Object.fromEntries(ids.map(id => [id, weightFor(scheme, id, param, leadH)]));

    const tw = w('temp'), tp = participants(ids, sampled, 'temp', i, tw);
    const T = blendWithSpread(tp, sampled, 'temp', 'temp_p10', 'temp_p90', i, false);
    out.temp.push(T.mean); out.temp_p10.push(T.lo); out.temp_p90.push(T.hi);
    const twSum = tp.reduce((a, p) => a + p.w, 0);
    for (const id of ids) out.weight_share[id].push(twSum ? (tp.find(p => p.id === id)?.w ?? 0) / twSum : 0);

    const W = blendWithSpread(participants(ids, sampled, 'wind', i, w('wind')),
                              sampled, 'wind', 'wind_p10', 'wind_p90', i, true);
    out.wind.push(W.mean); out.wind_p10.push(W.lo); out.wind_p90.push(W.hi);

    const P = blendWithSpread(participants(ids, sampled, 'precip_amount', i, w('precip')),
                              sampled, 'precip_amount', 'precip_min', 'precip_max', i, true);
    out.precip_amount.push(P.mean); out.precip_min.push(P.lo); out.precip_max.push(P.hi);

    // Sannolikheter: linjär pool (viktat medel) – behåller kalibreringen
    // bättre än att t.ex. multiplicera ihop källorna.
    out.precip_prob.push(wmean(participants(ids, sampled, 'precip_prob', i, w('precip_prob')), sampled, 'precip_prob', i));
    out.thunder.push(wmean(participants(ids, sampled, 'thunder', i, w('thunder')), sampled, 'thunder', i));

    for (const k of ['gust', 'humidity', 'pressure', 'cloud', 'uv']) {
      out[k].push(wmean(participants(ids, sampled, k, i, w(k)), sampled, k, i));
    }

    const dp = participants(ids, sampled, 'wind_direction', i, w('wind_direction'));
    out.wind_direction.push(dp.length
      ? circularWeightedMean(dp.map(p => sampled[p.id].wind_direction[i]), dp.map(p => p.w))
      : null);

    // Symbol kan inte medelvärdesbildas: ta den tyngst viktade källans
    const sp = participants(ids, sampled, 'symbol', i, w('symbol'));
    const best = sp.reduce((a, b) => (!a || b.w > a.w ? b : a), null);
    out.symbol.push(best ? sampled[best.id].symbol[i] : null);

    // Block-sannolikheter finns bara hos met.no – förs vidare oblandade
    out.prob6h.push(sampled.met?.prob6h[i] ?? null);
    out.prob12h.push(sampled.met?.prob12h[i] ?? null);
  }
  return { sampled, blended: out };
}

// ── LÄGEN (det användaren växlar mellan) ─────────────────────────────────────
// Viktningen i 'blend' är en startpunkt, inte verifierad: lika vikt överallt
// utom åska, som bara SMHI har. Byt mot en lead-time-kurva eller
// weightsFromErrors(...) när det finns verifieringsdata. Exempel på kurva:
//   met:  { default: [[0, 1.5], [48, 1.0]] },   // met.no väger tyngre första dygnen
//   smhi: { default: 1, precip_prob: [[0, 1], [72, 1.5]] },
const MODES = {
  met:   { label: 'met.no', grid: 'met',  weights: { met: 1, smhi: 0 } },
  smhi:  { label: 'SMHI',   grid: 'smhi', weights: { met: 0, smhi: 1 } },
  blend: { label: 'Viktad', grid: 'met',  weights: { met: { default: 1 }, smhi: { default: 1 } } },
};

// raw: { met?: <met.no JSON>, smhi?: <SMHI JSON> }
// Returnerar { times, data } i samma form som weatherData i index.html.
// feels_like, persistenceL och rolling3h räknas av appen efteråt.
function buildForecast(mode, raw, { nowMs = Date.now(), weights } = {}) {
  const cfg = MODES[mode];
  if (!cfg) throw new Error(`Okänt prognosläge: ${mode}`);
  const sources = {};
  if (raw.met)  sources.met  = normalizeMet(raw.met);
  if (raw.smhi) sources.smhi = normalizeSmhi(raw.smhi);
  if (!Object.keys(sources).length) throw new Error('Ingen prognosdata');

  const gridSrc = sources[cfg.grid] || sources.met || sources.smhi;
  const grid = gridFromSource(gridSrc).filter(g => g.stepH !== null);
  const { sampled, blended: b } = blend(sources, grid, weights || cfg.weights, nowMs);

  const perHour = (arr) => arr.map((v, i) => v === null ? null : v / grid[i].stepH);
  const data = {
    temp: b.temp, temp_p10: b.temp_p10, temp_p90: b.temp_p90,
    wind: b.wind, wind_p10: b.wind_p10, wind_p90: b.wind_p90,
    gust: b.gust, wind_direction: b.wind_direction,
    precip: perHour(b.precip_amount),          // timtakt för grafer
    precip_step: b.precip_amount,              // hela stegets mängd för summering
    precip_p10: perHour(b.precip_min),
    precip_p90: perHour(b.precip_max),
    precip_prob: b.precip_prob,
    prob6h: b.prob6h, prob12h: b.prob12h,
    step_hours: grid.map(g => g.stepH),
    cloud: b.cloud, humidity: b.humidity, pressure: b.pressure, uv: b.uv,
    symbols: b.symbol.map(s => s || 'unknown'),
    thunder: b.thunder,
  };
  // Varje källas egen kurva (för att rita dem som tunna linjer bredvid
  // den viktade), plus källans viktandel. Platta nycklar så att sliceData
  // i index.html skivar dem automatiskt.
  for (const id of Object.keys(sampled)) {
    data[`temp_src_${id}`] = sampled[id].temp;
    data[`precip_src_${id}`] = sampled[id].precip_amount.map((v, i) => v === null ? null : v / grid[i].stepH);
    data[`precip_prob_src_${id}`] = sampled[id].precip_prob;
    data[`weight_src_${id}`] = b.weight_share[id];
  }
  return {
    mode, sourceIds: Object.keys(sources),
    times: grid.map(g => new Date(g.t)),
    data,
  };
}

const api = {
  MODES, buildForecast, weightsFromErrors,
  // exponerade för tester
  normalizeMet, normalizeSmhi, smhiBand, gridFromSource, sampleSource, aggregatePeriods,
  blend, evalCurve, weightFor,
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.ForecastSources = api;

})(typeof window !== 'undefined' ? window : globalThis);
