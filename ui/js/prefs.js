// Turns UI preferences into attributes and CSS variables on <html>. Runs on every settings change.
import { fileSrc, webview } from './api.js';
import { store, pref } from './store.js';
import { pixelTile } from './ui.js';

const FONTS = {
  chakra: '"Chakra Petch", "Segoe UI", sans-serif',
  plex: '"IBM Plex Sans", "Segoe UI", system-ui, sans-serif',
  system: '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
  mono: '"IBM Plex Mono", Consolas, monospace',
};

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lighten([r, g, b], amt) {
  const f = (c) => Math.round(c + (255 - c) * amt);
  return `rgb(${f(r)}, ${f(g)}, ${f(b)})`;
}

let lastZoom = null;

export function applyPrefs() {
  const html = document.documentElement;
  const s = store.settings;
  html.dataset.accent = s.accent || 'emerald';
  html.dataset.theme = pref('theme');
  html.dataset.corners = pref('corners');
  html.dataset.density = pref('density');
  html.dataset.rail = pref('railSide');
  html.dataset.railLabels = pref('railLabels') ? 'on' : 'off';
  html.dataset.toast = pref('toastPos');
  html.dataset.tasks = pref('taskPos');
  html.dataset.scrollbars = pref('scrollbars');
  html.dataset.bg = pref('background');
  html.dataset.hover = pref('fxHover') ? 'on' : 'off';
  html.classList.toggle('reduce-motion', pref('motion') === 'off' || !!s.reduceMotion);
  html.classList.toggle('motion-reduced', pref('motion') === 'reduced');

  // Custom accent overrides the preset swatches.
  const rgb = hexToRgb(pref('accentCustom'));
  for (const v of ['--a', '--a-rgb', '--a-hover', '--on-a']) html.style.removeProperty(v);
  if (rgb) {
    const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
    html.style.setProperty('--a', pref('accentCustom'));
    html.style.setProperty('--a-rgb', rgb.join(', '));
    html.style.setProperty('--a-hover', lighten(rgb, 0.18));
    html.style.setProperty('--on-a', lum > 0.55 ? '#0b0c0e' : '#ffffff');
  }

  html.style.setProperty('--display', FONTS[pref('headingFont')] || FONTS.chakra);
  html.style.setProperty('--font', FONTS[pref('bodyFont')] || FONTS.plex);
  html.style.setProperty('--speed', String(1 / Math.max(0.25, Number(pref('speed')) || 1)));
  html.style.setProperty('--console-size', `${pref('consoleSize')}px`);

  // Background layer.
  const bg = document.querySelector('.bg');
  if (bg) {
    const img = pref('bgImage');
    // The stamp changes each time a picture is chosen, so a new image with the same file name still shows.
    bg.style.setProperty('--bg-image', pref('background') === 'image' && img ? `url("${fileSrc(img)}?v=${pref('bgImageStamp') || 0}")` : 'none');
    bg.style.setProperty('--bg-dim', String(pref('bgDim') / 100));
    bg.style.setProperty('--bg-blur', `${pref('bgBlur')}px`);
    bg.style.setProperty('--bg-pixels', pref('background') === 'pixels' ? pixelTile('orbit-background', s.accent || 'emerald') : 'none');
  }

  document.getElementById('palette-btn')?.toggleAttribute('hidden', !pref('showSearch'));
  document.getElementById('clock')?.toggleAttribute('hidden', !pref('showClock'));

  const zoom = Math.min(1.5, Math.max(0.7, (Number(pref('uiScale')) || 100) / 100));
  if (zoom !== lastZoom) {
    lastZoom = zoom;
    webview().setZoom(zoom).catch(() => {});
  }
}

/** Format a clock time per preference. */
export function clockText(d = new Date()) {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: !pref('clock24') });
}
