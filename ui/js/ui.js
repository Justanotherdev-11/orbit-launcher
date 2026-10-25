// Shared UI kit: icons, formatting, toasts, modals, menus, markdown.
import { fileSrc } from './api.js';
import { pref } from './store.js';

const P = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M10 20v-6h4v6"/>',
  library: '<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/>',
  discover: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2.2 4.8-4.8 2.2 2.2-4.8z"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  play: '<path d="M7 4.8v14.4a1 1 0 0 0 1.5.86l12-7.2a1 1 0 0 0 0-1.72l-12-7.2A1 1 0 0 0 7 4.8z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" stroke="none"/>',
  folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2h7.4A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  cube: '<path d="M12 2.5 21 7.5v9L12 21.5 3 16.5v-9z"/><path d="M3 7.5l9 5 9-5M12 12.5v9"/>',
  mods: '<path d="M12 2.5 21 7.5v9L12 21.5 3 16.5v-9z"/><path d="M3 7.5l9 5 9-5M12 12.5v9"/>',
  shader: '<path d="M12 3l1.9 4.9L19 9.8l-5.1 1.9L12 16.6l-1.9-4.9L5 9.8l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  resourcepack: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  modpack: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9M7.5 5.25l9 4.5"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  notes: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  scroll: '<path d="M8 3h11v14a3 3 0 0 1-3 3H6"/><path d="M8 3a3 3 0 0 0-3 3v11a3 3 0 0 0 3 3M11 8h5M11 12h5"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/>',
  more: '<circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.8 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8z"/><circle cx="7.5" cy="11.5" r="1.2" fill="currentColor"/><circle cx="10.5" cy="7.5" r="1.2" fill="currentColor"/><circle cx="15.5" cy="8" r="1.2" fill="currentColor"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  alert: '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.5h.01"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v10h14V9M10 13h4"/>',
  import: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  heart: '<path d="M12 20s-7-4.4-9-9a5 5 0 0 1 9-3 5 5 0 0 1 9 3c-2 4.6-9 9-9 9z"/>',
  java: '<path d="M8 17c0 1.7 2 2.5 4 2.5s4-.8 4-2.5"/><path d="M6 13h10v2a4 4 0 0 1-4 4h-2a4 4 0 0 1-4-4z"/><path d="M16 14h1.5a2 2 0 0 1 0 4H16"/><path d="M10 10c0-1.5 2-2 2-3.5S10 4 10 4M13 10c0-1 1.5-1.5 1.5-2.5"/>',
  sparkle: '<path d="M12 3l1.9 4.9L19 9.8l-5.1 1.9L12 16.6l-1.9-4.9L5 9.8l5.1-1.9z"/>',
  window: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9h18"/>',
  group: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H3z"/><path d="M3 10h18v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  export: '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  command: '<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>',
  signal: '<path d="M4 20v-3M9 20v-7M14 20V9M19 20V4"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>',
  dupe: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/><path d="M14 11v6M11 14h6"/>',
};

export const icon = (name, size = 18, sw = 1.75) =>
  `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`;

// Big decorative glyphs for instance art, one per loader.
export const GLYPHS = {
  vanilla: '<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3"><path d="M50 8 88 30v40L50 92 12 70V30z"/><path d="M12 30l38 22 38-22M50 52v40"/><path d="M31 19l38 22"/></svg>',
  fabric: '<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 70 70 20M30 80 80 30M14 56 56 14M44 86 86 44"/><rect x="10" y="10" width="80" height="80" rx="18"/></svg>',
  quilt: '<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3"><rect x="10" y="10" width="36" height="36" rx="8"/><rect x="54" y="10" width="36" height="36" rx="8" transform="rotate(8 72 28)"/><rect x="10" y="54" width="36" height="36" rx="8"/><rect x="54" y="54" width="36" height="36" rx="18"/></svg>',
  forge: '<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3"><path d="M10 34h60l20-12v20H72c0 14-10 22-22 24v12h18v10H26V78h18V66C30 64 22 54 22 44H10z"/></svg>',
  neoforge: '<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3"><path d="M50 8 88 30v40L50 92 12 70V30z"/><path d="M34 66V36l32 28V34"/></svg>',
};

