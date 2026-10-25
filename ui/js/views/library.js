import { store, on, go, pref, setPref } from '../store.js';
import { icon, esc, instanceArt, loaderChip, timeAgo, fmtDuration, menu, debounce } from '../ui.js';
import { createInstanceModal, importModal, wirePlay, instanceMenuItems } from '../actions.js';

let ui = { q: '', group: '', sort: null };

export function render(root) {
  ui.sort = ui.sort || pref('libSort');
  root.innerHTML = `<div class="page">
    <div class="page-head">
      <div><div class="sub" id="lib-count"></div><h1>Library</h1></div>
      <div class="spacer"></div>
      <button class="btn" id="lib-import">${icon('import', 16)} Import</button>
      <button class="btn primary" id="lib-new">${icon('plus', 16)} New instance</button>
    </div>
    <div class="toolbar">
      <div class="search" style="width:300px">${icon('search', 15)}<input class="input" id="lib-q" placeholder="Search instances" value="${esc(ui.q)}" /></div>
      <div class="chips" id="lib-groups"></div>
      <div class="spacer"></div>
      <div class="seg" id="lib-view"><button data-v="grid" title="Grid">${icon('library', 14)}</button><button data-v="list" title="List">${icon('menu', 14)}</button></div>
      <select class="select sm" id="lib-sort" style="width:180px">
        <option value="recent">Recently played</option><option value="name">Name</option><option value="created">Newest</option><option value="version">Minecraft version</option>
      </select>
    </div>
    <div id="lib-body"></div>
  </div>`;
  root.querySelector('#lib-new').onclick = () => createInstanceModal({ group: ui.group });
  root.querySelector('#lib-import').onclick = () => importModal();
  const q = root.querySelector('#lib-q');
  q.oninput = debounce(() => { ui.q = q.value; draw(); }, 100);
  const sort = root.querySelector('#lib-sort');
  sort.value = ui.sort;
  sort.onchange = () => { ui.sort = sort.value; draw(); };
  root.querySelectorAll('#lib-view [data-v]').forEach((b) => (b.onclick = () => setPref('libView', b.dataset.v)));

  const draw = () => {
    const all = store.instances;
    root.querySelector('#lib-count').textContent = `${all.length} INSTANCE${all.length === 1 ? '' : 'S'}`;
    const groups = [...new Set(all.map((i) => i.group).filter(Boolean))].sort();
    if (ui.group && !groups.includes(ui.group)) ui.group = '';
    root.querySelector('#lib-groups').innerHTML = groups.length ? [['', 'All'], ...groups.map((g) => [g, g])].map(([v, l]) => `<span class="chip chip-btn ${ui.group === v ? 'on' : ''}" data-g="${esc(v)}">${esc(l)}</span>`).join('') : '';
    root.querySelectorAll('[data-g]').forEach((c) => (c.onclick = () => { ui.group = c.dataset.g; draw(); }));

    let list = all.filter((i) => (!ui.group || i.group === ui.group) && (!ui.q || `${i.name} ${i.mcVersion} ${i.loader} ${i.group}`.toLowerCase().includes(ui.q.toLowerCase())));
    const cmp = {
      recent: (a, b) => (b.lastPlayed || b.created) - (a.lastPlayed || a.created),
      name: (a, b) => a.name.localeCompare(b.name),
      created: (a, b) => b.created - a.created,
      version: (a, b) => b.mcVersion.localeCompare(a.mcVersion, undefined, { numeric: true }),
    }[ui.sort];
    list = [...list].sort(cmp);
    const body = root.querySelector('#lib-body');
    if (!all.length) {
      body.innerHTML = `<div class="glass"><div class="empty"><div class="glyph">${icon('library', 30)}</div><h3>Your library is empty</h3><p>Instances keep each setup separate — its own version, mods, worlds and settings. Make as many as you like.</p><div class="row-flex"><button class="btn primary" id="e-new">${icon('plus', 16)} New instance</button><button class="btn" id="e-imp">${icon('import', 16)} Import from another launcher</button></div></div></div>`;
      body.querySelector('#e-new').onclick = () => createInstanceModal();
      body.querySelector('#e-imp').onclick = () => importModal();
      return;
    }
    if (!list.length) { body.innerHTML = `<div class="empty"><h3>No matches</h3><p>Try a different search.</p></div>`; return; }

    root.querySelectorAll('#lib-view [data-v]').forEach((b) => b.classList.toggle('on', b.dataset.v === pref('libView')));
    const gridClass = `inst-grid ${pref('libView') === 'list' ? 'view-list' : `size-${pref('cardSize')}`} ${pref('libArt') ? '' : 'no-art'}`;
    const sections = pref('libGroups') && !ui.group && groups.length && !ui.q
      ? [...groups.map((g) => [g, list.filter((i) => i.group === g)]), ['Ungrouped', list.filter((i) => !i.group)]].filter(([, l]) => l.length)
      : [[null, list]];
    body.innerHTML = sections.map(([g, l]) => `
      ${g ? `<div class="group-head"><span class="eyebrow">${esc(g)}</span><span class="dim mono" style="font-size:11px">${l.length}</span><div class="line"></div></div>` : ''}
      <div class="${gridClass}">${l.map(card).join('')}</div>`).join('');
    wirePlay(body);
    body.querySelectorAll('.inst-card').forEach((c) => (c.onclick = () => go('instance', { id: c.dataset.id })));
    body.querySelectorAll('[data-more]').forEach((b) => (b.onclick = (e) => {
      e.stopPropagation();
      const inst = store.instances.find((i) => i.id === b.dataset.more);
      menu(b, instanceMenuItems(inst));
    }));
  };

  draw();
  const offs = [on('instances', draw), on('running', draw), on('settings', draw), on('updates', draw)];
  return () => offs.forEach((f) => f());
}

function card(inst) {
  const running = store.running.has(inst.id);
  return `<div class="glass glass-hover inst-card" data-tilt data-id="${esc(inst.id)}">
    ${instanceArt(inst)}
    ${running ? `<span class="chip ${store.starting.has(inst.id) ? 'accent' : 'good'} running-tag" style="background:rgba(11,12,14,.85)"><span class="dot"></span>${store.starting.has(inst.id) ? 'Starting' : 'Running'}</span>` : ''}
    <button class="btn icon sm more" data-more="${esc(inst.id)}">${icon('more', 16)}</button>
    <button class="fab ${running ? 'running' : ''}" data-play="${esc(inst.id)}" title="${running ? 'Stop' : 'Play'}">${icon(running ? 'stop' : 'play', 20)}</button>
    <div class="body">
      <div class="name">${esc(inst.name)}</div>
      <div class="chips"><span class="chip mono">${esc(inst.mcVersion)}</span>${loaderChip(inst.loader)}${store.updates.get(inst.id)?.length ? `<span class="chip accent" title="Mod updates available">${icon('up', 11)} ${store.updates.get(inst.id).length}</span>` : ''}</div>
      <div class="foot"><span>${icon('clock', 11)}</span><span style="flex:1;margin-left:6px">${timeAgo(inst.lastPlayed)}</span>${pref('libPlaytime') ? `<span>${fmtDuration(inst.playtime)}</span>` : ''}</div>
    </div>
  </div>`;
}
