/* CityWalker — fond de carte détaillé (rues, noms) en tuiles raster.
 *
 * La carte vectorielle reste dessous et suffit à elle seule : les tuiles sont un
 * calque facultatif, qui demande le réseau. Si elles ne chargent pas — hors
 * ligne, réseau filtré, page embarquée — la carte sobre reste affichée telle
 * quelle, sans erreur ni trou.
 *
 * Aucune bibliothèque : la projection du build est déjà du Web Mercator, donc
 * la position d'une tuile dans le viewBox se calcule directement.
 */
(function () {
  'use strict';
  const CW = window.CW;

  const TILE = 256;
  const MAX_TILES = 260;          // garde-fou : au-delà, on baisse d'un niveau
  const MIN_Z = 10, MAX_Z = 18;

  /* `window.CW_TILE_SOURCES` permet de pointer vers un autre fournisseur — une
     instance auto-hébergée, ou un serveur de test. */
  const SOURCES = window.CW_TILE_SOURCES || {
    light: {
      url: (z, x, y) => `https://basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png`,
      credit: '© OpenStreetMap · © CARTO',
    },
    dark: {
      url: (z, x, y) => `https://basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`,
      credit: '© OpenStreetMap · © CARTO',
    },
  };

  class TileLayer {
    constructor(group) {
      this.group = group;
      this.city = null;
      this.enabled = false;
      this.variant = 'light';
      this.nodes = new Map();       // clé "z/x/y" -> <image>
      this.failures = 0;
      this.reported = false;
      this.onUnavailable = () => {};
    }

    setCity(city) {
      this.city = city;
      this.clear();
    }

    setEnabled(on) {
      this.enabled = !!on;
      this.group.style.display = this.enabled ? '' : 'none';
      if (!this.enabled) this.clear();
    }

    setVariant(variant) {
      const next = SOURCES[variant] ? variant : 'light';
      if (next === this.variant) return;
      this.variant = next;
      this.clear();
    }

    clear() {
      CW.clear(this.group);
      this.nodes.clear();
    }

    /** viewBox -> coordonnée monde [0,1] et retour. */
    _worldFromVB(vbX, vbY) {
      const pr = this.city.projection;
      const mx = (vbX - pr.pad) / pr.scale + pr.x0;
      const my = (vbY - pr.pad) / pr.scale + pr.y0;
      return { x: (mx / Math.PI + 1) / 2, y: (my / Math.PI + 1) / 2 };
    }
    _vbFromWorld(wx, wy) {
      const pr = this.city.projection;
      return {
        x: ((wx * 2 - 1) * Math.PI - pr.x0) * pr.scale + pr.pad,
        y: ((wy * 2 - 1) * Math.PI - pr.y0) * pr.scale + pr.pad,
      };
    }

    /**
     * Recalcule les tuiles visibles.
     * @param {{k:number,tx:number,ty:number}} t transformation de la scène
     * @param {number} fit facteur viewBox -> pixels écran
     */
    update(t, fit) {
      if (!this.enabled || !this.city) return;
      const view = this.city.view;
      const pr = this.city.projection;

      // Largeur du monde entier, en pixels écran, à l'échelle courante.
      const worldPx = 2 * Math.PI * pr.scale * t.k * (fit || 1);
      let z = Math.round(Math.log2(Math.max(1, worldPx) / TILE));
      z = CW.clamp(z, MIN_Z, MAX_Z);

      // Fenêtre visible, en coordonnées viewBox de la scène.
      const x0 = (0 - t.tx) / t.k, x1 = (view.w - t.tx) / t.k;
      const y0 = (0 - t.ty) / t.k, y1 = (view.h - t.ty) / t.k;
      const a = this._worldFromVB(x0, y0);
      const b = this._worldFromVB(x1, y1);

      let n = 1 << z;
      let i0, i1, j0, j1;
      // Si la fenêtre demande trop de tuiles, on recule d'un niveau.
      for (;;) {
        i0 = Math.floor(a.x * n); i1 = Math.floor(b.x * n);
        j0 = Math.floor(a.y * n); j1 = Math.floor(b.y * n);
        i0 = Math.max(0, i0); j0 = Math.max(0, j0);
        i1 = Math.min(n - 1, i1); j1 = Math.min(n - 1, j1);
        const count = (i1 - i0 + 1) * (j1 - j0 + 1);
        if (count <= MAX_TILES || z <= MIN_Z) break;
        z--; n = 1 << z;
      }
      if (i1 < i0 || j1 < j0) return;

      const wanted = new Set();
      const src = SOURCES[this.variant];
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const key = `${z}/${i}/${j}`;
          wanted.add(key);
          if (this.nodes.has(key)) continue;
          const p0 = this._vbFromWorld(i / n, j / n);
          const p1 = this._vbFromWorld((i + 1) / n, (j + 1) / n);
          const img = CW.svg('image', {
            x: p0.x, y: p0.y,
            width: Math.abs(p1.x - p0.x) + 0.6,     // léger recouvrement : pas de liseré
            height: Math.abs(p1.y - p0.y) + 0.6,
            href: src.url(z, i, j),
            class: 'tile',
            preserveAspectRatio: 'none',
          });
          img.addEventListener('error', () => {
            img.remove();
            this.nodes.delete(key);
            this.failures++;
            // Deux échecs suffisent à conclure que la source est inaccessible.
            if (this.failures >= 2 && !this.reported) {
              this.reported = true;
              this.onUnavailable();
            }
          });
          img.addEventListener('load', () => { img.classList.add('is-loaded'); });
          this.group.appendChild(img);
          this.nodes.set(key, img);
        }
      }

      // Les tuiles d'autres niveaux restent tant qu'elles couvrent l'écran ;
      // on ne retire que celles franchement hors champ.
      for (const [key, node] of this.nodes) {
        if (wanted.has(key)) continue;
        const [tz] = key.split('/').map(Number);
        if (tz !== z) { node.remove(); this.nodes.delete(key); }
        else if (!wanted.has(key)) { node.remove(); this.nodes.delete(key); }
      }
    }

    credit() { return SOURCES[this.variant].credit; }
  }

  CW.TileLayer = TileLayer;
})();