export const LOADERS = {
  vanilla: 'Vanilla',
  fabric: 'Fabric',
  quilt: 'Quilt',
  forge: 'Forge',
  neoforge: 'NeoForge',
};

// [accent, deep shade]. Keys are stored in settings/instances, so they keep their old names.
export const ACCENTS = {
  emerald: ['#c3ee3a', '#28300f'],
  cyan: ['#3fd3e6', '#0f2c31'],
  violet: ['#a594ff', '#221e3a'],
  sunset: ['#ff7a2e', '#36190b'],
  rose: ['#ff5c7c', '#36121b'],
  gold: ['#ffc53d', '#35290c'],
};
export const ACCENT_LABELS = { emerald: 'Lime', cyan: 'Cyan', violet: 'Violet', sunset: 'Orange', rose: 'Red', gold: 'Amber' };

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

export function fmtBytes(b) {
  b = Number(b) || 0;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b < 10 && i ? 1 : 0)} ${u[i]}`;
}

export function timeAgo(ts) {
  if (!ts) return 'Never';
  if (!pref('relativeTimes')) return fmtDate(ts);
  const t = typeof ts === 'number' ? ts * 1000 : Date.parse(ts);
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  if (s < 86400 * 365) return `${Math.floor(s / 86400 / 30)}mo ago`;
  return `${Math.floor(s / 86400 / 365)}y ago`;
}

export function fmtDuration(secs) {
  secs = Number(secs) || 0;
  if (secs < 60) return secs ? '<1m' : '0m';
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

export function fmtDate(ts) {
  const t = typeof ts === 'number' ? ts * 1000 : Date.parse(ts);
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function loaderChip(loader, version) {
  const l = loader || 'vanilla';
  return `<span class="chip l-${l}"><span class="dot"></span>${esc(LOADERS[l] || l)}${version ? ` <span class="dim mono">${esc(shortLoaderVersion(l, version))}</span>` : ''}</span>`;
}

export function shortLoaderVersion(loader, v) {
  if (loader === 'forge' && v.includes('-')) return v.split('-').slice(1).join('-');
  return v;
}

function seedFrom(str) {
  let h = 2166136261;
  for (const c of String(str)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Base block palettes for instance art (Settings → Background & art).
const MATERIALS = {
  stone: ['#121316', '#15171a', '#181a1e', '#1c1e23', '#202328'],
  deepslate: ['#0d0e12', '#111319', '#15171f', '#191c25', '#1d2029'],
  netherrack: ['#1a0d0e', '#211012', '#291416', '#311819', '#3a1d1e'],
  endstone: ['#1d1c14', '#232218', '#2a291d', '#313023', '#383729'],
  sandstone: ['#211b12', '#272015', '#2e2619', '#352c1d', '#3c3221'],
  prismarine: ['#0c1a19', '#0f201f', '#122725', '#152e2b', '#183532'],
};
const ORE = { none: [0, 0], sparse: [2, 2], normal: [5, 4], rich: [10, 5] };

/** The block colours behind an instance's art: { W, H, cells: [css colour] }, row-major. */
export function tileCells(seed, accent, material = pref('tileMaterial'), ore = pref('tileOre')) {
  const [a, deep] = ACCENTS[accent] || ACCENTS.emerald;
  const W = 32, H = 16, rnd = mulberry(seedFrom(seed));
  const greys = MATERIALS[material] || MATERIALS.stone;
  const cells = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) cells.push(greys[Math.floor(rnd() * rnd() * greys.length)]);
  // Ore veins: short random walks of accent-coloured blocks, denser towards the right.
  const [base, extra] = ORE[ore] || ORE.normal;
  const veins = base + Math.floor(rnd() * extra);
  for (let v = 0; v < veins; v++) {
    let x = Math.floor(W * (0.35 + rnd() * 0.65)), y = Math.floor(rnd() * H);
    const len = 2 + Math.floor(rnd() * 5);
    for (let s = 0; s < len; s++) {
      if (x >= 0 && x < W && y >= 0 && y < H) cells[y * W + x] = rnd() < 0.3 ? a : rnd() < 0.6 ? `${a}99` : deep;
      if (rnd() < 0.5) x += rnd() < 0.5 ? 1 : -1; else y += rnd() < 0.5 ? 1 : -1;
    }
  }
  return { W, H, cells };
}

const tileCache = new Map();
/** A stone-and-ore pixel texture, unique per instance and tinted with its accent. */
export function pixelTile(seed, accent, material = pref('tileMaterial'), ore = pref('tileOre')) {
  const key = `${seed}|${accent}|${material}|${ore}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const { W, H, cells } = tileCells(seed, accent, material, ore);
  let rects = '';
  cells.forEach((c, i) => { rects += `<rect x="${i % W}" y="${Math.floor(i / W)}" width="1" height="1" fill="${c}"/>`; });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" shape-rendering="crispEdges">${rects}</svg>`;
  // Single quotes: this ends up inside style="…" attributes.
  const url = `url('data:image/svg+xml,${encodeURIComponent(svg)}')`;
  tileCache.set(key, url);
  return url;
}

