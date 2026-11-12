// ── WX: gemensam kärna för appen och UI-utkasten ─────────────────────────────
// Datalager (hämtning, viktning via ForecastSources, statistik), solberäkning,
// väderikoner som SVG och ett SVG-meteogram med hårkors och panorering.
// index.html och utkasten i drafts/*.html står för layout och utseende.
//
// Kräver: forecast-sources.js (ForecastSources). demo.js används som reserv
// när met.no/SMHI inte går att nå.

(function (root) {
'use strict';

const WX = {};
const H = 3600e3;
WX.H = H;

// ── STATISTIK ────────────────────────────────────────────────────────────────
const valid = a => a.filter(v => v !== null && v !== undefined && !Number.isNaN(v));
WX.valid = valid;
WX.mean = a => { const v = valid(a); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };
WX.min  = a => { const v = valid(a); return v.length ? Math.min(...v) : null; };
WX.max  = a => { const v = valid(a); return v.length ? Math.max(...v) : null; };
WX.sum  = a => { const v = valid(a); return v.length ? v.reduce((x, y) => x + y, 0) : null; };

// Vektormedel för vindriktning (350° och 10° → 0°, inte 180°)
WX.circMean = degs => {
  const v = valid(degs);
  if (!v.length) return null;
  let sx = 0, sy = 0;
  for (const d of v) { const r = d * Math.PI / 180; sx += Math.cos(r); sy += Math.sin(r); }
  if (Math.hypot(sx, sy) < 1e-9) return null;
  return (Math.atan2(sy, sx) * 180 / Math.PI + 360) % 360;
};

// ── FORMATERING ──────────────────────────────────────────────────────────────
const DIRS = ['N','NNÖ','NÖ','ÖNÖ','Ö','ÖSÖ','SÖ','SSÖ','S','SSV','SV','VSV','V','VNV','NV','NNV'];
const DIRS_LONG = { N:'nordlig', NÖ:'nordostlig', Ö:'ostlig', SÖ:'sydostlig', S:'sydlig', SV:'sydvästlig', V:'västlig', NV:'nordvästlig' };
WX.windDir = deg => deg === null || deg === undefined ? '—' : DIRS[Math.round(deg / 22.5) % 16];
WX.windDirLong = deg => {
  if (deg === null || deg === undefined) return '';
  return DIRS_LONG[['N','NÖ','Ö','SÖ','S','SV','V','NV'][Math.round(deg / 45) % 8]];
};
WX.fmt = (v, d = 0) => {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const r = Number(v.toFixed(d));
  return (Object.is(r, -0) ? 0 : r).toFixed(d).replace('-', '−').replace('.', ',');
};
WX.fmtTemp = (v, d = 0) => {
  if (v === null || v === undefined) return '—';
  const r = Number(v.toFixed(d));
  return (Object.is(r, -0) ? 0 : r).toFixed(d).replace('-', '−').replace('.', ',') + '°';
};
WX.hhmm = d => d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
WX.hh = d => String(d.getHours()).padStart(2, '0');
WX.WEEKDAYS = ['sön', 'mån', 'tis', 'ons', 'tors', 'fre', 'lör'];
WX.WEEKDAYS_LONG = ['söndag', 'måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag'];
WX.MONTHS = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
WX.dateKey = d => {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
WX.keyToDate = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
WX.dayLabel = (d, long) => {
  const today = WX.dateKey(new Date());
  const tomorrow = WX.dateKey(new Date(Date.now() + 864e5));
  const k = WX.dateKey(d);
  if (k === today) return 'Idag';
  if (k === tomorrow) return 'Imorgon';
  const w = (long ? WX.WEEKDAYS_LONG : WX.WEEKDAYS)[d.getDay()];
  return w.charAt(0).toUpperCase() + w.slice(1);
};
WX.dateShort = d => `${d.getDate()} ${WX.MONTHS[d.getMonth()]}`;
WX.toLocalInput = d => `${WX.dateKey(d)}T${WX.hh(d)}:${String(d.getMinutes()).padStart(2, '0')}`;
WX.parseLocalInput = s => {
  const [date, time] = s.split('T');
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = (time || '00:00').split(':').map(Number);
  return new Date(y, mo - 1, d, h, mi);
};
WX.esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

// ── BEAUFORT, ÅSKA, KÄNNS SOM ────────────────────────────────────────────────
WX.BEAUFORT = [
  { name: 'Lugnt',     short: 'Lugnt', max: 0.2 },
  { name: 'Svag vind', short: 'Svag',  max: 3.3 },
  { name: 'Måttlig',   short: 'Måttl.', max: 7.9 },
  { name: 'Frisk',     short: 'Frisk', max: 13.8 },
  { name: 'Hård vind', short: 'Hård',  max: 24.4 },
  { name: 'Storm',     short: 'Storm', max: 32.6 },
  { name: 'Orkan',     short: 'Orkan', max: 99 },
];
WX.beaufort = s => s === null || s === undefined ? null : (WX.BEAUFORT.find(z => s < z.max) || WX.BEAUFORT[6]);
WX.THUNDER_MED = 15;
WX.THUNDER_HIGH = 40;

WX.feelsLike = (t, w, rh) => {
  if (t === null || t === undefined || w === null || w === undefined) return t;
  if (t <= 10 && w > 1.3) {
    const k = Math.pow(w * 3.6, 0.16);
    return 13.12 + 0.6215 * t - 11.37 * k + 0.3965 * t * k;
  }
  if (t >= 27 && rh !== null && rh !== undefined) {
    return -8.78469475556 + 1.61139411 * t + 2.33854883889 * rh - 0.14611605 * t * rh
      - 0.012308094 * t * t - 0.0164248277778 * rh * rh + 0.002211732 * t * t * rh
      + 0.00072546 * t * rh * rh - 0.000003582 * t * t * rh * rh;
  }
  return t;
};

// ── VÄDERSYMBOLER ────────────────────────────────────────────────────────────
// met.no:s symbol_code (SMHI:s Wsymb2 översätts redan i forecast-sources.js)
WX.parseSymbol = sym => {
  const s = (sym || 'unknown').toLowerCase();
  const base = s.replace(/_(day|night|polartwilight)$/, '');
  const night = /_night$/.test(s);
  const type = /snow/.test(base) ? 'snow' : /sleet/.test(base) ? 'sleet' : /rain/.test(base) ? 'rain' : null;
  return {
    base, night,
    thunder: /thunder/.test(base),
    type,
    intensity: /^light/.test(base) ? 1 : /^heavy/.test(base) ? 3 : 2,
    showers: /showers/.test(base),
    cover: base === 'clearsky' ? 0 : base === 'fair' ? 1 : base === 'partlycloudy' ? 2
      : base === 'fog' ? 'fog' : base === 'unknown' ? null : 3,
  };
};

WX.describe = sym => {
  const p = WX.parseSymbol(sym);
  const sky = { clearsky: 'Klart', fair: 'Mestadels klart', partlycloudy: 'Halvklart', cloudy: 'Mulet', fog: 'Dimma' };
  if (sky[p.base]) return sky[p.base];
  if (!p.type) return p.base === 'unknown' ? '—' : 'Okänt';
  const noun = { rain: 'regn', sleet: 'snöblandat regn', snow: 'snöfall' }[p.type];
  const shower = { rain: 'regnskurar', sleet: 'skurar av snöblandat regn', snow: 'snöbyar' }[p.type];
  const adj = p.intensity === 1 ? 'Lätta ' : p.intensity === 3 ? 'Kraftiga ' : '';
  const adj1 = p.intensity === 1 ? 'Lätt ' : p.intensity === 3 ? 'Kraftigt ' : '';
  let txt = p.showers ? adj + shower : adj1 + noun;
  if (!p.showers && p.intensity === 2) txt = noun.charAt(0).toUpperCase() + noun.slice(1);
  if (p.showers && p.intensity === 2) txt = shower.charAt(0).toUpperCase() + shower.slice(1);
  if (p.thunder) txt += ' och åska';
  return txt;
};

// ── VÄDERIKONER (SVG, 64×64) ─────────────────────────────────────────────────
// Byggs av delar: sol/måne, moln, nederbörd, blixt. Färger via CSS-klasser
// (.wxi-sun, .wxi-cloud …) som respektive utkast färgsätter.
function sunShape(cx, cy, r) {
  let rays = '';
  for (let k = 0; k < 8; k++) {
    const a = k * Math.PI / 4, r1 = r + 4, r2 = r + 9;
    rays += `M${(cx + Math.cos(a) * r1).toFixed(1)} ${(cy + Math.sin(a) * r1).toFixed(1)}L${(cx + Math.cos(a) * r2).toFixed(1)} ${(cy + Math.sin(a) * r2).toFixed(1)}`;
  }
  return `<path class="wxi-ray" d="${rays}"/><circle class="wxi-sun" cx="${cx}" cy="${cy}" r="${r}"/>`;
}
function moonShape(cx, cy, r) {
  // Skära: cirkel minus förskjuten cirkel via två bågar
  return `<path class="wxi-moon" d="M${cx + r * 0.35} ${cy - r}A${r} ${r} 0 1 0 ${cx + r} ${cy + r * 0.25}A${r * 0.78} ${r * 0.78} 0 0 1 ${cx + r * 0.35} ${cy - r}Z"/>`;
}
function cloudShape(dark, dx = 0, dy = 0, s = 1) {
  const cls = dark ? 'wxi-cloud-dark' : 'wxi-cloud';
  return `<g transform="translate(${dx} ${dy}) scale(${s})"><g class="${cls}">
    <circle cx="22" cy="38" r="9"/><circle cx="33" cy="31" r="13"/><circle cx="45" cy="38" r="9"/>
    <rect x="13" y="36" width="41" height="11" rx="5.5"/></g></g>`;
}
function dropsShape(type, intensity, y0) {
  const xs = intensity === 1 ? [32] : intensity === 2 ? [25, 39] : [20, 32, 44];
  return xs.map((x, k) => {
    const kind = type === 'sleet' ? (k % 2 ? 'snow' : 'rain') : type;
    const y = y0 + (k % 2) * 4;
    return kind === 'snow'
      ? `<circle class="wxi-snow" cx="${x}" cy="${y + 4}" r="2.6"/>`
      : `<path class="wxi-rain" d="M${x + 2} ${y}l-3 8"/>`;
  }).join('');
}
WX.icon = (sym, size = 40, title) => {
  const p = WX.parseSymbol(sym);
  let g = '';
  if (p.cover === null) {
    g = `<circle class="wxi-cloud" cx="32" cy="32" r="6"/>`;
  } else if (p.cover === 'fog') {
    g = cloudShape(false, 0, -6) + `<path class="wxi-fog" d="M14 50h36M18 56h28"/>`;
  } else if (!p.type && !p.thunder) {
    if (p.cover === 0) g = p.night ? moonShape(32, 32, 15) : sunShape(32, 32, 12);
    else if (p.cover === 3) g = cloudShape(false, 0, -2);
    else {
      g = (p.night ? moonShape(24, 22, 11) : sunShape(24, 22, 9))
        + cloudShape(false, p.cover === 1 ? 14 : 8, p.cover === 1 ? 14 : 10, p.cover === 1 ? 0.72 : 0.85);
    }
  } else {
    const dark = !p.showers && (p.intensity >= 2 || p.thunder);
    if (p.showers) g += p.night ? moonShape(22, 16, 9) : sunShape(22, 16, 7.5);
    g += cloudShape(dark, p.showers ? 4 : 0, p.showers ? -3 : -7, p.showers ? 0.92 : 1);
    if (p.type) g += dropsShape(p.type, p.intensity, 47);
    if (p.thunder) g += `<path class="wxi-bolt" d="M35 40l-8 12h6l-3 9 10-13h-6l4-8z"/>`;
  }
  return `<svg class="wxi" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="${WX.esc(title || WX.describe(sym))}">${g}</svg>`;
};

// Vindpil: pekar dit vinden blåser (från-riktning + 180°)
WX.windArrow = (deg, size = 18) => deg === null || deg === undefined ? '' :
  `<svg class="wxa" viewBox="0 0 20 20" width="${size}" height="${size}" aria-hidden="true"><g transform="rotate(${(deg + 180) % 360} 10 10)"><path d="M10 2l5 13-5-3-5 3z"/></g></svg>`;

// Temperatur → färgton (för värmekartor och chips). Halvgenomskinlig, så
// den fungerar på både ljus och mörk bakgrund.
WX.tempHue = t => {
  const stops = [[-25, 250], [-10, 220], [0, 195], [8, 140], [15, 70], [22, 35], [30, 5]];
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, h0] = stops[i - 1], [t1, h1] = stops[i];
      return h0 + (h1 - h0) * (t - t0) / (t1 - t0);
    }
  }
  return stops[stops.length - 1][1];
};
WX.tempTint = (t, a = 0.25) => t === null || t === undefined ? 'transparent' : `hsla(${WX.tempHue(t).toFixed(0)},80%,52%,${a})`;

