// Settings → Customize: a declarative list of every UI preference, rendered as settings sections.
import { invoke } from './api.js';
import { store, on, pref, setPref, saveSettings, resetPrefs, PREF_DEFAULTS } from './store.js';
import { icon, esc, ACCENTS, ACCENT_LABELS, pixelTile, toast, confirmDialog, modal, setRangeFill } from './ui.js';
import { play } from './sounds.js';

const MATERIALS = [['stone', 'Stone'], ['deepslate', 'Deepslate'], ['netherrack', 'Netherrack'], ['endstone', 'End stone'], ['sandstone', 'Sandstone'], ['prismarine', 'Prismarine']];

/* Item types: cards | select | toggle | range | accent | image | buttons. `top` = a top-level settings field, not ui. */
export const SECTIONS = [
  { id: 'theme', icon: 'palette', title: 'Theme', items: [
    { type: 'cards', key: 'theme', label: 'Colour scheme', options: [
      ['dark', 'Dark', 'background:#0b0c0e;box-shadow:inset 0 -14px 0 #16181c'],
      ['oled', 'OLED black', 'background:#000;box-shadow:inset 0 -14px 0 #0d0d0f'],
      ['dim', 'Dim', 'background:#17181b;box-shadow:inset 0 -14px 0 #23252a'],
      ['light', 'Light', 'background:#eef0f3;box-shadow:inset 0 -14px 0 #fff'],
    ] },
    { type: 'accent', label: 'Accent colour', desc: 'Pick a preset or any colour you like.' },
    { type: 'cards', key: 'corners', label: 'Corner style', options: [
      ['chamfer', 'Cut corners', 'background:var(--a);clip-path:polygon(0 0,calc(100% - 14px) 0,100% 14px,100% 100%,14px 100%,0 calc(100% - 14px))'],
      ['round', 'Rounded', 'background:var(--a);border-radius:12px'],
      ['sharp', 'Sharp', 'background:var(--a);border-radius:0'],
    ] },
    { type: 'select', key: 'headingFont', label: 'Heading font', options: [['chakra', 'Chakra Petch'], ['plex', 'IBM Plex Sans'], ['system', 'Segoe UI'], ['mono', 'IBM Plex Mono']] },
    { type: 'select', key: 'bodyFont', label: 'Text font', options: [['plex', 'IBM Plex Sans'], ['system', 'Segoe UI'], ['mono', 'IBM Plex Mono']] },
    { type: 'range', key: 'uiScale', label: 'Interface scale', desc: 'Makes everything bigger or smaller.', min: 80, max: 130, step: 5, unit: '%' },
    { type: 'select', key: 'density', label: 'Density', options: [['compact', 'Compact'], ['comfortable', 'Comfortable'], ['spacious', 'Spacious']] },
    { type: 'select', key: 'scrollbars', label: 'Scrollbars', options: [['thin', 'Thin'], ['wide', 'Wide'], ['hidden', 'Hidden']] },
  ] },
  { id: 'background', icon: 'image', title: 'Background & art', items: [
    { type: 'cards', key: 'background', label: 'Background', options: [
      ['dots', 'Dots', 'background:radial-gradient(rgba(255,255,255,.18) 1px,transparent 1.4px) #0b0c0e;background-size:9px 9px'],
      ['grid', 'Grid', 'background:linear-gradient(rgba(255,255,255,.1) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.1) 1px,transparent 1px) #0b0c0e;background-size:12px 12px'],
      ['pixels', 'Ore', () => `background-image:${pixelTile('orbit-background', store.settings.accent || 'emerald')}`],
      ['plain', 'Plain', 'background:#0b0c0e'],
      ['image', 'Your image', 'background:linear-gradient(135deg,#2a2d33,#111215)'],
    ] },
    { type: 'image', key: 'bgImage', label: 'Background image', desc: 'Any picture — a screenshot from your world looks great.', when: () => pref('background') === 'image' },
    { type: 'range', key: 'bgDim', label: 'Darken image', min: 0, max: 95, step: 5, unit: '%', when: () => pref('background') === 'image' },
    { type: 'range', key: 'bgBlur', label: 'Blur image', min: 0, max: 24, step: 2, unit: 'px', when: () => pref('background') === 'image' },
    { type: 'cards', key: 'tileMaterial', label: 'Instance art material', desc: 'The block every instance tile is carved from.', options: MATERIALS.map(([k, l]) => [k, l, () => `background-image:${pixelTile(`preview-${k}`, store.settings.accent || 'emerald', k)}`]) },
    { type: 'select', key: 'tileOre', label: 'Ore in the art', options: [['none', 'None'], ['sparse', 'A little'], ['normal', 'Normal'], ['rich', 'Loads']] },
  ] },
  { id: 'layout', icon: 'window', title: 'Layout', items: [
    { type: 'select', key: 'railSide', label: 'Sidebar side', options: [['left', 'Left'], ['right', 'Right']] },
    { type: 'toggle', key: 'railLabels', label: 'Sidebar labels', desc: 'Off for a slim icon-only sidebar.' },
    { type: 'toggle', key: 'showSearch', label: 'Search button in the title bar', desc: 'Ctrl+K still works when hidden.' },
    { type: 'toggle', key: 'showClock', label: 'Clock in the title bar' },
    { type: 'toggle', key: 'clock24', label: '24-hour time' },
    { type: 'toggle', key: 'relativeTimes', label: 'Relative times', desc: '“3h ago” instead of a date.' },
    { type: 'select', key: 'startPage', label: 'Open Orbit on', options: [['home', 'Home'], ['library', 'Library'], ['discover', 'Discover'], ['last', 'Last played instance']] },
  ] },
  { id: 'motion', icon: 'sparkle', title: 'Motion & sound', items: [
    { type: 'toggle', key: 'motion', label: 'Turn off all animations', desc: 'Stops every animation and transition in Orbit.', invert: true, on: 'off', off: 'full' },
    { type: 'select', key: 'motion', label: 'Animation level', options: [['full', 'Full'], ['reduced', 'Reduced — no big effects'], ['off', 'Off']] },
    { type: 'range', key: 'speed', label: 'Animation speed', min: 0.5, max: 2, step: 0.25, unit: '×', when: () => pref('motion') !== 'off' },
    { type: 'toggle', key: 'fxLaunch', label: 'Launch sequence', desc: 'Blocks assemble while the game loads, then shatter when it starts.', when: () => pref('motion') === 'full' },
    { type: 'toggle', key: 'loadGame', label: 'Mining mini-game while loading', desc: 'Click the glowing ore on the launch screen for points.', when: () => pref('motion') === 'full' && pref('fxLaunch') },
    { type: 'toggle', key: 'loadTips', label: 'Facts and tips while loading', when: () => pref('motion') === 'full' && pref('fxLaunch') },
    { type: 'toggle', key: 'fxWipe', label: 'Pixel wipe between pages', when: () => pref('motion') === 'full' },
    { type: 'toggle', key: 'fxTilt', label: '3D card tilt', when: () => pref('motion') === 'full' },
    { type: 'toggle', key: 'fxDecode', label: 'Title decode', desc: 'Headings resolve out of block characters.', when: () => pref('motion') === 'full' },
    { type: 'toggle', key: 'fxCascade', label: 'Cards cascade in', when: () => pref('motion') !== 'off' },
    { type: 'toggle', key: 'fxHover', label: 'Hover lift & Play-button glint', when: () => pref('motion') !== 'off' },
    { type: 'toggle', key: 'sounds', label: 'Interface sounds', desc: 'Little chiptune blips for clicks, launches and errors.' },
    { type: 'range', key: 'volume', label: 'Sound volume', min: 5, max: 100, step: 5, unit: '%', when: () => pref('sounds') },
    { type: 'buttons', label: 'Preview', when: () => pref('sounds'), buttons: [['Click', () => play('click')], ['Launch', () => play('launch')], ['Break', () => play('break')], ['Error', () => play('error')]] },
  ] },
  { id: 'home-prefs', icon: 'home', title: 'Home page', items: [
    { type: 'toggle', key: 'homeHero', label: 'Featured instance' },
    { type: 'toggle', key: 'homeRecent', label: 'Recent instances' },
    { type: 'toggle', key: 'homeQuick', label: 'Shortcuts row' },
    { type: 'toggle', key: 'homePopular', label: 'Popular list' },
    { type: 'select', key: 'popularKind', label: 'Popular list shows', options: [['mod', 'Mods'], ['resourcepack', 'Resource packs'], ['shader', 'Shaders'], ['modpack', 'Modpacks']] },
    { type: 'select', key: 'popularDays', label: 'Popular over', options: [[7, 'This week'], [30, 'This month'], [365, 'This year'], [0, 'All time']], number: true },
  ] },
  { id: 'library-prefs', icon: 'library', title: 'Library', items: [
    { type: 'select', key: 'libView', label: 'View', options: [['grid', 'Grid'], ['list', 'List']] },
    { type: 'select', key: 'cardSize', label: 'Card size', options: [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], when: () => pref('libView') === 'grid' },
    { type: 'select', key: 'libSort', label: 'Default sort', options: [['recent', 'Recently played'], ['name', 'Name'], ['created', 'Newest'], ['version', 'Minecraft version']] },
    { type: 'toggle', key: 'libGroups', label: 'Split into groups' },
    { type: 'toggle', key: 'libPlaytime', label: 'Show playtime' },
    { type: 'toggle', key: 'libArt', label: 'Show instance art' },
  ] },
  { id: 'discover-prefs', icon: 'discover', title: 'Discover', items: [
    { type: 'select', key: 'discoverSource', label: 'Default source', options: [['modrinth', 'Modrinth'], ['curseforge', 'CurseForge']] },
    { type: 'select', key: 'discoverSort', label: 'Default sort', options: [['relevance', 'Relevance'], ['downloads', 'Downloads'], ['follows', 'Popularity'], ['updated', 'Recently updated'], ['newest', 'Newest']] },
    { type: 'select', key: 'discoverView', label: 'Results', options: [['grid', 'Grid'], ['list', 'List']] },
    { type: 'toggle', key: 'showSnapshots', label: 'Show snapshots in version pickers', top: true },
  ] },
  { id: 'notifications', icon: 'info', title: 'Notifications', items: [
    { type: 'select', key: 'toastPos', label: 'Pop-up position', options: [['top-right', 'Top right'], ['top-center', 'Top centre'], ['top-left', 'Top left'], ['bottom-left', 'Bottom left']] },
    { type: 'range', key: 'toastSecs', label: 'Pop-ups stay for', min: 2, max: 15, step: 1, unit: 's' },
    { type: 'select', key: 'taskPos', label: 'Download progress position', options: [['bottom-right', 'Bottom right'], ['bottom-left', 'Bottom left'], ['top-right', 'Top right']] },
    { type: 'toggle', key: 'taskAutoHide', label: 'Hide finished downloads automatically' },
  ] },
  { id: 'console-prefs', icon: 'terminal', title: 'Console & logs', items: [
    { type: 'range', key: 'consoleSize', label: 'Log text size', min: 10, max: 16, step: 1, unit: 'px' },
    { type: 'toggle', key: 'consoleWrap', label: 'Wrap long lines' },
    { type: 'toggle', key: 'consoleColors', label: 'Colour warnings and errors' },
    { type: 'toggle', key: 'consoleFollow', label: 'Keep scrolled to the newest line' },
    { type: 'select', key: 'maxLogLines', label: 'Lines kept in memory', options: [[5000, '5,000'], [20000, '20,000'], [50000, '50,000'], [100000, '100,000']], number: true },
  ] },
  { id: 'behaviour', icon: 'settings', title: 'Behaviour', items: [
    { type: 'select', key: 'updateCheck', label: 'Mod updates', desc: 'Checks your mods, resource packs and shaders against Modrinth and offers to update them.', options: [['startup', 'Check when Orbit opens'], ['off', 'Only when I click Check updates']] },
    { type: 'toggle', key: 'updatesIncludePacks', label: 'Include modpack instances', desc: "Off by default — a pack's mods are meant to update together via its Modpack tab.", when: () => pref('updateCheck') !== 'off' },
    { type: 'buttons', label: 'Check for mod updates now', buttons: [['Check now', () => import('./updates.js').then((u) => u.checkAllUpdates().then((r) => { if (!r.length) toast('Everything is up to date', 'good'); }))]] },
    { type: 'toggle', key: 'confirmDeletes', label: 'Ask before deleting', desc: 'Instances, worlds, mods and screenshots.' },
    { type: 'toggle', key: 'openAfterCreate', label: 'Open new instances straight away' },
    { type: 'toggle', key: 'openLogOnLaunch', label: 'Show the game log when launching' },
    { type: 'range', key: 'parallelDownloads', label: 'Parallel downloads', desc: 'Lower this on slow or shared connections.', min: 1, max: 32, step: 1, unit: '', top: true },
  ] },
  { id: 'profiles', icon: 'export', title: 'Customization profile', items: [
    { type: 'buttons', label: 'Share your look', desc: 'Copy your setup as text to send to a friend, paste one in, or start over.', buttons: [
      ['Copy to clipboard', () => { navigator.clipboard.writeText(JSON.stringify({ accent: store.settings.accent, ui: store.settings.ui || {} })); toast('Customization copied', 'good'); }],
      ['Paste…', () => pasteProfile()],
      ['Reset everything', async () => { if (await confirmDialog('Reset customization?', 'Every option on this page goes back to its default.', { ok: 'Reset', danger: true })) { await resetPrefs(); toast('Back to defaults', 'good'); } }],
    ] },
  ] },
];

