/* CityWalker — orchestration de l'application. */
(function () {
  'use strict';
  const CW = window.CW;
  const { el, $, $$, clear } = CW;
  const { catIcon, ring, bar, tagChip } = CW.ui;

  const app = {
    cities: {},          // données statiques par ville
    cityId: 'paris',
    city: null,
    settings: CW.store.getSettings(),
    shared: null,        // {city, owner, progress} quand on regarde une carte partagée
    selected: null,
    filters: { q: '', state: 'tous', zone: '', cat: '', tags: [] },
    map: null,
    addMode: false,
    visible: new Set(),
  };
  window.CityWalker = app;

  // -------------------------------------------------------------- progression

  const progressOf = () => (app.shared ? app.shared.progress : CW.store.loadProgress(app.cityId));
  const entryOf = (id) => progressOf().spots[id] || null;
  const readOnly = () => !!app.shared;
  const customSpots = () => progressOf().custom || [];
  /** Liste curatée plus lieux posés à la main : ce que voient la carte et la liste. */
  const allSpots = () => app.city.spots.concat(customSpots());
  const spotById = (id) => allSpots().find((s) => s.id === id) || null;

  // -------------------------------------------------------------- chargement

  async function loadCity(id) {
    if (app.cities[id]) return app.cities[id];
    // Version « un seul fichier » : les données sont déjà dans la page.
    if (window.CW_DATA && window.CW_DATA[id]) {
      app.cities[id] = window.CW_DATA[id];
      return app.cities[id];
    }
    let res;
    try {
      res = await fetch(`data/${id}.json`, { cache: 'no-cache' });
    } catch (_) {
      throw new Error("Les données n'ont pas pu être chargées. Ouvre la page via un serveur (http://) et non par double-clic sur le fichier.");
    }
    if (!res.ok) throw new Error(`Impossible de charger la carte de ${id} (${res.status}).`);
    const data = await res.json();
    app.cities[id] = data;
    return data;
  }

  // ------------------------------------------------------------------ thème

  // `data-theme` peut déjà être posé par l'hôte (ex. la visionneuse d'artifact) :
  // on ne l'efface que si c'est nous qui l'avions posé.
  let themeOwned = false;
  function applyTheme() {
    const t = app.settings.theme;
    const root = document.documentElement;
    if (t === 'auto') {
      if (themeOwned) { root.removeAttribute('data-theme'); themeOwned = false; }
    } else {
      root.setAttribute('data-theme', t);
      themeOwned = true;
    }
  }
  function cycleTheme() {
    const order = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(app.settings.theme) + 1) % order.length];
    app.settings = CW.store.setSettings({ theme: next });
    applyTheme();
    CW.toast(`Thème : ${{ auto: 'automatique', light: 'clair', dark: 'sombre' }[next]}`);
  }

  // ------------------------------------------------------------------ filtres

  function matches(spot) {
    const f = app.filters;
    const e = entryOf(spot.id);
    const done = CW.isDone(e);
    if (f.state === 'done' && !done) return false;
    if (f.state === 'todo' && done) return false;
    if (f.zone === '__custom') { if (!spot.custom) return false; }
    else if (f.zone && (spot.custom || spot.zone !== f.zone)) return false;
    if (f.cat && spot.cat !== f.cat) return false;
    if (f.tags.length) {
      const tags = e ? e.tags || [] : [];
      if (!f.tags.every((t) => tags.includes(t))) return false;
    }
    if (f.q) {
      const zone = app.city.zones.find((z) => z.id === spot.zone);
      const hay = CW.norm([spot.name, spot.sub || '', zone ? zone.name : '', zone ? zone.label : '', CW.catLabel(spot.cat)].join(' '));
      if (!hay.includes(f.q)) return false;
    }
    return true;
  }

  function activeFilterCount() {
    const f = app.filters;
    return (f.zone ? 1 : 0) + (f.cat ? 1 : 0) + f.tags.length;
  }

  // -------------------------------------------------------------------- liste

  function renderList() {
    const host = $('#liste-lieux');
    clear(host);
    const visible = allSpots().filter(matches);
    app.visible = new Set(visible.map((s) => s.id));
    app.map.setFilter(activeFilterCount() || app.filters.q || app.filters.state !== 'tous' ? app.visible : null);

    const summary = $('#list-summary');
    const stats = CW.computeStats(app.city, progressOf());
    summary.textContent = visible.length === allSpots().length
      ? `${stats.done} / ${stats.total} lieux photographiés`
      : `${visible.length} ${CW.plural(visible.length, 'lieu affiché', 'lieux affichés')} sur ${stats.total}`;

    const fc = $('#filter-count');
    const n = activeFilterCount();
    fc.textContent = n ? `(${n})` : '';

    if (!visible.length) {
      host.appendChild(el('p', { class: 'empty' }, 'Aucun lieu ne correspond. Essaie de retirer un filtre.'));
      return;
    }

    const byZone = new Map();
    for (const s of visible) {
      const key = s.custom ? '__custom' : s.zone;
      if (!byZone.has(key)) byZone.set(key, []);
      byZone.get(key).push(s);
    }
    const zonesPlusCustom = app.city.zones.concat([{ id: '__custom', name: 'Mes lieux', label: 'Mes lieux' }]);
    for (const z of zonesPlusCustom) {
      const list = byZone.get(z.id);
      if (!list) continue;
      const zs = stats.byZone[z.id] || { done: list.filter((x) => CW.isDone(entryOf(x.id))).length, total: list.length };
      const group = el('section', { class: 'group' });
      group.appendChild(el('h3', { class: 'group-head' }, [
        el('button', {
          type: 'button', class: 'group-title', title: `Zoomer sur ${z.name}`,
          onclick: () => { if (z.id !== '__custom') app.map.focusZone(z.id); setView('carte'); },
        }, [
          el('span', { class: 'group-label', text: z.label }),
          el('span', { class: 'group-name', text: z.label === z.name ? '' : z.name }),
        ]),
        el('span', { class: 'group-count', text: `${zs.done}/${zs.total}` }),
        bar(zs.done, zs.total),
      ]));
      const ul = el('ul', { class: 'spot-list' });
      for (const s of list) ul.appendChild(spotRow(s));
      group.appendChild(ul);
      host.appendChild(group);
    }
  }

  function spotRow(s) {
    const e = entryOf(s.id);
    const done = CW.isDone(e);
    const li = el('li', { class: `spot-row${done ? ' is-done' : ''}${s.id === app.selected ? ' is-selected' : ''}`, 'data-id': s.id });
    const btn = el('button', { type: 'button', class: 'spot-btn', onclick: () => selectSpot(s.id, true) }, [
      el('span', { class: 'spot-check', 'aria-hidden': 'true' }, done ? '✓' : ''),
      el('span', { class: 'spot-main' }, [
        el('span', { class: 'spot-name', text: s.name }),
        el('span', { class: 'spot-meta' }, [
          catIcon(s.cat, 'cat-ico cat-ico-sm'),
          el('span', { text: CW.catLabel(s.cat) }),
          s.sub ? el('span', { class: 'spot-sub', text: `· ${s.sub}` }) : null,
        ]),
      ]),
      el('span', { class: 'spot-tags' }, (e && e.tags ? e.tags : []).slice(0, 4).map((t) => el('span', { class: 'mini-tag', title: CW.TAG_BY_ID[t].label, text: CW.TAG_BY_ID[t].emoji }))),
      e && (e.photos.length || e.photoCount) ? el('span', { class: 'spot-photos', title: 'photos', text: `▣ ${e.photos.length || e.photoCount}` }) : null,
    ]);
    li.appendChild(btn);
    return li;
  }

  // ------------------------------------------------------------ fiche du lieu

  function selectSpot(id, fly) {
    app.selected = id;
    app.map.select(id, fly !== false);
    renderSheet();
    $$('.spot-row').forEach((r) => r.classList.toggle('is-selected', r.dataset.id === id));
    if (id) {
      const row = document.querySelector(`.spot-row[data-id="${id}"]`);
      if (row) row.scrollIntoView({ block: 'nearest', behavior: CW.prefersReducedMotion() ? 'auto' : 'smooth' });
    }
  }

  function closeSheet() {
    app.selected = null;
    app.map.select(null);
    $('#sheet').hidden = true;
    $('#sheet-backdrop').hidden = true;
    $$('.spot-row').forEach((r) => r.classList.remove('is-selected'));
  }

  function renderSheet() {
    const sheet = $('#sheet');
    const inner = $('#sheet-inner');
    if (!app.selected) { closeSheet(); return; }
    const s = spotById(app.selected);
    if (!s) { closeSheet(); return; }
    const zone = app.city.zones.find((z) => z.id === s.zone);
    const e = app.shared ? (progressOf().spots[s.id] || CW.emptyEntry()) : CW.store.ensureEntry(app.cityId, s.id);
    const done = CW.isDone(e);

    clear(inner);
    inner.appendChild(el('header', { class: 'sheet-head' }, [
      el('div', { class: 'sheet-titles' }, [
        el('h2', { id: 'sheet-title', class: 'sheet-title', text: s.name }),
        el('p', { class: 'sheet-sub' }, [
          catIcon(s.cat, 'cat-ico cat-ico-sm'),
          el('span', { text: CW.catLabel(s.cat) }),
          el('span', { text: ' · ' }),
          el('span', { text: zone ? (zone.label === zone.name ? zone.name : `${zone.label} — ${zone.name}`) : s.zone }),
          s.sub ? el('span', { text: ` · ${s.sub}` }) : null,
        ]),
      ]),
      el('button', { type: 'button', class: 'btn btn-icon sheet-close', 'aria-label': 'Fermer la fiche', onclick: closeSheet }, '✕'),
    ]));

    if (s.tip) inner.appendChild(el('p', { class: 'tip' }, [el('span', { class: 'tip-ico', 'aria-hidden': 'true', text: '◆' }), s.tip]));

    if (s.custom && !readOnly()) {
      const grid = el('div', { class: 'field-grid' });
      grid.appendChild(el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Nom du lieu' }),
        el('input', {
          type: 'text', class: 'custom-name', value: s.name === 'Lieu sans nom' ? '' : s.name,
          placeholder: 'Ex. le muret derrière la gare', maxlength: 80,
          oninput: CW.debounce((ev) => renameCustomSpot(s, { name: ev.target.value.trim() || 'Lieu sans nom' }), 400),
        }),
      ]));
      grid.appendChild(el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Catégorie' }),
        el('select', { onchange: (ev) => { renameCustomSpot(s, { cat: ev.target.value }); renderSheet(); } },
          Object.keys(CW.CATS).sort((a, b) => CW.catLabel(a).localeCompare(CW.catLabel(b), 'fr'))
            .map((c) => el('option', { value: c, selected: s.cat === c }, CW.catLabel(c)))),
      ]));
      inner.appendChild(grid);
      inner.appendChild(el('p', { class: 'hint', text: `Posé à ${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}.` }));
    }

    if (readOnly()) {
      inner.appendChild(el('p', { class: 'sheet-ro' }, done ? 'Photographié ✓' : 'Pas encore photographié'));
      if (e.tags.length) inner.appendChild(el('div', { class: 'tag-row' }, e.tags.map((t) => el('span', { class: 'tag-chip is-on is-static' }, [el('span', { class: 'tag-emoji', text: CW.TAG_BY_ID[t].emoji }), el('span', { class: 'tag-text', text: CW.TAG_BY_ID[t].short })]))));
      if (e.date) inner.appendChild(el('p', { class: 'sheet-date', text: CW.fmtDate(e.date) }));
      if (e.photoCount) inner.appendChild(el('p', { class: 'sheet-date', text: `${e.photoCount} ${CW.plural(e.photoCount, 'photo', 'photos')} (non incluses dans un lien de partage)` }));
      if (e.note) inner.appendChild(el('p', { class: 'sheet-note-ro', text: e.note }));
    } else {
      // Bouton principal : photographié ou non
      const toggle = el('button', {
        type: 'button', class: `done-toggle${done ? ' is-on' : ''}`, 'aria-pressed': done ? 'true' : 'false',
        onclick: () => {
          const nowDone = !CW.isDone(e);
          const patch = { done: nowDone };
          if (nowDone && !e.date) patch.date = CW.todayISO();
          CW.store.updateEntry(app.cityId, s.id, patch);
          refreshAll();
          renderSheet();
        },
      }, [el('span', { class: 'done-mark', 'aria-hidden': 'true', text: done ? '✓' : '' }), el('span', { text: done ? 'Photographié' : "Je l'ai photographié" })]);
      inner.appendChild(toggle);

      inner.appendChild(el('h3', { class: 'sheet-h3', text: 'Ambiance capturée' }));
      const tagRow = el('div', { class: 'tag-row' });
      for (const t of CW.TAGS) {
        const on = e.tags.includes(t.id);
        tagRow.appendChild(tagChip(t, on, () => {
          const tags = new Set(e.tags);
          on ? tags.delete(t.id) : tags.add(t.id);
          const patch = { tags: Array.from(tags) };
          if (!on && !CW.isDone(e)) { patch.done = true; if (!e.date) patch.date = CW.todayISO(); }
          CW.store.updateEntry(app.cityId, s.id, patch);
          refreshAll();
          renderSheet();
        }));
      }
      inner.appendChild(tagRow);
      if (s.best && s.best.length) {
        inner.appendChild(el('p', { class: 'sheet-hint' }, `Recommandé ici : ${s.best.map((b) => (CW.TAG_BY_ID[b] ? CW.TAG_BY_ID[b].label.toLowerCase() : b)).join(', ')}.`));
      }

      const grid = el('div', { class: 'field-grid' });
      grid.appendChild(el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Date' }),
        el('input', {
          type: 'date', value: e.date || '', max: CW.todayISO(),
          oninput: (ev) => { CW.store.updateEntry(app.cityId, s.id, { date: ev.target.value }); refreshAll(); },
        }),
      ]));
      grid.appendChild(el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Coup de cœur' }),
        el('div', { class: 'stars', role: 'group' }, [0, 1, 2, 3].slice(1).map((n) => el('button', {
          type: 'button', class: `star${e.rating >= n ? ' is-on' : ''}`, 'aria-label': `${n} sur 3`, 'aria-pressed': e.rating >= n ? 'true' : 'false',
          onclick: () => { CW.store.updateEntry(app.cityId, s.id, { rating: e.rating === n ? 0 : n }); refreshAll(); renderSheet(); },
        }, '★'))),
      ]));
      inner.appendChild(grid);

      inner.appendChild(el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Note' }),
        el('textarea', {
          rows: 2, placeholder: 'Ce que tu as vu, l’objectif utilisé, à refaire…', maxlength: 2000,
          oninput: CW.debounce((ev) => { CW.store.updateEntry(app.cityId, s.id, { note: ev.target.value }); }, 400),
        }, e.note || ''),
      ]));

      inner.appendChild(el('h3', { class: 'sheet-h3', text: 'Photos' }));
      const photoHost = el('div', { class: 'photo-grid' });
      inner.appendChild(photoHost);
      const fileInput = el('input', {
        type: 'file', accept: 'image/*', multiple: true, class: 'visually-hidden', id: 'photo-input',
        onchange: (ev) => { addPhotos(s, Array.from(ev.target.files || [])); ev.target.value = ''; },
      });
      inner.appendChild(fileInput);
      inner.appendChild(el('button', {
        type: 'button', class: 'btn btn-add', onclick: () => fileInput.click(),
      }, CW.store.photosAvailable ? '+ Ajouter des photos' : '+ Ajouter des photos (indisponible ici)'));
      renderPhotos(photoHost, s);

      if (s.custom) {
        inner.appendChild(el('button', {
          type: 'button', class: 'btn btn-danger btn-small sheet-delete',
          onclick: () => deleteCustomSpot(s),
        }, 'Supprimer ce lieu'));
      }
    }

    sheet.hidden = false;
    if (window.matchMedia('(max-width: 900px)').matches) $('#sheet-backdrop').hidden = false;
    sheet.scrollTop = 0;
  }

  async function renderPhotos(host, spot) {
    clear(host);
    let rows = [];
    try { rows = await CW.store.photosForSpot(app.cityId, spot.id); } catch (_) { rows = []; }
    if (!rows.length) {
      host.appendChild(el('p', { class: 'empty empty-sm' }, CW.store.photosAvailable
        ? 'Aucune photo pour l’instant. Elles restent sur cet appareil.'
        : 'Ce navigateur bloque le stockage local des images (navigation privée ?).'));
      return;
    }
    for (const r of rows) {
      const fig = el('figure', { class: 'photo' });
      fig.appendChild(el('img', { src: CW.store.objectURL(r, 'thumb'), alt: `Photo de ${spot.name}`, loading: 'lazy', width: 200, height: 150 }));
      fig.appendChild(el('button', {
        type: 'button', class: 'photo-del', title: 'Supprimer cette photo', 'aria-label': 'Supprimer cette photo',
        onclick: async () => {
          if (!confirm('Supprimer cette photo ? C’est définitif.')) return;
          await CW.store.deletePhoto(r.id);
          const e = CW.store.ensureEntry(app.cityId, spot.id);
          CW.store.updateEntry(app.cityId, spot.id, { photos: e.photos.filter((p) => p !== r.id) });
          refreshAll();
          renderSheet();
        },
      }, '✕'));
      fig.appendChild(el('a', { class: 'photo-open', href: CW.store.objectURL(r, 'full'), target: '_blank', rel: 'noopener', title: 'Ouvrir en grand' }, '⤢'));
      host.appendChild(fig);
    }
  }

  async function addPhotos(spot, files) {
    if (!files.length) return;
    if (!CW.store.photosAvailable) { CW.toast('Le stockage des photos est indisponible sur ce navigateur.', 'error'); return; }
    let ok = 0;
    for (const f of files) {
      try {
        const p = await CW.ingestPhoto(f);
        const id = CW.uid();
        await CW.store.putPhoto({
          id, city: app.cityId, spot: spot.id, w: p.w, h: p.h,
          takenAt: p.takenAt ? p.takenAt.toISOString() : '', caption: '', createdAt: Date.now(),
          full: p.full, thumb: p.thumb,
        });
        const e = CW.store.ensureEntry(app.cityId, spot.id);
        const patch = { photos: e.photos.concat([id]), done: true };
        if (!e.date) patch.date = p.takenAt ? CW.dateToISO(p.takenAt) : CW.todayISO();
        CW.store.updateEntry(app.cityId, spot.id, patch);
        ok++;
        if (p.lat !== null && p.lon !== null) {
          const near = CW.nearestSpot(app.city, p.lat, p.lon, 400);
          if (near && near.spot.id !== spot.id) {
            CW.toast(`Le GPS de cette photo pointe plutôt vers « ${near.spot.name} » (${near.distance} m).`, 'info', 6000);
          }
        }
      } catch (err) {
        CW.toast(err && err.message ? err.message : 'Photo illisible.', 'error');
      }
    }
    if (ok) CW.toast(`${ok} ${CW.plural(ok, 'photo ajoutée', 'photos ajoutées')}.`);
    refreshAll();
    renderSheet();
  }

  // ------------------------------------------------------ lieux personnels

  function toggleAddMode(on) {
    if (readOnly()) return;
    app.addMode = on === undefined ? !app.addMode : on;
    app.map.setAddMode(app.addMode);
    const btn = $('#btn-add-spot');
    btn.setAttribute('aria-pressed', app.addMode ? 'true' : 'false');
    btn.classList.toggle('is-on', app.addMode);
    $('#add-hint').hidden = !app.addMode;
    if (app.addMode) { setView('carte'); closeSheet(); }
  }

  function createCustomSpot(x, y) {
    if (readOnly()) return;
    if (!app.map.insideCity(x, y)) {
      CW.toast(`Ce point est hors de ${app.city.name}. Pose l'épingle à l'intérieur de la ville.`, 'error');
      return;
    }
    const { lat, lon } = app.map.unproject(x, y);
    const spot = CW.normalizeCustom({
      id: 'u' + CW.uid(), name: '', cat: 'insolite',
      zone: app.map.zoneAt(x, y) || '',
      x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, lat, lon,
    });
    const p = CW.store.loadProgress(app.cityId);
    p.custom.push(spot);
    CW.store.saveProgress(app.cityId);
    toggleAddMode(false);
    app.map.setSpots(allSpots());
    refreshAll();
    selectSpot(spot.id, false);
    const input = $('#sheet .custom-name');
    if (input) { input.focus(); input.select(); }
    CW.toast('Lieu posé. Donne-lui un nom.');
  }

  function deleteCustomSpot(spot) {
    if (!confirm(`Supprimer « ${spot.name} » et ses photos ? C'est définitif.`)) return;
    CW.store.photosForSpot(app.cityId, spot.id)
      .then((rows) => Promise.all(rows.map((r) => CW.store.deletePhoto(r.id))))
      .catch(() => {})
      .then(() => {
        const p = CW.store.loadProgress(app.cityId);
        p.custom = p.custom.filter((c) => c.id !== spot.id);
        delete p.spots[spot.id];
        CW.store.saveProgress(app.cityId);
        closeSheet();
        app.map.setSpots(allSpots());
        refreshAll();
        CW.toast('Lieu supprimé.');
      });
  }

  function renameCustomSpot(spot, patch) {
    const p = CW.store.loadProgress(app.cityId);
    const target = p.custom.find((c) => c.id === spot.id);
    if (!target) return;
    Object.assign(target, patch);
    CW.store.saveProgress(app.cityId);
    app.map.setSpots(allSpots());
    refreshAll();
  }

  /** Un lieu au hasard parmi ceux qui restent à faire. */
  function randomSpot() {
    const todo = allSpots().filter((s) => !CW.isDone(entryOf(s.id)));
    if (!todo.length) { CW.toast(`Tout est photographié à ${app.city.name}. Chapeau.`); return; }
    const pick = todo[Math.floor(Math.random() * todo.length)];
    setView('carte');
    selectSpot(pick.id, true);
    CW.toast(`Au hasard : ${pick.name}.`);
  }

  // -------------------------------------------------------------- progression

  function renderProgress() {
    const host = $('#progress-body');
    clear(host);
    const stats = CW.computeStats(app.city, progressOf());

    host.appendChild(el('div', { class: 'prog-hero' }, [
      ring(stats.pct, 132),
      el('div', { class: 'prog-hero-txt' }, [
        el('p', { class: 'prog-level', text: stats.level.label }),
        el('p', { class: 'prog-count' }, [el('strong', { text: `${stats.done}` }), ` / ${stats.total} lieux photographiés`]),
        el('p', { class: 'prog-sub', text: `${stats.photos} ${CW.plural(stats.photos, 'photo enregistrée', 'photos enregistrées')} · ${stats.zonesVisited}/${stats.zonesTotal} ${app.city.zoneWordPlural} entamés · ${stats.zonesComplete} ${CW.plural(stats.zonesComplete, 'terminé', 'terminés')}` }),
        stats.customTotal ? el('p', { class: 'prog-sub', text: `Plus ${stats.customDone}/${stats.customTotal} ${CW.plural(stats.customTotal, 'lieu à toi', 'lieux à toi')}, hors du pourcentage.` }) : null,
        stats.next ? el('p', { class: 'prog-next', text: `Prochain palier à ${stats.next.min} % : ${stats.next.label}.` }) : null,
      ]),
    ]));

    host.appendChild(el('h3', { class: 'prog-h3', text: `Par ${app.city.zoneWord}` }));
    const zl = el('ul', { class: 'prog-list' });
    for (const z of app.city.zones) {
      const s = stats.byZone[z.id];
      if (!s) continue;
      zl.appendChild(el('li', { class: `prog-row${s.done === s.total && s.total ? ' is-complete' : ''}` }, [
        el('button', {
          type: 'button', class: 'prog-name', onclick: () => { app.map.focusZone(z.id); setView('carte'); },
        }, z.label === z.name ? z.name : `${z.label} · ${z.name}`),
        bar(s.done, s.total),
        el('span', { class: 'prog-num', text: `${s.done}/${s.total}` }),
      ]));
    }
    host.appendChild(zl);

    host.appendChild(el('h3', { class: 'prog-h3', text: 'Ambiances' }));
    const tl = el('ul', { class: 'prog-tags' });
    for (const t of CW.TAGS) {
      const n = stats.byTag[t.id] || 0;
      const goal = CW.TAG_GOALS[t.id];
      tl.appendChild(el('li', { class: `prog-tag${goal && n >= goal ? ' is-complete' : ''}${n ? '' : ' is-zero'}` }, [
        el('span', { class: 'tag-emoji', 'aria-hidden': 'true', text: t.emoji }),
        el('span', { class: 'prog-tag-label', text: t.label }),
        el('span', { class: 'prog-tag-num', text: goal ? `${n}/${goal}` : String(n) }),
      ]));
    }
    host.appendChild(tl);

    host.appendChild(el('h3', { class: 'prog-h3', text: 'Par catégorie' }));
    const cl = el('ul', { class: 'prog-list' });
    for (const c of Object.values(stats.byCat).sort((a, b) => b.total - a.total)) {
      cl.appendChild(el('li', { class: 'prog-row' }, [
        el('span', { class: 'prog-name prog-name-static' }, [catIcon(c.id, 'cat-ico cat-ico-sm'), c.label]),
        bar(c.done, c.total),
        el('span', { class: 'prog-num', text: `${c.done}/${c.total}` }),
      ]));
    }
    host.appendChild(cl);

    const sugg = CW.suggest(app.city, progressOf(), stats, 6);
    if (sugg.length) {
      host.appendChild(el('h3', { class: 'prog-h3', text: 'À faire ensuite' }));
      const ul = el('ul', { class: 'sugg-list' });
      for (const s of sugg) {
        ul.appendChild(el('li', {}, el('button', {
          type: 'button', class: 'sugg', onclick: () => { setView('carte'); selectSpot(s.id, true); },
        }, [
          catIcon(s.cat, 'cat-ico cat-ico-sm'),
          el('span', { class: 'sugg-name', text: s.name }),
          s.tip ? el('span', { class: 'sugg-tip', text: s.tip }) : null,
        ])));
      }
      host.appendChild(ul);
    }
  }

  // ----------------------------------------------------------------- modales

  function openModal(title, build) {
    const dlg = $('#modal');
    const inner = $('#modal-inner');
    clear(inner);
    inner.appendChild(el('h2', { class: 'modal-title', text: title }));
    build(inner);
    if (!dlg.open) dlg.showModal();
  }

  function shareModal() {
    openModal('Partager cette carte', (host) => {
      const p = CW.store.loadProgress(app.cityId);
      const stats = CW.computeStats(app.city, p);
      host.appendChild(el('p', { class: 'modal-lead' }, `Carte de ${app.city.name} — ${stats.done}/${stats.total} lieux, ${stats.pct} %.`));

      const nameField = el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Ton prénom (affiché sur la carte partagée)' }),
        el('input', { type: 'text', value: p.owner || app.settings.owner || '', maxlength: 40, placeholder: 'Ex. Souad' }),
      ]);
      host.appendChild(nameField);
      const nameInput = nameField.querySelector('input');

      const notesBox = el('label', { class: 'check' }, [
        el('input', { type: 'checkbox' }), el('span', { text: 'Inclure mes notes personnelles' }),
      ]);
      host.appendChild(notesBox);

      const out = el('input', { type: 'text', class: 'link-out', readonly: true, 'aria-label': 'Lien de partage' });
      const build = async () => {
        const owner = nameInput.value.trim();
        p.owner = owner;
        CW.store.saveProgress(app.cityId);
        app.settings = CW.store.setSettings({ owner });
        const token = await CW.encodeShare(app.cityId, p, { notes: notesBox.querySelector('input').checked, owner });
        out.value = CW.shareURL(token);
        size.textContent = `${out.value.length} caractères`;
      };
      const size = el('span', { class: 'hint' });
      nameInput.addEventListener('input', CW.debounce(build, 250));
      notesBox.querySelector('input').addEventListener('change', build);

      host.appendChild(el('div', { class: 'link-row' }, [out, el('button', {
        type: 'button', class: 'btn btn-primary', onclick: async () => {
          const ok = await CW.copyText(out.value);
          CW.toast(ok ? 'Lien copié.' : 'Copie impossible — sélectionne le lien à la main.', ok ? 'info' : 'error');
        },
      }, 'Copier')]));
      host.appendChild(el('p', { class: 'hint' }, ['Ce lien contient ta progression et tes ambiances, pas tes photos (trop lourdes pour une URL). ', size]));

      if (navigator.share) {
        host.appendChild(el('button', {
          type: 'button', class: 'btn', onclick: () => navigator.share({ title: `CityWalker — ${app.city.name}`, url: out.value }).catch(() => {}),
        }, 'Partager…'));
      }

      host.appendChild(el('hr', { class: 'sep' }));
      host.appendChild(el('h3', { class: 'modal-h3', text: 'Sauvegarde complète (photos comprises)' }));
      host.appendChild(el('p', { class: 'hint' }, 'Un fichier à garder ou à envoyer : il contient les deux villes, tes notes et tes photos.'));
      const actions = el('div', { class: 'modal-actions' });
      actions.appendChild(el('button', {
        type: 'button', class: 'btn', onclick: async (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true; btn.textContent = 'Préparation…';
          try {
            const bundle = await CW.exportBundle(CW.CITY_ORDER, (n) => { btn.textContent = `Préparation… ${n} photos`; });
            const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });
            const saved = await CW.download(blob, `citywalker-${CW.todayISO()}.json`);
            if (saved) CW.toast(`Sauvegarde exportée (${CW.fmtBytes(blob.size)}).`);
          } catch (err) {
            CW.toast('Export impossible : ' + (err && err.message ? err.message : 'erreur inconnue'), 'error');
          } finally { btn.disabled = false; btn.textContent = 'Exporter'; }
        },
      }, 'Exporter'));
      const imp = el('input', { type: 'file', accept: 'application/json,.json', class: 'visually-hidden', onchange: async (ev) => {
        const file = ev.target.files && ev.target.files[0];
        ev.target.value = '';
        if (!file) return;
        try {
          const bundle = await CW.parseBundle(file);
          const report = await CW.applyBundle(bundle, () => {});
          CW.toast(`Import terminé : ${report.changed} ${CW.plural(report.changed, 'lieu mis à jour', 'lieux mis à jour')}, ${report.photosAdded} ${CW.plural(report.photosAdded, 'photo ajoutée', 'photos ajoutées')}.`);
          refreshAll(); renderSheet();
        } catch (err) {
          CW.toast('Import impossible : ' + (err && err.message ? err.message : 'fichier invalide'), 'error');
        }
      } });
      actions.appendChild(imp);
      actions.appendChild(el('button', { type: 'button', class: 'btn', onclick: () => imp.click() }, 'Importer / fusionner'));
      host.appendChild(actions);
      build();
    });
  }

  function settingsModal() {
    openModal('Réglages', (host) => {
      host.appendChild(el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Ton prénom' }),
        el('input', { type: 'text', value: app.settings.owner, maxlength: 40, placeholder: 'Ex. Souad',
          oninput: CW.debounce((ev) => { app.settings = CW.store.setSettings({ owner: ev.target.value.trim() }); }, 300) }),
      ]));
      host.appendChild(el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Thème' }),
        el('select', { onchange: (ev) => { app.settings = CW.store.setSettings({ theme: ev.target.value }); applyTheme(); } },
          [['auto', 'Automatique'], ['light', 'Clair'], ['dark', 'Sombre']].map(([v, t]) => el('option', { value: v, selected: app.settings.theme === v }, t))),
      ]));
      host.appendChild(el('label', { class: 'check' }, [
        el('input', { type: 'checkbox', checked: app.settings.labels, onchange: (ev) => {
          app.settings = CW.store.setSettings({ labels: ev.target.checked });
          app.map.showLabels = ev.target.checked; app.map._apply();
        } }),
        el('span', { text: 'Afficher le nom des lieux sur la carte (en zoom)' }),
      ]));

      const info = el('p', { class: 'hint', text: 'Calcul de l’espace utilisé…' });
      host.appendChild(info);
      CW.store.storageEstimate().then((est) => {
        info.textContent = est && est.usage ? `Espace utilisé sur cet appareil : ${CW.fmtBytes(est.usage)}.` : 'Tes données restent sur cet appareil, dans ce navigateur.';
      });

      host.appendChild(el('hr', { class: 'sep' }));
      host.appendChild(el('button', {
        type: 'button', class: 'btn btn-danger', onclick: async () => {
          if (!confirm(`Effacer toute la progression de ${app.city.name} (photos comprises) ? C’est définitif.`)) return;
          await CW.store.deletePhotosForCity(app.cityId);
          CW.store.resetCity(app.cityId);
          refreshAll(); closeSheet();
          CW.toast(`Carte de ${app.city.name} remise à zéro.`);
        },
      }, `Effacer ma carte de ${app.city.name}`));
      host.appendChild(el('p', { class: 'hint' }, 'Données cartographiques © OpenStreetMap (ODbL) et Ville de Paris (Open Data).'));
    });
  }

  // ------------------------------------------------------------------- vues

  function setView(view) {
    $('#app').dataset.view = view;
    $$('.mobile-tab').forEach((b) => b.setAttribute('aria-pressed', b.dataset.view === view ? 'true' : 'false'));
    if (view === 'liste' || view === 'progress') setTab(view === 'progress' ? 'progress' : 'lieux');
  }
  function setTab(tab) {
    $$('.side-tab').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false'));
    $('#tab-lieux').hidden = tab !== 'lieux';
    $('#tab-progress').hidden = tab !== 'progress';
    if (tab === 'progress') renderProgress();
  }

  function refreshAll() {
    app.map.getEntry = entryOf;
    app.map.refresh();
    renderList();
    if ($('#tab-progress').hidden === false) renderProgress();
    updateCityTabs();
  }

  function updateCityTabs() {
    for (const id of CW.CITY_ORDER) {
      const node = document.querySelector(`[data-pct-for="${id}"]`);
      if (!node) continue;
      const data = app.cities[id];
      if (!data) { node.textContent = '—'; continue; }
      const st = CW.computeStats(data, app.shared && app.shared.city === id ? app.shared.progress : CW.store.loadProgress(id));
      node.textContent = `${Math.round(st.pct)} %`;
    }
    $$('.city-tab').forEach((b) => b.setAttribute('aria-pressed', b.dataset.city === app.cityId ? 'true' : 'false'));
  }

  // ------------------------------------------------------------ changement de ville

  async function switchCity(id, keepShared) {
    if (!CW.CITY_ORDER.includes(id)) return;
    app.cityId = id;
    app.city = await loadCity(id);
    if (!keepShared && app.shared && app.shared.city !== id) leaveShared(true);
    app.settings = CW.store.setSettings({ lastCity: id });
    document.documentElement.style.setProperty('--accent', app.city.accent);
    $('.map-city-name').textContent = app.city.name;
    $('.map-city-sub').textContent = app.city.subtitle;
    app.map.getEntry = entryOf;
    app.map.showLabels = app.settings.labels;
    app.map.load(app.city, allSpots());
    buildFilterOptions();
    app.selected = null;
    closeSheet();
    refreshAll();
  }

  function buildFilterOptions() {
    const zoneSel = $('#filter-zone');
    clear(zoneSel);
    zoneSel.appendChild(el('option', { value: '' }, `Tous les ${app.city.zoneWordPlural}`));
    for (const z of app.city.zones) zoneSel.appendChild(el('option', { value: z.id }, z.label === z.name ? z.name : `${z.label} — ${z.name}`));
    zoneSel.appendChild(el('option', { value: '__custom' }, 'Mes lieux'));
    zoneSel.value = '';
    const catSel = $('#filter-cat');
    clear(catSel);
    catSel.appendChild(el('option', { value: '' }, 'Toutes les catégories'));
    const used = Array.from(new Set(allSpots().map((s) => s.cat)));
    for (const c of used.sort((a, b) => CW.catLabel(a).localeCompare(CW.catLabel(b), 'fr'))) catSel.appendChild(el('option', { value: c }, CW.CATS[c] ? CW.CATS[c].plural : c));
    catSel.value = '';
    app.filters.zone = ''; app.filters.cat = '';

    const tagHost = $('#filter-tags');
    clear(tagHost);
    for (const t of CW.TAGS) {
      tagHost.appendChild(tagChip(t, app.filters.tags.includes(t.id), (ev) => {
        const i = app.filters.tags.indexOf(t.id);
        i === -1 ? app.filters.tags.push(t.id) : app.filters.tags.splice(i, 1);
        const btn = ev.currentTarget;
        btn.classList.toggle('is-on');
        btn.setAttribute('aria-pressed', btn.classList.contains('is-on') ? 'true' : 'false');
        renderList();
      }));
    }
  }

  // ------------------------------------------------------------ mode partagé

  function enterShared(shared) {
    app.shared = shared;
    const banner = $('#shared-banner');
    const who = shared.owner ? `de ${shared.owner}` : 'partagée';
    banner.querySelector('.shared-banner-text').textContent = `Tu regardes la carte ${who} — lecture seule.`;
    banner.hidden = false;
    $('#app').classList.add('is-shared');
  }
  function leaveShared(silent) {
    app.shared = null;
    $('#shared-banner').hidden = true;
    $('#app').classList.remove('is-shared');
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    if (!silent) { refreshAll(); closeSheet(); }
  }

  // ------------------------------------------------------------------ boot

  async function boot() {
    applyTheme();
    const stage = $('#map-stage');
    app.map = new CW.CityMap($('#map'), stage);
    app.map.getEntry = entryOf;
    app.map.onSelect = (id) => (id ? selectSpot(id, false) : closeSheet());
    app.map.onZone = (zoneId) => { if (!app.addMode) app.map.focusZone(zoneId); };
    app.map.onAddPoint = (x, y) => createCustomSpot(x, y);

    // Événements globaux
    $$('.city-tab').forEach((b) => b.addEventListener('click', () => switchCity(b.dataset.city)));
    $$('.side-tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
    $$('.mobile-tab').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
    $('#btn-theme').addEventListener('click', cycleTheme);
    $('#btn-settings').addEventListener('click', settingsModal);
    $('#btn-share').addEventListener('click', shareModal);
    $('#btn-add-spot').addEventListener('click', () => toggleAddMode());
    $('#btn-random').addEventListener('click', randomSpot);
    $('#btn-zoom-in').addEventListener('click', () => app.map.zoomBy(1.5));
    $('#btn-zoom-out').addEventListener('click', () => app.map.zoomBy(1 / 1.5));
    $('#btn-zoom-reset').addEventListener('click', () => app.map.reset(true));
    $('#sheet-backdrop').addEventListener('click', closeSheet);
    $('#search').addEventListener('input', CW.debounce((ev) => { app.filters.q = CW.norm(ev.target.value); renderList(); }, 160));
    $('#filter-zone').addEventListener('change', (ev) => { app.filters.zone = ev.target.value; renderList(); });
    $('#filter-cat').addEventListener('change', (ev) => { app.filters.cat = ev.target.value; renderList(); });
    $$('#filter-state .chip').forEach((b) => b.addEventListener('click', () => {
      app.filters.state = b.dataset.state;
      $$('#filter-state .chip').forEach((x) => x.classList.toggle('is-on', x === b));
      renderList();
    }));
    $('#btn-clear-filters').addEventListener('click', () => {
      app.filters = { q: '', state: 'tous', zone: '', cat: '', tags: [] };
      $('#search').value = '';
      $('#filter-zone').value = ''; $('#filter-cat').value = '';
      $$('#filter-state .chip').forEach((x) => x.classList.toggle('is-on', x.dataset.state === 'tous'));
      $$('#filter-tags .tag-chip').forEach((x) => { x.classList.remove('is-on'); x.setAttribute('aria-pressed', 'false'); });
      renderList();
    });
    $('#btn-leave-shared').addEventListener('click', () => leaveShared(false));
    $('#btn-merge-shared').addEventListener('click', () => {
      if (!app.shared) return;
      const mine = CW.store.loadProgress(app.shared.city);
      const { progress, changed } = CW.mergeProgress(mine, app.shared.progress);
      CW.store.replaceProgress(app.shared.city, progress);
      CW.toast(`${changed} ${CW.plural(changed, 'lieu fusionné', 'lieux fusionnés')} dans ta carte.`);
      leaveShared(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && app.addMode) { toggleAddMode(false); return; }
      if (e.key === 'Escape' && app.selected && !$('#modal').open) closeSheet();
      if (e.key === '/' && document.activeElement !== $('#search')) { e.preventDefault(); $('#search').focus(); }
    });

    // Lien de partage éventuel
    let target = app.settings.lastCity;
    let shared = null;
    const token = CW.readShareFromLocation();
    if (token) {
      try {
        shared = await CW.decodeShare(token);
        target = shared.city;
      } catch (err) {
        CW.toast(err && err.message ? err.message : 'Lien de partage invalide.', 'error');
      }
    }

    await Promise.all(CW.CITY_ORDER.map(loadCity));
    if (shared) enterShared(shared);
    await switchCity(target, true);
    setView(window.matchMedia('(max-width: 900px)').matches ? 'carte' : 'carte');
    $('#app').setAttribute('aria-busy', 'false');
    $('#boot').hidden = true;
  }

  // Installable et utilisable hors ligne. Uniquement sur un site servi en HTTPS :
  // le fichier unique (file://) et la visionneuse d'artifact n'y ont pas droit.
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
    if (window.CW_DATA) return;                    // build « un seul fichier » : rien à mettre en cache
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* pas d'installation possible, tant pis */ });
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    registerServiceWorker();
    boot().catch((err) => {
      const box = $('#boot-error');
      if (box) { box.hidden = false; box.textContent = (err && err.message) || 'Erreur inconnue au chargement.'; }
      // eslint-disable-next-line no-console
      console.error(err);
    });
  });
})();