// ── SOL (efter suncalc, V. Agafonkin, BSD) ───────────────────────────────────
const rad = Math.PI / 180, J1970 = 2440588, J2000 = 2451545, OBL = rad * 23.4397, J0 = 0.0009;
const toDays = ms => ms / 864e5 - 0.5 + J1970 - J2000;
const fromJulian = j => new Date((j + 0.5 - J1970) * 864e5);
const meanAnomaly = d => rad * (357.5291 + 0.98560028 * d);
const eclLong = M => M + rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + rad * 102.9372 + Math.PI;
const decl = L => Math.asin(Math.sin(OBL) * Math.sin(L));
const rightAsc = L => Math.atan2(Math.sin(L) * Math.cos(OBL), Math.cos(L));

WX.sunAltitude = (ms, lat, lon) => {
  const d = toDays(ms), M = meanAnomaly(d), L = eclLong(M);
  const Hh = rad * (280.16 + 360.9856235 * d) - rad * -lon - rightAsc(L);
  const phi = rad * lat, dec = decl(L);
  return Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(Hh)) / rad;
};

// Soluppgång/-nedgång för ett lokalt datum. polar: 'day' (midnattssol),
// 'night' (polarnatt) eller null.
WX.sunTimes = (date, lat, lon) => {
  const noon = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12).getTime();
  const lw = rad * -lon, phi = rad * lat, d = toDays(noon);
  const n = Math.round(d - J0 - lw / (2 * Math.PI));
  const ds = J0 + lw / (2 * Math.PI) + n;
  const M = meanAnomaly(ds), L = eclLong(M), dec = decl(L);
  const Jnoon = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const cosW = (Math.sin(-0.833 * rad) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  if (cosW < -1) return { rise: null, set: null, polar: 'day', noon: fromJulian(Jnoon) };
  if (cosW > 1)  return { rise: null, set: null, polar: 'night', noon: fromJulian(Jnoon) };
  const w = Math.acos(cosW);
  const Jset = J2000 + (J0 + (w + lw) / (2 * Math.PI) + n) + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  return { rise: fromJulian(Jnoon - (Jset - Jnoon)), set: fromJulian(Jset), polar: null, noon: fromJulian(Jnoon) };
};

// Nattintervall [ms, ms] över ett tidsspann, för skuggning i graferna
WX.nightIntervals = (fromMs, toMs, lat, lon) => {
  const out = [];
  const start = new Date(fromMs); start.setHours(0, 0, 0, 0);
  let cur = null; // pågående natt
  for (let day = new Date(start); day.getTime() <= toMs; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
    const st = WX.sunTimes(day, lat, lon);
    const d0 = day.getTime(), d1 = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
    let segs;
    if (st.polar === 'night') segs = [[d0, d1]];
    else if (st.polar === 'day') segs = [];
    else segs = [[d0, st.rise.getTime()], [st.set.getTime(), d1]];
    for (const [a, b] of segs) {
      if (b <= a) continue;
      if (cur && Math.abs(cur[1] - a) < 60e3) cur[1] = b;
      else { if (cur) out.push(cur); cur = [a, b]; }
    }
  }
  if (cur) out.push(cur);
  return out.filter(([a, b]) => b > fromMs && a < toMs);
};

