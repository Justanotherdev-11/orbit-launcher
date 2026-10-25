import { invoke, fileSrc, openUrl } from '../api.js';
import { store, on, go, emit, refreshInstances, mcVersions, pref } from '../store.js';
import { icon, esc, h, GLYPHS, LOADERS, ACCENTS, artStyle, instanceArt, loaderChip, timeAgo, fmtDuration, fmtBytes, fmtDate, toast, errText, confirmDialog, modal, menu, debounce, setRangeFill, shortLoaderVersion, iconUrl, mcText } from '../ui.js';
import { playButton, wirePlay, instanceMenuItems, launch, deleteInstance, changeIcon, packDone } from '../actions.js';

const TABS = [
  ['Game'],
  ['log', 'terminal', 'Minecraft log'],
  ['version', 'layers', 'Version'],
  ['Content'],
  ['mod', 'mods', 'Mods'],
  ['resourcepack', 'resourcepack', 'Resource packs'],
  ['shader', 'shader', 'Shader packs'],
  ['Data'],
  ['worlds', 'globe', 'Worlds'],
  ['servers', 'server', 'Servers'],
  ['screenshots', 'camera', 'Screenshots'],
  ['notes', 'notes', 'Notes'],
  ['logs', 'scroll', 'Other logs'],
  ['Configure'],
  ['settings', 'settings', 'Settings'],
];

const KIND_LABEL = { mod: 'Mods', resourcepack: 'Resource packs', shader: 'Shader packs' };

export function render(root, { id, tab }) {
  let inst = store.instances.find((i) => i.id === id);
  if (!inst) { go('library'); return; }
  let current = tab || (inst.loader !== 'vanilla' ? 'mod' : 'worlds');
  let tabCleanup = null;

  root.innerHTML = `<div class="page">
    <button class="btn sm ghost back-btn" id="back">${icon('back', 15)} Library</button>
    <div class="inst-header" id="ihead"></div>
    <div class="inst-layout">
      <nav class="glass subnav" id="subnav"></nav>
      <section class="glass panel" id="panel"></section>
    </div>
  </div>`;
  root.querySelector('#back').onclick = () => go('library');

  const drawHeader = () => {
    const head = root.querySelector('#ihead');
    head.innerHTML = `
      ${instanceArt(inst, { icon: false })}
      <div class="inst-header-content">
        <button class="big-icon" id="h-icon" title="Change icon" style="${artStyle(inst.accent, inst.id)};background-image:var(--art)">${inst.icon ? `<img src="${esc(iconUrl(inst.icon))}" />` : `<span style="width:40px;height:40px;color:#fff;opacity:.85">${GLYPHS[inst.loader] || GLYPHS.vanilla}</span>`}<span class="big-icon-edit">${icon('image', 18)}</span></button>
        <div style="flex:1;min-width:0">
          <div class="eyebrow">${esc(inst.group || 'Instance')}</div>
          <h1>${esc(inst.name)}</h1>
          <div class="chips">
            <span class="chip mono">${icon('cube', 12)} ${esc(inst.mcVersion)}</span>
            ${loaderChip(inst.loader, inst.loaderVersion)}
            <span class="chip">${icon('clock', 12)} ${fmtDuration(inst.playtime)} played</span>
            <span class="chip">Last played ${timeAgo(inst.lastPlayed)}</span>
            ${inst.pack ? `<span class="chip ${esc(inst.pack.source)}">${icon('modpack', 12)} ${esc(inst.pack.version || 'Modpack')}</span>` : ''}
            ${store.running.has(inst.id) ? '<span class="chip good"><span class="dot"></span>Running</span>' : ''}
          </div>
        </div>
        <div class="row-flex">
          <button class="btn icon" id="h-folder" title="Open folder" style="width:42px;height:42px;border-radius:13px">${icon('folder', 18)}</button>
          <button class="btn icon" id="h-more" title="More" style="width:42px;height:42px;border-radius:13px">${icon('more', 18)}</button>
          ${playButton(inst, { small: true })}
        </div>
      </div>`;
    wirePlay(head);
    head.querySelector('#h-folder').onclick = () => invoke('open_instance_folder', { id: inst.id });
    head.querySelector('#h-icon').onclick = () => changeIcon(inst);
    head.querySelector('#h-more').onclick = (e) => menu(e.currentTarget, instanceMenuItems(inst, { onDeleted: () => go('library') }));
  };

  const drawNav = () => {
    const nav = root.querySelector('#subnav');
    const tabs = TABS.flatMap((t) => (t[0] === 'version' && inst.pack ? [t, ['modpack', 'modpack', 'Modpack']] : [t]));
    nav.innerHTML = tabs.map((t) => t.length === 1
      ? `<div class="label-row eyebrow">${t[0]}</div>`
      : `<button data-tab="${t[0]}" class="${t[0] === current ? 'on' : ''}">${icon(t[1], 17)}<span>${t[2]}</span>${t[0] === 'log' && store.running.has(inst.id) ? '<span class="count" style="color:var(--good)">● LIVE</span>' : ''}</button>`).join('');
    nav.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => show(b.dataset.tab)));
  };

  const show = (t) => {
    if (typeof tabCleanup === 'function') tabCleanup();
    store.dropTarget = null;
    current = t;
    drawNav();
    // A fresh panel per tab: late async work from the previous tab lands in a detached element.
    const old = root.querySelector('#panel');
    const panel = old.cloneNode(false);
    old.replaceWith(panel);
    panel.dataset.tab = t;
    const fn = { log: logTab, version: versionTab, modpack: modpackTab, mod: contentTab, resourcepack: contentTab, shader: contentTab, notes: notesTab, worlds: worldsTab, servers: serversTab, screenshots: shotsTab, logs: otherLogsTab, settings: settingsTab }[t];
    tabCleanup = fn(panel, () => inst, t);
  };

  drawHeader();
  show(current);

  const offs = [
    on('instances', () => {
      const fresh = store.instances.find((i) => i.id === id);
      if (!fresh) return go('library');
      inst = fresh;
      drawHeader();
    }),
    on('running', () => { drawHeader(); drawNav(); }),
  ];
  return () => { offs.forEach((f) => f()); if (typeof tabCleanup === 'function') tabCleanup(); store.dropTarget = null; };
}

// ───────────────────────── log ─────────────────────────

const logPrefs = { follow: null, wrap: null, color: null };

