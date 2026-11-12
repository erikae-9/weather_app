// ── WX.createApp: tillstånd och beteende som utkasten delar ──────────────────
// Plats, prognoskälla, vald period, favoriter, senaste platser, sökning och
// position. Utkasten ritar själva; appen anropar deras callbacks.

(function (root) {
'use strict';
const WX = root.WX, H = WX.H;

WX.createApp = ({ prefix, onData, onPeriod, onLoading, onError }) => {
  const S = {
    loc: WX.store.get(`${prefix}.loc`, WX.PRESETS[0]),
    mode: WX.store.get(`${prefix}.mode`, 'met'),
    favs: WX.store.get(`${prefix}.favs`, WX.PRESETS.slice()),
    recent: WX.store.get(`${prefix}.recent`, []),
    raw: null, live: true, wd: null, days: [], night: [],
    period: null,          // { start, end } index, end exklusivt
    sel: new Set(),        // valda dygn (dateKey)
    periodKind: 'days',    // 'days' | 'all' | 'custom' | 'pan'
    fetchedAt: null,
  };
  const app = { S };

  const sameLoc = (a, b) => a && b && Math.abs(a.lat - b.lat) < 1e-4 && Math.abs(a.lon - b.lon) < 1e-4;

  function rebuild() {
    S.wd = WX.build(S.raw, S.mode);
    S.days = WX.days(S.wd, S.loc.lat, S.loc.lon);
    S.night = WX.nightIntervals(S.wd.ms[0] - 24 * H, S.wd.end(S.wd.n - 1) + 24 * H, S.loc.lat, S.loc.lon);
  }

  app.load = async (loc) => {
    S.loc = { name: loc.name, detail: loc.detail || '', lat: +loc.lat, lon: +loc.lon };
    WX.store.set(`${prefix}.loc`, S.loc);
    S.recent = [S.loc, ...S.recent.filter(r => !sameLoc(r, S.loc))].slice(0, 6);
    WX.store.set(`${prefix}.recent`, S.recent);
    onLoading?.(true);
    try {
      const r = await WX.fetchForecast(S.loc.lat, S.loc.lon, { demo: WX.wantsDemo() });
      S.raw = r.raw; S.live = r.live; S.fetchedAt = new Date();
      rebuild();
      app.setDefaultPeriod(true);
      onData?.();
    } catch (e) {
      onError?.(`Kunde inte hämta prognosen: ${e.message}`);
    } finally { onLoading?.(false); }
  };

  app.reloadIfStale = () => {
    if (S.fetchedAt && Date.now() - S.fetchedAt > 30 * 60e3) app.load(S.loc);
  };

  app.setMode = (mode) => {
    S.mode = mode;
    WX.store.set(`${prefix}.mode`, mode);
    if (!S.raw) return;
    // Tidsaxeln kan skilja mellan källorna: behåll perioden som tider
    const keep = S.period ? [S.wd.ms[S.period.start], S.wd.end(S.period.end - 1)] : null;
    rebuild();
    if (keep) S.period = clampPeriod(WX.indexRange(S.wd, keep[0], keep[1]));
    onData?.();
  };
  app.effectiveMode = () => S.raw ? WX.effectiveMode(S.raw, S.mode) : S.mode;
  app.modeAvailable = (m) => !S.raw || ((m === 'met' || S.raw.smhi) && (m === 'smhi' || S.raw.met));

  // ── PERIOD ──
  function clampPeriod(p) {
    const n = S.wd.n;
    let start = Math.max(0, Math.min(p.start, n - 1));
    let end = Math.max(start + 1, Math.min(p.end, n));
    return { start, end };
  }
  function syncSelFromPeriod() {
    S.sel = new Set();
    for (let i = S.period.start; i < S.period.end; i++) S.sel.add(WX.dateKey(S.wd.times[i]));
  }
  app.setDefaultPeriod = (silent) => {
    const keys = S.days.slice(0, 2).map(d => d.key);
    S._userPicked = false;
    app.setDays(keys, silent);
  };
  app.setDays = (keys, silent) => {
    if (!keys.length) return app.setDefaultPeriod(silent);
    const sorted = keys.slice().sort();
    const a = WX.keyToDate(sorted[0]).getTime();
    const b2 = WX.keyToDate(sorted[sorted.length - 1]);
    const b = new Date(b2.getFullYear(), b2.getMonth(), b2.getDate() + 1).getTime();
    S.period = clampPeriod(WX.indexRange(S.wd, a, b));
    S.periodKind = 'days';
    syncSelFromPeriod();
    if (!silent) onPeriod?.('days');
  };
  app.toggleDay = (key) => {
    // Första klicket efter standardvalet väljer bara den dagen
    if (S.periodKind !== 'days' || S.sel.size > 1 && !S._userPicked) {
      S._userPicked = true;
      return app.setDays([key]);
    }
    const sel = new Set(S.sel);
    if (sel.has(key) && sel.size > 1) sel.delete(key); else sel.add(key);
    S._userPicked = true;
    app.setDays([...sel]);
  };
  app.setAll = () => {
    S.period = { start: 0, end: S.wd.n };
    S.periodKind = 'all';
    syncSelFromPeriod();
    onPeriod?.('all');
  };
  app.setRange = (a, b, kind = 'custom') => {
    const p = WX.indexRange(S.wd, a, b);
    if (p.end <= p.start) { onError?.('Det finns ingen prognos i det valda tidsintervallet.'); return false; }
    S.period = clampPeriod(p);
    S.periodKind = kind;
    syncSelFromPeriod();
    onPeriod?.(kind);
    return true;
  };
  app.periodRange = () => S.period ? [S.wd.ms[S.period.start], S.wd.end(S.period.end - 1)] : null;
  app.extent = () => [S.wd.ms[0], S.wd.end(S.wd.n - 1)];
  app.stats = () => WX.periodStats(S.wd, S.period.start, S.period.end);
  app.periodLabel = () => {
    const [a, b] = app.periodRange();
    const A = new Date(a), B = new Date(b - 1);
    const d = x => `${WX.WEEKDAYS[x.getDay()]} ${x.getDate()} ${WX.MONTHS[x.getMonth()]}`;
    if (WX.dateKey(A) === WX.dateKey(B)) return `${d(A)} ${WX.hh(A)}–${WX.hh(new Date(b))}`;
    return `${d(A)} ${WX.hh(A)}:00 – ${d(new Date(b))} ${WX.hh(new Date(b))}:00`;
  };

  // ── FAVORITER ──
  app.isFav = (loc = S.loc) => S.favs.some(f => sameLoc(f, loc));
  app.toggleFav = (loc = S.loc) => {
    S.favs = app.isFav(loc) ? S.favs.filter(f => !sameLoc(f, loc)) : [...S.favs, { name: loc.name, detail: loc.detail, lat: loc.lat, lon: loc.lon }];
    WX.store.set(`${prefix}.favs`, S.favs);
    return app.isFav(loc);
  };
  app.sameLoc = sameLoc;

  // ── POSITION ──
  app.geolocate = () => new Promise(resolve => {
    if (!navigator.geolocation) { onError?.('Din webbläsare kan inte dela position. Sök efter platsen i stället.'); return resolve(false); }
    navigator.geolocation.getCurrentPosition(
      pos => { app.load({ name: 'Min position', detail: `${pos.coords.latitude.toFixed(3)}, ${pos.coords.longitude.toFixed(3)}`, lat: pos.coords.latitude, lon: pos.coords.longitude }); resolve(true); },
      err => {
        onError?.(err.code === 1 ? 'Positionen är blockerad. Tillåt platsåtkomst i webbläsaren, eller sök efter platsen.' : `Kunde inte hämta positionen (${err.message}).`);
        resolve(false);
      },
      { timeout: 10000, maximumAge: 600000 });
  });

  // ── SÖKRUTA MED FÖRSLAG ──
  // input: <input>, pop: behållare för listan. Tom ruta visar favoriter och
  // senaste. Pil upp/ned + Enter fungerar. Koordinater ("64.7, 20.9") går också.
  app.bindSearch = (input, pop, { onPick } = {}) => {
    let items = [], active = -1, timer = null, seq = 0;
    const pick = (loc) => { close(); input.value = ''; input.blur(); onPick?.(loc); app.load(loc); };
    const close = () => { pop.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
    const row = (loc, k, tag) => `<li role="option" id="${pop.id}-o${k}" class="sp-item" data-k="${k}" aria-selected="${k === active}">
        <span class="sp-name">${WX.esc(loc.name)}</span><span class="sp-detail">${WX.esc(loc.detail || `${loc.lat.toFixed(3)}, ${loc.lon.toFixed(3)}`)}</span>${tag ? `<span class="sp-tag">${tag}</span>` : ''}</li>`;
    const render = (groups, note) => {
      items = groups.flatMap(g => g.items);
      let k = 0, html = '';
      for (const g of groups) {
        if (!g.items.length) continue;
        html += `<li class="sp-head" role="presentation">${g.title}</li>` + g.items.map(l => row(l, k++, g.tag)).join('');
      }
      if (note) html += `<li class="sp-note" role="presentation">${note}</li>`;
      pop.innerHTML = html || '<li class="sp-note" role="presentation">Inga träffar. Prova en större ort eller ange koordinater, t.ex. 64.76, 20.92.</li>';
      pop.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    };
    const showDefault = () => render([
      { title: 'Mina platser', items: S.favs },
      { title: 'Senast visade', items: S.recent.filter(r => !app.isFav(r)).slice(0, 4) },
    ]);
    const query = async () => {
      const q = input.value.trim();
      if (q.length < 2) return showDefault();
      const my = ++seq;
      pop.hidden = false;
      const res = await WX.geocode(q);
      if (my !== seq) return;
      render([{ title: 'Sökträffar', items: res.results }],
        res.offline ? 'Sökningen är inte nåbar härifrån. Visar platser från en inbyggd lista.' : '');
    };
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', pop.id);
    input.setAttribute('aria-expanded', 'false');
    pop.setAttribute('role', 'listbox');
    input.addEventListener('focus', () => { if (!input.value.trim()) showDefault(); else query(); });
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(query, 280); });
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { close(); input.blur(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (pop.hidden || !items.length) return;
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        pop.querySelectorAll('.sp-item').forEach(li => li.setAttribute('aria-selected', String(+li.dataset.k === active)));
        input.setAttribute('aria-activedescendant', `${pop.id}-o${active}`);
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(timer);
        if (items.length && !pop.hidden) pick(items[Math.max(0, active)]);
        else query().then(() => { if (items.length) pick(items[0]); });
      }
    });
    pop.addEventListener('pointerdown', e => {
      const li = e.target.closest('.sp-item');
      if (!li) return;
      e.preventDefault();
      pick(items[+li.dataset.k]);
    });
    document.addEventListener('pointerdown', e => {
      if (!pop.hidden && !pop.contains(e.target) && e.target !== input) close();
    });
  };

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') app.reloadIfStale(); });
  return app;
};

// Tema: sparat val, annars systemets. Sätter data-theme på <html>.
WX.theme = {
  init(key) {
    const saved = WX.store.get(key, null);
    if (saved) document.documentElement.dataset.theme = saved;
  },
  current() {
    const t = document.documentElement.dataset.theme;
    if (t) return t;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  },
  toggle(key) {
    const next = WX.theme.current() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    WX.store.set(key, next);
    return next;
  },
};

// Enkel hash-router: #oversikt, #timmar … (inga snedstreck)
WX.router = (views, onChange) => {
  const cur = () => { const h = location.hash.replace(/^#\/?/, ''); return views.includes(h) ? h : views[0]; };
  const apply = () => onChange(cur());
  window.addEventListener('hashchange', apply);
  return { current: cur, go: v => { if (cur() === v) apply(); else location.hash = v; }, apply };
};

})(typeof window !== 'undefined' ? window : globalThis);