// ── NEDERBÖRDSRISK MED PERSISTENS ────────────────────────────────────────────
// Samma metod som index.html: timvisa sannolikheter är autokorrelerade, så
// risken över en period räknas med en persistenslängd L kalibrerad mot
// met.no:s 6h-sannolikheter.
function unionProb(items, L) {
  const v = items.filter(o => o && o.p !== null && o.p !== undefined && !Number.isNaN(o.p))
    .map(o => ({ p: Math.min(Math.max(o.p, 0), 1), hours: o.hours || 1 }))
    .sort((a, b) => b.p - a.p);
  if (!v.length) return null;
  let q = 1 - v[0].p;
  for (let i = 1; i < v.length; i++) q *= Math.pow(1 - v[i].p, Math.min(1, v[i].hours / L));
  return 1 - q;
}
function fitL(items, target) {
  if (unionProb(items, 240) > target) return 240;
  if (unionProb(items, 1) < target) return 1;
  let lo = 1, hi = 240;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (unionProb(items, mid) > target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
function estimatePersistence(wd) {
  const { times, data } = wd, Ls = [];
  for (let i = 0; i + 5 < times.length; i++) {
    const target = data.prob6h[i];
    if (target === null || target === undefined) continue;
    if (times[i + 5] - times[i] !== 5 * H) continue;
    const hourly = data.precip_prob.slice(i, i + 6);
    if (hourly.some(p => p === null || p === undefined)) continue;
    const items = hourly.map(p => ({ p: p / 100, hours: 1 }));
    const t = target / 100;
    if (t <= Math.max(...hourly) / 100 + 0.01) continue;
    if (t >= unionProb(items, 1) - 0.01) continue;
    Ls.push(fitL(items, t));
  }
  if (!Ls.length) return 4;
  Ls.sort((a, b) => a - b);
  return Ls[Math.floor(Ls.length / 2)];
}
// Risk för nederbörd någon gång i [start, end) (index), i procent
WX.periodRisk = (wd, start, end) => {
  const { times, data } = wd;
  if (end <= start) return null;
  const items = [];
  for (let i = start; i < end; i++) {
    items.push({ p: data.precip_prob[i] == null ? null : data.precip_prob[i] / 100, hours: data.step_hours[i] ?? 1 });
  }
  let p = unionProb(items, wd.L);
  if (p === null) return null;
  const t0 = times[start].getTime();
  const t1 = times[end - 1].getTime() + (data.step_hours[end - 1] ?? 1) * H;
  let floor = 0, ceil = 1;
  for (let i = 0; i < times.length; i++) {
    const s = times[i].getTime();
    for (const [h, v] of [[6, data.prob6h[i]], [12, data.prob12h[i]]]) {
      if (v === null || v === undefined) continue;
      const e = s + h * H;
      if (s >= t0 && e <= t1) floor = Math.max(floor, v / 100);
      if (s <= t0 && e >= t1) ceil = Math.min(ceil, v / 100);
    }
  }
  p = Math.min(Math.max(p, floor), Math.max(ceil, floor));
  return Math.round(p * 100);
};
function rolling3h(wd) {
  const pp = wd.data.precip_prob, sh = wd.data.step_hours;
  return pp.map((_, i) => {
    if (sh[i] !== 1) return null;
    const items = [];
    for (let k = Math.max(0, i - 1); k <= Math.min(pp.length - 1, i + 1); k++) {
      if (sh[k] !== 1) continue;
      if (pp[k] !== null && pp[k] !== undefined) items.push({ p: pp[k] / 100, hours: 1 });
    }
    const u = items.length ? unionProb(items, wd.L) : null;
    return u === null ? null : Math.round(u * 100);
  });
}

// ── PROGNOSKÄLLOR ────────────────────────────────────────────────────────────
WX.MODES = [
  { id: 'met',   label: 'met.no', hint: 'Norska Meteorologisk institutt' },
  { id: 'smhi',  label: 'SMHI',   hint: 'SMHI:s punktprognos (Norden)' },
  { id: 'blend', label: 'Viktad', hint: 'Viktat medel av met.no och SMHI' },
  { id: 'both',  label: 'Båda',   hint: 'Båda källorna bredvid varandra i graferna' },
];
WX.SOURCE_LABELS = { met: 'met.no', smhi: 'SMHI' };

WX.effectiveMode = (raw, mode) => !raw.smhi ? 'met' : !raw.met ? 'smhi' : mode;

// raw: { met, smhi } → weatherData med härledda fält
WX.build = (raw, mode, nowMs = Date.now()) => {
  const eff = WX.effectiveMode(raw, mode);
  const built = root.ForecastSources.buildForecast(eff === 'both' ? 'blend' : eff, raw, { nowMs });
  const wd = { times: built.times, ms: built.times.map(t => t.getTime()), data: built.data, mode: eff, sourceIds: built.sourceIds };
  const d = wd.data;
  d.feels_like = d.temp.map((t, i) => WX.feelsLike(t, d.wind[i], d.humidity[i]));
  for (const id of built.sourceIds) {
    if (d[`temp_src_${id}`]) d[`feels_like_src_${id}`] = d[`temp_src_${id}`].map((t, i) =>
      t === null ? null : WX.feelsLike(t, d[`wind_src_${id}`][i], d[`humidity_src_${id}`][i]));
  }
  wd.L = estimatePersistence(wd);
  d.rolling3h = rolling3h(wd);
  wd.n = wd.times.length;
  wd.step = i => d.step_hours[i] || 1;
  wd.end = i => wd.ms[i] + wd.step(i) * H;
  return wd;
};

WX.nowIndex = (wd, nowMs = Date.now()) => {
  let best = 0, diff = Infinity;
  for (let i = 0; i < wd.n; i++) {
    const df = Math.abs(wd.ms[i] - nowMs);
    if (df < diff) { diff = df; best = i; }
  }
  return best;
};

// Index i [start, end) inom tidsspannet [a, b)
WX.indexRange = (wd, a, b) => {
  let start = wd.ms.findIndex(t => t >= a - 60e3);
  let end = wd.ms.findIndex(t => t >= b - 60e3);
  if (start === -1) start = wd.n;
  if (end === -1) end = wd.n;
  return { start, end: Math.max(end, start) };
};

// ── STATISTIK FÖR EN PERIOD ──────────────────────────────────────────────────
WX.periodStats = (wd, start, end) => {
  const d = wd.data, sl = k => (d[k] || []).slice(start, end);
  const thunder = sl('thunder');
  const thMax = WX.max(thunder);
  let thAt = null;
  if (thMax !== null) thAt = wd.times[start + thunder.indexOf(thMax)];
  return {
    start, end,
    from: wd.times[start], to: end > start ? new Date(wd.end(end - 1)) : null,
    tMean: WX.mean(sl('temp')), tMin: WX.min(sl('temp')), tMax: WX.max(sl('temp')),
    fMin: WX.min(sl('feels_like')),
    wMean: WX.mean(sl('wind')), wMax: WX.max(sl('wind')), gMax: WX.max(sl('gust')),
    wDir: WX.circMean(sl('wind_direction')),
    pSum: WX.sum(sl('precip_step')) ?? 0,
    pRisk: WX.periodRisk(wd, start, end),
    thMax, thAt,
    uvMax: WX.max(sl('uv')), uvMin: WX.min(sl('uv')),
    cMean: WX.mean(sl('cloud')), cMin: WX.min(sl('cloud')), cMax: WX.max(sl('cloud')),
    hMean: WX.mean(sl('humidity')), hMin: WX.min(sl('humidity')), hMax: WX.max(sl('humidity')),
    prMean: WX.mean(sl('pressure')), prFirst: d.pressure[start], prLast: d.pressure[end - 1],
  };
};

// ── DYGNSSAMMANFATTNING ──────────────────────────────────────────────────────
WX.days = (wd, lat, lon) => {
  const byKey = new Map();
  wd.times.forEach((t, i) => {
    const k = WX.dateKey(t);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(i);
  });
  const d = wd.data, out = [];
  for (const [key, idx] of byKey) {
    const temps = valid(idx.map(i => d.temp[i]));
    if (!temps.length) continue;
    const date = WX.keyToDate(key);
    const first = idx[0], last = idx[idx.length - 1];
    const covered = idx.reduce((a, i) => a + wd.step(i), 0);
    if (covered < 12 && out.length) continue;         // bara en svans av dygnet
    // Symbol: steget som täcker klockan 12 (resp. 03), annars mitten
    const covering = h => {
      const t = new Date(date.getFullYear(), date.getMonth(), date.getDate(), h).getTime();
      return idx.find(i => wd.ms[i] <= t && t < wd.end(i));
    };
    const dayIdx = covering(12) ?? covering(13) ?? idx[Math.floor(idx.length / 2)];
    const nightIdx = covering(3);
    const sun = WX.sunTimes(date, lat, lon);
    let symbol = d.symbols[dayIdx] || 'unknown';
    if (sun.polar !== 'night') symbol = symbol.replace(/_night$/, '_day');
    out.push({
      key, date, idx, first, last: last + 1,
      label: WX.dayLabel(date), labelLong: WX.dayLabel(date, true),
      hi: Math.max(...temps), lo: Math.min(...temps),
      precip: WX.sum(idx.map(i => d.precip_step[i])),
      risk: WX.periodRisk(wd, first, last + 1),
      windMax: WX.max(idx.map(i => d.wind[i])),
      gustMax: WX.max(idx.map(i => d.gust[i])),
      windDir: WX.circMean(idx.map(i => d.wind_direction[i])),
      thunder: WX.max(idx.map(i => d.thunder[i])),
      uv: WX.max(idx.map(i => d.uv[i])),
      symbol,
      symbolNight: nightIdx !== undefined ? d.symbols[nightIdx] : null,
      sun,
      partial: covered < 18,
    });
  }
  return out;
};

// ── "PROGNOSEN I KORTHET": automatiska noteringar ────────────────────────────
// Letar efter det som är värt att lyfta: nederbördsperioder, hård vind,
// åska, temperatur kring noll och kraftiga temperaturomslag.
// Standard: från nu och tre dygn framåt. range = { start, end } ger en vald period.
WX.highlights = (wd, days, range) => {
  const d = wd.data, out = [];
  let nowI, end;
  if (range) { nowI = range.start; end = range.end; }
  else {
    nowI = WX.nowIndex(wd);
    const horizon = wd.ms.findIndex(t => t > wd.ms[nowI] + 72 * H);
    end = horizon === -1 ? wd.n : horizon;
  }

  // Sammanhängande nederbörd (≥0,3 mm/h eller ≥50 % risk)
  let run = null;
  const flush = () => {
    if (run && run.sum >= 1) out.push(run);
    run = null;
  };
  for (let i = nowI; i < end; i++) {
    const wet = (d.precip[i] ?? 0) >= 0.3 || (d.precip_prob[i] ?? 0) >= 50;
    if (wet) {
      if (!run) run = { kind: 'precip', from: wd.times[i], i0: i, sum: 0, sym: d.symbols[i] };
      run.sum += d.precip_step[i] ?? 0; run.to = new Date(wd.end(i)); run.i1 = i;
    } else flush();
  }
  flush();
  out.forEach(r => {
    // Nederbördstyp: vanligaste typen bland stegens symboler, annars temperaturen
    const count = { rain: 0, sleet: 0, snow: 0 };
    for (let i = r.i0; i <= r.i1; i++) { const ty = WX.parseSymbol(d.symbols[i]).type; if (ty) count[ty]++; }
    let type = Object.keys(count).sort((a, b) => count[b] - count[a])[0];
    if (!count[type]) {
      const tm = WX.mean(d.temp.slice(r.i0, r.i1 + 1));
      type = tm < 0 ? 'snow' : tm < 1.5 ? 'sleet' : 'rain';
    }
    const p = { type };
    r.sym = { snow: 'snow', sleet: 'sleet', rain: 'rain' }[type];
    const noun = p.type === 'snow' ? 'Snöfall' : p.type === 'sleet' ? 'Snöblandat regn' : 'Regn';
    r.level = r.sum >= 15 ? 'high' : r.sum >= 5 ? 'medium' : 'low';
    r.title = `${noun} ${WX.spanText(r.from, r.to)}`;
    r.text = `Totalt omkring ${WX.fmt(r.sum, r.sum < 10 ? 1 : 0)} mm${p.type === 'snow' ? ` (ungefär ${Math.round(r.sum)} cm snö)` : ''}.`;
    r.icon = r.sym;
  });

  const gMax = WX.max(d.gust.slice(nowI, end)), wMax = WX.max(d.wind.slice(nowI, end));
  if ((gMax ?? 0) >= 15 || (wMax ?? 0) >= 10) {
    const i = nowI + d.gust.slice(nowI, end).indexOf(gMax);
    out.push({ kind: 'wind', level: gMax >= 21 || wMax >= 14 ? 'high' : 'medium',
      title: `Blåsigt ${WX.dayLabel(wd.times[i]).toLowerCase()} kring ${WX.hh(wd.times[i])}`,
      text: `Medelvind upp till ${WX.fmt(wMax)} m/s, byar ${WX.fmt(gMax)} m/s från ${WX.windDirLong(d.wind_direction[i])} riktning.`,
      from: wd.times[i] });
  }
  const thMax = WX.max(d.thunder.slice(nowI, end));
  if ((thMax ?? 0) >= WX.THUNDER_MED) {
    const i = nowI + d.thunder.slice(nowI, end).indexOf(thMax);
    out.push({ kind: 'thunder', level: thMax >= WX.THUNDER_HIGH ? 'high' : 'medium',
      title: `Risk för åska ${WX.dayLabel(wd.times[i]).toLowerCase()}`,
      text: `Upp till ${Math.round(thMax)} % sannolikhet kring ${WX.hh(wd.times[i])}:00 (SMHI).`, from: wd.times[i] });
  }
  // Frost/töväder: temperaturen passerar noll
  const t = d.temp.slice(nowI, end).filter(v => v !== null);
  if (t.length && Math.min(...t) < -0.5 && Math.max(...t) > 0.5) {
    out.push({ kind: 'freeze', level: 'low', title: 'Temperatur kring noll',
      text: `Mellan ${WX.fmtTemp(Math.min(...t))} och ${WX.fmtTemp(Math.max(...t))} de närmaste dygnen. Risk för halka.` });
  }
  // Omslag mellan dygn (≥6° skillnad i maxtemperatur)
  for (let k = 1; k < Math.min(days.length, 7); k++) {
    const dlt = days[k].hi - days[k - 1].hi;
    if (Math.abs(dlt) >= 6) {
      out.push({ kind: 'trend', level: 'low',
        title: dlt < 0 ? `Kallare ${days[k].labelLong.toLowerCase()}` : `Mildare ${days[k].labelLong.toLowerCase()}`,
        text: `Maxtemperaturen ${dlt < 0 ? 'sjunker' : 'stiger'} från ${WX.fmtTemp(days[k - 1].hi)} till ${WX.fmtTemp(days[k].hi)}.` });
      break;
    }
  }
  const order = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level] || (a.from ?? 0) - (b.from ?? 0)).slice(0, 4);
};