function logTab(panel, getInst) {
  const inst = getInst();
  if (logPrefs.follow === null) Object.assign(logPrefs, { follow: pref('consoleFollow'), wrap: pref('consoleWrap'), color: pref('consoleColors') });
  panel.innerHTML = `
    <div class="panel-head">
      <h2>Minecraft log</h2><div class="spacer"></div>
      <div class="search" style="width:220px">${icon('search', 14)}<input class="input sm" id="lq" placeholder="Find in log" /></div>
      <span class="chip chip-btn ${logPrefs.follow ? 'on' : ''}" data-p="follow">Keep updating</span>
      <span class="chip chip-btn ${logPrefs.wrap ? 'on' : ''}" data-p="wrap">Wrap lines</span>
      <span class="chip chip-btn ${logPrefs.color ? 'on' : ''}" data-p="color">Colours</span>
    </div>
    <div class="console-wrap">
      <div class="console selectable" id="con"></div>
      <div class="row-flex" style="margin-top:12px">
        <button class="btn sm" id="l-copy">${icon('copy', 14)} Copy</button>
        <button class="btn sm" id="l-up">${icon('upload', 14)} Upload</button>
        <button class="btn sm ghost" id="l-clear">${icon('trash', 14)} Clear</button>
        <div class="spacer"></div>
        <button class="btn sm ghost" id="l-bottom">${icon('down', 14)} Bottom</button>
        <span id="l-run"></span>
      </div>
    </div>`;
  const con = panel.querySelector('#con');
  const q = panel.querySelector('#lq');
  let rendered = 0;
  const lines = () => store.logs.get(inst.id) || [];
  const applyPrefs = () => { con.classList.toggle('wrap', logPrefs.wrap); con.classList.toggle('color', logPrefs.color); };
  const lineHtml = (l, query) => {
    // Match against the raw text, then escape each piece, so searching "amp" can't split "&amp;".
    const t = query
      ? l.line.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')).map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join('')
      : esc(l.line);
    return `<div class="ln ${l.level === 'SYS' ? 'sys' : esc(l.level)}">${t}</div>`;
  };
  const full = () => {
    const query = q.value.trim();
    const all = lines();
    rendered = all.length;
    if (!all.length) {
      con.innerHTML = `<div class="console-empty"><div>${icon('terminal', 30, 1.4)}<div style="margin-top:10px">No output yet — launch the game and its log streams here live.</div></div></div>`;
      return;
    }
    const shown = (query ? all.filter((l) => l.line.toLowerCase().includes(query.toLowerCase())) : all).slice(-5000);
    con.innerHTML = shown.map((l) => lineHtml(l, query)).join('');
    if (logPrefs.follow) con.scrollTop = con.scrollHeight;
  };
  const append = () => {
    const all = lines();
    if (q.value.trim() || rendered === 0 || all.length < rendered) return full();
    const frag = all.slice(rendered).map((l) => lineHtml(l, '')).join('');
    rendered = all.length;
    con.insertAdjacentHTML('beforeend', frag);
    while (con.childElementCount > 6000) con.firstElementChild.remove();
    if (logPrefs.follow) con.scrollTop = con.scrollHeight;
  };
  applyPrefs();
  full();
  q.oninput = debounce(full, 150);
  panel.querySelectorAll('[data-p]').forEach((c) => (c.onclick = () => { logPrefs[c.dataset.p] = !logPrefs[c.dataset.p]; c.classList.toggle('on'); applyPrefs(); if (logPrefs.follow) con.scrollTop = con.scrollHeight; }));
  panel.querySelector('#l-copy').onclick = () => { navigator.clipboard.writeText(lines().map((l) => l.line).join('\n')); toast('Log copied', 'good'); };
  panel.querySelector('#l-up').onclick = () => uploadLog(lines().map((l) => l.line).join('\n'));
  panel.querySelector('#l-clear').onclick = () => { store.logs.set(inst.id, []); full(); };
  panel.querySelector('#l-bottom').onclick = () => (con.scrollTop = con.scrollHeight);
  const drawRunButton = () => {
    const slot = panel.querySelector('#l-run');
    if (store.running.has(inst.id)) {
      slot.innerHTML = `<button class="btn sm danger">${icon('stop', 13)} Kill</button>`;
      slot.firstChild.onclick = () => invoke('kill_instance', { instanceId: inst.id }).catch((e) => toast(errText(e), 'bad'));
    } else {
      slot.innerHTML = `<button class="btn sm primary">${icon('play', 13)} Launch</button>`;
      slot.firstChild.onclick = () => launch(inst);
    }
  };
  drawRunButton();
  const off1 = on('log', (lid) => { if (lid === inst.id) append(); });
  const off2 = on('running', drawRunButton);
  return () => { off1(); off2(); };
}

async function uploadLog(text) {
  if (!text.trim()) return toast('Nothing to upload yet', 'info');
  if (!(await confirmDialog('Upload log to mclo.gs?', 'Anyone with the link will be able to read it. mclo.gs hides IP addresses and access tokens automatically.', { ok: 'Upload' }))) return;
  try {
    const url = await invoke('upload_log', { content: text });
    navigator.clipboard.writeText(url);
    toast(url, 'good', { title: 'Link copied', actions: [{ label: 'Open', run: () => openUrl(url) }] });
  } catch (e) { toast(errText(e), 'bad'); }
}

// ───────────────────────── version ─────────────────────────

function versionTab(panel, getInst) {
  const inst = getInst();
  const st = { mc: inst.mcVersion, loader: inst.loader || 'vanilla', lv: inst.loaderVersion || '', snapshots: !!store.settings.showSnapshots };
  panel.innerHTML = `
    <div class="panel-head"><h2>Version</h2><div class="spacer"></div><button class="btn primary" id="v-save" disabled>${icon('check', 16)} Apply changes</button></div>
    ${inst.pack ? `<div class="callout info" style="margin-bottom:16px">${icon('modpack', 18)}<div>Installed from a <b>${esc(inst.pack.source === 'curseforge' ? 'CurseForge' : 'Modrinth')}</b> modpack (${esc(inst.pack.version)}). Changing versions here can break the pack's mods.</div></div>` : ''}
    <div class="version-cards">
      <div class="glass vcard">
        <div class="k"><div class="q-icon">${icon('cube', 18)}</div><div><div class="eyebrow">Component</div><div style="font-weight:600">Minecraft</div></div></div>
        <select class="select" id="v-mc"><option>${esc(st.mc)}</option></select>
        <label class="row-flex hint" style="margin-top:10px"><span class="switch"><input type="checkbox" id="v-snap" ${st.snapshots ? 'checked' : ''} /><span></span></span> Show snapshots &amp; old versions</label>
      </div>
      <div class="glass vcard">
        <div class="k"><div class="q-icon">${icon('layers', 18)}</div><div><div class="eyebrow">Component</div><div style="font-weight:600">Mod loader</div></div></div>
        <div class="seg" id="v-loader" style="display:flex;flex-wrap:wrap">${Object.entries(LOADERS).map(([k, v]) => `<button data-l="${k}" class="${k === st.loader ? 'on' : ''}">${v}</button>`).join('')}</div>
        <select class="select" id="v-lv" style="margin-top:10px"></select>
      </div>
      <div class="glass vcard">
        <div class="k"><div class="q-icon">${icon('java', 18)}</div><div><div class="eyebrow">Runtime</div><div style="font-weight:600">Java</div></div></div>
        <div class="muted" style="font-size:13px;line-height:1.6">${inst.javaPath ? `Custom: <span class="mono">${esc(inst.javaPath)}</span>` : store.settings.javaPath ? `Global override: <span class="mono">${esc(store.settings.javaPath)}</span>` : 'Automatic — Orbit downloads the exact Java runtime Mojang uses for this version.'}</div>
        <button class="btn sm" id="v-java" style="margin-top:12px">${icon('settings', 14)} Change in settings</button>
      </div>
    </div>`;
  const save = panel.querySelector('#v-save');
  const dirty = () => (save.disabled = !(st.mc !== inst.mcVersion || st.loader !== inst.loader || (st.loader !== 'vanilla' && st.lv !== (inst.loaderVersion || ''))));
  const mcSel = panel.querySelector('#v-mc');
  const lvSel = panel.querySelector('#v-lv');
  const fillMc = async () => {
    const vs = await mcVersions().catch(() => []);
    const list = vs.filter((v) => st.snapshots || v.type === 'release' || v.id === st.mc);
    mcSel.innerHTML = list.map((v) => `<option value="${esc(v.id)}" ${v.id === st.mc ? 'selected' : ''}>${esc(v.id)}${v.type !== 'release' ? `  · ${v.type}` : ''}</option>`).join('');
  };
  let tok = 0;
  // Apply stays disabled until the loader list for the chosen Minecraft version has loaded,
  // so a loader version from a different Minecraft version can never be saved.
  const fillLv = async () => {
    if (st.loader === 'vanilla') { lvSel.style.display = 'none'; dirty(); return; }
    save.disabled = true;
    lvSel.style.display = '';
    lvSel.innerHTML = '<option>Loading…</option>';
    const t = ++tok;
    try {
      const list = await invoke('get_loader_versions', { loader: st.loader, mc: st.mc });
      if (t !== tok) return;
      if (!list.length) { lvSel.innerHTML = `<option value="">Not available for ${esc(st.mc)}</option>`; st.lv = ''; return; }
      if (!list.some((v) => v.id === st.lv)) st.lv = (list.find((v) => v.stable) || list[0]).id;
      lvSel.innerHTML = list.slice(0, 200).map((v) => `<option value="${esc(v.id)}" ${v.id === st.lv ? 'selected' : ''}>${esc(shortLoaderVersion(st.loader, v.id))}${v.stable ? '' : '  · beta'}</option>`).join('');
      dirty();
    } catch (e) {
      if (t !== tok) return;
      st.lv = '';
      lvSel.innerHTML = `<option>${esc(errText(e))}</option>`;
    }
  };
  fillMc(); fillLv();
  mcSel.onchange = () => { st.mc = mcSel.value; fillLv(); };
  lvSel.onchange = () => { st.lv = lvSel.value; dirty(); };
  panel.querySelector('#v-snap').onchange = (e) => { st.snapshots = e.target.checked; fillMc(); };
  panel.querySelectorAll('#v-loader [data-l]').forEach((b) => (b.onclick = () => { st.loader = b.dataset.l; panel.querySelectorAll('#v-loader [data-l]').forEach((x) => x.classList.toggle('on', x === b)); fillLv(); }));
  panel.querySelector('#v-java').onclick = () => panel.closest('.page').querySelector('[data-tab="settings"]').click();
  save.onclick = async () => {
    if (st.loader !== 'vanilla' && !st.lv) return toast(`${LOADERS[st.loader]} isn't available for Minecraft ${st.mc}`, 'bad');
    if (st.mc !== inst.mcVersion && !(await confirmDialog('Change Minecraft version?', 'Mods and worlds made for one version may not work in another. Consider duplicating the instance first.', { ok: 'Change version' }))) return;
    try {
      await invoke('update_instance', { instance: { ...getInst(), mcVersion: st.mc, loader: st.loader, loaderVersion: st.loader === 'vanilla' ? null : st.lv } });
      await refreshInstances();
      toast('Version updated — it installs on next launch', 'good');
      versionTab(panel, getInst);
    } catch (e) { toast(errText(e), 'bad'); }
  };
}

