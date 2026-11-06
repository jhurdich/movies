'use strict';

// Keep the site's optional zoom setting separate from the browser's own zoom.
(() => {
  const levels = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  const key = 'nextthree.pageZoom.v1';
  const out = document.getElementById('zoomOut');
  const reset = document.getElementById('zoomReset');
  const input = document.getElementById('zoomIn');
  const status = document.getElementById('zoomStatus');
  if (!out || !reset || !input) return;

  let value = 1;
  try {
    const saved = Number(localStorage.getItem(key));
    if (levels.includes(saved)) value = saved;
  } catch (_) {}

  function apply(next) {
    value = next;
    document.body.style.zoom = String(value);
    document.documentElement.classList.toggle('zoom-large', value >= 1.5);
    reset.textContent = `${Math.round(value * 100)}%`;
    reset.setAttribute('aria-label', `Reset page zoom, currently ${Math.round(value * 100)} percent`);
    if (status) status.textContent = `Page zoom ${Math.round(value * 100)} percent`;
    out.disabled = value === levels[0];
    input.disabled = value === levels[levels.length - 1];
    try { localStorage.setItem(key, String(value)); } catch (_) {}
  }

  out.addEventListener('click', () => apply(levels[Math.max(0, levels.indexOf(value) - 1)]));
  reset.addEventListener('click', () => apply(1));
  input.addEventListener('click', () => apply(levels[Math.min(levels.length - 1, levels.indexOf(value) + 1)]));
  apply(value);
})();
