/* CityWalker — modèle : ambiances, catégories, progression et statistiques. */
(function () {
  'use strict';
  const CW = window.CW;

  CW.VERSION = 1;
  CW.CITY_ORDER = ['paris', 'montpellier'];

  /** Ambiances (« modulo ») : l'ordre est figé, il sert à l'encodage binaire du lien de partage. */
  CW.TAGS = [
    { id: 'jour',       emoji: '☀️', label: 'En plein jour',       short: 'Jour' },
    { id: 'sunrise',    emoji: '🌄', label: 'Au lever du soleil',  short: 'Lever' },
    { id: 'sunset',     emoji: '🌅', label: 'Au coucher du soleil', short: 'Coucher' },
    { id: 'bleue',      emoji: '🌆', label: "À l'heure bleue",     short: 'Heure bleue' },
    { id: 'nuit',       emoji: '🌙', label: 'De nuit',             short: 'Nuit' },
    { id: 'pluie',      emoji: '🌧️', label: 'Sous la pluie',       short: 'Pluie' },
    { id: 'neige',      emoji: '❄️', label: 'Sous la neige',       short: 'Neige' },
    { id: 'brume',      emoji: '🌫️', label: 'Dans la brume',       short: 'Brume' },
    { id: 'printemps',  emoji: '🌸', label: 'Au printemps',        short: 'Printemps' },
    { id: 'automne',    emoji: '🍂', label: 'En automne',          short: 'Automne' },
    { id: 'portrait',   emoji: '🧍', label: 'Avec quelqu’un',      short: 'Portrait' },
    { id: 'argentique', emoji: '🎞️', label: 'En argentique',       short: 'Argentique' },
    { id: 'hauteur',    emoji: '🕊️', label: 'Vu d’en haut',        short: "D'en haut" },
    { id: 'detail',     emoji: '🔎', label: 'Un détail',           short: 'Détail' },
  ];
  CW.TAG_INDEX = Object.fromEntries(CW.TAGS.map((t, i) => [t.id, i]));
  CW.TAG_BY_ID = Object.fromEntries(CW.TAGS.map((t) => [t.id, t]));

  /** Objectifs « collection » par ambiance (pour la page Progression). */
  CW.TAG_GOALS = { sunset: 10, nuit: 10, sunrise: 5, pluie: 5, automne: 8, printemps: 8, bleue: 5, brume: 3, neige: 3 };

  /** Catégories de lieux : glyphe SVG monochrome (viewBox 0 0 24 24, tracé au trait). */
  CW.CATS = {
    monument:   { label: 'Monument',          plural: 'Monuments',          glyph: 'M4 20h16M6 20V9l6-5 6 5v11M10 20v-6h4v6' },
    musee:      { label: 'Musée',             plural: 'Musées',             glyph: 'M3 20h18M5 20V10M9 20V10M15 20V10M19 20V10M3 10l9-6 9 6z' },
    parc:       { label: 'Parc & jardin',     plural: 'Parcs & jardins',    glyph: 'M12 21v-6M12 15c-4 0-7-3-7-7 0-3 2-5 4-5 1 0 2 1 3 2 1-1 2-2 3-2 2 0 4 2 4 5 0 4-3 7-7 7z' },
    vue:        { label: 'Point de vue',      plural: 'Points de vue',      glyph: 'M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z' },
    place:      { label: 'Place',             plural: 'Places',             glyph: 'M4 4h16v16H4zM9 9h6v6H9z' },
    pont:       { label: 'Pont & berge',      plural: 'Ponts & berges',     glyph: 'M2 16h20M4 16V9M20 16V9M4 9c4-4 12-4 16 0M8 16v-4M12 16v-5M16 16v-4' },
    rue:        { label: 'Rue',               plural: 'Rues',               glyph: 'M6 21l3-18M18 21l-3-18M12 4v3M12 10v3M12 16v3' },
    eglise:     { label: 'Église',            plural: 'Églises',            glyph: 'M12 2v5M9.5 4.5h5M6 21V12l6-4 6 4v9M6 21h12M10 21v-5h4v5' },
    marche:     { label: 'Marché',            plural: 'Marchés',            glyph: 'M3 9h18l-1 4H4zM5 13v8h14v-8M9 21v-5h6v5M3 9l2-5h14l2 5' },
    insolite:   { label: 'Insolite',          plural: 'Lieux insolites',    glyph: 'M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.5 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z' },
    passage:    { label: 'Passage couvert',   plural: 'Passages couverts',  glyph: 'M4 21V8a8 8 0 0 1 16 0v13M4 21h16M8 21V12M16 21V12M12 21v-8' },
    quartier:   { label: 'Quartier',          plural: 'Quartiers',          glyph: 'M3 21h18M5 21V11h5v10M14 21V6h5v15M7 14h1M7 17h1M16 9h1M16 12h1M16 15h1M16 18h1' },
    'street-art': { label: 'Street art',      plural: 'Street art',         glyph: 'M4 20l4-1 11-11-3-3L5 16zM13 8l3 3M4 20l1-4' },
    eau:        { label: 'Canal & bassin',    plural: 'Canaux & bassins',   glyph: 'M3 8c2-2 4-2 6 0s4 2 6 0 4-2 6 0M3 13c2-2 4-2 6 0s4 2 6 0 4-2 6 0M3 18c2-2 4-2 6 0s4 2 6 0 4-2 6 0' },
    culture:    { label: 'Lieu culturel',     plural: 'Lieux culturels',    glyph: 'M4 5h16v11H4zM8 21l4-5 4 5M4 9h16' },
  };
  CW.catLabel = (id) => (CW.CATS[id] ? CW.CATS[id].label : id);

  /** Paliers de progression (le pourcentage de lieux photographiés). */
  CW.LEVELS = [
    { min: 0,   label: 'Premiers pas' },
    { min: 5,   label: 'Flâneur·se' },
    { min: 15,  label: 'Curieux·se' },
    { min: 30,  label: 'Explorateur·rice' },
    { min: 50,  label: 'Arpenteur·se' },
    { min: 70,  label: 'Connaisseur·se' },
    { min: 90,  label: 'Encyclopédie vivante' },
    { min: 100, label: 'Ville complétée' },
  ];
  CW.levelFor = function levelFor(pct) {
    let current = CW.LEVELS[0];
    for (const lvl of CW.LEVELS) if (pct >= lvl.min) current = lvl;
    return current;
  };

  /** Structure de progression vide pour une ville. */
  CW.emptyProgress = function emptyProgress(cityId) {
    return { v: CW.VERSION, city: cityId, owner: '', updatedAt: 0, spots: {} };
  };

  /** Entrée vide pour un lieu. */
  CW.emptyEntry = () => ({ done: false, date: '', tags: [], note: '', photos: [], rating: 0 });

  /** Normalise une entrée lue depuis le stockage ou un import (défensif). */
  CW.normalizeEntry = function normalizeEntry(raw) {
    const e = CW.emptyEntry();
    if (!raw || typeof raw !== 'object') return e;
    e.done = !!raw.done;
    e.date = typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : '';
    e.tags = Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === 'string' && CW.TAG_BY_ID[t]) : [];
    e.tags = Array.from(new Set(e.tags));
    e.note = typeof raw.note === 'string' ? raw.note.slice(0, 2000) : '';
    e.photos = Array.isArray(raw.photos) ? raw.photos.filter((p) => typeof p === 'string' && p.length < 64) : [];
    e.rating = Number.isInteger(raw.rating) ? CW.clamp(raw.rating, 0, 3) : 0;
    return e;
  };

  CW.normalizeProgress = function normalizeProgress(raw, cityId) {
    const p = CW.emptyProgress(cityId);
    if (!raw || typeof raw !== 'object') return p;
    p.owner = typeof raw.owner === 'string' ? raw.owner.slice(0, 40) : '';
    p.updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0;
    if (raw.spots && typeof raw.spots === 'object') {
      for (const id of Object.keys(raw.spots)) {
        if (typeof id !== 'string' || id.length > 64) continue;
        p.spots[id] = CW.normalizeEntry(raw.spots[id]);
      }
    }
    return p;
  };

  /** Un lieu compte comme « photographié » s'il est coché OU s'il a au moins une photo. */
  CW.isDone = (entry) => !!entry && (entry.done || (entry.photos && entry.photos.length > 0));

  /** Statistiques complètes d'une ville. */
  CW.computeStats = function computeStats(city, progress) {
    const spots = city.spots;
    const entries = progress.spots || {};
    const total = spots.length;
    let done = 0;
    let photos = 0;
    const byZone = {};
    const byCat = {};
    const byTag = {};
    for (const t of CW.TAGS) byTag[t.id] = 0;
    for (const z of city.zones) byZone[z.id] = { id: z.id, name: z.name, label: z.label, total: 0, done: 0 };

    for (const s of spots) {
      const e = entries[s.id];
      const isDone = CW.isDone(e);
      const zone = byZone[s.zone] || (byZone[s.zone] = { id: s.zone, name: s.zone, label: s.zone, total: 0, done: 0 });
      zone.total++;
      const cat = byCat[s.cat] || (byCat[s.cat] = { id: s.cat, label: CW.catLabel(s.cat), total: 0, done: 0 });
      cat.total++;
      if (isDone) {
        done++;
        zone.done++;
        cat.done++;
        photos += e.photos ? e.photos.length : 0;
        for (const t of e.tags || []) if (t in byTag) byTag[t]++;
      }
    }
    const pct = total ? Math.round((done / total) * 1000) / 10 : 0;
    const zonesVisited = Object.values(byZone).filter((z) => z.done > 0).length;
    const zonesComplete = Object.values(byZone).filter((z) => z.total > 0 && z.done === z.total).length;
    return {
      total, done, pct, photos, byZone, byCat, byTag,
      zonesVisited, zonesTotal: city.zones.length, zonesComplete,
      level: CW.levelFor(pct),
      next: CW.LEVELS.find((l) => l.min > pct) || null,
    };
  };

  /** Suggestions : lieux non faits, d'abord ceux qui brillent à une ambiance donnée, puis des quartiers peu explorés. */
  CW.suggest = function suggest(city, progress, stats, count) {
    const todo = city.spots.filter((s) => !CW.isDone(progress.spots[s.id]));
    const zoneScore = (s) => {
      const z = stats.byZone[s.zone];
      return z ? z.done / Math.max(1, z.total) : 0;
    };
    const scored = todo.map((s) => ({
      spot: s,
      score: (s.tip ? 1 : 0) + (s.best ? 0.6 : 0) - zoneScore(s) * 1.2 + (s.cat === 'vue' ? 0.4 : 0),
    }));
    scored.sort((a, b) => b.score - a.score || a.spot.name.localeCompare(b.spot.name, 'fr'));
    return scored.slice(0, count || 6).map((x) => x.spot);
  };
})();
