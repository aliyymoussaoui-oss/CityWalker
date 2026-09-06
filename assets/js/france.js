/* CityWalker — vue France : l'index des villes couvertes.
 *
 * Ce n'est pas une ville : pas de quartiers, pas de lieux, pas de progression
 * propre. Juste l'Hexagone, une épingle par ville, et le pourcentage déjà fait.
 * Elle vit donc à part de CW.CITY_ORDER, qui pilote la synchronisation, le
 * partage et les statistiques — y glisser « france » les fausserait tous.
 */
(function () {
  'use strict';
  const CW = window.CW;
  const svg = CW.svg;

  let cache = null;

  // Un fichier france.json en retard sur model.js afficherait une ville que
  // l'application ne sait pas ouvrir : on ne garde que celles qu'elle connaît.
  CW.franceCities = (data) => data.cities.filter((c) => CW.CITY_ORDER.includes(c.id));

  /** Charge data/france.json une seule fois (ou le lit depuis le fichier unique). */
  CW.loadFrance = async function loadFrance() {
    if (cache) return cache;
    if (window.CW_FRANCE) { cache = window.CW_FRANCE; return cache; }
    const res = await fetch('data/france.json', { cache: 'force-cache' });
    if (!res.ok) throw new Error(`france.json : ${res.status}`);
    cache = await res.json();
    return cache;
  };

  /**
   * Dessine la carte.
   *
   * @param {object} data     contenu de data/france.json
   * @param {object} options  { currentCity, pctOf(id) -> number|null, onPick(id) }
   * @returns {SVGElement}
   */
  CW.franceMap = function franceMap(data, options) {
    const opts = options || {};
    const pctOf = opts.pctOf || (() => null);
    const root = svg('svg', {
      class: 'fr-map',
      viewBox: `0 0 ${data.view.w} ${data.view.h}`,
      role: 'group',
      'aria-label': 'Carte de France des villes couvertes',
    });

    const land = svg('g', { class: 'fr-land' });
    for (const r of data.regions) {
      land.appendChild(svg('path', { d: r.d, class: 'fr-region' }, [
        svg('title', { text: r.name }),
      ]));
    }
    root.appendChild(land);

    for (const city of CW.franceCities(data)) {
      const pct = pctOf(city.id);
      const current = city.id === opts.currentCity;
      const label = pct === null
        ? city.name
        : `${city.name} — ${Math.round(pct)} % découvert`;
      const g = svg('g', {
        class: `fr-city${current ? ' is-current' : ''}`,
        role: 'button',
        tabindex: '0',
        'aria-label': `Ouvrir ${label}`,
        'aria-current': current ? 'true' : null,
        // CW.svg ne connaît pas `dataset` (contrairement à CW.el) : attribut direct.
        'data-city': city.id,
        transform: `translate(${city.x} ${city.y})`,
      });
      // Cible tactile confortable : un disque transparent bien plus large que
      // le point dessiné. Sur un écran de 340 px de large, le point fait 4 px.
      g.appendChild(svg('circle', { class: 'fr-city-hit', r: 26 }));
      g.appendChild(svg('circle', { class: 'fr-city-dot', r: 10 }));
      g.appendChild(svg('text', { class: 'fr-city-name', x: 0, y: -22, text: city.name }));
      if (pct !== null) {
        g.appendChild(svg('text', { class: 'fr-city-pct', x: 0, y: 42, text: `${Math.round(pct)} %` }));
      }
      const pick = () => opts.onPick && opts.onPick(city.id);
      g.addEventListener('click', pick);
      g.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
          ev.preventDefault();
          pick();
        }
      });
      root.appendChild(g);
    }
    return root;
  };

})();