/** CSS custom property value for an instance's generated art. */
export function artStyle(accent, seed = accent) {
  return `--art: ${pixelTile(seed, accent)}`;
}

/** Instance icons are either remote (modpack logos) or a local file in the instance folder. */
export const iconUrl = (icon) => (!icon ? '' : /^https?:/i.test(icon) ? icon : fileSrc(icon));

export function instanceArt(inst, { icon = true } = {}) {
  return `<div class="art" style="${artStyle(inst.accent, inst.id)}">
    <div class="art-bg"></div>
    <div class="art-shade"></div>
    <span class="art-tag">${esc(LOADERS[inst.loader] || 'Vanilla')}</span>
    ${icon && inst.icon ? `<img class="art-icon" src="${esc(iconUrl(inst.icon))}" alt="" />` : ''}
  </div>`;
}

const MC_COLORS = { 0: '#000000', 1: '#0000aa', 2: '#00aa00', 3: '#00aaaa', 4: '#aa0000', 5: '#aa00aa', 6: '#ffaa00', 7: '#aaaaaa', 8: '#555555', 9: '#5555ff', a: '#55ff55', b: '#55ffff', c: '#ff5555', d: '#ff55ff', e: '#ffff55', f: '#ffffff' };

/** Render §-formatted Minecraft text (server MOTDs) as coloured HTML. */
export function mcText(text) {
  let out = '', style = {};
  const flush = (chunk) => {
    if (!chunk) return;
    const css = [style.color && `color:${style.color}`, style.l && 'font-weight:700', style.o && 'font-style:italic', (style.n || style.m) && `text-decoration:${[style.n && 'underline', style.m && 'line-through'].filter(Boolean).join(' ')}`].filter(Boolean).join(';');
    out += css ? `<span style="${css}">${esc(chunk)}</span>` : esc(chunk);
  };
  const re = /§(#[0-9a-fA-F]{6}|[0-9a-fk-or])/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    flush(text.slice(last, m.index));
    last = re.lastIndex;
    const c = m[1].toLowerCase();
    if (c.startsWith('#')) style = { color: c };
    else if (MC_COLORS[c]) style = { color: MC_COLORS[c] };
    else if (c === 'r') style = {};
    else style[c] = true;
  }
  flush(text.slice(last));
  return out.replace(/\n/g, '<br>');
}

export function avatarUrl(acc, size = 64) {
  return acc ? `https://mc-heads.net/avatar/${encodeURIComponent(acc.kind === 'msa' ? acc.uuid : acc.name)}/${size}` : '';
}

