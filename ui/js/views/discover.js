import { invoke, openUrl } from '../api.js';
import { store, go, on, mcVersions, saveSettings, refreshInstances, pref } from '../store.js';
import { icon, esc, h, fmtNum, timeAgo, fmtDate, toast, errText, menu, markdown, sanitize, debounce, LOADERS } from '../ui.js';
import { packDone } from '../actions.js';

const KINDS = [
  ['mod', 'mods', 'Mods'],
  ['modpack', 'modpack', 'Modpacks'],
  ['resourcepack', 'resourcepack', 'Resource packs'],
  ['shader', 'shader', 'Shaders'],
];

const KINDS_OK = ['mod', 'modpack', 'resourcepack', 'shader'];
/** The kind of a search hit — taken from the project itself, never from whichever tab is open. */
const kindOf = (hit) => (KINDS_OK.includes(hit.kind) ? hit.kind : st.kind);
/** Installs in flight, so a double click can't install twice. */
const installing = new Set();

const st = { source: 'modrinth', kind: 'mod', query: '', gameVersion: '', loader: '', sort: 'relevance', target: '' };

export function render(root, params = {}) {
  if (!st.prefsLoaded) Object.assign(st, { source: pref('discoverSource'), sort: pref('discoverSort'), prefsLoaded: true });
  const resultsClass = `results ${pref('discoverView') === 'list' ? 'view-list' : ''}`;
  if (params.kind) st.kind = params.kind;
  if (params.instanceId) applyTarget(params.instanceId);
  if (st.target && !store.instances.some((i) => i.id === st.target)) st.target = '';
  let offset = 0, total = 0, loading = false, token = 0, installed = new Set(), observer;

  root.innerHTML = `<div class="page">
    <div class="page-head">
      <div><div class="sub">MODRINTH · CURSEFORGE</div><h1>Discover</h1></div>
      <div class="spacer"></div>
      <div class="seg" id="d-src">
        <button data-s="modrinth"><span class="dot" style="background:var(--modrinth)"></span>Modrinth</button>
        <button data-s="curseforge"><span class="dot" style="background:var(--curseforge)"></span>CurseForge</button>
      </div>
    </div>
    <div class="tabs" id="d-kinds">${KINDS.map(([k, ic, l]) => `<button class="tab" data-k="${k}">${icon(ic, 16)} ${l}</button>`).join('')}</div>
    <div class="search lg">${icon('search', 18)}<input class="input" id="d-q" placeholder="Search…" value="${esc(st.query)}" /></div>
    <div class="filters">
      <div class="target-pill" id="d-target-wrap"><span class="eyebrow">Install to</span><select class="select sm" id="d-target"></select></div>
      <select class="select sm" id="d-gv"><option value="">All versions</option></select>
      <select class="select sm" id="d-loader"><option value="">Any loader</option>${['fabric', 'quilt', 'forge', 'neoforge'].map((l) => `<option value="${l}">${LOADERS[l]}</option>`).join('')}</select>
      <div class="spacer"></div>
      <select class="select sm" id="d-sort">
        <option value="relevance">Relevance</option><option value="downloads">Downloads</option><option value="follows">Popularity</option><option value="updated">Recently updated</option><option value="newest">Newest</option>
      </select>
    </div>
    <div id="d-results"></div>
    <div class="load-more" id="d-more"></div>
  </div>`;

  const $ = (s) => root.querySelector(s);
  const results = $('#d-results');

  const syncControls = () => {
    root.querySelectorAll('#d-src button').forEach((b) => b.classList.toggle('on', b.dataset.s === st.source));
    root.querySelectorAll('#d-kinds .tab').forEach((b) => b.classList.toggle('on', b.dataset.k === st.kind));
    $('#d-q').placeholder = `Search ${KINDS.find((k) => k[0] === st.kind)[2].toLowerCase()} on ${st.source === 'modrinth' ? 'Modrinth' : 'CurseForge'}…`;
    $('#d-target-wrap').style.display = st.kind === 'modpack' ? 'none' : '';
    $('#d-loader').style.display = st.kind === 'mod' || st.kind === 'modpack' ? '' : 'none';
    $('#d-target').innerHTML = `<option value="">Choose an instance…</option>` + store.instances.map((i) => `<option value="${esc(i.id)}" ${i.id === st.target ? 'selected' : ''}>${esc(i.name)} · ${esc(i.mcVersion)}${i.loader !== 'vanilla' ? ` · ${LOADERS[i.loader]}` : ''}</option>`).join('');
    $('#d-loader').value = st.loader;
    $('#d-sort').value = st.sort;
    if ([...$('#d-gv').options].some((o) => o.value === st.gameVersion)) $('#d-gv').value = st.gameVersion;
  };

  mcVersions().then((vs) => {
    const rel = vs.filter((v) => v.type === 'release').map((v) => v.id);
    if (st.gameVersion && !rel.includes(st.gameVersion)) rel.unshift(st.gameVersion);
    $('#d-gv').innerHTML = '<option value="">All versions</option>' + rel.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    $('#d-gv').value = st.gameVersion;
  }).catch(() => {});

  const refreshInstalled = async () => {
    installed = new Set();
    if (!st.target || st.kind === 'modpack') return;
    const items = await invoke('list_content', { instanceId: st.target, kind: st.kind }).catch(() => []);
    items.forEach((i) => i.meta && installed.add(`${i.meta.source}:${i.meta.projectId}`));
  };

  const card = (hit) => {
    const isInstalled = installed.has(`${hit.source}:${hit.id}`) || installed.has(`${hit.source}:${hit.slug}`);
    return `<div class="glass glass-hover result" data-tilt data-id="${esc(hit.id)}">
      <img class="ic" src="${esc(hit.icon || '')}" loading="lazy" alt="" />
      <div class="main">
        <div class="t">${esc(hit.title)}</div>
        <div class="by">by ${esc(hit.author || 'unknown')}</div>
        <div class="desc">${esc(hit.description)}</div>
        <div class="stats"><span>${icon('download', 12)} ${fmtNum(hit.downloads)}</span><span>${icon('heart', 12)} ${fmtNum(hit.follows)}</span><span>${icon('clock', 12)} ${timeAgo(hit.updated)}</span></div>
      </div>
      <div class="install">${isInstalled ? `<span class="chip good">${icon('check', 12, 2.5)} Installed</span>` : `<button class="btn sm primary" data-install="${esc(hit.id)}">${icon('download', 14)} Install</button>`}</div>
    </div>`;
  };

  const search = async (reset) => {
    if (loading && !reset) return;
    const my = ++token;
    if (reset) {
      offset = 0;
      results.innerHTML = `<div class="${resultsClass}">${Array(9).fill('<div class="skeleton" style="height:138px;border-radius:18px"></div>').join('')}</div>`;
      $('#d-more').innerHTML = '';
      await refreshInstalled();
    }
    loading = true;
    try {
      const page = await invoke('search_content', { query: { source: st.source, kind: st.kind, query: st.query, gameVersion: st.gameVersion || null, loader: st.loader || null, sort: st.sort, offset } });
      if (my !== token) return;
      total = page.total;
      if (reset) results.innerHTML = `<div class="${resultsClass}"></div>`;
      const grid = results.querySelector('.results');
      if (!page.hits.length && offset === 0) {
        results.innerHTML = `<div class="empty"><div class="glyph">${icon('search', 28)}</div><h3>Nothing found</h3><p>Try another search${st.gameVersion ? `, or clear the ${esc(st.gameVersion)} version filter` : ''}.</p></div>`;
        $('#d-more').innerHTML = '';
        return;
      }
      page.hits.forEach((hit) => {
        const el = h(card(hit));
        el.querySelector('img').onerror = (e) => (e.target.style.visibility = 'hidden');
        el.onclick = (e) => { if (!e.target.closest('[data-install]')) openDrawer(hit); };
        el.querySelector('[data-install]')?.addEventListener('click', (e) => { e.stopPropagation(); quickInstall(hit, e.currentTarget); });
        grid.append(el);
      });
      offset += page.hits.length;
      $('#d-more').innerHTML = offset < total ? '<div class="spinner"></div>' : `<span class="dim mono" style="font-size:11px">${fmtNum(total)} RESULTS</span>`;
      // The observer only fires on changes; if one page doesn't fill a tall window, keep loading.
      requestAnimationFrame(() => {
        const more = $('#d-more'), view = document.getElementById('view');
        if (more && view && offset < total && !loading && more.getBoundingClientRect().top < view.getBoundingClientRect().bottom + 400) search(false);
      });
    } catch (e) {
      if (my !== token) return;
      const msg = errText(e);
      if (msg.includes('CF_KEY_MISSING')) cfSetup();
      else results.innerHTML = `<div class="empty"><div class="glyph">${icon('alert', 28)}</div><h3>Couldn't search</h3><p>${esc(msg)}</p></div>`;
      $('#d-more').innerHTML = '';
    } finally {
      if (my === token) loading = false;
    }
  };

  const cfSetup = () => {
    results.innerHTML = `<div class="glass" style="max-width:640px;margin:20px auto">
      <div class="empty" style="padding:40px 36px">
        <div class="glyph" style="color:var(--curseforge);background:rgba(241,100,54,.1);border-color:rgba(241,100,54,.3)">${icon('key', 28)}</div>
        <h3>Connect CurseForge</h3>
        <p>CurseForge requires an API key for third-party launchers. Create a free one at <a href="https://console.curseforge.com/">console.curseforge.com</a> → API keys, then paste it here. It stays on this PC.</p>
        <div class="row-flex" style="width:100%;max-width:460px"><input class="input mono" id="cf-key" placeholder="$2a$10$…" /><button class="btn primary" id="cf-save">Connect</button></div>
      </div></div>`;
    results.querySelector('#cf-save').onclick = async () => {
      const key = results.querySelector('#cf-key').value.trim();
      if (!key) return;
      await saveSettings({ curseforgeKey: key });
      search(true);
    };
  };

  const pickInstance = (anchor, hit, run) => {
    const compatible = store.instances.filter((i) => st.kind !== 'mod' || i.loader !== 'vanilla');
    if (!compatible.length) return toast('Create a modded instance first.', 'info');
    menu(anchor, compatible.slice(0, 12).map((i) => ({ label: `${i.name} · ${i.mcVersion}`, icon: 'cube', run: () => run(i.id) })));
  };

  const doInstall = async (hit, instanceId, versionId, btn) => {
    const kind = kindOf(hit);
    const flight = `${hit.source}:${hit.id}:${kind === 'modpack' ? 'pack' : instanceId}`;
    if (installing.has(flight)) return toast(`${hit.title} is already installing`, 'info');
    installing.add(flight);
    const label = btn?.innerHTML;
    if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner" style="width:14px;height:14px"></div> Installing'; }
    try {
      if (kind === 'modpack') {
        const r = await invoke('install_modpack', { source: hit.source, projectId: hit.id, versionId: versionId || null });
        await refreshInstances();
        packDone(r);
      } else {
        const r = await invoke('install_content', { instanceId, source: hit.source, projectId: hit.id, versionId: versionId || null, kind });
        if (instanceId === st.target) installed.add(`${hit.source}:${hit.id}`);
        const inst = store.instances.find((i) => i.id === instanceId);
        toast(r.installed.length > 1 ? `Also added: ${r.installed.slice(1).join(', ')}` : `Added to ${inst?.name}`, 'good', { title: `${hit.title} installed` });
        if (r.skipped.length) toast(r.skipped.join('\n'), 'info', { title: 'Some dependencies were skipped' });
      }
      if (btn?.isConnected) btn.outerHTML = `<span class="chip good">${icon('check', 12, 2.5)} Installed</span>`;
    } catch (e) {
      if (btn) { btn.disabled = false; btn.innerHTML = label; }
      const msg = errText(e);
      if (msg.startsWith('BLOCKED:')) toast("The author doesn't allow downloads outside CurseForge.", 'bad', { title: hit.title, actions: [{ label: 'Open page', run: () => openUrl(msg.slice(8) || hit.url) }] });
      else toast(msg, 'bad', { title: `Couldn't install ${hit.title}` });
    } finally {
      installing.delete(flight);
    }
  };

  const quickInstall = (hit, btn) => {
    if (kindOf(hit) === 'modpack') return doInstall(hit, null, null, btn);
    if (st.target) return doInstall(hit, st.target, null, btn);
    pickInstance(btn, hit, (id) => doInstall(hit, id, null, btn));
  };

  // ───── detail drawer ─────
  const openDrawer = (hit) => {
    const back = h('<div class="drawer-backdrop"></div>');
    const d = h(`<div class="drawer">
      <div class="drawer-banner">${hit.banner ? `<img src="${esc(hit.banner)}" alt="" />` : ''}</div>
      <button class="btn icon sm drawer-close">${icon('x', 16)}</button>
      <div class="drawer-head">
        <img class="ic" src="${esc(hit.icon || '')}" alt="" />
        <div style="flex:1;min-width:0;padding-bottom:4px">
          <div class="chips" style="margin-bottom:6px"><span class="chip ${hit.source}">${hit.source === 'modrinth' ? 'Modrinth' : 'CurseForge'}</span>${hit.categories.slice(0, 4).map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>
          <h2>${esc(hit.title)}</h2>
          <div class="dim" style="font-size:12.5px">by ${esc(hit.author)} · ${fmtNum(hit.downloads)} downloads · updated ${timeAgo(hit.updated)}</div>
        </div>
        <div class="row-flex" style="padding-bottom:6px"><button class="btn icon" id="dr-web" title="Open website">${icon('external', 16)}</button><button class="btn primary" id="dr-install">${icon('download', 16)} ${kindOf(hit) === 'modpack' ? 'Install pack' : 'Install'}</button></div>
      </div>
      <div class="tabs" id="dr-tabs"><button class="tab on" data-t="about">About</button><button class="tab" data-t="versions">Versions</button><button class="tab" data-t="gallery">Gallery</button><div class="spacer"></div><span class="dim" style="align-self:center;font-size:12px;padding-right:4px">${esc(hit.description)}</span></div>
      <div class="drawer-body" id="dr-body"><div class="loading-row"><div class="spinner"></div></div></div>
    </div>`);
    const close = () => { back.remove(); d.remove(); document.removeEventListener('keydown', key); offNav(); };
    const key = (e) => e.key === 'Escape' && close();
    const offNav = on('navigate', close); // leaving Discover closes the drawer
    document.addEventListener('keydown', key);
    back.onclick = close;
    d.querySelector('.drawer-close').onclick = close;
    d.querySelector('#dr-web').onclick = () => openUrl(hit.url);
    d.querySelector('.drawer-head .ic').onerror = (e) => (e.target.style.visibility = 'hidden');
    d.querySelector('#dr-install').onclick = (e) => quickInstall(hit, e.currentTarget);
    document.getElementById('overlays').append(back, d);

    const body = d.querySelector('#dr-body');
    let detail = null, versions = null, allVersions = false;
    const target = store.instances.find((i) => i.id === st.target);
    const show = async (t) => {
      d.querySelectorAll('#dr-tabs .tab').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
      body.innerHTML = '<div class="loading-row"><div class="spinner"></div></div>';
      try {
        if (t === 'versions') {
          const kind = kindOf(hit);
          const filterOn = target && kind !== 'modpack' && !allVersions;
          versions = await invoke('get_project_versions', {
            source: hit.source, projectId: hit.id,
            gameVersion: filterOn ? target.mcVersion : null,
            loader: filterOn && kind === 'mod' ? target.loader : null,
          });
          body.innerHTML = `${target && kind !== 'modpack' ? `<label class="row-flex hint" style="margin-bottom:12px"><span class="switch"><input type="checkbox" id="dr-all" ${allVersions ? 'checked' : ''} /><span></span></span> Show versions that don't match ${esc(target.name)} (${esc(target.mcVersion)})</label>` : ''}
            <div class="list">${versions.length ? versions.slice(0, 120).map((v, i) => `
              <div class="version-row">
                <span class="chip ${v.kind === 'release' ? 'good' : v.kind === 'beta' ? 'warn' : 'bad'}" style="width:62px;justify-content:center">${esc(v.kind)}</span>
                <div style="flex:1;min-width:0"><div class="vt">${esc(v.name || v.number)}</div><div class="vs">${esc(v.gameVersions.slice(0, 6).join(', '))}${v.gameVersions.length > 6 ? '…' : ''} · ${esc(v.loaders.join(', '))} · ${fmtDate(v.date)}</div></div>
                <button class="btn sm" data-v="${i}">${icon('download', 14)} Install</button>
              </div>`).join('') : '<div class="empty"><h3>No matching versions</h3><p>Turn on “show versions that don’t match” to see everything.</p></div>'}</div>`;
          body.querySelector('#dr-all')?.addEventListener('change', (e) => { allVersions = e.target.checked; show('versions'); });
          body.querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => {
            const v = versions[+b.dataset.v];
            if (kind === 'modpack') return doInstall(hit, null, v.id, b);
            if (st.target) return doInstall(hit, st.target, v.id, b);
            pickInstance(b, hit, (id) => doInstall(hit, id, v.id, b));
          }));
          return;
        }
        detail = detail || (await invoke('get_project', { source: hit.source, id: hit.id }));
        if (t === 'gallery') {
          body.innerHTML = detail.gallery.length ? `<div class="gallery">${detail.gallery.map((g) => `<img src="${esc(g)}" loading="lazy" />`).join('')}</div>` : '<div class="empty"><h3>No images</h3></div>';
          body.querySelectorAll('.gallery img').forEach((img) => (img.onclick = () => {
            const lb = h(`<div class="lightbox"><img src="${esc(img.src)}" /></div>`);
            lb.onclick = () => lb.remove();
            document.getElementById('overlays').append(lb);
          }));
          return;
        }
        const html = detail.format === 'markdown' ? markdown(detail.body) : detail.body;
        body.innerHTML = `${detail.links.length ? `<div class="chips" style="margin-bottom:16px">${detail.links.map((l) => `<a class="chip chip-btn" href="${esc(l.url)}">${icon('external', 11)} ${esc(l.label)}</a>`).join('')}</div>` : ''}<div class="md">${sanitize(html)}</div>`;
      } catch (e) {
        body.innerHTML = `<div class="empty"><h3>Couldn't load</h3><p>${esc(errText(e))}</p></div>`;
      }
    };
    d.querySelectorAll('#dr-tabs .tab').forEach((b) => (b.onclick = () => show(b.dataset.t)));
    show('about');
  };

  // ───── wiring ─────
  root.querySelectorAll('#d-src button').forEach((b) => (b.onclick = () => { st.source = b.dataset.s; syncControls(); search(true); }));
  root.querySelectorAll('#d-kinds .tab').forEach((b) => (b.onclick = () => { st.kind = b.dataset.k; if (st.kind === 'modpack') st.loader = ''; else if (st.target) applyTarget(st.target); syncControls(); search(true); }));
  $('#d-q').oninput = debounce(() => { st.query = $('#d-q').value; search(true); }, 300);
  $('#d-target').onchange = () => { applyTarget($('#d-target').value); syncControls(); search(true); };
  $('#d-gv').onchange = () => { st.gameVersion = $('#d-gv').value; search(true); };
  $('#d-loader').onchange = () => { st.loader = $('#d-loader').value; search(true); };
  $('#d-sort').onchange = () => { st.sort = $('#d-sort').value; search(true); };

  observer = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && offset > 0 && offset < total && !loading) search(false);
  }, { root: document.getElementById('view'), rootMargin: '400px' });
  observer.observe($('#d-more'));

  syncControls();
  search(true);
  if (params.open) {
    st.source = params.open.source || 'modrinth';
    syncControls();
    openDrawer(params.open);
  } else setTimeout(() => $('#d-q').focus(), 50);
  return () => observer.disconnect();
}

function applyTarget(id) {
  st.target = id;
  const inst = store.instances.find((i) => i.id === id);
  if (!inst) return;
  st.gameVersion = inst.mcVersion;
  st.loader = st.kind === 'mod' && inst.loader !== 'vanilla' ? inst.loader : '';
}