function pasteProfile() {
  const m = modal({ title: 'Paste a customization', body: '<textarea class="textarea mono" id="pp" rows="8" placeholder="{ &quot;accent&quot;: …, &quot;ui&quot;: { … } }"></textarea>', foot: '<button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="pp-ok">Apply</button>' });
  m.el.querySelector('#pp-ok').onclick = async () => {
    try {
      const p = JSON.parse(m.el.querySelector('#pp').value);
      // Keep only known options, each coerced to the type of its default; drop anything invalid.
      const ui = {};
      for (const [k, v] of Object.entries(p.ui || {})) {
        if (!(k in PREF_DEFAULTS) || k === 'bgImage') continue;
        const d = PREF_DEFAULTS[k];
        if (typeof d === 'number') { const n = Number(v); if (Number.isFinite(n)) ui[k] = n; }
        else if (typeof d === 'boolean') { if (typeof v === 'boolean') ui[k] = v; }
        else if (typeof v === 'string') ui[k] = v;
      }
      await saveSettings({ ui, ...(typeof p.accent === 'string' ? { accent: p.accent } : {}) });
      m.close();
      toast('Customization applied', 'good');
    } catch { toast("That doesn't look like an Orbit customization", 'bad'); }
  };
}

const value = (it) => (it.top ? store.settings[it.key] : pref(it.key));
const style = (s) => (typeof s === 'function' ? s() : s);