// ── TEXTPROGNOS FÖR ETT DYGN ─────────────────────────────────────────────────
// Några meningar i stil med en uppläst prognos: himmel och nederbörd per
// del av dygnet, temperatur, vind, mängd och åska.
const DAYPARTS = [['natten', 0, 6], ['förmiddagen', 6, 12], ['eftermiddagen', 12, 18], ['kvällen', 18, 24]];
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const listJoin = a => a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' och ' + a[a.length - 1];
const skyWord = c => c === null ? 'växlande molnighet' : c < 20 ? 'klart' : c < 45 ? 'mestadels klart' : c < 75 ? 'växlande molnighet' : 'mulet';

WX.dayText = (wd, day) => {
  const D = wd.data, b = day.date;
  const parts = DAYPARTS.map(([name, h0, h1]) => {
    const a = new Date(b.getFullYear(), b.getMonth(), b.getDate(), h0).getTime();
    const e = new Date(b.getFullYear(), b.getMonth(), b.getDate(), h1).getTime();
    let p = 0, cl = 0, w = 0;
    for (const i of day.idx) {
      const ov = Math.min(e, wd.end(i)) - Math.max(a, wd.ms[i]);
      if (ov <= 0) continue;
      p += (D.precip_step[i] ?? 0) * ov / (wd.end(i) - wd.ms[i]);
      if (D.cloud[i] != null) { cl += D.cloud[i] * ov; w += ov; }
    }
    return { name, p, cloud: w ? cl / w : null, has: w > 0 };
  }).filter(r => r.has);

  // Nederbördstyp och om det är skurar: majoritet bland dygnets symboler
  const cnt = { rain: 0, sleet: 0, snow: 0 }; let showers = 0, wetSyms = 0;
  for (const i of day.idx) {
    const p = WX.parseSymbol(D.symbols[i]);
    if (p.type) { cnt[p.type]++; wetSyms++; if (p.showers) showers++; }
  }
  let type = Object.keys(cnt).sort((x, y) => cnt[y] - cnt[x])[0];
  if (!cnt[type]) type = day.hi < 0 ? 'snow' : day.lo > 1.5 ? 'rain' : 'sleet';
  const isShowers = wetSyms && showers / wetSyms > 0.5;
  const total = day.precip ?? 0;
  const light = total < 2;
  const noun = isShowers
    ? { rain: 'regnskurar', sleet: 'skurar av snöblandat regn', snow: 'snöbyar' }[type]
    : { rain: light ? 'lätt regn' : 'regn', sleet: 'snöblandat regn', snow: light ? 'lätt snöfall' : 'snöfall' }[type];

  const s = [];
  const wet = parts.filter(r => r.p >= 0.3);
  const dry = parts.filter(r => r.p < 0.3);
  if (wet.length) {
    const when = wet.length === parts.length && parts.length > 2 ? 'under större delen av dygnet' : `under ${listJoin(wet.map(r => r.name))}`;
    const dc = dry.length ? WX.mean(dry.map(r => r.cloud)) : null;
    s.push(cap(`${noun} ${when}`) + (dry.length ? `, annars ${skyWord(dc)}` : '') + '.');
  } else if (parts.length >= 2) {
    const f = parts[0], l = parts[parts.length - 1];
    if (f.cloud > 70 && l.cloud < 40) s.push(`${cap(skyWord(f.cloud))}, men uppklarnande mot ${l.name}.`);
    else if (f.cloud < 40 && l.cloud > 70) s.push(`${cap(skyWord(f.cloud))}, mulnar på mot ${l.name}.`);
    else s.push(`${cap(skyWord(WX.mean(parts.map(r => r.cloud))))}.`);
  } else s.push(`${cap(skyWord(parts[0]?.cloud ?? null))}.`);

  const feels = WX.min(day.idx.map(i => D.feels_like[i]));
  s.push(`${day.lo === day.hi ? `Omkring ${WX.fmtTemp(day.hi)}` : `Mellan ${WX.fmtTemp(day.lo)} och ${WX.fmtTemp(day.hi)}`}`
    + (feels !== null && feels < day.lo - 3 ? `, känns som ner mot ${WX.fmtTemp(feels)}` : '') + '.');

  const wMin = WX.min(day.idx.map(i => D.wind[i])), wMax = day.windMax;
  if (wMax !== null) {
    const adj = wMax < 3.3 ? 'svag ' : wMax >= 24.4 ? 'storm, ' : wMax >= 13.8 ? 'hård ' : wMax >= 7.9 ? 'frisk ' : '';
    const dir = WX.windDirLong(day.windDir);
    const span = Math.round(wMin) === Math.round(wMax) ? `${WX.fmt(wMax)} m/s` : `${WX.fmt(wMin)}–${WX.fmt(wMax)} m/s`;
    s.push(cap(`${adj}${dir ? dir + ' ' : ''}vind ${span}`) + (day.gustMax != null && day.gustMax >= wMax + 3 ? `, i byarna upp till ${WX.fmt(day.gustMax)} m/s` : '') + '.');
  }
  if (total >= 0.1) s.push(`Totalt ${WX.fmt(total, total < 10 ? 1 : 0)} mm${type === 'snow' && total >= 1 ? `, ungefär ${Math.round(total)} cm snö` : ''}${day.risk != null ? ` (risk ${day.risk} %)` : ''}.`);
  else if ((day.risk ?? 0) >= 20) s.push(`Mestadels uppehåll, ${day.risk} % risk för nederbörd.`);
  else s.push('Uppehåll.');
  if ((day.thunder ?? 0) >= WX.THUNDER_MED) s.push(`Risk för åska, upp till ${Math.round(day.thunder)} %.`);
  return { lead: s[0], text: s.join(' ') };
};