// ───────────────────────── toasts ─────────────────────────

export function toast(msg, kind = 'info', { title, actions = [], timeout } = {}) {
  const root = document.getElementById('toasts');
  const ic = kind === 'good' ? 'check' : kind === 'bad' ? 'alert' : 'info';
  const el = h(`<div class="toast ${kind}">
    <div class="ti">${icon(ic, 15, 2)}</div>
    <div class="tb">${title ? `<b>${esc(title)}</b>` : ''}${esc(msg)}${actions.length ? '<div class="tact"></div>' : ''}</div>
  </div>`);
  actions.forEach((a) => {
    const b = h(`<button class="btn sm">${esc(a.label)}</button>`);
    b.onclick = () => { a.run(); close(); };
    el.querySelector('.tact').append(b);
  });
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 300); };
  el.addEventListener('click', (e) => { if (!e.target.closest('button')) close(); });
  root.append(el);
  const base = (Number(pref('toastSecs')) || 4) * 1000;
  const life = timeout ?? (kind === 'bad' ? base * 2 : actions.length ? base * 2.2 : base);
  if (Number.isFinite(life)) setTimeout(close, life); // Infinity = stays until dismissed
  return close;
}

export function errText(e) {
  return String(e?.message || e || 'Something went wrong');
}

// ───────────────────────── modal ─────────────────────────

export function modal({ title, body = '', foot = '', wide = false, onClose } = {}) {
  const root = document.getElementById('overlays');
  const back = h(`<div class="modal-backdrop">
    <div class="modal ${wide ? 'wide' : ''}">
      <div class="modal-head"><h3>${esc(title)}</h3><button class="btn icon sm ghost" data-close>${icon('x', 16)}</button></div>
      <div class="modal-body">${body}</div>
      ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
    </div>
  </div>`);
  const m = back.querySelector('.modal');
  const close = () => {
    if (!back.isConnected) return;
    back.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  // Escape closes only the topmost modal, not every stacked one.
  const onKey = (e) => { if (e.key === 'Escape' && [...document.querySelectorAll('.modal-backdrop')].pop() === back) close(); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  m.querySelectorAll('[data-close]').forEach((b) => (b.onclick = close));
  root.append(back);
  return { el: m, body: m.querySelector('.modal-body'), close };
}

export function confirmDialog(title, text, { ok = 'Confirm', danger = false } = {}) {
  // Settings → Behaviour can switch off delete confirmations.
  if (danger && !pref('confirmDeletes') && /delete|remove/i.test(ok)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title,
      body: `<p class="muted" style="margin:0;line-height:1.6">${esc(text)}</p>`,
      foot: `<button class="btn ghost" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(ok)}</button>`,
      onClose: () => { if (!done) resolve(false); },
    });
    m.el.querySelector('[data-ok]').onclick = () => { done = true; m.close(); resolve(true); };
  });
}

export function promptDialog(title, { label = '', value = '', placeholder = '', ok = 'Save' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title,
      body: `<div class="field">${label ? `<label>${esc(label)}</label>` : ''}<input class="input" value="${esc(value)}" placeholder="${esc(placeholder)}" /></div>`,
      foot: `<button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-ok>${esc(ok)}</button>`,
      onClose: () => { if (!done) resolve(null); },
    });
    const input = m.el.querySelector('input');
    const submit = () => { done = true; m.close(); resolve(input.value); };
    m.el.querySelector('[data-ok]').onclick = submit;
    input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

// ───────────────────────── menu ─────────────────────────

