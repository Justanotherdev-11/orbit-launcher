// Ctrl+K command palette: jump to anything, launch anything.
import { invoke } from './api.js';
import { store, go } from './store.js';
import { icon, esc, h, iconUrl, LOADERS } from './ui.js';
import { launch, stop, createInstanceModal, importModal, accountsModal } from './actions.js';

let open = null;

function commands() {
  const out = [];
  for (const i of store.instances) {
    const running = store.running.has(i.id);
    out.push({
      group: 'Instances',
      title: running ? `Stop ${i.name}` : `Play ${i.name}`,
      sub: `${i.mcVersion} · ${LOADERS[i.loader] || i.loader}`,
      thumb: i.icon ? iconUrl(i.icon) : null,
      icon: running ? 'stop' : 'play',
      run: () => (running ? stop(i) : launch(i)),
    });
    out.push({ group: 'Instances', title: `Open ${i.name}`, sub: i.group || 'Instance', icon: 'cube', run: () => go('instance', { id: i.id }) });
  }
  out.push(
    { group: 'Go to', title: 'Home', icon: 'home', run: () => go('home') },
    { group: 'Go to', title: 'Library', icon: 'library', run: () => go('library') },
    { group: 'Go to', title: 'Browse mods', icon: 'mods', run: () => go('discover', { kind: 'mod' }) },
    { group: 'Go to', title: 'Browse modpacks', icon: 'modpack', run: () => go('discover', { kind: 'modpack' }) },
    { group: 'Go to', title: 'Browse resource packs', icon: 'resourcepack', run: () => go('discover', { kind: 'resourcepack' }) },
    { group: 'Go to', title: 'Browse shaders', icon: 'shader', run: () => go('discover', { kind: 'shader' }) },
    { group: 'Go to', title: 'Settings', icon: 'settings', run: () => go('settings') },
    { group: 'Actions', title: 'New instance', sub: 'Ctrl+N', icon: 'plus', run: () => createInstanceModal() },
    { group: 'Actions', title: 'Import from another launcher', sub: 'Prism, CurseForge, Modrinth…', icon: 'import', run: () => importModal() },
    { group: 'Actions', title: 'Import a modpack or backup file', icon: 'modpack', run: () => importModal('file') },
    { group: 'Actions', title: 'Manage accounts', icon: 'user', run: () => accountsModal() },
    { group: 'Actions', title: 'Open data folder', icon: 'folder', run: () => invoke('open_data_folder') },
  );
  return out;
}

/** Subsequence match; higher is better, -1 means no match. */
function score(q, text) {
  if (!q) return 0;
  const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx >= 0) return 1000 - idx * 2 - (t.length - q.length) * 0.1;
  let ti = 0, s = 0, streak = 0;
  for (const c of q) {
    const found = t.indexOf(c, ti);
    if (found < 0) return -1;
    streak = found === ti ? streak + 1 : 0;
    s += 10 + streak * 5 - (found - ti);
    ti = found + 1;
  }
  return s;
}

export function togglePalette() {
  if (open) return open.close();
  const all = commands();
  const back = h(`<div class="palette-backdrop"><div class="palette">
    <div class="palette-input">${icon('search', 18)}<input placeholder="Search instances, pages and actions…" /><span class="kbd">ESC</span></div>
    <div class="palette-list"></div>
    <div class="palette-foot"><span><span class="kbd">↑</span><span class="kbd">↓</span> navigate</span><span><span class="kbd">↵</span> run</span></div>
  </div></div>`);
  const input = back.querySelector('input');
  const listEl = back.querySelector('.palette-list');
  let results = [], sel = 0;

  const render = () => {
    const q = input.value.trim().toLowerCase();
    results = all
      .map((c) => ({ c, s: Math.max(score(q, c.title), score(q, `${c.title} ${c.sub || ''}`) - 50) }))
      .filter((r) => r.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((r) => r.c);
    if (!q) results = all.filter((c) => !(c.group === 'Instances' && c.title.startsWith('Open'))).slice(0, 14);
    sel = Math.min(sel, Math.max(0, results.length - 1));
    let group = null;
    listEl.innerHTML = results.length ? results.map((c, i) => {
      const head = c.group !== group ? `<div class="palette-group">${esc((group = c.group))}</div>` : '';
      return `${head}<button class="palette-item ${i === sel ? 'on' : ''}" data-i="${i}">
        <span class="pi-icon">${c.thumb ? `<img src="${esc(c.thumb)}" />` : icon(c.icon, 16)}</span>
        <span class="pi-title">${esc(c.title)}</span>
        ${c.sub ? `<span class="pi-sub">${esc(c.sub)}</span>` : ''}
      </button>`;
    }).join('') : '<div class="palette-empty">Nothing matches</div>';
    listEl.querySelectorAll('[data-i]').forEach((b) => {
      b.onmousemove = () => { if (sel !== +b.dataset.i) { sel = +b.dataset.i; highlight(); } };
      b.onclick = () => runSel(+b.dataset.i);
    });
  };
  const highlight = () => {
    listEl.querySelectorAll('[data-i]').forEach((b) => b.classList.toggle('on', +b.dataset.i === sel));
    listEl.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  const runSel = (i) => {
    const c = results[i];
    if (!c) return;
    close();
    c.run();
  };
  const close = () => { back.remove(); open = null; };

  input.oninput = () => { sel = 0; render(); };
  input.onkeydown = (e) => {
    e.stopPropagation(); // keys typed here never reach a modal underneath (e.g. Escape)
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % Math.max(1, results.length); highlight(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + results.length) % Math.max(1, results.length); highlight(); }
    else if (e.key === 'Enter') { e.preventDefault(); runSel(sel); }
    else if (e.key === 'Escape' || (e.ctrlKey && e.key.toLowerCase() === 'k')) { e.preventDefault(); close(); }
  };
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.getElementById('overlays').append(back);
  render();
  input.focus();
  open = { close };
}