WX.spanText = (a, b) => {
  const sameDay = WX.dateKey(a) === WX.dateKey(new Date(b.getTime() - 1));
  const d1 = WX.dayLabel(a).toLowerCase();
  const endH = b.getHours() === 0 && b.getMinutes() === 0 ? '24' : WX.hh(b);
  if (sameDay) return `${d1} ${WX.hh(a)}–${endH}`;
  return `${d1} ${WX.hh(a)} – ${WX.dayLabel(b).toLowerCase()} ${WX.hh(b)}`;
};

// ── PLATSER ──────────────────────────────────────────────────────────────────
WX.PRESETS = [
  { name: 'Sjungande dalen', detail: 'Skellefteå', lat: 64.762528, lon: 20.923429 },
  { name: 'Skråmträsk', detail: 'Skellefteå', lat: 64.661972, lon: 20.624056 },
  { name: 'Stockholm', detail: 'Stockholms län', lat: 59.3293, lon: 18.0686 },
  { name: 'Skarja, Sarek', detail: 'Jokkmokk', lat: 67.377503, lon: 17.644642 },
];
// Liten reservlista när sökningen (Nominatim) inte går att nå
const GAZETTEER = [
  ['Skellefteå', 'Västerbottens län', 64.7507, 20.9528], ['Umeå', 'Västerbottens län', 63.8258, 20.2630],
  ['Luleå', 'Norrbottens län', 65.5848, 22.1547], ['Kiruna', 'Norrbottens län', 67.8558, 20.2253],
  ['Jokkmokk', 'Norrbottens län', 66.6066, 19.8227], ['Abisko', 'Norrbottens län', 68.3495, 18.8312],
  ['Östersund', 'Jämtlands län', 63.1792, 14.6357], ['Åre', 'Jämtlands län', 63.3990, 13.0815],
  ['Sundsvall', 'Västernorrlands län', 62.3908, 17.3069], ['Gävle', 'Gävleborgs län', 60.6749, 17.1413],
  ['Uppsala', 'Uppsala län', 59.8586, 17.6389], ['Stockholm', 'Stockholms län', 59.3293, 18.0686],
  ['Västerås', 'Västmanlands län', 59.6099, 16.5448], ['Örebro', 'Örebro län', 59.2753, 15.2134],
  ['Karlstad', 'Värmlands län', 59.3793, 13.5036], ['Linköping', 'Östergötlands län', 58.4108, 15.6214],
  ['Göteborg', 'Västra Götalands län', 57.7089, 11.9746], ['Jönköping', 'Jönköpings län', 57.7826, 14.1618],
  ['Visby', 'Gotlands län', 57.6348, 18.2948], ['Kalmar', 'Kalmar län', 56.6634, 16.3568],
  ['Växjö', 'Kronobergs län', 56.8777, 14.8091], ['Halmstad', 'Hallands län', 56.6745, 12.8578],
  ['Malmö', 'Skåne län', 55.6050, 13.0038], ['Lund', 'Skåne län', 55.7047, 13.1910],
  ['Oslo', 'Norge', 59.9139, 10.7522], ['Tromsø', 'Norge', 69.6492, 18.9553],
  ['Helsingfors', 'Finland', 60.1699, 24.9384], ['Köpenhamn', 'Danmark', 55.6761, 12.5683],
].map(([name, detail, lat, lon]) => ({ name, detail, lat, lon }));