export function menu(anchor, items) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const el = h('<div class="menu"></div>');
  for (const it of items) {
    if (it === '-') { el.append(h('<hr/>')); continue; }
    const b = h(`<button class="${it.danger ? 'danger' : ''}">${icon(it.icon || 'sparkle', 15)}<span>${esc(it.label)}</span></button>`);
    b.onclick = (e) => { e.stopPropagation(); el.remove(); it.run(); };
    el.append(b);
  }
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, hh = el.offsetHeight;
  el.style.left = Math.min(r.right - w, window.innerWidth - w - 10) + 'px';
  el.style.top = (r.bottom + 6 + hh > window.innerHeight ? r.top - hh - 6 : r.bottom + 6) + 'px';
  const off = (e) => { if (!el.contains(e.target)) { el.remove(); document.removeEventListener('mousedown', off); } };
  setTimeout(() => document.addEventListener('mousedown', off), 0);
}

// ───────────────────────── markdown + sanitizing ─────────────────────────

const ALLOWED = new Set('a b strong i em u s del p br hr h1 h2 h3 h4 h5 h6 ul ol li blockquote code pre img span div center table thead tbody tr th td details summary sup sub small figure figcaption'.split(' '));
const DROP = new Set('script style iframe object embed form input button textarea select link meta noscript svg math video audio source'.split(' '));
const ATTRS = new Set(['href', 'src', 'alt', 'title', 'width', 'height', 'align', 'colspan', 'rowspan']);

export function sanitize(html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 8) { child.remove(); continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName.toLowerCase();
      if (DROP.has(tag)) {
        if (tag === 'iframe' && /^https:\/\/(www\.)?(youtube\.com|youtube-nocookie\.com|youtu\.be)\//i.test(child.getAttribute('src') || '')) {
          const a = doc.createElement('a');
          a.href = child.getAttribute('src').replace('/embed/', '/watch?v=');
          a.textContent = '▶ Watch video';
          child.replaceWith(a);
        } else child.remove();
        continue;
      }
      walk(child);
      if (!ALLOWED.has(tag)) { child.replaceWith(...child.childNodes); continue; }
      for (const at of [...child.attributes]) {
        const n = at.name.toLowerCase();
        if (!ATTRS.has(n)) { child.removeAttribute(at.name); continue; }
        if (n === 'href' && !/^(https?:|#)/i.test(at.value.trim())) child.removeAttribute(at.name);
        if (n === 'src' && !/^https:/i.test(at.value.trim())) child.removeAttribute(at.name);
      }
      if (tag === 'img') child.setAttribute('loading', 'lazy');
    }
  };
  walk(doc.body.firstChild);
  return doc.body.firstChild.innerHTML;
}

function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '<img alt="$1" src="$2">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '<a href="$2">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2">$2</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[i])}</code>`);
}

export function markdown(md) {
  const lines = String(md || '').replace(/\r/g, '').split('\n');
  let out = '', list = null, para = [];
  const flushPara = () => { if (para.length) { out += `<p>${inline(para.join(' '))}</p>`; para = []; } };
  const flushList = () => { if (list) { out += `</${list}>`; list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushPara(); flushList();
      const code = [];
      while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
      out += `<pre><code>${esc(code.join('\n'))}</code></pre>`;
      continue;
    }
    let m;
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if ((m = line.match(/^(#{1,6})\s+(.*)/))) { flushPara(); flushList(); out += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; continue; }
    if (/^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$/.test(line.trim())) { flushPara(); flushList(); out += '<hr>'; continue; }
    if ((m = line.match(/^>\s?(.*)/))) { flushPara(); flushList(); out += `<blockquote>${inline(m[1])}</blockquote>`; continue; }
    if ((m = line.match(/^\s*[-*+]\s+(.*)/))) { flushPara(); if (list !== 'ul') { flushList(); out += '<ul>'; list = 'ul'; } out += `<li>${inline(m[1])}</li>`; continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { flushPara(); if (list !== 'ol') { flushList(); out += '<ol>'; list = 'ol'; } out += `<li>${inline(m[1])}</li>`; continue; }
    if (/^\s*</.test(line)) { flushPara(); flushList(); out += line; continue; }
    para.push(line.trim());
  }
  flushPara(); flushList();
  return out;
}

export function setRangeFill(input) {
  const p = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--p', p + '%');
}