// ───────────────────────── modpack ─────────────────────────

/** Instances with a pack update in flight — survives leaving and re-entering the tab. */
const packBusy = new Set();

function modpackTab(panel, getInst) {
  const inst = getInst();
  const pack = inst.pack;
  const sourceName = pack.source === 'curseforge' ? 'CurseForge' : 'Modrinth';
  panel.innerHTML = `
    <div class="panel-head"><h2>Modpack</h2><div class="spacer"></div><button class="btn sm" id="mp-web">${icon('external', 14)} View on ${sourceName}</button></div>
    <div class="glass vcard pack-card">
      <div class="row-flex" style="gap:16px">
        <div class="pack-icon">${inst.icon ? `<img src="${esc(iconUrl(inst.icon))}" />` : icon('modpack', 26)}</div>
        <div style="flex:1;min-width:0">
          <div class="eyebrow">Installed version</div>
          <div style="font-size:20px;font-weight:650;letter-spacing:-.01em">${esc(pack.version || 'Unknown')}</div>
          <div class="chips" style="margin-top:6px"><span class="chip ${esc(pack.source)}">${sourceName}</span><span class="chip mono">${esc(inst.mcVersion)}</span>${loaderChip(inst.loader, inst.loaderVersion)}</div>
        </div>
        <div id="mp-status"><div class="spinner"></div></div>
      </div>
    </div>
    <div class="callout info" style="margin:16px 0">${icon('info', 18)}<div>Updating swaps the pack's own mods and files for the new version. Your worlds, screenshots and anything you added yourself stay put — but the pack's config files are reset to its defaults.</div></div>
    <div class="section-title" style="margin-top:6px"><span class="eyebrow">All versions</span><div class="line"></div></div>
    <div class="list" id="mp-versions"><div class="loading-row"><div class="spinner"></div></div></div>`;
  panel.querySelector('#mp-web').onclick = () => openUrl(pack.source === 'curseforge' ? `https://www.curseforge.com/projects/${pack.projectId}` : `https://modrinth.com/modpack/${pack.projectId}`);

  const lockButtons = (on) => panel.querySelectorAll('#mp-versions [data-v], #mp-status button').forEach((b) => (b.disabled = on));
  const install = async (v, btn) => {
    if (packBusy.has(inst.id)) return toast('This pack is already updating', 'info');
    if (store.running.has(inst.id)) return toast('Stop the game first', 'bad');
    const newer = v.id !== pack.versionId;
    if (!(await confirmDialog(`Switch to ${v.number}?`, 'The pack\'s mods and config files will be replaced with this version. Consider exporting a backup first if you have changed things.', { ok: newer ? 'Update pack' : 'Reinstall' }))) return;
    if (packBusy.has(inst.id)) return;
    packBusy.add(inst.id);
    lockButtons(true);
    btn.innerHTML = '<div class="spinner" style="width:14px;height:14px"></div> Working';
    try {
      const r = await invoke('update_modpack', { instanceId: inst.id, versionId: v.id });
      packBusy.delete(inst.id);
      await refreshInstances();
      packDone(r);
      // Re-render with the new installed version, if the user is still on this tab.
      if (panel.dataset.tab === 'modpack') modpackTab(panel, getInst);
    } catch (e) {
      packBusy.delete(inst.id);
      if (panel.dataset.tab === 'modpack') { lockButtons(false); btn.textContent = 'Retry'; }
      toast(errText(e).replace(/^BLOCKED:.*/, "The author doesn't allow downloads outside CurseForge."), 'bad', { title: 'Update failed' });
    }
  };

  invoke('get_project_versions', { source: pack.source, projectId: pack.projectId, gameVersion: null, loader: null })
    .then((versions) => {
      const latest = versions.find((v) => v.kind === 'release') || versions[0];
      const status = panel.querySelector('#mp-status');
      if (latest && latest.id !== pack.versionId) {
        status.innerHTML = `<button class="btn primary">${icon('up', 15)} Update to ${esc(latest.number)}</button>`;
        status.firstChild.onclick = (e) => install(latest, e.currentTarget);
      } else {
        status.innerHTML = `<span class="chip good">${icon('check', 12, 2.5)} Up to date</span>`;
      }
      panel.querySelector('#mp-versions').innerHTML = versions.slice(0, 60).map((v, i) => `
        <div class="version-row">
          <span class="chip ${v.kind === 'release' ? 'good' : v.kind === 'beta' ? 'warn' : 'bad'}" style="width:62px;justify-content:center">${esc(v.kind)}</span>
          <div style="flex:1;min-width:0"><div class="vt">${esc(v.name || v.number)} ${v.id === pack.versionId ? '<span class="chip accent" style="margin-left:6px">Installed</span>' : ''}</div><div class="vs">${esc(v.gameVersions.slice(0, 4).join(', '))} · ${esc(v.loaders.join(', '))} · ${fmtDate(v.date)}</div></div>
          <button class="btn sm" data-v="${i}">${v.id === pack.versionId ? `${icon('refresh', 13)} Reinstall` : `${icon('download', 13)} Install`}</button>
        </div>`).join('') || '<div class="empty"><h3>No versions found</h3></div>';
      panel.querySelectorAll('#mp-versions [data-v]').forEach((b) => (b.onclick = () => install(versions[+b.dataset.v], b)));
      if (packBusy.has(inst.id)) lockButtons(true);
    })
    .catch((e) => {
      panel.querySelector('#mp-status').innerHTML = '';
      panel.querySelector('#mp-versions').innerHTML = `<div class="loading-row">${esc(errText(e).includes('CF_KEY_MISSING') ? 'Add a CurseForge API key in Settings to check for updates.' : errText(e))}</div>`;
    });
}

// ───────────────────────── content (mods / packs / shaders) ─────────────────────────

const identified = new Set();