function row(it, idx, body) {
  return `<div class="setting-row" data-item="${idx}"><div class="txt"><div class="t">${esc(it.label)}</div>${it.desc ? `<div class="d">${esc(it.desc)}</div>` : ''}</div><div class="ctl">${body}</div></div>`;
}

function itemHtml(it, idx) {
  if (it.when && !it.when()) return '';
  const v = value(it);
  switch (it.type) {
    case 'cards':
      return `<div class="setting-row" data-item="${idx}" style="display:block"><div class="txt"><div class="t">${esc(it.label)}</div>${it.desc ? `<div class="d">${esc(it.desc)}</div>` : ''}</div>
        <div class="cz-grid">${it.options.map(([k, l, s]) => `<button class="cz-opt ${String(k) === String(v) ? 'on' : ''}" data-val="${esc(k)}"><div class="cz-prev" style="${style(s)}"></div>${esc(l)}</button>`).join('')}</div></div>`;
    case 'select':
      return row(it, idx, `<select class="select sm" style="width:auto;min-width:170px">${it.options.map(([k, l]) => `<option value="${esc(k)}" ${String(k) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`);
    case 'toggle': {
      const checked = it.invert ? v === it.on : !!v;
      return row(it, idx, `<label class="switch"><input type="checkbox" ${checked ? 'checked' : ''} /><span></span></label>`);
    }
    case 'range':
      return row(it, idx, `<input type="range" class="range" min="${it.min}" max="${it.max}" step="${it.step}" value="${v}" style="width:200px" /><span class="mem-readout">${v}${it.unit}</span>`);
    case 'accent': {
      const custom = pref('accentCustom');
      return row(it, idx, `<div class="swatches">${Object.entries(ACCENTS).map(([k, [a]]) => `<div class="swatch ${!custom && k === (store.settings.accent || 'emerald') ? 'on' : ''}" data-acc="${k}" title="${ACCENT_LABELS[k]}" style="background:${a}"></div>`).join('')}</div>
        <input type="color" class="cz-color ${custom ? 'on' : ''}" value="${custom || '#c3ee3a'}" title="Custom colour" />${custom ? `<button class="btn sm ghost" data-clear>Use preset</button>` : ''}`);
    }
    case 'image':
      return row(it, idx, `<span class="dim mono" style="font-size:11px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc((v || '').split(/[\\/]/).pop() || 'None')}</span><button class="btn sm" data-pick>${icon('image', 14)} Choose…</button>`);
    case 'buttons':
      return row(it, idx, it.buttons.map(([l], i) => `<button class="btn sm" data-btn="${i}">${esc(l)}</button>`).join(''));
    default:
      return '';
  }
}

export function sectionsHtml() {
  return SECTIONS.map((s) => `<section class="glass settings-section" id="sec-${s.id}" data-cz="${s.id}"><h3>${icon(s.icon, 18)} ${esc(s.title)}</h3><div class="cz-body"></div></section>`).join('');
}

async function apply(it, raw) {
  const v = it.number || typeof PREF_DEFAULTS[it.key] === 'number' || it.top && typeof store.settings[it.key] === 'number' ? Number(raw) : raw;
  if (it.top) await saveSettings({ [it.key]: v });
  else await setPref(it.key, v);
}

/** Render every customization section into `root` and keep them live. */
export function mountCustomize(root) {
  const draw = (sec) => {
    const s = SECTIONS.find((x) => x.id === sec.dataset.cz);
    const body = sec.querySelector('.cz-body');
    body.innerHTML = s.items.map(itemHtml).join('');
    body.querySelectorAll('[data-item]').forEach((rowEl) => {
      const it = s.items[+rowEl.dataset.item];
      const redraw = () => draw(sec);
      rowEl.querySelectorAll('.cz-opt').forEach((b) => (b.onclick = () => apply(it, b.dataset.val).then(redrawAll)));
      rowEl.querySelector('select')?.addEventListener('change', (e) => apply(it, e.target.value).then(redrawAll));
      const sw = rowEl.querySelector('.switch input');
      if (sw) sw.onchange = () => apply(it, it.invert ? (sw.checked ? it.on : it.off) : sw.checked).then(redrawAll);
      const rg = rowEl.querySelector('input[type="range"]');
      if (rg) {
        setRangeFill(rg);
        rg.oninput = () => { setRangeFill(rg); rowEl.querySelector('.mem-readout').textContent = `${rg.value}${it.unit}`; };
        rg.onchange = () => apply(it, rg.value);
      }
      rowEl.querySelectorAll('[data-acc]').forEach((b) => (b.onclick = async () => { await saveSettings({ accent: b.dataset.acc, ui: { ...(store.settings.ui || {}), accentCustom: '' } }); redrawAll(); }));
      const color = rowEl.querySelector('.cz-color');
      if (color) color.onchange = () => setPref('accentCustom', color.value).then(redraw);
      rowEl.querySelector('[data-clear]')?.addEventListener('click', () => setPref('accentCustom', '').then(redraw));
      rowEl.querySelector('[data-pick]')?.addEventListener('click', async () => {
        const path = await invoke('pick_file', { title: 'Choose a background image', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] });
        if (!path) return;
        try {
          await saveSettings({ ui: { ...(store.settings.ui || {}), bgImage: await invoke('set_background_image', { path }), bgImageStamp: Date.now() } });
          redraw();
        } catch (e) { toast(String(e), 'bad'); }
      });
      rowEl.querySelectorAll('[data-btn]').forEach((b) => (b.onclick = () => it.buttons[+b.dataset.btn][1]()));
    });
  };
  const redrawAll = () => root.querySelectorAll('[data-cz]').forEach(draw);
  redrawAll();
  // Reset, Paste and changes made elsewhere all flow through settings; keep the controls in step.
  return on('settings', redrawAll);
}
