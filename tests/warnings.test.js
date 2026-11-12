// Kör: node --test tests/
// SMHI-varningar: vilka områden som gäller en plats, sortering och upphörda.
// Testdatan följer SMHI:s format (IBWW warning.json) men är konstruerad.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

globalThis.window = globalThis;
require('../js/core.js');
require('../js/warnings.js');
const WX = globalThis.WX;

const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'smhi-ibww-sample.json'), 'utf8'));
const NOW = Date.parse('2026-11-12T13:00:00Z');
const SKELLEFTEA = [64.7507, 20.9528];
const IN_HOLE = [64.65, 20.62];      // Skråmträsk ligger i hålet i testpolygonen
const SAREK = [67.3775, 17.6446];

test('väljer områden som innehåller platsen, högst nivå först', () => {
  const list = WX.parseWarnings(SAMPLE, ...SKELLEFTEA, { nowMs: NOW });
  assert.deepEqual(list.map(w => [w.code, w.title]), [['RED', 'Mycket hård vind'], ['YELLOW', 'Mycket snö']]);
  const snow = list[1];
  assert.equal(snow.level, 'Gul varning');
  assert.equal(snow.event, 'Snö');
  assert.equal(snow.area, 'Kustland i Västerbotten');
  assert.deepEqual(snow.affected, ['Västerbottens län']);
  assert.equal(snow.start.toISOString(), '2026-11-13T05:00:00.000Z');
  assert.deepEqual(snow.texts, [{ title: 'Vad händer', text: '10–20 cm snö.' }]);   // tom text utelämnas
  assert.equal(list[0].end, null);                                                     // saknat slut = tills vidare
});

test('hål i polygonen räknas inte som inuti', () => {
  const codes = WX.parseWarnings(SAMPLE, ...IN_HOLE, { nowMs: NOW }).map(w => w.code);
  assert.deepEqual(codes, ['RED']);   // vindpolygonen saknar hål, snöpolygonen har ett
});

test('MultiPolygon och plats utanför alla områden', () => {
  assert.deepEqual(WX.parseWarnings(SAMPLE, ...SAREK, { nowMs: NOW }).map(w => w.code), ['ORANGE']);
  assert.deepEqual(WX.parseWarnings(SAMPLE, 59.33, 18.07, { nowMs: NOW }), []);
});

test('upphörda varningar tas bort, all: true visar alla aktuella', () => {
  const all = WX.parseWarnings(SAMPLE, 59.33, 18.07, { nowMs: NOW, all: true });
  assert.deepEqual(all.map(w => w.code), ['RED', 'ORANGE', 'YELLOW']);
  assert.ok(all.every(w => !w.end || w.end.getTime() > NOW));
});

test('tål oväntat innehåll', () => {
  assert.deepEqual(WX.parseWarnings(null, ...SKELLEFTEA), []);
  assert.deepEqual(WX.parseWarnings({}, ...SKELLEFTEA), []);
  assert.deepEqual(WX.parseWarnings([{ warningAreas: [{ area: null }] }], ...SKELLEFTEA), []);
  const msg = WX.parseWarnings([{ event: { sv: 'Brandrisk' }, warningAreas: [{ area: SAMPLE[1].warningAreas[0].area }] }], ...SKELLEFTEA, { nowMs: NOW });
  assert.equal(msg[0].code, 'MESSAGE');
  assert.equal(msg[0].level, 'Meddelande');
  assert.equal(msg[0].title, 'Brandrisk');
});

test('varning per dygn tar högsta nivån som berör dygnet', () => {
  const list = WX.parseWarnings(SAMPLE, ...SKELLEFTEA, { nowMs: NOW });
  assert.equal(WX.warningForDay(list, new Date(2026, 10, 13)).code, 'RED');   // röd saknar slut
  const yellowOnly = list.filter(w => w.code === 'YELLOW');
  assert.equal(WX.warningForDay(yellowOnly, new Date(2026, 10, 12)), null);
  assert.equal(WX.warningForDay(yellowOnly, new Date(2026, 10, 13)).code, 'YELLOW');
});
