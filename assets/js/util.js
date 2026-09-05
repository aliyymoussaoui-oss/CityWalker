/* CityWalker — utilitaires partagés (espace de noms global `CW`). */
(function () {
  'use strict';

  const CW = (window.CW = window.CW || {});

  CW.$ = (sel, root) => (root || document).querySelector(sel);
  CW.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /** Crée un élément HTML : el('div', {class:'x', onclick: fn}, [enfants]) */
  CW.el = function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const key of Object.keys(attrs)) {
        const value = attrs[key];
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
        else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
        else node.setAttribute(key, value === true ? '' : String(value));
      }
    }
    CW.append(node, children);
    return node;
  };

  const SVG_NS = 'http://www.w3.org/2000/svg';
  CW.svg = function svg(tag, attrs, children) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (const key of Object.keys(attrs)) {
        const value = attrs[key];
        if (value === null || value === undefined || value === false) continue;
        if (key === 'text') node.textContent = value;
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, String(value));
      }
    }
    CW.append(node, children);
    return node;
  };

  CW.append = function append(node, children) {
    if (children === null || children === undefined) return node;
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  };

  CW.clear = function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  };

  CW.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Normalise pour la recherche : minuscules, sans accents, sans ponctuation. */
  CW.norm = function norm(s) {
    return String(s ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[’'`´]/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  };

  CW.clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  CW.debounce = function debounce(fn, wait) {
    let timer = null;
    const wrapped = function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => { timer = null; fn.apply(this, args); }, wait);
    };
    wrapped.flush = () => { if (timer) { clearTimeout(timer); timer = null; fn(); } };
    return wrapped;
  };

  CW.uid = function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  };

  CW.todayISO = function todayISO() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  CW.dateToISO = function dateToISO(d) {
    if (!(d instanceof Date) || isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  CW.fmtDate = function fmtDate(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
    const [y, m, d] = iso.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    if (isNaN(date.getTime())) return '';
    try {
      return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    } catch (_) {
      return iso;
    }
  };

  CW.fmtBytes = function fmtBytes(n) {
    if (!(n >= 0)) return '';
    if (n < 1024) return `${n} o`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`;
    return `${(n / 1024 / 1024).toFixed(1)} Mo`;
  };

  CW.plural = (n, one, many) => (n > 1 ? many : one);

  /** Toasts discrets, empilés, auto-fermés. */
  CW.toast = function toast(message, kind, ms) {
    const host = document.getElementById('toasts');
    if (!host) return;
    const node = CW.el('div', { class: `toast toast-${kind || 'info'}`, role: 'status' }, message);
    host.appendChild(node);
    requestAnimationFrame(() => node.classList.add('is-in'));
    const ttl = ms || (kind === 'error' ? 6500 : 3200);
    setTimeout(() => {
      node.classList.remove('is-in');
      setTimeout(() => node.remove(), 320);
    }, ttl);
  };

  /** Copie dans le presse-papiers avec repli (champ texte sélectionné). */
  CW.copyText = async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* on tente le repli */ }
    try {
      const ta = CW.el('textarea', { style: { position: 'fixed', top: '-1000px', opacity: '0' } });
      ta.value = text;
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand && document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch (_) {
      return false;
    }
  };

  /** Téléchargement d'un Blob (repli : ouvre dans un nouvel onglet). */
  CW.download = function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = CW.el('a', { href: url, download: filename, style: { display: 'none' } });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 4000);
  };

  CW.readFileAsText = (file) => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(fr.error || new Error('Lecture du fichier impossible'));
    fr.readAsText(file);
  });

  CW.readFileAsArrayBuffer = (file) => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error('Lecture du fichier impossible'));
    fr.readAsArrayBuffer(file);
  });

  CW.blobToDataURL = (blob) => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(fr.error || new Error('Conversion impossible'));
    fr.readAsDataURL(blob);
  });

  CW.dataURLToBlob = function dataURLToBlob(dataUrl) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl || '');
    if (!m) throw new Error('data URL invalide');
    const mime = m[1] || 'application/octet-stream';
    if (m[2]) {
      const bin = atob(m[3]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    }
    return new Blob([decodeURIComponent(m[3])], { type: mime });
  };

  /** base64url <-> Uint8Array, sans limite de taille de pile. */
  CW.b64url = {
    encode(bytes) {
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },
    decode(str) {
      let s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
      while (s.length % 4) s += '=';
      const bin = atob(s);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    },
  };

  CW.isTouch = () => window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  CW.prefersReducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
})();
