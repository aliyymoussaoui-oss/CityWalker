/* CityWalker — carte vectorielle SVG : rendu, pan/zoom, épingles. */
(function () {
  'use strict';
  const CW = window.CW;

  const MIN_K = 0.85, MAX_K = 16;
  const PIN_D = 'M0 0C-5.5-6.5-8.5-10.5-8.5-14.5A8.5 8.5 0 1 1 8.5-14.5C8.5-10.5 5.5-6.5 0 0Z';

  class CityMap {
    constructor(svg, stage) {
      this.svg = svg;
      this.stage = stage;
      this.tooltip = document.getElementById('map-tooltip');
      this.city = null;
      this.getEntry = () => null;
      this.onSelect = () => {};
      this.onZone = () => {};
      this.onAddPoint = () => {};
      this.addMode = false;
      this.k = 1; this.tx = 0; this.ty = 0;
      this.selected = null;
      this.pins = new Map();
      this.pointers = new Map();
      this.drag = null;
      this.showLabels = true;
      this._bind();
    }

    load(city, spots) {
      this.city = city;
      this.selected = null;
      this.pins.clear();
      const { w, h } = city.view;
      const svg = this.svg;
      CW.clear(svg);
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      svg.style.setProperty('--accent', city.accent);

      const defs = CW.svg('defs');
      const clip = CW.svg('clipPath', { id: 'cw-clip' }, CW.svg('path', { d: city.outline }));
      defs.appendChild(clip);
      svg.appendChild(defs);

      const scene = CW.svg('g', { class: 'scene' });
      this.scene = scene;
      const base = CW.svg('g', { class: 'layer-base', 'clip-path': 'url(#cw-clip)' });
      base.appendChild(CW.svg('rect', { x: -50, y: -50, width: w + 100, height: h + 100, class: 'land' }));
      const green = CW.svg('g', { class: 'layer-green' });
      for (const d of city.green) green.appendChild(CW.svg('path', { d }));
      base.appendChild(green);
      const water = CW.svg('g', { class: 'layer-water' });
      for (const d of city.water) water.appendChild(CW.svg('path', { d }));
      base.appendChild(water);
      scene.appendChild(base);

      const zones = CW.svg('g', { class: 'layer-zones' });
      for (const z of city.zones) {
        const p = CW.svg('path', { d: z.d, class: 'zone', 'data-zone': z.id });
        p.addEventListener('click', (e) => { if (!this._moved) this.onZone(z.id, e); });
        zones.appendChild(p);
      }
      scene.appendChild(zones);
      scene.appendChild(CW.svg('path', { d: city.outline, class: 'outline' }));

      const zl = CW.svg('g', { class: 'layer-zone-labels' });
      for (const z of city.zones) {
        zl.appendChild(CW.svg('text', { x: z.cx, y: z.cy, class: 'zone-label', text: z.label }));
      }
      scene.appendChild(zl);
      const sl = CW.svg('g', { class: 'layer-sub-labels' });
      for (const l of city.labels || []) sl.appendChild(CW.svg('text', { x: l.x, y: l.y, class: 'sub-label', text: l.name }));
      scene.appendChild(sl);

      const pins = CW.svg('g', { class: 'layer-pins' });
      this.pinLayer = pins;
      scene.appendChild(pins);
      svg.appendChild(scene);
      this.setSpots(spots || city.spots);
      this.reset(false);
    }

    /** (Re)construit la couche d'épingles — liste curatée plus lieux personnels. */
    setSpots(spots) {
      CW.clear(this.pinLayer);
      this.pins.clear();
      for (const s of spots) {
        const g = CW.svg('g', {
          class: `pin${s.custom ? ' is-custom' : ''}`, transform: `translate(${s.x} ${s.y})`,
          'data-id': s.id, tabindex: -1, role: 'button', 'aria-label': s.name,
        });
        const inner = CW.svg('g', { class: 'pin-inner' });
        // Cible tactile généreuse, invisible : le doigt est plus large que l'épingle.
        inner.appendChild(CW.svg('circle', { cx: 0, cy: -11, r: 15, class: 'pin-hit' }));
        inner.appendChild(CW.svg('path', { d: PIN_D, class: 'pin-body' }));
        inner.appendChild(CW.svg('circle', { cx: 0, cy: -14.5, r: 3.2, class: 'pin-dot' }));
        inner.appendChild(CW.svg('text', { x: 12, y: -11, class: 'pin-label', text: s.name }));
        g.appendChild(inner);
        g.addEventListener('click', (e) => { e.stopPropagation(); if (!this._moved && !this.addMode) this.onSelect(s.id); });
        g.addEventListener('pointerenter', () => this._tip(s, g));
        g.addEventListener('pointerleave', () => this._hideTip());
        this.pinLayer.appendChild(g);
        this.pins.set(s.id, { g, inner, spot: s });
      }
      this._apply();
      this.refresh();
    }

    /** viewBox -> latitude/longitude (inverse de la projection du build). */
    unproject(x, y) {
      const pr = this.city.projection;
      const mx = (x - pr.pad) / pr.scale + pr.x0;
      const my = (y - pr.pad) / pr.scale + pr.y0;
      const lon = (mx * 180) / Math.PI;
      const lat = ((2 * Math.atan(Math.exp(-my)) - Math.PI / 2) * 180) / Math.PI;
      return { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
    }

    /** Quartier contenant un point du viewBox, via le tracé SVG lui-même. */
    zoneAt(x, y) {
      const paths = this.svg.querySelectorAll('.zone');
      for (const path of paths) {
        try {
          if (path.isPointInFill && path.isPointInFill(new DOMPoint(x, y))) return path.dataset.zone;
        } catch (_) { /* isPointInFill absent : on retombe sur le centroïde */ }
      }
      let best = null, bestD = Infinity;
      for (const z of this.city.zones) {
        const d = Math.hypot(z.cx - x, z.cy - y);
        if (d < bestD) { bestD = d; best = z.id; }
      }
      return best;
    }

    /** Le point est-il à l'intérieur de la commune ? */
    insideCity(x, y) {
      const outline = this.svg.querySelector('.outline');
      try {
        if (outline && outline.isPointInFill) return outline.isPointInFill(new DOMPoint(x, y));
      } catch (_) { /* rien */ }
      return true;
    }

    setAddMode(on) {
      this.addMode = !!on;
      this.svg.classList.toggle('is-adding', this.addMode);
      this._hideTip();
    }

    /** Met à jour l'état visuel des épingles (fait / à faire / sélection). */
    refresh() {
      for (const [id, p] of this.pins) {
        const e = this.getEntry(id);
        p.g.classList.toggle('is-done', CW.isDone(e));
        p.g.classList.toggle('is-selected', id === this.selected);
        p.g.classList.toggle('is-dim', !!this.filter && !this.filter.has(id));
      }
      // L'épingle sélectionnée passe au-dessus.
      if (this.selected && this.pins.has(this.selected)) this.pinLayer.appendChild(this.pins.get(this.selected).g);
    }

    setFilter(idSet) { this.filter = idSet; this.refresh(); }

    select(id, fly) {
      this.selected = id;
      this.refresh();
      if (fly && id && this.pins.has(id)) {
        const s = this.pins.get(id).spot;
        this.flyTo(s.x, s.y, Math.max(this.k, this.city.id === 'paris' ? 3.2 : 2.6));
      }
    }

    _tip(s, g) {
      if (!this.tooltip || CW.isTouch()) return;
      const e = this.getEntry(s.id);
      const done = CW.isDone(e);
      this.tooltip.textContent = '';
      this.tooltip.appendChild(CW.el('strong', { text: s.name }));
      this.tooltip.appendChild(CW.el('span', { text: done ? ' · photographié' : ' · à faire', class: done ? 'is-done' : '' }));
      this.tooltip.hidden = false;
      const r = g.getBoundingClientRect();
      const sr = this.stage.getBoundingClientRect();
      this.tooltip.style.left = `${r.left + r.width / 2 - sr.left}px`;
      this.tooltip.style.top = `${r.top - sr.top - 6}px`;
    }
    _hideTip() { if (this.tooltip) this.tooltip.hidden = true; }

    // ------------------------------------------------------------ transform

    _apply() {
      this.scene.setAttribute('transform', `translate(${this.tx} ${this.ty}) scale(${this.k})`);
      const s = 1 / this.k;
      const pinScale = s * CW.clamp(0.75 + this.k * 0.12, 0.8, 1.15);
      for (const p of this.pins.values()) p.inner.setAttribute('transform', `scale(${pinScale})`);
      const tier = this.k >= (this.city.id === 'paris' ? 2.6 : 2.0) ? 2 : this.k >= 1.6 ? 1 : 0;
      this.svg.dataset.zoomTier = String(tier);
      this.svg.dataset.labels = this.showLabels ? '1' : '0';
      this.svg.style.setProperty('--inv', String(s));
    }

    _metrics() {
      const r = this.svg.getBoundingClientRect();
      const { w, h } = this.city.view;
      const scale = Math.min(r.width / w, r.height / h) || 1;
      return { r, scale, offX: (r.width - w * scale) / 2, offY: (r.height - h * scale) / 2 };
    }
    /** client -> coordonnées viewBox */
    _toVB(cx, cy) {
      const m = this._metrics();
      return { x: (cx - m.r.left - m.offX) / m.scale, y: (cy - m.r.top - m.offY) / m.scale };
    }

    _clampPan() {
      const { w, h } = this.city.view;
      const k = this.k;
      // La carte doit rester au moins à moitié visible.
      this.tx = CW.clamp(this.tx, -w * k + w * 0.35, w * 0.65);
      this.ty = CW.clamp(this.ty, -h * k + h * 0.35, h * 0.65);
    }

    zoomAt(vbx, vby, factor, animate) {
      const k2 = CW.clamp(this.k * factor, MIN_K, MAX_K);
      const f = k2 / this.k;
      this.tx = vbx - (vbx - this.tx) * f;
      this.ty = vby - (vby - this.ty) * f;
      this.k = k2;
      this._clampPan();
      animate ? this._animate() : this._apply();
    }
    zoomBy(factor) {
      const { w, h } = this.city.view;
      this.zoomAt(w / 2, h / 2, factor, true);
    }
    flyTo(x, y, k) {
      const { w, h } = this.city.view;
      this.k = CW.clamp(k, MIN_K, MAX_K);
      this.tx = w / 2 - x * this.k;
      this.ty = h / 2 - y * this.k;
      this._clampPan();
      this._animate();
    }
    reset(animate) {
      this.k = 1; this.tx = 0; this.ty = 0;
      animate ? this._animate() : this._apply();
    }
    focusZone(zoneId) {
      const path = this.svg.querySelector(`.zone[data-zone="${zoneId}"]`);
      if (!path) return;
      const b = path.getBBox();
      const { w, h } = this.city.view;
      const k = CW.clamp(Math.min(w / (b.width * 1.3), h / (b.height * 1.3)), MIN_K, 8);
      this.flyTo(b.x + b.width / 2, b.y + b.height / 2, k);
    }

    _animate() {
      if (CW.prefersReducedMotion()) { this._apply(); return; }
      const from = this._last || { k: this.k, tx: this.tx, ty: this.ty };
      const to = { k: this.k, tx: this.tx, ty: this.ty };
      const t0 = performance.now();
      const dur = 320;
      cancelAnimationFrame(this._raf);
      const step = (now) => {
        const t = Math.min(1, (now - t0) / dur);
        const e = 1 - Math.pow(1 - t, 3);
        this.k = from.k + (to.k - from.k) * e;
        this.tx = from.tx + (to.tx - from.tx) * e;
        this.ty = from.ty + (to.ty - from.ty) * e;
        this._apply();
        if (t < 1) this._raf = requestAnimationFrame(step);
        else { this.k = to.k; this.tx = to.tx; this.ty = to.ty; this._apply(); this._last = { ...to }; }
      };
      this._raf = requestAnimationFrame(step);
    }

    // --------------------------------------------------------------- events

    _bind() {
      const svg = this.svg;
      svg.addEventListener('pointerdown', (e) => {
        if (!this.city) return;
        if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
        this._hideTip();
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        try { svg.setPointerCapture(e.pointerId); } catch (_) { /* rien */ }
        if (this.pointers.size === 1) {
          this.drag = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty };
          this._moved = false;
        } else if (this.pointers.size === 2) {
          const [a, b] = Array.from(this.pointers.values());
          this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: this.k, tx: this.tx, ty: this.ty, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
          this.drag = null;
        }
      });
      svg.addEventListener('pointermove', (e) => {
        if (!this.pointers.has(e.pointerId)) return;
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const m = this._metrics();
        if (this.pointers.size >= 2 && this.pinch) {
          const [a, b] = Array.from(this.pointers.values());
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
          const f = CW.clamp((d / this.pinch.d) * this.pinch.k, MIN_K, MAX_K) / this.pinch.k;
          const c0 = this._toVB(this.pinch.cx, this.pinch.cy);
          this.k = this.pinch.k * f;
          this.tx = c0.x - (c0.x - this.pinch.tx) * f + (cx - this.pinch.cx) / m.scale;
          this.ty = c0.y - (c0.y - this.pinch.ty) * f + (cy - this.pinch.cy) / m.scale;
          this._moved = true;
          this._clampPan();
          this._apply();
        } else if (this.drag) {
          const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
          if (Math.hypot(dx, dy) > 4) this._moved = true;
          if (!this._moved) return;
          this.tx = this.drag.tx + dx / m.scale;
          this.ty = this.drag.ty + dy / m.scale;
          this._clampPan();
          this._apply();
        }
      });
      const up = (e) => {
        this.pointers.delete(e.pointerId);
        try { svg.releasePointerCapture(e.pointerId); } catch (_) { /* rien */ }
        if (this.pointers.size < 2) this.pinch = null;
        if (this.pointers.size === 0) {
          this.drag = null;
          this._last = { k: this.k, tx: this.tx, ty: this.ty };
          setTimeout(() => { this._moved = false; }, 0);
        }
      };
      svg.addEventListener('pointerup', up);
      svg.addEventListener('pointercancel', up);
      svg.addEventListener('wheel', (e) => {
        if (!this.city) return;
        e.preventDefault();
        const p = this._toVB(e.clientX, e.clientY);
        const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018));
        this.zoomAt(p.x, p.y, f, false);
        this._last = { k: this.k, tx: this.tx, ty: this.ty };
      }, { passive: false });
      svg.addEventListener('dblclick', (e) => {
        if (!this.city) return;
        const p = this._toVB(e.clientX, e.clientY);
        this.zoomAt(p.x, p.y, 1.8, true);
      });
      svg.addEventListener('keydown', (e) => {
        if (!this.city) return;
        const step = 40 / this.k;
        const map = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
        if (map[e.key]) { this.tx += map[e.key][0] * this.k; this.ty += map[e.key][1] * this.k; this._clampPan(); this._apply(); e.preventDefault(); }
        else if (e.key === '+' || e.key === '=') { this.zoomBy(1.4); e.preventDefault(); }
        else if (e.key === '-') { this.zoomBy(1 / 1.4); e.preventDefault(); }
        else if (e.key === '0') { this.reset(true); e.preventDefault(); }
      });
      svg.addEventListener('click', (e) => {
        if (this._moved || !this.city) return;
        if (this.addMode) {
          const p = this._toVB(e.clientX, e.clientY);
          const scene = { x: (p.x - this.tx) / this.k, y: (p.y - this.ty) / this.k };
          this.onAddPoint(scene.x, scene.y);
          return;
        }
        this.onSelect(null);
      });
      window.addEventListener('resize', () => this._hideTip());
    }
  }

  CW.CityMap = CityMap;
})();
