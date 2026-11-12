// ── VÄDERVARNINGAR (SMHI) ────────────────────────────────────────────────────
// SMHI:s konsekvensbaserade varningar (IBWW), öppna data:
//   https://opendata-download-warnings.smhi.se/ibww/api/version/1/warning.json
// Svaret är en lista med varningar. Varje varning har en händelse (event) och
// ett eller flera områden (warningAreas) med nivå, beskrivning, ungefärlig
// start och slut, berörda kommuner/län och områdets form som GeoJSON-polygon
// (EPSG:4326, [lon, lat]). Appen visar de områden som innehåller vald plats.
//
// Formatet är hämtat från SMHI:s API-dokumentation och kontrollerat mot två
// fristående projekt som läser samma tjänst. Läsningen är försiktig: saknade
// fält ger tomma värden i stället för fel.

(function (root) {
'use strict';
const WX = root.WX;

const WARNINGS_URL = 'https://opendata-download-warnings.smhi.se/ibww/api/version/1/warning.json';
const RANK = { RED: 3, ORANGE: 2, YELLOW: 1, MESSAGE: 0 };
const LEVEL_SV = { RED: 'Röd varning', ORANGE: 'Orange varning', YELLOW: 'Gul varning', MESSAGE: 'Meddelande' };

// Punkt i polygon (strålkastning) för en ring [[lon, lat], ...]
function inRing(lon, lat, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = +ring[i][0], yi = +ring[i][1], xj = +ring[j][0], yj = +ring[j][1];
    if (((yi > lat) !== (yj > lat)) && lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-30) + xi) inside = !inside;
  }
  return inside;
}
function inPolygon(lon, lat, rings) {
  if (!rings?.length || !inRing(lon, lat, rings[0])) return false;
  return !rings.slice(1).some(hole => inRing(lon, lat, hole));   // hål
}
// Klarar Geometry, Feature och FeatureCollection
function inGeometry(lon, lat, g) {
  if (!g || typeof g !== 'object') return false;
  if (g.type === 'Feature') return inGeometry(lon, lat, g.geometry);
  if (g.type === 'FeatureCollection') return (g.features || []).some(f => inGeometry(lon, lat, f));
  if (g.type === 'GeometryCollection') return (g.geometries || []).some(x => inGeometry(lon, lat, x));
  if (g.type === 'Polygon') return inPolygon(lon, lat, g.coordinates);
  if (g.type === 'MultiPolygon') return (g.coordinates || []).some(p => inPolygon(lon, lat, p));
  return false;
}

const sv = o => (o && typeof o === 'object' ? (o.sv ?? o.en ?? '') : (o ?? '')) || '';
const toDate = s => { if (!s) return null; const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d; };

// json: SMHI:s svar. Returnerar varningsområden som gäller platsen (eller
// alla, med all: true), utan de som redan har upphört, högst nivå först.
WX.parseWarnings = (json, lat, lon, { nowMs = Date.now(), all = false } = {}) => {
  const list = Array.isArray(json) ? json : (Array.isArray(json?.warnings) ? json.warnings : []);
  const out = [], seen = new Set();
  for (const w of list) {
    for (const a of w?.warningAreas || []) {
      const geom = a.area?.geometry ? a.area.geometry : a.area;
      const inside = inGeometry(lon, lat, geom);
      if (!all && !inside) continue;
      const end = toDate(a.approximateEnd);
      if (end && end.getTime() <= nowMs) continue;
      const key = `${w.id ?? ''}/${a.id ?? out.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const code = String(a.warningLevel?.code || 'MESSAGE').toUpperCase();
      out.push({
        id: key, code, rank: RANK[code] ?? 0,
        level: sv(a.warningLevel) || LEVEL_SV[code] || code,
        event: sv(w.event),
        title: sv(a.eventDescription) || sv(w.event) || 'Varning',
        area: sv(a.areaName),
        affected: (a.affectedAreas || []).map(sv).filter(Boolean),
        start: toDate(a.approximateStart), end,
        published: toDate(a.published),
        texts: (a.descriptions || []).map(d => ({ title: sv(d.title), text: sv(d.text) })).filter(d => d.text),
        inside,
      });
    }
  }
  return out.sort((x, y) => y.rank - x.rank || (x.start?.getTime() ?? 0) - (y.start?.getTime() ?? 0));
};

// Hämtar och filtrerar. Kastar vid nätverksfel (anroparen avgör vad som visas).
WX.fetchWarnings = async (lat, lon, { demo = false, all = false } = {}) => {
  if (demo) return { live: false, list: WX.parseWarnings(root.WXDemo.warnings(lat, lon, Date.now()), lat, lon, { all }) };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch(WARNINGS_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`SMHI varningar HTTP ${res.status}`);
    return { live: true, list: WX.parseWarnings(await res.json(), lat, lon, { all }) };
  } finally { clearTimeout(timer); }
};
// ?varningar=alla visar alla aktuella varningar i Sverige (för att kontrollera tjänsten)
WX.wantsAllWarnings = () => typeof location !== 'undefined' && /[?&]varningar=alla\b/.test(location.search);

// "tors 12 nov 06:00 – 18:00", "tors 12 nov 06:00 – fre 13 nov 00:00", "från tors 12 nov 06:00"
WX.warningSpan = w => {
  const d = x => `${WX.WEEKDAYS[x.getDay()]} ${x.getDate()} ${WX.MONTHS[x.getMonth()]}`;
  const t = x => WX.hhmm(x);
  if (!w.start && !w.end) return '';
  if (!w.end) return `från ${d(w.start)} ${t(w.start)}`;
  if (!w.start) return `till ${d(w.end)} ${t(w.end)}`;
  const sameDay = WX.dateKey(w.start) === WX.dateKey(new Date(w.end.getTime() - 1));
  return sameDay ? `${d(w.start)} ${t(w.start)}–${w.end.getHours() === 0 && w.end.getMinutes() === 0 ? '24:00' : t(w.end)}`
    : `${d(w.start)} ${t(w.start)} – ${d(w.end)} ${t(w.end)}`;
};

// Högsta varning som berör ett dygn ([dygnets början, nästa midnatt))
WX.warningForDay = (list, date) => {
  const a = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const b = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
  return (list || []).filter(w => (w.start ? w.start.getTime() : -Infinity) < b && (w.end ? w.end.getTime() : Infinity) > a)
    .sort((x, y) => y.rank - x.rank)[0] || null;
};

WX._inGeometry = inGeometry;   // för tester
})(typeof window !== 'undefined' ? window : globalThis);
