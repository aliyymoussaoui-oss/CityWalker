/* CityWalker — interface : liste, filtres, fiche d'un lieu, progression, modales. */
(function () {
  'use strict';
  const CW = window.CW;
  const { el, $, clear } = CW;

  function catIcon(catId, cls) {
    const c = CW.CATS[catId];
    const svg = CW.svg('svg', { class: cls || 'cat-ico', viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
    svg.appendChild(CW.svg('path', { d: c ? c.glyph : 'M12 3v18M3 12h18', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    return svg;
  }
  CW.catIcon = catIcon;

  function ring(pct, size, label) {
    const r = 42, c = 2 * Math.PI * r;
    const svg = CW.svg('svg', { class: 'ring', viewBox: '0 0 100 100', width: size, height: size, 'aria-hidden': 'true' });
    svg.appendChild(CW.svg('circle', { cx: 50, cy: 50, r, class: 'ring-bg' }));
    svg.appendChild(CW.svg('circle', {
      cx: 50, cy: 50, r, class: 'ring-fg', transform: 'rotate(-90 50 50)',
      'stroke-dasharray': `${(c * CW.clamp(pct, 0, 100)) / 100} ${c}`,
    }));
    svg.appendChild(CW.svg('text', { x: 50, y: 52, class: 'ring-text', text: label !== undefined ? label : `${Math.round(pct)}%` }));
    return svg;
  }
  CW.ring = ring;

  function bar(done, total) {
    const pct = total ? (done / total) * 100 : 0;
    return el('span', { class: 'bar', role: 'img', 'aria-label': `${done} sur ${total}` },
      el('span', { class: 'bar-fill', style: { width: `${pct}%` } }));
  }

  function tagChip(tag, on, onToggle) {
    return el('button', {
      type: 'button', class: `tag-chip${on ? ' is-on' : ''}`, 'aria-pressed': on ? 'true' : 'false',
      title: tag.label, onclick: onToggle,
    }, [el('span', { class: 'tag-emoji', 'aria-hidden': 'true', text: tag.emoji }), el('span', { class: 'tag-text', text: tag.short })]);
  }

  CW.ui = { catIcon, ring, bar, tagChip };
})();