WX.geocode = async (q) => {
  q = q.trim();
  const coord = q.match(/^\s*(-?\d+(?:[.,]\d+)?)\s*[,; ]\s*(-?\d+(?:[.,]\d+)?)\s*$/);
  if (coord) {
    const lat = parseFloat(coord[1].replace(',', '.')), lon = parseFloat(coord[2].replace(',', '.'));
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      return { results: [{ name: `${lat.toFixed(4)}, ${lon.toFixed(4)}`, detail: 'Koordinater', lat, lon }], offline: false };
    }
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=6&addressdetails=1&accept-language=sv`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    return {
      offline: false,
      results: data.map(r => {
        const a = r.address || {};
        const name = r.name || a.village || a.town || a.city || r.display_name.split(',')[0];
        const detail = [a.municipality || a.city || a.town, a.county || a.state, a.country]
          .filter((v, i, arr) => v && v !== name && arr.indexOf(v) === i).slice(0, 2).join(', ');
        return { name, detail, lat: parseFloat(r.lat), lon: parseFloat(r.lon) };
      }),
    };
  } catch {
    const ql = q.toLowerCase();
    const all = [...WX.PRESETS, ...GAZETTEER];
    return { offline: true, results: all.filter(p => p.name.toLowerCase().includes(ql) || p.detail.toLowerCase().includes(ql)).slice(0, 6) };
  }
};

// ── LAGRING (try/catch: kan saknas i privata fönster) ────────────────────────
WX.store = {
  get(key, def) { try { const v = localStorage.getItem(key); return v === null ? def : JSON.parse(v); } catch { return def; } },
  set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} },
};

// ── HÄMTNING ─────────────────────────────────────────────────────────────────
async function fetchJson(url, ms = 9000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

// Returnerar { raw: {met, smhi}, live: bool }. Svarar ingen av källorna
// används demodata om WX.demoFallback är sant (utkasten, så att de går att
// titta på överallt); annars kastas ett fel. ?demo=1 ger alltid demodata.
WX.demoFallback = true;
WX.fetchForecast = async (lat, lon, { demo = false } = {}) => {
  if (!demo) {
    const [met, smhi] = await Promise.allSettled([
      fetchJson(`https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`),
      fetchJson(`https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/geotype/point/lon/${lon.toFixed(6)}/lat/${lat.toFixed(6)}/data.json`),
    ]);
    if (met.status === 'fulfilled' || smhi.status === 'fulfilled') {
      return { live: true, raw: {
        met: met.status === 'fulfilled' ? met.value : null,
        smhi: smhi.status === 'fulfilled' ? smhi.value : null,
      } };
    }
  }
  if (!demo && !WX.demoFallback) throw new Error('varken met.no eller SMHI svarar just nu. Försök igen om en stund');
  return { live: false, raw: root.WXDemo.generate(lat, lon, Date.now()) };
};
WX.wantsDemo = () => /[?&]demo(=1)?\b/.test(location.search);

// ═════════════════════════════════════════════════════════════════════════════
// ── METEOGRAM (SVG) ──────────────────────────────────────────────────────────
// Paneler: 'temp', 'precip', 'wind'. Alla paneler i en grupp delar
// tidsfönster och marginaler, så att samma tid hamnar på samma x-position.
// Färger sätts med CSS-klasser (.mg-*), så temat byts utan omritning.
// ═════════════════════════════════════════════════════════════════════════════
const chart = {};
WX.chart = chart;
let clipSeq = 0;

function niceStep(span, target) {
  const raw = span / target, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}
function linePath(xs, ys) {
  let d = '', pen = false;
  for (let i = 0; i < xs.length; i++) {
    if (ys[i] === null || ys[i] === undefined || Number.isNaN(ys[i])) { pen = false; continue; }
    d += `${pen ? 'L' : 'M'}${xs[i].toFixed(1)} ${ys[i].toFixed(1)}`;
    pen = true;
  }
  return d;
}
function bandPath(xs, lo, hi) {
  // Ett polygonsegment per sammanhängande bit utan luckor
  let d = '', seg = [];
  const flush = () => {
    if (seg.length > 1) {
      d += 'M' + seg.map(i => `${xs[i].toFixed(1)} ${hi[i].toFixed(1)}`).join('L')
        + 'L' + seg.slice().reverse().map(i => `${xs[i].toFixed(1)} ${lo[i].toFixed(1)}`).join('L') + 'Z';
    }
    seg = [];
  };
  for (let i = 0; i < xs.length; i++) {
    if (lo[i] === null || hi[i] === null || lo[i] === undefined || hi[i] === undefined) flush();
    else seg.push(i);
  }
  flush();
  return d;
}

// Tidsaxel: timetiketter (tätheten efter fönstrets längd) och dagnamn
function timeTicks(a, b, widthPx) {
  const hours = (b - a) / H, pxPerH = widthPx / hours;
  const step = [1, 2, 3, 6, 12, 24].find(s => s * pxPerH >= 34) || 24;
  const ticks = [], days = [];
  const d0 = new Date(a); d0.setHours(0, 0, 0, 0);
  for (let day = d0; day.getTime() < b; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
    days.push({ t0: Math.max(day.getTime(), a), t1: Math.min(next, b), date: day, midnight: day.getTime() >= a ? day.getTime() : null });
    for (let h = 0; h < 24; h += step) {
      const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h).getTime();
      if (t >= a && t <= b && h !== 0) ticks.push({ t, label: String(h).padStart(2, '0') });
    }
  }
  return { ticks, days, step };
}

// Gemensam geometri för en panel
function frame(ctx, height, opts) {
  const W = Math.max(280, ctx.width);
  const m = { l: ctx.ml ?? 38, r: ctx.mr ?? 48, t: opts.top ?? 6, b: opts.bottom ?? 6 };
  const [a, b] = ctx.range;
  const pw = W - m.l - m.r, ph = height - m.t - m.b;
  const x = ms => m.l + (ms - a) / (b - a) * pw;
  const wd = ctx.wd;
  // Index som syns (med ett steg marginal åt båda håll)
  const vis = [];
  for (let i = 0; i < wd.n; i++) if (wd.end(i) >= a - 6 * H && wd.ms[i] <= b + 6 * H) vis.push(i);
  return { W, height, m, a, b, pw, ph, x, vis };
}

function decorations(ctx, f, clipId) {
  const { m, x, ph } = f;
  let s = '';
  // Natt
  for (const [n0, n1] of ctx.night || []) {
    const x0 = Math.max(m.l, x(n0)), x1 = Math.min(m.l + f.pw, x(n1));
    if (x1 > x0) s += `<rect class="mg-night" x="${x0.toFixed(1)}" y="${m.t}" width="${(x1 - x0).toFixed(1)}" height="${ph}"/>`;
  }
  // Midnattslinjer
  const tt = timeTicks(f.a, f.b, f.pw);
  for (const dd of tt.days) {
    if (dd.midnight !== null) s += `<line class="mg-midnight" x1="${x(dd.midnight).toFixed(1)}" x2="${x(dd.midnight).toFixed(1)}" y1="${m.t}" y2="${m.t + ph}"/>`;
  }
  // Nu
  const now = ctx.nowMs ?? Date.now();
  if (now > f.a && now < f.b) s += `<line class="mg-now" x1="${x(now).toFixed(1)}" x2="${x(now).toFixed(1)}" y1="${m.t}" y2="${m.t + ph}"/>`;
  return s;
}

function xAxis(ctx, f, where) {
  const { m, x } = f;
  const tt = timeTicks(f.a, f.b, f.pw);
  let s = '';
  if (where.includes('hours')) {
    const y = f.height - 4;
    for (const t of tt.ticks) s += `<text class="mg-tick" x="${x(t.t).toFixed(1)}" y="${y}" text-anchor="middle">${t.label}</text>`;
    for (const dd of tt.days) if (dd.midnight !== null) {
      s += `<text class="mg-tick mg-tick-day" x="${x(dd.midnight).toFixed(1)}" y="${y}" text-anchor="middle">${WX.WEEKDAYS[dd.date.getDay()]} ${dd.date.getDate()}</text>`;
    }
  }
  if (where.includes('days')) {
    for (const dd of tt.days) {
      const x0 = x(dd.t0), x1 = x(dd.t1);
      if (x1 - x0 < 46) continue;
      const label = WX.dayLabel(dd.date, x1 - x0 > 150) + (x1 - x0 > 110 ? ` ${dd.date.getDate()} ${WX.MONTHS[dd.date.getMonth()]}` : '');
      const cx = Math.min(Math.max((x0 + x1) / 2, m.l + 30), m.l + f.pw - 30);
      s += `<text class="mg-dayname" x="${cx.toFixed(1)}" y="13" text-anchor="middle">${label}</text>`;
    }
  }
  return s;
}

function yGrid(f, lo, hi, y, fmt, side = 'left', cls = '') {
  const step = niceStep(hi - lo, f.ph < 110 ? 3 : 4);
  let s = '';
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
    const yy = y(v).toFixed(1);
    s += `<line class="mg-grid ${Math.abs(v) < 1e-9 ? cls : ''}" x1="${f.m.l}" x2="${f.m.l + f.pw}" y1="${yy}" y2="${yy}"/>`;
    s += side === 'left'
      ? `<text class="mg-ylab" x="${f.m.l - 6}" y="${(+yy + 3.5).toFixed(1)}" text-anchor="end">${fmt(v)}</text>`
      : `<text class="mg-ylab" x="${f.m.l + f.pw + 6}" y="${(+yy + 3.5).toFixed(1)}" text-anchor="start">${fmt(v)}</text>`;
  }
  return s;
}

const PANELS = {};

PANELS.temp = (ctx, opts) => {
  const height = opts.height ?? 190;
  const iconsRow = opts.icons ? 34 : 0;
  const dayRow = opts.axis?.includes('days') ? 18 : 0;
  const f = frame(ctx, height, { top: 6 + iconsRow + dayRow, bottom: opts.axis?.includes('hours') ? 20 : 6 });
  const { vis, x, m } = f, D = ctx.wd.data, wd = ctx.wd;
  const both = wd.mode === 'both';
  const series = both ? wd.sourceIds.map(id => D[`temp_src_${id}`]) : [D.temp, D.temp_p10, D.temp_p90, D.feels_like];
  const vals = valid(series.flatMap(s => vis.map(i => s[i])));
  if (!vals.length) return `<svg width="${f.W}" height="${height}"></svg>`;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max(1, (hi - lo) * 0.12);
  lo = Math.floor(lo - pad); hi = Math.ceil(hi + pad);
  const y = v => m.t + (hi - v) / (hi - lo) * f.ph;
  const xs = vis.map(i => x(wd.ms[i]));
  const cid = `mgc${++clipSeq}`;
  let s = `<defs><clipPath id="${cid}"><rect x="${m.l}" y="${m.t}" width="${f.pw}" height="${f.ph}"/></clipPath>`
    + `<clipPath id="${cid}w"><rect x="${m.l}" y="${m.t - 4}" width="${f.pw}" height="${Math.max(0, y(0) - m.t + 4)}"/></clipPath>`
    + `<clipPath id="${cid}c"><rect x="${m.l}" y="${y(0)}" width="${f.pw}" height="${Math.max(0, m.t + f.ph - y(0) + 4)}"/></clipPath></defs>`;
  s += decorations(ctx, f);
  s += yGrid(f, lo, hi, y, v => WX.fmt(v) + '°', 'left', 'mg-zero');
  s += `<g clip-path="url(#${cid})">`;
  if (both) {
    wd.sourceIds.forEach(id => {
      s += `<path class="mg-src mg-src-${id}" d="${linePath(xs, vis.map(i => D[`temp_src_${id}`][i] === null ? null : y(D[`temp_src_${id}`][i])))}"/>`;
    });
  } else {
    s += `<path class="mg-band mg-band-temp" d="${bandPath(xs, vis.map(i => D.temp_p10[i] === null ? null : y(D.temp_p10[i])), vis.map(i => D.temp_p90[i] === null ? null : y(D.temp_p90[i])))}"/>`;
    s += `<path class="mg-feels" d="${linePath(xs, vis.map(i => D.feels_like[i] === null ? null : y(D.feels_like[i])))}"/>`;
    const tp = linePath(xs, vis.map(i => D.temp[i] === null ? null : y(D.temp[i])));
    s += `<path class="mg-temp mg-temp-warm" clip-path="url(#${cid}w)" d="${tp}"/>`;
    s += `<path class="mg-temp mg-temp-cold" clip-path="url(#${cid}c)" d="${tp}"/>`;
  }
  s += '</g>';
  if (opts.icons) {
    // En ikon per block; blockets längd så att ikonerna får plats
    const pxPerH = f.pw / ((f.b - f.a) / H);
    const every = [1, 2, 3, 4, 6, 12, 24].find(h => h * pxPerH >= 32) || 24;
    const top = m.t - iconsRow;
    for (const i of vis) {
      const t = wd.times[i];
      if (wd.ms[i] < f.a || wd.ms[i] >= f.b) continue;
      const step = wd.step(i);
      if (step === 1 && t.getHours() % every !== 0) continue;
      if (step > 1 && step * pxPerH < 26) continue;
      const cx = x(wd.ms[i] + Math.min(every, step) * H / 2);
      if (cx < m.l + 8 || cx > m.l + f.pw - 8) continue;
      const sz = 28;
      s += `<g transform="translate(${(cx - sz / 2).toFixed(1)} ${top + 2})">${WX.icon(D.symbols[i], sz).replace('<svg ', '<svg x="0" y="0" ')}</g>`;
    }
  }
  s += xAxis(ctx, f, opts.axis || '');
  f.y = y; f.key = 'temp';
  return { svg: s, f };
};

PANELS.precip = (ctx, opts) => {
  const height = opts.height ?? 130;
  const wd = ctx.wd, D = wd.data;
  const hasThunder = valid(D.thunder).length > 0;
  const strips = opts.strips === false ? 0 : (hasThunder ? 2 : 1);
  const stripH = 9;
  const f = frame(ctx, height, { top: 8, bottom: (opts.axis?.includes('hours') ? 20 : 6) + strips * (stripH + 3) });
  const { vis, x, m } = f;
  const both = wd.mode === 'both';
  const maxMean = WX.max(vis.map(i => both ? Math.max(D.precip_src_met?.[i] ?? 0, D.precip_src_smhi?.[i] ?? 0) : D.precip[i])) ?? 0;
  const maxHi = WX.max(vis.map(i => D.precip_p90[i])) ?? 0;
  let hi = Math.max(1, maxMean * 1.25, Math.min(maxHi, Math.max(maxMean * 2.5, 1)));
  hi = Math.ceil(hi * 2) / 2;
  const y = v => m.t + (1 - Math.min(v, hi) / hi) * f.ph;
  const cid = `mgc${++clipSeq}`;
  let s = `<defs><clipPath id="${cid}"><rect x="${m.l}" y="0" width="${f.pw}" height="${height}"/></clipPath></defs>`;
  s += decorations(ctx, f);
  s += yGrid(f, 0, hi, y, v => WX.fmt(v, hi < 3 && v % 1 ? 1 : 0), 'left');
  s += `<text class="mg-unit" x="${m.l + f.pw - 4}" y="${m.t + 10}" text-anchor="end">mm/h</text>`;
  s += `<g clip-path="url(#${cid})">`;
  for (const i of vis) {
    const x0 = x(wd.ms[i]), x1 = x(wd.end(i));
    const w = Math.max(1, x1 - x0 - (x1 - x0 > 4 ? 1.5 : 0.5));
    if (both) {
      wd.sourceIds.forEach((id, k) => {
        const v = D[`precip_src_${id}`][i];
        if (!v) return;
        const ww = w / wd.sourceIds.length;
        s += `<rect class="mg-bar mg-bar-${id}" x="${(x0 + k * ww).toFixed(1)}" y="${y(v).toFixed(1)}" width="${Math.max(0.8, ww - 0.4).toFixed(1)}" height="${(m.t + f.ph - y(v)).toFixed(1)}"/>`;
      });
    } else {
      const p90 = D.precip_p90[i], v = D.precip[i];
      if (p90 > 0.02) s += `<rect class="mg-bar-hi" x="${x0.toFixed(1)}" y="${y(p90).toFixed(1)}" width="${w.toFixed(1)}" height="${(m.t + f.ph - y(p90)).toFixed(1)}"/>`;
      if (v > 0.02) s += `<rect class="mg-bar" x="${x0.toFixed(1)}" y="${y(v).toFixed(1)}" width="${w.toFixed(1)}" height="${(m.t + f.ph - y(v)).toFixed(1)}"/>`;
    }
  }
  s += '</g>';
  // Riskremsa och åskremsa: opacitet = sannolikhet
  if (strips) {
    let ys = m.t + f.ph + 4;
    const strip = (key, cls, label) => {
      let r = `<text class="mg-strip-lab" x="${m.l - 6}" y="${ys + 7.5}" text-anchor="end">${label}</text>`;
      for (const i of vis) {
        const p = D[key][i];
        if (p === null || p === undefined || p < 2) continue;
        const x0 = Math.max(m.l, x(wd.ms[i])), x1 = Math.min(m.l + f.pw, x(wd.end(i)));
        if (x1 <= x0) continue;
        r += `<rect class="${cls}" x="${x0.toFixed(1)}" y="${ys}" width="${Math.max(0.6, x1 - x0 - 0.5).toFixed(1)}" height="${stripH}" opacity="${Math.min(1, 0.08 + p / 100).toFixed(2)}"/>`;
      }
      ys += stripH + 3;
      return r;
    };
    s += strip('precip_prob', 'mg-risk', 'Risk');
    if (hasThunder) s += strip('thunder', 'mg-thunder', 'Åska');
  }
  s += xAxis(ctx, f, opts.axis || '');
  f.y = y; f.key = 'precip';
  return { svg: s, f };
};

PANELS.wind = (ctx, opts) => {
  const height = opts.height ?? 150;
  const arrowsRow = opts.arrows === false ? 0 : 22;
  const f = frame(ctx, height, { top: 8, bottom: (opts.axis?.includes('hours') ? 20 : 6) + arrowsRow });
  const { vis, x, m } = f, wd = ctx.wd, D = wd.data;
  const both = wd.mode === 'both';
  const vals = valid(vis.flatMap(i => both ? wd.sourceIds.flatMap(id => [D[`wind_src_${id}`][i], D[`gust_src_${id}`][i]]) : [D.gust[i], D.wind_p90[i], D.wind[i]]));
  const hi = Math.max(8, Math.ceil(((vals.length ? Math.max(...vals) : 8) * 1.12) / 2) * 2);
  const y = v => m.t + (1 - v / hi) * f.ph;
  const xs = vis.map(i => x(wd.ms[i]));
  const cid = `mgc${++clipSeq}`;
  let s = `<defs><clipPath id="${cid}"><rect x="${m.l}" y="${m.t}" width="${f.pw}" height="${f.ph}"/></clipPath></defs>`;
  s += decorations(ctx, f);
  s += yGrid(f, 0, hi, y, v => WX.fmt(v), 'left');
  s += `<text class="mg-unit" x="${m.l + 4}" y="${m.t + 10}" text-anchor="start">m/s</text>`;
  // Beaufort-gränser och namn i högermarginalen
  let prev = 0;
  for (const z of WX.BEAUFORT) {
    const top = Math.min(z.max, hi);
    if (z.max < hi && z.max > 1) s += `<line class="mg-bft" x1="${m.l}" x2="${m.l + f.pw}" y1="${y(z.max).toFixed(1)}" y2="${y(z.max).toFixed(1)}"/>`;
    if (opts.bft !== false && prev < hi && y(prev) - y(top) > 13) s += `<text class="mg-bft-lab" x="${m.l + f.pw + 5}" y="${((y(prev) + y(top)) / 2 + 3).toFixed(1)}">${f.W < 560 ? z.short : z.name}</text>`;
    prev = z.max;
  }
  s += `<g clip-path="url(#${cid})">`;
  if (both) {
    wd.sourceIds.forEach(id => {
      s += `<path class="mg-src mg-src-${id}" d="${linePath(xs, vis.map(i => D[`wind_src_${id}`][i] === null ? null : y(D[`wind_src_${id}`][i])))}"/>`;
      s += `<path class="mg-src mg-src-${id} mg-dash" d="${linePath(xs, vis.map(i => D[`gust_src_${id}`][i] == null ? null : y(D[`gust_src_${id}`][i])))}"/>`;
    });
  } else {
    s += `<path class="mg-band mg-band-wind" d="${bandPath(xs, vis.map(i => D.wind_p10[i] === null ? null : y(D.wind_p10[i])), vis.map(i => D.wind_p90[i] === null ? null : y(D.wind_p90[i])))}"/>`;
    s += `<path class="mg-gust" d="${linePath(xs, vis.map(i => D.gust[i] == null ? null : y(D.gust[i])))}"/>`;
    s += `<path class="mg-wind" d="${linePath(xs, vis.map(i => D.wind[i] === null ? null : y(D.wind[i])))}"/>`;
  }
  s += '</g>';
  if (arrowsRow) {
    const pxPerH = f.pw / ((f.b - f.a) / H);
    const every = [1, 2, 3, 6, 12, 24].find(h => h * pxPerH >= 24) || 24;
    const ay = m.t + f.ph + 4;
    for (const i of vis) {
      const t = wd.times[i], dir = D.wind_direction[i];
      if (dir === null || dir === undefined || wd.ms[i] < f.a || wd.ms[i] >= f.b) continue;
      if (wd.step(i) === 1 && t.getHours() % every !== 0) continue;
      if (wd.step(i) > 1 && wd.step(i) * pxPerH < 20) continue;
      const cx = x(wd.ms[i]);
      if (cx < m.l + 6 || cx > m.l + f.pw - 6) continue;
      s += `<g class="mg-arrow" transform="translate(${(cx - 8).toFixed(1)} ${ay}) rotate(${((dir + 180) % 360).toFixed(0)} 8 8)"><path d="M8 1.5l4.5 12-4.5-2.8-4.5 2.8z"/></g>`;
    }
  }
  s += xAxis(ctx, f, opts.axis || '');
  f.y = y; f.key = 'wind';
  return { svg: s, f };
};

// Ritar en panel i el. Returnerar geometrin (för hårkorset).
chart.draw = (el, kind, ctx, opts = {}) => {
  ctx = { ...ctx, width: el.clientWidth || el.getBoundingClientRect().width || 600 };
  // Alternativ kan vara funktioner av bredden (t.ex. högre grafer på mobil)
  const BY_WIDTH = ['height', 'bft', 'icons', 'axis', 'arrows', 'strips'];
  opts = Object.fromEntries(Object.entries(opts).map(([k, v]) => [k, typeof v === 'function' && BY_WIDTH.includes(k) ? v(ctx.width) : v]));
  const out = PANELS[kind](ctx, opts);
  if (typeof out === 'string') { el.innerHTML = out; return null; }
  let plot = el.querySelector(':scope > .mg-plot');
  if (!plot) {
    el.innerHTML = '<div class="mg-plot"><svg class="mg-svg"></svg><div class="mg-xhair" hidden></div></div>';
    plot = el.firstChild;
  }
  const svg = plot.querySelector('svg');
  svg.setAttribute('viewBox', `0 0 ${out.f.W} ${out.f.height}`);
  svg.setAttribute('width', out.f.W);
  svg.setAttribute('height', out.f.height);
  svg.innerHTML = out.svg;
  return out.f;
};

// Grupp av synkade paneler med gemensamt hårkors och panorering.
// panels: [{ el, kind, opts }]. getCtx(): { wd, nowMs, night, ml, mr }.
// onCursor(index|null, pinned), onRange([a, b]) anropas vid ändring.
chart.group = ({ panels, getCtx, onCursor, onRange }) => {
  const g = { range: null, extent: null, cursor: null, pinned: false, frames: [] };
  let raf = null;

  g.render = () => {
    const ctx = getCtx();
    if (!ctx || !g.range) return;
    g.frames = panels.map(p => chart.draw(p.el, p.kind, { ...ctx, range: g.range }, p.opts));
    g.ctx = ctx;
    g.updateCursor();
  };
  g.setRange = (range, extent) => {
    g.extent = extent || g.extent;
    g.range = range;
    g.render();
  };
  g.updateCursor = () => {
    const wd = g.ctx?.wd;
    panels.forEach((p, k) => {
      const xh = p.el.querySelector('.mg-xhair'), f = g.frames[k];
      if (!xh || !f) return;
      const plot = xh.parentElement;
      // Valfritt: värdeetikett (opts.tip) och punkter på kurvorna (opts.dots)
      let tip = plot.querySelector(':scope > .mg-tip'), dots = plot.querySelector(':scope > .mg-dots');
      if (p.opts?.tip && !tip) { tip = document.createElement('div'); tip.className = 'mg-tip'; tip.hidden = true; plot.appendChild(tip); }
      if (p.opts?.dots && !dots) { dots = document.createElement('div'); dots.className = 'mg-dots'; plot.appendChild(dots); }
      const hide = () => { xh.hidden = true; if (tip) tip.hidden = true; if (dots) dots.innerHTML = ''; };
      if (g.cursor === null || !wd) return hide();
      const px = f.x(wd.ms[g.cursor]);
      if (px < f.m.l || px > f.m.l + f.pw) return hide();
      xh.hidden = false;
      xh.style.left = `${px}px`;
      xh.style.top = `${f.m.t}px`;
      xh.style.height = `${f.ph}px`;
      xh.classList.toggle('pinned', g.pinned);
      if (dots) {
        dots.innerHTML = p.opts.dots(g.cursor).filter(d => d.v !== null && d.v !== undefined && !Number.isNaN(d.v))
          .map(d => `<span class="mg-dot" style="left:${px}px;top:${Math.max(f.m.t, Math.min(f.m.t + f.ph, f.y(d.v))).toFixed(1)}px;--c:${d.c}"></span>`).join('');
      }
      if (tip) {
        tip.innerHTML = p.opts.tip(g.cursor);
        tip.hidden = false;
        tip.classList.toggle('pinned', g.pinned);
        const w = tip.offsetWidth, room = f.m.l + f.pw;
        // Till höger om linjen om det får plats, annars till vänster
        const left = px + 10 + w <= room ? px + 10 : Math.max(f.m.l, px - 10 - w);
        tip.style.left = `${left}px`;
        tip.style.top = `${f.m.t + 4}px`;
      }
    });
    onCursor?.(g.cursor, g.pinned);
  };
  const indexAt = (el, clientX, k) => {
    const f = g.frames[k], wd = g.ctx?.wd;
    if (!f || !wd) return null;
    const r = el.getBoundingClientRect();
    const ms = f.a + (clientX - r.left - f.m.l) / f.pw * (f.b - f.a);
    if (ms < f.a || ms > f.b) return null;
    for (let i = 0; i < wd.n; i++) if (ms >= wd.ms[i] && ms < wd.end(i)) {
      // inom 1h-steg: närmaste hel timme
      if (wd.step(i) === 1 && ms - wd.ms[i] > H / 2 && i + 1 < wd.n) return i + 1;
      return i;
    }
    return null;
  };

  panels.forEach((p, k) => {
    const el = p.el;
    let down = null;
    el.addEventListener('pointerdown', e => {
      if (e.button !== undefined && e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, range: g.range.slice(), panning: false, id: e.pointerId, type: e.pointerType };
    });
    el.addEventListener('pointermove', e => {
      if (down && down.id === e.pointerId) {
        const dx = e.clientX - down.x, dy = e.clientY - down.y;
        if (!down.panning && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
          down.panning = true;
          try { el.setPointerCapture(e.pointerId); } catch {}
          el.classList.add('mg-panning');
        }
        if (down.panning) {
          const f = g.frames[k];
          const span = down.range[1] - down.range[0];
          let a = down.range[0] - dx / f.pw * span;
          a = Math.max(g.extent[0], Math.min(a, g.extent[1] - span));
          g.range = [a, a + span];
          if (!raf) raf = requestAnimationFrame(() => { raf = null; g.render(); });
          return;
        }
      }
      if (e.pointerType === 'mouse' && !g.pinned) {
        const i = indexAt(el, e.clientX, k);
        if (i !== g.cursor) { g.cursor = i; g.updateCursor(); }
      }
    });
    const end = e => {
      if (!down || down.id !== e.pointerId) return;
      if (down.panning) {
        el.classList.remove('mg-panning');
        onRange?.(g.range);
      } else if (e.type === 'pointerup') {
        const i = indexAt(el, e.clientX, k);
        if (g.pinned && i === g.cursor) { g.pinned = false; g.cursor = e.pointerType === 'mouse' ? i : null; }
        else { g.cursor = i; g.pinned = i !== null; }
        g.updateCursor();
      }
      down = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', e => {
      if (e.pointerType === 'mouse' && !g.pinned && !down) { g.cursor = null; g.updateCursor(); }
    });
  });

  let rt = null;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(g.render, 120); });
  return g;
};

// Liten sparkline (SVG) med ytfyllnad och markerad slutpunkt
WX.sparkline = (values, { w = 120, h = 32, cls = '' } = {}) => {
  const v = values.map(x => (x === null || x === undefined ? null : x));
  const vv = valid(v);
  if (vv.length < 2) return `<svg class="spark ${cls}" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none"></svg>`;
  let lo = Math.min(...vv), hi = Math.max(...vv);
  if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
  const xs = v.map((_, i) => 1 + i / (v.length - 1) * (w - 2));
  const ys = v.map(x => x === null ? null : 2 + (hi - x) / (hi - lo) * (h - 4));
  const line = linePath(xs, ys);
  const firstI = ys.findIndex(y => y !== null);
  let lastI = ys.length - 1; while (lastI > 0 && ys[lastI] === null) lastI--;
  const area = line + `L${xs[lastI].toFixed(1)} ${h}L${xs[firstI].toFixed(1)} ${h}Z`;
  return `<svg class="spark ${cls}" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" aria-hidden="true">`
    + `<path class="spark-area" d="${area}"/><path class="spark-line" d="${line}" vector-effect="non-scaling-stroke"/></svg>`;
};

root.WX = WX;
})(typeof window !== 'undefined' ? window : globalThis);
