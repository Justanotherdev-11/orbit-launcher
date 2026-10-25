import { invoke } from '../api.js';
import { store, on, go, pref } from '../store.js';
import { icon, esc, instanceArt, artStyle, loaderChip, timeAgo, fmtDuration, fmtDate, fmtNum, errText, iconUrl } from '../ui.js';
import { playButton, wirePlay, createInstanceModal, importModal } from '../actions.js';

// Popular list on the right: what kind, over what window, and results per (kind, window).
const popular = { kind: null, days: null, cache: new Map() };
const POPULAR_KINDS = [['mod', 'Mods'], ['resourcepack', 'Packs'], ['shader', 'Shaders'], ['modpack', 'Modpacks']];
const POPULAR_RANGES = [[7, 'This week'], [30, 'This month'], [365, 'This year'], [0, 'All time']];

export function render(root) {
  popular.kind = popular.kind || pref('popularKind');
  popular.days = popular.days ?? Number(pref('popularDays'));
  let featuredId = null;
  const draw = () => {
    const list = store.instances;
    const featured = list.find((i) => i.id === featuredId) || list[0];
    featuredId = featured?.id;
    const showPopular = pref('homePopular');
    root.innerHTML = `<div class="page">
      <div class="home-grid" style="${showPopular ? '' : 'grid-template-columns:1fr'}">
        <div>
          ${featured ? (pref('homeHero') ? hero(featured, list) : '') : welcome()}
          ${list.length > 1 && pref('homeRecent') ? `
            <div class="section-title"><span class="eyebrow">Recent</span><div class="line"></div><button class="btn sm ghost" id="see-all">All instances</button></div>
            <div class="recent-row">${list.slice(0, 8).filter((i) => i.id !== featured.id).slice(0, 6).map(mini).join('')}</div>` : ''}
          ${pref('homeQuick') ? `<div class="section-title"><span class="eyebrow">Start something</span><div class="line"></div></div>
          <div class="quick">
            <div class="glass glass-hover quick-card" data-q="new"><div class="q-icon">${icon('plus', 20)}</div><div><div class="t">New instance</div><div class="d">Any version, any loader</div></div></div>
            <div class="glass glass-hover quick-card" data-q="packs"><div class="q-icon">${icon('modpack', 20)}</div><div><div class="t">Browse modpacks</div><div class="d">Modrinth &amp; CurseForge</div></div></div>
            <div class="glass glass-hover quick-card" data-q="import"><div class="q-icon">${icon('import', 20)}</div><div><div class="t">Import</div><div class="d">From any launcher or a pack file</div></div></div>
          </div>` : ''}
        </div>
        ${showPopular ? `<aside class="popular">
          <div class="section-title" style="margin-top:4px"><span class="eyebrow">Popular</span><div class="line"></div>
            <select class="select sm" id="pop-range" style="width:auto">${POPULAR_RANGES.map(([d, l]) => `<option value="${d}" ${d === popular.days ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="seg" id="pop-kind" style="display:flex;margin-bottom:10px">${POPULAR_KINDS.map(([k, l]) => `<button data-k="${k}" class="${k === popular.kind ? 'on' : ''}" style="flex:1;justify-content:center">${l}</button>`).join('')}</div>
          <div class="pop-list" id="pop-list"></div>
        </aside>` : ''}
      </div>
    </div>`;
    wirePlay(root);
    root.querySelector('#see-all')?.addEventListener('click', () => go('library'));
    root.querySelector('[data-hero-open]')?.addEventListener('click', () => go('instance', { id: featured.id }));
    root.querySelectorAll('[data-feature]').forEach((b) => (b.onclick = () => { featuredId = b.dataset.feature; draw(); }));
    root.querySelectorAll('.mini-card').forEach((c) => (c.onclick = () => go('instance', { id: c.dataset.id })));
    root.querySelector('[data-q="new"]')?.addEventListener('click', () => createInstanceModal());
    root.querySelector('[data-q="packs"]')?.addEventListener('click', () => go('discover', { kind: 'modpack' }));
    root.querySelector('[data-q="import"]')?.addEventListener('click', () => importModal());
    root.querySelector('#w-new')?.addEventListener('click', () => createInstanceModal());
    root.querySelector('#w-packs')?.addEventListener('click', () => go('discover', { kind: 'modpack' }));
    root.querySelector('#w-import')?.addEventListener('click', () => importModal());
    drawPopular(root);
  };

  draw();
  const offs = [on('instances', draw), on('running', draw), on('settings', draw)];
  return () => offs.forEach((f) => f());
}

function hero(inst, list) {
  const others = list.slice(0, 5);
  return `<div class="hero">
    ${instanceArt(inst, { icon: false })}
    ${others.length > 1 ? `<div class="hero-switch">${others.map((i) => `<button class="hero-pick ${i.id === inst.id ? 'on' : ''}" data-feature="${esc(i.id)}" title="${esc(i.name)}" style="${artStyle(i.accent, i.id)}">${i.icon ? `<img src="${esc(iconUrl(i.icon))}" />` : ''}</button>`).join('')}</div>` : ''}
    <div class="hero-content">
      <div class="eyebrow">${inst.lastPlayed ? 'Last played' : 'Not played yet'}</div>
      <h1>${esc(inst.name)}</h1>
      <div class="chips">
        <span class="chip mono">${icon('cube', 12)} ${esc(inst.mcVersion)}</span>
        ${loaderChip(inst.loader, inst.loaderVersion)}
        ${inst.group ? `<span class="chip">${icon('group', 12)} ${esc(inst.group)}</span>` : ''}
        ${store.running.has(inst.id) ? '<span class="chip good"><span class="dot"></span>Running</span>' : ''}
      </div>
      <div class="hero-actions">
        ${playButton(inst)}
        <button class="btn" data-hero-open style="height:52px;padding:0 18px">${icon('settings', 17)} Manage</button>
      </div>
      <div class="hero-stats">
        <div class="stat"><div class="v">${fmtDuration(inst.playtime)}</div><div class="k">Played</div></div>
        <div class="stat"><div class="v">${timeAgo(inst.lastPlayed)}</div><div class="k">Last session</div></div>
        <div class="stat"><div class="v">${fmtDate(inst.created)}</div><div class="k">Created</div></div>
      </div>
    </div>
  </div>`;
}

function welcome() {
  return `<div class="hero glass">
    <div class="art" style="${artStyle('emerald', 'welcome')}"><div class="art-bg"></div><div class="art-shade"></div></div>
    <div class="welcome" style="position:relative">
      <div class="eyebrow">No instances yet</div>
      <h1>Set up your first game</h1>
      <p>Pick any Minecraft version and loader, grab a modpack, or bring your instances over from Prism, CurseForge, Modrinth and other launchers.</p>
      <div class="row-flex">
        <button class="btn primary" id="w-new" style="height:42px;padding:0 18px">${icon('plus', 17)} New instance</button>
        <button class="btn" id="w-packs" style="height:42px">${icon('modpack', 17)} Modpacks</button>
        <button class="btn ghost" id="w-import" style="height:42px">${icon('import', 17)} Import</button>
      </div>
    </div>
  </div>`;
}

function mini(inst) {
  return `<div class="glass glass-hover mini-card" data-tilt data-id="${esc(inst.id)}">
    ${instanceArt(inst)}
    <div class="body"><div class="name">${esc(inst.name)}</div><div class="meta">${esc(inst.mcVersion)} · ${timeAgo(inst.lastPlayed || inst.created)}</div></div>
  </div>`;
}

function popularKey() {
  return `${popular.kind}|${popular.days}`;
}

async function drawPopular(root) {
  const list = root.querySelector('#pop-list');
  if (!list) return;
  root.querySelector('#pop-range').onchange = (e) => { popular.days = +e.target.value; drawPopular(root); };
  root.querySelectorAll('#pop-kind [data-k]').forEach((b) => (b.onclick = () => {
    popular.kind = b.dataset.k;
    root.querySelectorAll('#pop-kind [data-k]').forEach((x) => x.classList.toggle('on', x === b));
    drawPopular(root);
  }));
  const key = popularKey();
  let hits = popular.cache.get(key);
  if (!hits) {
    list.innerHTML = Array(6).fill('<div class="skeleton" style="height:64px"></div>').join('');
    try {
      const page = await invoke('search_content', { query: { source: 'modrinth', kind: popular.kind, query: '', sort: 'downloads', offset: 0, sinceDays: popular.days || null } });
      hits = page.hits.slice(0, 10);
      popular.cache.set(key, hits);
    } catch (e) {
      list.innerHTML = `<div class="dim" style="font-size:12.5px;padding:10px">Couldn't load — ${esc(errText(e))}</div>`;
      return;
    }
    if (popularKey() !== key) return;
  }
  list.innerHTML = hits.length ? hits.map((h, i) => `
    <button class="pop-item" data-i="${i}">
      <span class="pop-rank">${String(i + 1).padStart(2, '0')}</span>
      <img src="${esc(h.icon || '')}" alt="" loading="lazy" />
      <span class="pop-main">
        <span class="pop-title">${esc(h.title)}</span>
        <span class="pop-desc">${esc(h.description)}</span>
        <span class="pop-meta">${icon('download', 11)} ${fmtNum(h.downloads)} · ${esc(h.author)}</span>
      </span>
    </button>`).join('') : '<div class="dim" style="font-size:12.5px;padding:10px">Nothing new in this window yet.</div>';
  list.querySelectorAll('img').forEach((img) => (img.onerror = () => (img.style.visibility = 'hidden')));
  list.querySelectorAll('[data-i]').forEach((b) => (b.onclick = () => go('discover', { kind: popular.kind, open: hits[+b.dataset.i] })));
}
