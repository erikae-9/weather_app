// ── DEMODATA ─────────────────────────────────────────────────────────────────
// Syntetiska svar i exakt samma format som met.no (locationforecast 2.0
// /complete) och SMHI (snow1g v1). Används när API:erna inte går att nå,
// t.ex. i förhandsvisningar, så att utkasten alltid visar ett realistiskt
// läge. Vädret är påhittat men följer årstid, latitud och dygnsrytm, och är
// detsamma för samma plats och dag.

(function (root) {
'use strict';
const H = 3600e3;

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r1 = v => Math.round(v * 10) / 10;

function makeModel(lat, lon, t0) {
  const day = Math.floor(t0 / 864e5);
  const rnd = mulberry32((Math.round(lat * 100) * 7919) ^ (Math.round(lon * 100) * 104729) ^ day);
  const ph = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];
  const fronts = [
    { h: 20 + rnd() * 16, w: 6 + rnd() * 3, amp: 1.0 + rnd() * 0.9 },
    { h: 95 + rnd() * 30, w: 8 + rnd() * 4, amp: 0.5 + rnd() * 0.6 },
    { h: 170 + rnd() * 30, w: 7, amp: 0.4 + rnd() * 0.5 },
  ];
  const doy = (t0 - Date.UTC(new Date(t0).getUTCFullYear(), 0, 1)) / 864e5;
  const season = Math.cos(2 * Math.PI * (doy - 200) / 365);          // +1 sommar, −1 vinter
  const clim = 6 + 10 * season - (lat - 59) * 1.3;
  const diurnal = 2.5 + 3 * Math.max(0, Math.cos(2 * Math.PI * (doy - 172) / 365));
  const noise = h => { const s = Math.sin(h * 12.9898 + lat * 78.233) * 43758.5453; return s - Math.floor(s); };

  return function at(ms, o = {}) {
    const h = (ms - t0) / H - (o.shift || 0);
    const solarHour = (((ms / H) + lon / 15) % 24 + 24) % 24;
    let front = 0, wide = 0;
    for (const f of fronts) {
      front += f.amp * Math.exp(-(((h - f.h) / f.w) ** 2));
      wide += Math.exp(-(((h - f.h) / (f.w * 2.2)) ** 2));
    }
    wide = Math.min(1.2, wide);
    const temp = clim + 2.6 * Math.sin(2 * Math.PI * h / 110 + ph[0]) + 1.6 * Math.sin(2 * Math.PI * h / 47 + ph[1])
      + diurnal * Math.cos(2 * Math.PI * (solarHour - 14.5) / 24) * (1 - 0.6 * Math.min(1, wide))
      + 2.2 * wide - 3.5 * Math.max(0, (h - 150) / 90) * (season < 0 ? 1 : 0) + (o.dT || 0);
    const cloud = clamp(28 + 72 * Math.min(1, wide * 1.25) + 28 * Math.sin(2 * Math.PI * h / 31 + ph[2]), 0, 100);
    let rate = front * (0.75 + 0.25 * Math.sin(h * 0.9 + ph[1]));
    if (cloud > 70 && noise(Math.floor(h)) > 0.82) rate += 0.15 + 0.4 * noise(Math.floor(h) + 0.5);   // enstaka skurar
    rate = rate < 0.06 ? 0 : rate * (o.pk || 1);
    const wind = clamp((2.2 + 2.6 * Math.sin(2 * Math.PI * h / 70 + ph[2]) ** 2 + 7.5 * Math.min(1, wide)
      + 0.9 * Math.cos(2 * Math.PI * (solarHour - 15) / 24)) * (o.wk || 1), 0.2, 40);
    const dir = (205 + 75 * Math.tanh((h - fronts[0].h) / 10) + 35 * Math.sin(2 * Math.PI * h / 90 + ph[0]) + 720) % 360;
    const lead = Math.max(0, h);
    return {
      temp, cloud, rate, wind, dir,
      gust: wind * 1.55 + 1.3,
      humidity: clamp(72 + 24 * Math.min(1, wide) + 9 * Math.cos(2 * Math.PI * (solarHour - 4) / 24), 35, 100),
      pressure: 1014 - 17 * Math.min(1, wide) + 7 * Math.sin(2 * Math.PI * h / 130 + ph[3]),
      tSpread: 0.6 + 0.035 * lead, wSpread: 0.5 + 0.02 * lead,
      prob: clamp(100 * ((1 - Math.exp(-(rate + 0.12 * wide) * 3.2)) * (1 - Math.min(0.5, lead / 400)) + 0.3 * Math.min(1, wide) * Math.min(0.5, lead / 400)), 0, 100),
      thunder: clamp((temp > 4 ? 1 : 0.35) * front * 9 * (season > 0 ? 3 : 1), 0, 60),
    };
  };
}

function symbolFor(p, alt) {
  const sfx = alt > -0.833 ? '_day' : '_night';
  if (p.rate >= 0.1) {
    const type = p.temp < -0.3 ? 'snow' : p.temp < 1.5 ? 'sleet' : 'rain';
    const inten = p.rate < 0.5 ? 'light' : p.rate > 2.5 ? 'heavy' : '';
    if (p.cloud < 80) return `${inten}${type}showers${sfx}`;
    return `${inten}${type}`;
  }
  if (p.cloud < 12) return 'clearsky' + sfx;
  if (p.cloud < 35) return 'fair' + sfx;
  if (p.cloud < 78) return 'partlycloudy' + sfx;
  return 'cloudy';
}
const WSYMB = { clearsky: 1, fair: 2, partlycloudy: 3, cloudy: 6, fog: 7,
  lightrainshowers: 8, rainshowers: 9, heavyrainshowers: 10, lightsleetshowers: 12, sleetshowers: 13,
  heavysleetshowers: 14, lightsnowshowers: 15, snowshowers: 16, heavysnowshowers: 17, lightrain: 18, rain: 19,
  heavyrain: 20, lightsleet: 22, sleet: 23, heavysleet: 24, lightsnow: 25, snow: 26, heavysnow: 27 };

function integrate(at, a, b, o) {
  let sum = 0, pmax = 0, q = 1;
  for (let t = a; t < b; t += H / 2) {
    const p = at(t + H / 4, o);
    sum += p.rate / 2;
    pmax = Math.max(pmax, p.prob);
    q *= Math.pow(1 - p.prob / 100, 0.25);
  }
  // mellan "maxtimmen" och oberoende union (persistens)
  const union = 100 * (1 - q);
  return { sum, prob: pmax + 0.45 * (union - pmax) };
}

function generate(lat, lon, nowMs) {
  const sun = (ms) => root.WX ? root.WX.sunAltitude(ms, lat, lon) : 10;
  const t0 = Math.floor(nowMs / H) * H;
  const at = makeModel(lat, lon, t0);

  // met.no: 1h-steg i ~60 h, sedan 6h-steg till ~9,5 dygn
  const metTimes = [];
  for (let k = 0; k <= 60; k++) metTimes.push(t0 + k * H);
  let t6 = Math.ceil((t0 + 61 * H) / (6 * H)) * 6 * H;
  for (; t6 <= t0 + 228 * H; t6 += 6 * H) metTimes.push(t6);
  const metTs = metTimes.map((t, k) => {
    const p = at(t), hourly = k <= 60;
    const blk = (hrs) => {
      const g = integrate(at, t, t + hrs * H);
      const pm = at(t + hrs * H / 2);
      const sym = symbolFor({ ...pm, rate: g.sum / hrs }, sun(t + hrs * H / 2));
      return { summary: { symbol_code: sym }, details: {
        precipitation_amount: r1(g.sum),
        precipitation_amount_min: g.prob >= 90 ? r1(g.sum * 0.4) : 0,
        precipitation_amount_max: g.prob > 15 ? r1(g.sum * 1.9 + 0.2 * hrs) : r1(g.sum),
        probability_of_precipitation: Math.round(g.prob),
      } };
    };
    const n6 = blk(6);
    const e = { time: new Date(t).toISOString(), data: {
      instant: { details: {
        air_temperature: r1(p.temp),
        air_temperature_percentile_10: r1(p.temp - p.tSpread), air_temperature_percentile_90: r1(p.temp + p.tSpread),
        wind_speed: r1(p.wind), wind_speed_percentile_10: r1(Math.max(0, p.wind - p.wSpread)), wind_speed_percentile_90: r1(p.wind + p.wSpread),
        wind_speed_of_gust: r1(p.gust), wind_from_direction: r1(p.dir),
        relative_humidity: r1(p.humidity), air_pressure_at_sea_level: r1(p.pressure),
        cloud_area_fraction: r1(p.cloud), ultraviolet_index_clear_sky: r1(Math.max(0, 9 * Math.sin(Math.max(0, sun(t)) * Math.PI / 180) ** 1.3)),
      } },
      next_6_hours: n6,
      next_12_hours: { summary: n6.summary, details: { probability_of_precipitation: Math.round(Math.min(100, integrate(at, t, t + 12 * H).prob)) } },
    } };
    if (hourly) e.data.next_1_hours = blk(1);
    return e;
  });
  const met = { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat, 0] },
    properties: { meta: { updated_at: new Date(t0).toISOString() }, timeseries: metTs } };

  // SMHI: 1h i 48 h, 3h till 72 h, 6h till 144 h, 12h till 240 h. Lite
  // annorlunda modellkörning: fronten en och en halv timme senare, något
  // kallare och blåsigare.
  const o = { shift: 1.5, dT: -0.5, wk: 1.08, pk: 0.9 };
  const smhiTimes = [];
  for (let k = 1; k <= 48; k++) smhiTimes.push(t0 + k * H);
  let ts = t0 + 48 * H;
  for (const [step, until] of [[3, 72], [6, 144], [12, 240]]) {
    for (ts += step * H; ts <= t0 + until * H; ts += step * H) smhiTimes.push(ts);
    ts -= step * H;
  }
  const smhiTs = smhiTimes.map((t, k) => {
    const start = k === 0 ? t0 : smhiTimes[k - 1];
    const p = at(t, o);
    const g = integrate(at, start, t, o);
    const hrs = (t - start) / H;
    const pm = at((start + t) / 2, o);
    const symName = symbolFor({ ...pm, rate: g.sum / hrs }, sun((start + t) / 2)).replace(/_(day|night)$/, '');
    return { time: new Date(t).toISOString(), intervalParametersStartTime: new Date(start).toISOString(), data: {
      air_temperature: r1(p.temp), wind_speed: r1(p.wind), wind_speed_of_gust: r1(p.gust),
      wind_from_direction: Math.round(p.dir), relative_humidity: Math.round(p.humidity),
      air_pressure_at_mean_sea_level: r1(p.pressure), cloud_area_fraction: Math.round(p.cloud / 12.5),
      thunderstorm_probability: Math.round(p.thunder),
      precipitation_amount_mean: r1(g.sum),
      precipitation_amount_min: g.sum > 0 ? r1(g.sum * 0.6 + 0.1) : 0,
      precipitation_amount_max: g.sum > 0 ? r1(g.sum * 2 + 0.3) : 0,
      probability_of_precipitation: Math.round(g.prob),
      symbol_code: WSYMB[symName] ?? 6,
    } };
  });
  const smhi = { createdTime: new Date(t0).toISOString(), referenceTime: new Date(t0).toISOString(),
    geometry: { type: 'Point', coordinates: [lon, lat] }, timeSeries: smhiTs };
  return { met, smhi };
}

root.WXDemo = { generate };
})(typeof window !== 'undefined' ? window : globalThis);