function contentTab(panel, getInst, kind) {
  const inst = getInst();
  const label = KIND_LABEL[kind];
  store.dropTarget = { instanceId: inst.id, kind, label: label.toLowerCase(), instanceName: inst.name };
  let items = [];
  const folderPrefix = { mod: 'mods/', resourcepack: 'resourcepacks/', shader: 'shaderpacks/' }[kind];
  let updates = (store.updates.get(inst.id) || []).filter((u) => u.file.startsWith(folderPrefix));
  let filter = '';
  panel.innerHTML = `
    <div class="panel-head">
      <h2>${label}</h2><span class="chip mono" id="c-count">…</span><div class="spacer"></div>
      <div class="search" style="width:200px">${icon('search', 14)}<input class="input sm" id="c-q" placeholder="Filter" /></div>
      <button class="btn sm" id="c-upd">${icon('refresh', 14)} Check updates</button>
      <button class="btn sm" id="c-add">${icon('plus', 14)} Add file</button>
      <button class="btn sm icon" id="c-folder" title="Open folder">${icon('folder', 15)}</button>
      <button class="btn sm primary" id="c-browse">${icon('discover', 14)} Browse</button>
    </div>
    <div id="c-hint"></div>
    <div id="c-upd-banner"></div>
    <div class="bulk-bar" id="c-bulk"></div>
    <div class="list" id="c-list"><div class="loading-row"><div class="spinner"></div></div></div>`;
  const listEl = panel.querySelector('#c-list');
  const selected = new Set(); // keyed by fileName, which survives enable/disable renames
  let shown = [];
  let lastClicked = null; // anchor for shift-click range selection

  const iconFor = (it) => it.meta?.icon || (it.local.icon ? fileSrc(it.local.icon) : '');
  const titleFor = (it) => it.meta?.title || it.local.name || it.fileName.replace(/\.(jar|zip)$/i, '');
  const pageFor = (m) => (m?.projectId ? (m.source === 'curseforge' ? `https://www.curseforge.com/projects/${m.projectId}` : `https://modrinth.com/project/${m.projectId}`) : null);

  const drawBulk = () => {
    const bar = panel.querySelector('#c-bulk');
    for (const f of [...selected]) if (!items.some((i) => i.fileName === f)) selected.delete(f);
    if (!selected.size) { bar.classList.remove('show'); bar.innerHTML = ''; return; }
    bar.classList.add('show');
    bar.innerHTML = `<span class="mono" style="font-size:12px"><b style="color:var(--a)">${selected.size}</b> SELECTED</span>
      <button class="btn sm ghost" data-b="all">Select all${filter ? ' shown' : ''}</button>
      <div class="spacer"></div>
      <button class="btn sm" data-b="on">${icon('check', 13)} Enable</button>
      <button class="btn sm" data-b="off">${icon('x', 13)} Disable</button>
      <button class="btn sm danger" data-b="del">${icon('trash', 13)} Delete</button>
      <button class="btn sm icon ghost" data-b="clear" title="Clear selection">${icon('x', 14)}</button>`;
    const files = () => items.filter((i) => selected.has(i.fileName)).map((i) => i.file);
    const run = async (fn) => { try { await fn(); } catch (e) { toast(errText(e), 'bad'); } load(); };
    bar.querySelector('[data-b="all"]').onclick = () => { shown.forEach((i) => selected.add(i.fileName)); draw(); };
    bar.querySelector('[data-b="clear"]').onclick = () => { selected.clear(); draw(); };
    bar.querySelector('[data-b="on"]').onclick = () => run(() => invoke('set_content_enabled', { instanceId: inst.id, files: files(), enabled: true }));
    bar.querySelector('[data-b="off"]').onclick = () => run(() => invoke('set_content_enabled', { instanceId: inst.id, files: files(), enabled: false }));
    bar.querySelector('[data-b="del"]').onclick = async () => {
      if (!(await confirmDialog(`Delete ${selected.size} file${selected.size === 1 ? '' : 's'}?`, 'They will be removed from this instance.', { ok: 'Delete', danger: true }))) return;
      const f = files();
      selected.clear();
      run(() => invoke('delete_content', { instanceId: inst.id, files: f }));
    };
  };

  const draw = () => {
    panel.querySelector('#c-count').textContent = `${items.filter((i) => i.enabled).length}/${items.length}`;
    shown = items.filter((it) => !filter || `${titleFor(it)} ${it.fileName}`.toLowerCase().includes(filter));
    drawBulk();
    if (!items.length) {
      listEl.innerHTML = `<div class="empty"><div class="glyph">${icon(kind === 'mod' ? 'mods' : kind, 28)}</div><h3>No ${label.toLowerCase()} yet</h3><p>Browse Modrinth and CurseForge, or drag files from your computer onto this window.</p><div class="row-flex"><button class="btn primary" data-browse>${icon('discover', 16)} Browse ${label.toLowerCase()}</button></div></div>`;
      listEl.querySelector('[data-browse]').onclick = browse;
      return;
    }
    listEl.innerHTML = shown.map((it, idx) => {
      const ic = iconFor(it);
      const ver = it.meta?.version || it.local.version;
      const by = it.local.authors?.length ? `by ${it.local.authors.slice(0, 2).join(', ')}` : '';
      const src = it.meta?.source;
      const page = pageFor(it.meta);
      return `<div class="item ${it.enabled ? '' : 'off'} ${selected.has(it.fileName) ? 'sel' : ''}" data-row="${idx}">
        <span class="check ${selected.has(it.fileName) ? 'on' : ''}" data-sel="${idx}">${icon('check', 12, 3)}</span>
        <div class="ic">${ic ? `<img src="${esc(ic)}" loading="lazy" />` : icon(kind === 'mod' ? 'mods' : kind, 18)}</div>
        <div class="main">
          <div class="t">${esc(titleFor(it))} ${ver ? `<span class="dim mono" style="font-weight:400;font-size:11.5px;margin-left:6px">${esc(ver)}</span>` : ''}</div>
          <div class="s">${esc([by, it.fileName, fmtBytes(it.size)].filter(Boolean).join(' · '))}</div>
        </div>
        ${src ? `<span class="chip ${esc(src)}">${src === 'curseforge' ? 'CurseForge' : 'Modrinth'}</span>` : '<span class="chip">Local</span>'}
        ${updates.some((u) => u.file === it.file) ? `<span class="chip accent">${icon('up', 12)} Update</span>` : ''}
        <div class="actions">
          ${page ? `<button class="btn icon sm ghost" data-page="${idx}" title="Open project page">${icon('external', 14)}</button>` : ''}
          <label class="switch" title="${it.enabled ? 'Disable' : 'Enable'}"><input type="checkbox" data-toggle="${idx}" ${it.enabled ? 'checked' : ''} /><span></span></label>
          <button class="btn icon sm ghost" data-del="${idx}" title="Delete">${icon('trash', 15)}</button>
        </div>
      </div>`;
    }).join('') || '<div class="loading-row">No matches</div>';
    listEl.querySelectorAll('.ic img').forEach((img) => (img.onerror = () => img.remove()));
    listEl.querySelectorAll('[data-sel]').forEach((c) => (c.onclick = (e) => {
      const idx = +c.dataset.sel;
      const key = shown[idx].fileName;
      // Anchor on the file, not its row number, which changes when the list filters or reloads.
      const anchor = lastClicked == null ? -1 : shown.findIndex((i) => i.fileName === lastClicked);
      if (e.shiftKey && anchor >= 0) {
        const [a, b] = [Math.min(anchor, idx), Math.max(anchor, idx)];
        shown.slice(a, b + 1).forEach((i) => selected.add(i.fileName));
      } else if (selected.has(key)) selected.delete(key);
      else selected.add(key);
      lastClicked = key;
      draw();
    }));
    listEl.querySelectorAll('[data-page]').forEach((b) => (b.onclick = () => openUrl(pageFor(shown[+b.dataset.page].meta))));
    listEl.querySelectorAll('[data-toggle]').forEach((t) => (t.onchange = async () => {
      const it = shown[+t.dataset.toggle];
      try { await invoke('toggle_content', { instanceId: inst.id, file: it.file }); load(); } catch (e) { toast(errText(e), 'bad'); }
    }));
    listEl.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      const it = shown[+b.dataset.del];
      if (!(await confirmDialog(`Delete ${titleFor(it)}?`, 'The file will be removed from this instance.', { ok: 'Delete', danger: true }))) return;
      try { await invoke('delete_content', { instanceId: inst.id, files: [it.file] }); load(); } catch (e) { toast(errText(e), 'bad'); }
    }));
  };

  const drawUpdates = () => {
    const el = panel.querySelector('#c-upd-banner');
    if (!updates.length) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="update-banner">${icon('up', 18)}<div style="flex:1"><b>${updates.length} update${updates.length === 1 ? '' : 's'} available</b><div class="dim" style="font-size:12px">${esc(updates.slice(0, 4).map((u) => `${u.title} → ${u.latest}`).join(' · '))}${updates.length > 4 ? ' …' : ''}</div></div><button class="btn sm primary" id="c-upall">Update all</button></div>`;
    el.querySelector('#c-upall').onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const done = new Set();
      for (const u of updates) {
        try { await invoke('apply_update', { instanceId: inst.id, file: u.file, versionId: u.versionId }); done.add(u.file); } catch (err) { toast(`${u.title}: ${errText(err)}`, 'bad'); }
      }
      if (done.size) toast(`Updated ${done.size} file${done.size === 1 ? '' : 's'}`, 'good');
      // Only clear what actually updated; failures stay listed so they can be retried.
      const rest = (store.updates.get(inst.id) || []).filter((u) => !done.has(u.file));
      if (rest.length) store.updates.set(inst.id, rest); else store.updates.delete(inst.id);
      emit('updates');
      updates = updates.filter((u) => !done.has(u.file));
      drawUpdates();
      load();
    };
  };

  const shaderHint = async () => {
    if (kind !== 'shader') return;
    const el = panel.querySelector('#c-hint');
    const mods = await invoke('list_content', { instanceId: inst.id, kind: 'mod' }).catch(() => []);
    const has = mods.some((m) => /iris|oculus|optifine/i.test(`${m.fileName} ${m.local.modId || ''} ${m.meta?.title || ''}`));
    if (has) return;
    const slug = inst.loader === 'fabric' || inst.loader === 'quilt' ? 'iris' : inst.loader === 'forge' || inst.loader === 'neoforge' ? 'oculus' : null;
    el.innerHTML = `<div class="callout info" style="margin-bottom:14px">${icon('shader', 18)}<div style="flex:1">Shader packs need a shader mod. ${slug ? `For ${LOADERS[inst.loader]}, that's <b>${slug === 'iris' ? 'Iris' : 'Oculus'}</b>.` : 'Switch this instance to Fabric or Quilt and install Iris.'}</div>${slug ? `<button class="btn sm primary" id="c-iris">${icon('download', 14)} Install ${slug === 'iris' ? 'Iris' : 'Oculus'}</button>` : ''}</div>`;
    el.querySelector('#c-iris')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget; // currentTarget is null once we've awaited
      btn.disabled = true;
      try { await invoke('install_content', { instanceId: inst.id, source: 'modrinth', projectId: slug, versionId: null, kind: 'mod' }); el.innerHTML = ''; toast('Shader support installed', 'good'); } catch (err) { btn.disabled = false; toast(errText(err), 'bad'); }
    });
  };

  const load = async () => {
    try {
      items = await invoke('list_content', { instanceId: inst.id, kind });
      draw();
      if (!identified.has(inst.id) && items.some((i) => !i.meta)) {
        identified.add(inst.id);
        const n = await invoke('identify_content', { instanceId: inst.id }).catch(() => 0);
        if (n) { items = await invoke('list_content', { instanceId: inst.id, kind }); draw(); }
      }
    } catch (e) { listEl.innerHTML = `<div class="loading-row">${esc(errText(e))}</div>`; }
  };

  const browse = () => go('discover', { kind, instanceId: inst.id });
  panel.querySelector('#c-browse').onclick = browse;
  panel.querySelector('#c-folder').onclick = () => invoke('open_instance_folder', { id: inst.id, sub: { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks' }[kind] });
  panel.querySelector('#c-q').oninput = debounce((e) => { filter = e.target.value.toLowerCase(); draw(); }, 100);
  panel.querySelector('#c-add').onclick = async () => {
    const path = await invoke('pick_file', { title: `Add to ${label.toLowerCase()}`, extensions: kind === 'mod' ? ['jar'] : ['zip'] });
    if (!path) return;
    try { await invoke('add_local_files', { instanceId: inst.id, kind, paths: [path] }); load(); toast('Added', 'good'); } catch (e) { toast(errText(e), 'bad'); }
  };
  panel.querySelector('#c-upd').onclick = async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    b.innerHTML = `<div class="spinner" style="width:14px;height:14px"></div> Checking`;
    try {
      updates = (await invoke('check_updates', { instanceId: inst.id })).filter((u) => u.file.startsWith({ mod: 'mods/', resourcepack: 'resourcepacks/', shader: 'shaderpacks/' }[kind]));
      drawUpdates(); draw();
      if (!updates.length) toast('Everything is up to date', 'good');
    } catch (err) { toast(errText(err), 'bad'); }
    b.disabled = false;
    b.innerHTML = `${icon('refresh', 14)} Check updates`;
  };

  load();
  drawUpdates();
  shaderHint();
  const off = on('content-changed', load);
  return () => { off(); store.dropTarget = null; };
}

// ───────────────────────── notes ─────────────────────────

function notesTab(panel, getInst) {
  const inst = getInst();
  panel.innerHTML = `
    <div class="panel-head"><h2>Notes</h2><div class="spacer"></div><span class="dim mono" id="n-state" style="font-size:11px"></span></div>
    <textarea class="textarea notes-area" id="n-text" placeholder="Seeds, coordinates, server IPs, to-do lists… saved automatically."></textarea>`;
  const ta = panel.querySelector('#n-text');
  const stateEl = panel.querySelector('#n-state');
  let edited = false;
  invoke('get_notes', { id: inst.id }).then((t) => { if (!edited) ta.value = t; }).catch((e) => { stateEl.textContent = 'COULDN’T LOAD'; toast(errText(e), 'bad'); });
  const save = debounce(async () => {
    try { await invoke('save_notes', { id: inst.id, notes: ta.value }); stateEl.textContent = 'SAVED'; } catch (e) { stateEl.textContent = 'ERROR'; }
  }, 500);
  ta.oninput = () => { edited = true; stateEl.textContent = 'EDITING…'; save(); };
}

// ───────────────────────── worlds ─────────────────────────

function worldsTab(panel, getInst) {
  const inst = getInst();
  store.dropTarget = { instanceId: inst.id, kind: 'world', label: 'worlds', instanceName: inst.name };
  panel.innerHTML = `
    <div class="panel-head"><h2>Worlds</h2><span class="chip mono" id="w-count">…</span><div class="spacer"></div><button class="btn sm" id="w-folder">${icon('folder', 14)} Saves folder</button></div>
    <div class="tile-grid" id="w-list"><div class="loading-row"><div class="spinner"></div></div></div>`;
  panel.querySelector('#w-folder').onclick = () => invoke('open_instance_folder', { id: inst.id, sub: 'saves' });
  const load = async () => {
    const list = await invoke('list_worlds', { instanceId: inst.id }).catch(() => []);
    panel.querySelector('#w-count').textContent = list.length;
    const el = panel.querySelector('#w-list');
    if (!list.length) {
      el.style.display = 'block';
      el.innerHTML = `<div class="empty"><div class="glyph">${icon('globe', 28)}</div><h3>No worlds yet</h3><p>Worlds you create in-game show up here. Drop a world folder onto the window to import one.</p></div>`;
      return;
    }
    el.style.display = '';
    el.innerHTML = list.map((w, i) => `
      <div class="glass world">
        ${w.icon ? `<img src="${esc(fileSrc(w.icon))}" />` : `<div class="ph">${icon('globe', 24)}</div>`}
        <div style="flex:1;min-width:0">
          <div class="t">${esc(w.name)}</div>
          <div class="s">${esc(w.mode)}${w.hardcore ? ' · HARDCORE' : ''}${w.version ? ` · ${esc(w.version)}` : ''}</div>
          <div class="s">${timeAgo(w.lastPlayed)} · ${fmtBytes(w.size)}</div>
          <div class="actions">
            <button class="btn sm primary" data-wp="${i}" title="Launch straight into this world (1.20+)">${icon('play', 12)} Play</button>
            <button class="btn sm icon" data-wf="${i}" title="Open folder">${icon('folder', 14)}</button>
            <button class="btn sm icon" data-wb="${i}" title="Back up to zip">${icon('archive', 14)}</button>
            ${w.seed ? `<button class="btn sm icon" data-ws="${i}" title="Copy seed">${icon('copy', 14)}</button>` : ''}
            <button class="btn sm icon ghost" data-wd="${i}" title="Delete">${icon('trash', 14)}</button>
          </div>
        </div>
      </div>`).join('');
    el.querySelectorAll('[data-wp]').forEach((b) => (b.onclick = () => {
      if (store.running.has(inst.id)) return toast('The game is already running', 'info');
      launch(inst, { world: list[+b.dataset.wp].folder });
    }));
    el.querySelectorAll('[data-wf]').forEach((b) => (b.onclick = () => invoke('open_instance_folder', { id: inst.id, sub: `saves/${list[+b.dataset.wf].folder}` })));
    el.querySelectorAll('[data-ws]').forEach((b) => (b.onclick = () => { navigator.clipboard.writeText(list[+b.dataset.ws].seed); toast('Seed copied', 'good'); }));
    el.querySelectorAll('[data-wb]').forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      try { await invoke('backup_world', { instanceId: inst.id, folder: list[+b.dataset.wb].folder }); toast('Backup saved to the backups folder', 'good', { actions: [{ label: 'Show', run: () => invoke('open_instance_folder', { id: inst.id, sub: 'backups' }) }] }); } catch (e) { toast(errText(e), 'bad'); }
      b.disabled = false;
    }));
    el.querySelectorAll('[data-wd]').forEach((b) => (b.onclick = async () => {
      const w = list[+b.dataset.wd];
      if (!(await confirmDialog(`Delete “${w.name}”?`, 'The world is permanently deleted. Make a backup first if you might want it back.', { ok: 'Delete world', danger: true }))) return;
      try { await invoke('delete_world', { instanceId: inst.id, folder: w.folder }); load(); } catch (e) { toast(errText(e), 'bad'); }
    }));
  };
  load();
  const off = on('content-changed', load);
  return () => { off(); store.dropTarget = null; };
}

// ───────────────────────── servers ─────────────────────────

function serversTab(panel, getInst) {
  const inst = getInst();
  let list = [];
  const status = new Map(); // address -> 'loading' | {online, max, motd, latency, ...} | {error}
  let alive = true;
  panel.innerHTML = `
    <div class="panel-head"><h2>Servers</h2><span class="chip mono" id="s-count">…</span><div class="spacer"></div><button class="btn sm" id="s-refresh">${icon('refresh', 14)} Refresh</button><button class="btn sm primary" id="s-add">${icon('plus', 14)} Add server</button></div>
    ${store.running.has(inst.id) ? `<div class="callout" style="margin-bottom:14px">${icon('alert', 18)}<div>The game is running — Minecraft rewrites this list when it closes, so edits made now may be lost.</div></div>` : ''}
    <div class="list" id="s-list" style="gap:8px"></div>`;
  const save = async () => {
    try { await invoke('save_servers', { instanceId: inst.id, servers: list }); } catch (e) { toast(errText(e), 'bad'); }
    draw();
  };
  const edit = (idx) => {
    const s = idx == null ? { name: '', ip: '' } : list[idx];
    const m = modal({
      title: idx == null ? 'Add server' : 'Edit server',
      body: `<div class="fields"><div class="field"><label>Name</label><input class="input" id="se-n" value="${esc(s.name)}" placeholder="Minecraft Server" /></div><div class="field"><label>Address</label><input class="input mono" id="se-ip" value="${esc(s.ip)}" placeholder="play.example.com" /></div></div>`,
      foot: `<button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="se-ok">${idx == null ? 'Add' : 'Save'}</button>`,
    });
    m.el.querySelector('#se-ok').onclick = () => {
      const name = m.el.querySelector('#se-n').value.trim() || 'Minecraft Server';
      const ip = m.el.querySelector('#se-ip').value.trim();
      if (!ip) return toast('Enter an address', 'bad');
      if (idx == null) list.push({ name, ip }); else list[idx] = { ...s, name, ip };
      m.close();
      save();
      pingOne(ip);
    };
  };
  const pingOne = async (ip) => {
    status.set(ip, 'loading');
    if (alive) draw();
    try { status.set(ip, await invoke('ping_server', { address: ip })); } catch (e) { status.set(ip, { error: errText(e) }); }
    if (alive) draw();
  };
  const pingAll = () => [...new Set(list.map((s) => s.ip))].forEach(pingOne);
  const bars = (ms) => {
    const n = ms <= 0 ? 1 : ms < 80 ? 4 : ms < 150 ? 3 : ms < 300 ? 2 : 1;
    const color = n >= 3 ? 'var(--good)' : n === 2 ? 'var(--warn)' : 'var(--bad)';
    return `<span class="sig" style="--c:${color}">${[1, 2, 3, 4].map((i) => `<i class="${i <= n ? 'on' : ''}" style="height:${i * 3 + 2}px"></i>`).join('')}</span>`;
  };
  const statusHtml = (ip) => {
    const st = status.get(ip);
    if (!st || st === 'loading') return `<div class="srv-status dim"><div class="spinner" style="width:14px;height:14px"></div></div>`;
    if (st.error) return `<div class="srv-status"><span class="chip bad"><span class="dot"></span>Offline</span></div>`;
    return `<div class="srv-status">
      <div class="srv-meta"><span class="mono" title="${esc(st.players.join(', '))}">${icon('users', 13)} ${st.online}<span class="dim">/${st.max}</span></span>${bars(st.latency)}<span class="mono dim" style="font-size:11px">${st.latency ? `${st.latency}ms` : ''}</span></div>
      <div class="dim mono" style="font-size:10.5px;text-align:right">${mcText(st.version.replace(/§[0-9a-f]/gi, ''))}</div>
    </div>`;
  };
  const draw = () => {
    panel.querySelector('#s-count').textContent = list.length;
    const el = panel.querySelector('#s-list');
    if (!list.length) {
      el.innerHTML = `<div class="empty"><div class="glyph">${icon('server', 28)}</div><h3>No servers saved</h3><p>Add one here or in-game, then join it straight from the launcher.</p></div>`;
      return;
    }
    el.innerHTML = list.map((s, i) => {
      const st = status.get(s.ip);
      const favicon = s.icon || (st && st.favicon) || null;
      const motd = st && st.motd ? `<div class="motd">${mcText(st.motd)}</div>` : '';
      return `
      <div class="glass server ${st && st.error ? 'offline' : ''}">
        ${favicon ? `<img src="${esc(favicon)}" />` : `<div class="ph">${icon('server', 22)}</div>`}
        <div style="flex:1;min-width:0"><div style="font-weight:600">${esc(s.name)} <span class="dim mono" style="font-weight:400;font-size:11.5px;margin-left:6px">${esc(s.ip)}</span></div>${motd}</div>
        ${statusHtml(s.ip)}
        <button class="btn sm icon ghost" data-up="${i}" ${i === 0 ? 'disabled' : ''} title="Move up">${icon('up', 14)}</button>
        <button class="btn sm icon ghost" data-dn="${i}" ${i === list.length - 1 ? 'disabled' : ''} title="Move down">${icon('down', 14)}</button>
        <button class="btn sm icon ghost" data-ed="${i}" title="Edit">${icon('edit', 14)}</button>
        <button class="btn sm icon ghost" data-rm="${i}" title="Remove">${icon('trash', 14)}</button>
        <button class="btn sm primary" data-join="${i}">${icon('play', 13)} Join</button>
      </div>`;
    }).join('');
    el.querySelectorAll('[data-join]').forEach((b) => (b.onclick = () => {
      if (store.running.has(inst.id)) return toast('The game is already running', 'info');
      launch(inst, { server: list[+b.dataset.join].ip });
    }));
    el.querySelectorAll('[data-ed]').forEach((b) => (b.onclick = () => edit(+b.dataset.ed)));
    el.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog('Remove server?', list[+b.dataset.rm].name, { ok: 'Remove', danger: true }))) return;
      list.splice(+b.dataset.rm, 1); save();
    }));
    el.querySelectorAll('[data-up]').forEach((b) => (b.onclick = () => { const i = +b.dataset.up; [list[i - 1], list[i]] = [list[i], list[i - 1]]; save(); }));
    el.querySelectorAll('[data-dn]').forEach((b) => (b.onclick = () => { const i = +b.dataset.dn; [list[i + 1], list[i]] = [list[i], list[i + 1]]; save(); }));
  };
  panel.querySelector('#s-add').onclick = () => edit(null);
  panel.querySelector('#s-refresh').onclick = pingAll;
  invoke('list_servers', { instanceId: inst.id })
    .then((l) => { list = l; draw(); pingAll(); })
    .catch((e) => {
      // Never let a save from an empty list overwrite a servers.dat we couldn't read.
      panel.querySelector('#s-add').disabled = true;
      panel.querySelector('#s-refresh').disabled = true;
      panel.querySelector('#s-list').innerHTML = `<div class="empty"><div class="glyph">${icon('alert', 26)}</div><h3>Couldn't read the server list</h3><p>${esc(errText(e))}. Editing is disabled so your saved servers aren't overwritten — you can still manage them in-game.</p></div>`;
    });
  return () => { alive = false; };
}

// ───────────────────────── screenshots ─────────────────────────

function shotsTab(panel, getInst) {
  const inst = getInst();
  let list = [];
  panel.innerHTML = `
    <div class="panel-head"><h2>Screenshots</h2><span class="chip mono" id="sh-count">…</span><div class="spacer"></div><button class="btn sm" id="sh-folder">${icon('folder', 14)} Open folder</button></div>
    <div id="sh-list"></div>`;
  panel.querySelector('#sh-folder').onclick = () => invoke('open_instance_folder', { id: inst.id, sub: 'screenshots' });
  let closeLightbox = null;
  const lightbox = (i) => {
    closeLightbox?.();
    const lb = h(`<div class="lightbox"><img /><button class="btn icon lb-nav prev">${icon('back', 18)}</button><button class="btn icon lb-nav next" style="transform:translateY(-50%) scaleX(-1)">${icon('back', 18)}</button>
      <div class="lb-bar glass"><span class="mono dim" style="font-size:12px;padding:0 8px" id="lb-n"></span><button class="btn sm" id="lb-open">${icon('external', 14)} Open</button><button class="btn sm danger" id="lb-del">${icon('trash', 14)} Delete</button><button class="btn sm icon ghost" id="lb-x">${icon('x', 15)}</button></div></div>`);
    const show = () => { lb.querySelector('img').src = fileSrc(list[i].path); lb.querySelector('#lb-n').textContent = `${list[i].name} · ${i + 1}/${list.length}`; };
    const close = () => { lb.remove(); document.removeEventListener('keydown', key); closeLightbox = null; };
    closeLightbox = close;
    const key = (e) => { if (e.key === 'Escape') close(); if (e.key === 'ArrowLeft') { i = (i - 1 + list.length) % list.length; show(); } if (e.key === 'ArrowRight') { i = (i + 1) % list.length; show(); } };
    lb.querySelector('.prev').onclick = () => { i = (i - 1 + list.length) % list.length; show(); };
    lb.querySelector('.next').onclick = () => { i = (i + 1) % list.length; show(); };
    lb.querySelector('#lb-x').onclick = close;
    lb.onclick = (e) => { if (e.target === lb) close(); };
    lb.querySelector('#lb-open').onclick = () => invoke('open_screenshot', { instanceId: inst.id, name: list[i].name });
    lb.querySelector('#lb-del').onclick = async () => {
      await invoke('delete_screenshot', { instanceId: inst.id, name: list[i].name }).catch((e) => toast(errText(e), 'bad'));
      close(); load();
    };
    document.addEventListener('keydown', key);
    document.getElementById('overlays').append(lb);
    show();
  };
  const load = async () => {
    list = await invoke('list_screenshots', { instanceId: inst.id }).catch(() => []);
    panel.querySelector('#sh-count').textContent = list.length;
    const el = panel.querySelector('#sh-list');
    if (!list.length) {
      el.innerHTML = `<div class="empty"><div class="glyph">${icon('camera', 28)}</div><h3>No screenshots yet</h3><p>Press F2 in-game and your shots appear here.</p></div>`;
      return;
    }
    el.innerHTML = `<div class="shots">${list.map((s, i) => `<div class="shot" data-i="${i}"><img src="${esc(fileSrc(s.path))}" loading="lazy" /><div class="cap">${esc(fmtDate(s.modified))}</div></div>`).join('')}</div>`;
    el.querySelectorAll('.shot').forEach((s) => (s.onclick = () => lightbox(+s.dataset.i)));
  };
  load();
  return () => closeLightbox?.(); // leaving the tab or page closes the viewer and its key handler
}

// ───────────────────────── other logs ─────────────────────────

function otherLogsTab(panel, getInst) {
  const inst = getInst();
  let files = [];
  let active = null;
  let text = '';
  let readToken = 0;
  panel.innerHTML = `
    <div class="panel-head"><h2>Other logs</h2><div class="spacer"></div>
      <div class="search" style="width:200px">${icon('search', 14)}<input class="input sm" id="ol-q" placeholder="Find" /></div>
      <button class="btn sm" id="ol-copy" disabled>${icon('copy', 14)} Copy</button>
      <button class="btn sm" id="ol-up" disabled>${icon('upload', 14)} Upload</button>
      <button class="btn sm icon ghost" id="ol-del" disabled title="Delete">${icon('trash', 14)}</button>
    </div>
    <div class="logs-layout"><div class="log-files" id="ol-files"></div><div class="console wrap color selectable" id="ol-view" style="height:calc(100vh - var(--titlebar) - 300px);min-height:380px"></div></div>`;
  const view = panel.querySelector('#ol-view');
  const q = panel.querySelector('#ol-q');
  const level = (l) => (/\/(ERROR|FATAL)\]|Exception|^\s+at /.test(l) ? 'ERROR' : /\/WARN\]/.test(l) ? 'WARN' : '');
  const drawText = () => {
    if (!active) { view.innerHTML = `<div class="console-empty">Pick a log on the left.</div>`; return; }
    const query = q.value.trim().toLowerCase();
    const lines = text.split('\n').filter((l) => !query || l.toLowerCase().includes(query)).slice(-8000);
    view.innerHTML = lines.map((l) => `<div class="ln ${level(l)}">${esc(l) || ' '}</div>`).join('');
  };
  const drawFiles = () => {
    const el = panel.querySelector('#ol-files');
    el.innerHTML = files.length ? files.map((f, i) => `<button data-f="${i}" class="${active === f ? 'on' : ''}"><div class="n">${f.folder === 'crash-reports' ? '<span class="crash">CRASH · </span>' : ''}${esc(f.name)}</div><div class="m">${timeAgo(f.modified)} · ${fmtBytes(f.size)}</div></button>`).join('') : '<div class="dim" style="padding:10px;font-size:12.5px">No log files yet.</div>';
    el.querySelectorAll('[data-f]').forEach((b) => (b.onclick = async () => {
      const mine = ++readToken; // ignore a slow read that finishes after a newer click
      active = files[+b.dataset.f];
      drawFiles();
      ['#ol-copy', '#ol-up', '#ol-del'].forEach((s) => (panel.querySelector(s).disabled = true));
      view.innerHTML = '<div class="loading-row"><div class="spinner"></div></div>';
      let got;
      try { got = await invoke('read_log', { instanceId: inst.id, folder: active.folder, name: active.name }); } catch (e) { got = errText(e); }
      if (mine !== readToken) return;
      text = got;
      ['#ol-copy', '#ol-up', '#ol-del'].forEach((s) => (panel.querySelector(s).disabled = false));
      drawText();
    }));
  };
  q.oninput = debounce(drawText, 150);
  panel.querySelector('#ol-copy').onclick = () => { navigator.clipboard.writeText(text); toast('Copied', 'good'); };
  panel.querySelector('#ol-up').onclick = () => uploadLog(text);
  panel.querySelector('#ol-del').onclick = async () => {
    if (!active || !(await confirmDialog(`Delete ${active.name}?`, 'This log file will be removed.', { ok: 'Delete', danger: true }))) return;
    await invoke('delete_log', { instanceId: inst.id, folder: active.folder, name: active.name }).catch((e) => toast(errText(e), 'bad'));
    active = null; load();
  };
  const load = async () => { files = await invoke('list_logs', { instanceId: inst.id }).catch(() => []); drawFiles(); drawText(); };
  load();
}

// ───────────────────────── settings ─────────────────────────

function settingsTab(panel, getInst) {
  const inst = getInst();
  const st = { ...inst };
  invoke('system_memory').then((total) => {
    const r = panel.querySelector('#is-mem');
    if (!r) return;
    r.max = Math.max(2048, Math.floor((total * 0.85) / 512) * 512);
    setRangeFill(r);
  });
  const memOverride = st.memoryMb != null;
  panel.innerHTML = `
    <div class="panel-head"><h2>Instance settings</h2><div class="spacer"></div><button class="btn primary" id="is-save">${icon('check', 16)} Save</button></div>
    <div class="fields two">
      <div class="field"><label>Name</label><input class="input" id="is-name" value="${esc(st.name)}" /></div>
      <div class="field"><label>Group</label><input class="input" id="is-group" value="${esc(st.group || '')}" placeholder="None" /></div>
    </div>
    <div class="setting-row"><div class="txt"><div class="t">Accent</div><div class="d">Colours this instance's artwork.</div></div><div class="ctl swatches" id="is-acc">${Object.entries(ACCENTS).map(([k, [a, b]]) => `<div class="swatch ${k === st.accent ? 'on' : ''}" data-a="${k}" style="background:${a}"></div>`).join('')}</div></div>
    <div class="setting-row"><div class="txt"><div class="t">Custom memory</div><div class="d">Override the global allocation (${(store.settings.memoryMb / 1024).toFixed(1)} GB) for this instance.</div></div>
      <div class="ctl"><input type="range" class="range" id="is-mem" min="1024" max="16384" step="512" value="${st.memoryMb || store.settings.memoryMb}" style="width:220px" ${memOverride ? '' : 'disabled'} /><span class="mem-readout" id="is-mem-v"></span><label class="switch"><input type="checkbox" id="is-mem-on" ${memOverride ? 'checked' : ''} /><span></span></label></div></div>
    <div class="setting-row"><div class="txt"><div class="t">Game window</div><div class="d">Starting size in pixels. Leave blank to use the global default.</div></div>
      <div class="ctl"><input class="input sm mono" id="is-w" style="width:90px" placeholder="Width" value="${st.windowWidth || ''}" /><span class="dim">×</span><input class="input sm mono" id="is-h" style="width:90px" placeholder="Height" value="${st.windowHeight || ''}" /></div></div>
    <div class="field" style="margin-top:16px"><label>Extra JVM arguments</label><input class="input mono" id="is-jvm" value="${esc(st.jvmArgs || '')}" placeholder="-XX:+UseZGC" /></div>
    <div class="field" style="margin-top:16px"><label>Java executable</label>
      <div class="row-flex"><input class="input mono" id="is-java" value="${esc(st.javaPath || '')}" placeholder="Automatic (recommended)" /><button class="btn" id="is-java-pick">Browse</button></div>
      <div class="hint">Leave empty and Orbit uses Mojang's matching Java runtime automatically.</div></div>
    <details class="advanced" ${st.preLaunch || st.wrapper || st.postExit || st.envVars ? 'open' : ''}>
      <summary>${icon('command', 15)} Custom commands &amp; environment</summary>
      <div class="fields" style="margin-top:14px">
        <div class="field"><label>Pre-launch command</label><input class="input mono" id="is-pre" value="${esc(st.preLaunch || '')}" placeholder="Runs before the game starts; a failure cancels the launch" /></div>
        <div class="field"><label>Wrapper command</label><input class="input mono" id="is-wrap" value="${esc(st.wrapper || '')}" placeholder="e.g. a profiler — Java is appended after it" /></div>
        <div class="field"><label>Post-exit command</label><input class="input mono" id="is-post" value="${esc(st.postExit || '')}" placeholder="Runs after the game closes" /></div>
        <div class="field"><label>Environment variables</label><textarea class="textarea mono" id="is-env" rows="3" placeholder="KEY=value (one per line)">${esc(st.envVars || '')}</textarea>
          <div class="hint">Commands run through <span class="mono">cmd</span> in the game folder and can use <span class="mono">%INST_NAME% %INST_ID% %INST_DIR% %INST_MC_DIR% %INST_JAVA%</span> — the same variables as Prism.</div></div>
      </div>
    </details>
    <div class="glass" style="margin-top:26px;padding:16px 18px;border-color:rgba(255,92,122,.2)">
      <div class="row-flex"><div style="flex:1"><div style="font-weight:600">Delete instance</div><div class="dim" style="font-size:12px">Removes all worlds, mods, screenshots and settings for this instance.</div></div><button class="btn danger" id="is-del">${icon('trash', 15)} Delete</button></div>
    </div>`;
  const mem = panel.querySelector('#is-mem');
  const memOn = panel.querySelector('#is-mem-on');
  const memV = panel.querySelector('#is-mem-v');
  const showMem = () => { memV.textContent = memOn.checked ? `${(mem.value / 1024).toFixed(1)} GB` : 'Global'; setRangeFill(mem); };
  mem.oninput = showMem;
  memOn.onchange = () => { mem.disabled = !memOn.checked; showMem(); };
  showMem();
  panel.querySelectorAll('#is-acc .swatch').forEach((s) => (s.onclick = () => { st.accent = s.dataset.a; panel.querySelectorAll('#is-acc .swatch').forEach((x) => x.classList.toggle('on', x === s)); }));
  panel.querySelector('#is-java-pick').onclick = async () => {
    const p = await invoke('pick_file', { title: 'Choose java.exe or javaw.exe', extensions: ['exe'] });
    if (p) panel.querySelector('#is-java').value = p;
  };
  panel.querySelector('#is-del').onclick = async () => { if (await deleteInstance(getInst())) go('library'); };
  panel.querySelector('#is-save').onclick = async () => {
    const num = (v) => (parseInt(v, 10) > 0 ? parseInt(v, 10) : null);
    try {
      await invoke('update_instance', {
        instance: {
          ...getInst(), // current version/loader/pack — this tab only edits the fields below
          name: panel.querySelector('#is-name').value,
          group: panel.querySelector('#is-group').value,
          accent: st.accent,
          memoryMb: memOn.checked ? +mem.value : null,
          jvmArgs: panel.querySelector('#is-jvm').value,
          javaPath: panel.querySelector('#is-java').value,
          windowWidth: num(panel.querySelector('#is-w').value),
          windowHeight: num(panel.querySelector('#is-h').value),
          preLaunch: panel.querySelector('#is-pre').value,
          wrapper: panel.querySelector('#is-wrap').value,
          postExit: panel.querySelector('#is-post').value,
          envVars: panel.querySelector('#is-env').value,
        },
      });
      await refreshInstances();
      toast('Settings saved', 'good');
    } catch (e) { toast(errText(e), 'bad'); }
  };
}
