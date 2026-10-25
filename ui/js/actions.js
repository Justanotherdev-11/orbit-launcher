// Cross-view actions: launching, accounts, creating/importing instances.
import { invoke, listen, openUrl } from './api.js';
import { launchSequence } from './fx.js';
import { store, refreshInstances, refreshAccounts, refreshRunning, mcVersions, go, activeAccount, saveSettings, pref } from './store.js';
import { icon, esc, h, modal, toast, errText, confirmDialog, LOADERS, GLYPHS, ACCENTS, avatarUrl, fmtDate, debounce, shortLoaderVersion } from './ui.js';

// ───────────────────────── launch ─────────────────────────

/** Launch an instance, optionally dropping straight into `{ server }` or `{ world }`. */
export async function launch(inst, { server = null, world = null } = {}) {
  if (!activeAccount()) {
    toast('Add an account first — Microsoft or offline.', 'info', { title: 'No account' });
    return accountsModal();
  }
  // Claim the instance before anything async, so a second click can't start a second launch.
  if (store.running.has(inst.id)) return;
  store.running.add(inst.id);
  store.starting.add(inst.id);
  if (pref('openLogOnLaunch')) go('instance', { id: inst.id, tab: 'log' });
  const seq = launchSequence(inst);
  let unlisten = () => {};
  try {
    unlisten = await listen('task', (t) => {
      // A failed task reports progress 1.0; don't show that as 100%.
      if (t.title === `Launching ${inst.name}` && t.state !== 'error') seq.progress(t.progress, t.detail);
    });
    store.logs.set(inst.id, [{ line: `── Launching ${inst.name} · Minecraft ${inst.mcVersion}${server ? ` → ${server}` : world ? ` → ${world}` : ''} ──`, level: 'SYS' }]);
    await invoke('launch_instance', { instanceId: inst.id, server, world });
    seq.success();
  } catch (e) {
    const msg = errText(e);
    seq.fail(msg.includes('already running') ? 'Already running' : msg.split('\n')[0]);
    if (msg.includes('NO_ACCOUNT')) accountsModal();
    else if (msg.includes('MSA_CLIENT_ID_MISSING')) toast('Microsoft sign-in needs a client ID — see Settings → Integrations.', 'bad');
    else if (!msg.includes('already running')) toast(msg, 'bad', { title: `Couldn't launch ${inst.name}` });
  } finally {
    unlisten();
    refreshRunning();
  }
}

export async function stop(inst) {
  try { await invoke('kill_instance', { instanceId: inst.id }); } catch (e) { toast(errText(e), 'bad'); }
}

export function playButton(inst, { small = false } = {}) {
  const starting = store.starting.has(inst.id);
  const running = store.running.has(inst.id) && !starting;
  const [cls, ic, label] = starting ? ['busy', null, 'STARTING'] : running ? ['stop', 'stop', 'STOP'] : ['', 'play', 'PLAY'];
  return `<button class="play-btn ${small ? 'sm' : ''} ${cls}" data-play="${esc(inst.id)}" ${starting ? 'title="Preparing the game…"' : ''}>
    ${ic ? icon(ic, small ? 16 : 20) : '<div class="spinner" style="width:16px;height:16px"></div>'}<span>${label}</span></button>`;
}

export function wirePlay(root) {
  root.querySelectorAll('[data-play]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const inst = store.instances.find((i) => i.id === b.dataset.play);
      if (!inst || store.starting.has(inst.id)) return;
      store.running.has(inst.id) ? stop(inst) : launch(inst);
    };
  });
}

// ───────────────────────── accounts ─────────────────────────

export function accountsModal() {
  const m = modal({ title: 'Accounts', body: '<div id="acc-body"></div>' });
  const body = m.el.querySelector('#acc-body');
  const render = () => {
    const accs = store.accounts;
    body.innerHTML = `
      <div class="list" style="gap:8px">
        ${accs.length ? accs.map((a) => `
          <div class="acct ${a.active ? 'on' : ''}">
            <img src="${avatarUrl(a)}" alt="" />
            <div style="flex:1;min-width:0">
              <div style="font-weight:600">${esc(a.name)}</div>
              <div class="dim mono" style="font-size:11px">${a.kind === 'msa' ? 'Microsoft' : 'Offline'}${a.active ? ' · active' : ''}</div>
            </div>
            ${a.active ? `<span class="chip accent">${icon('check', 12, 2.5)} Active</span>` : `<button class="btn sm" data-use="${esc(a.uuid)}">Use</button>`}
            <button class="btn icon sm ghost" data-rm="${esc(a.uuid)}" title="Remove">${icon('trash', 15)}</button>
          </div>`).join('') : `<div class="empty" style="padding:24px"><div class="glyph">${icon('user', 26)}</div><h3>No accounts yet</h3><p>Sign in with Microsoft to play online, or add an offline profile for singleplayer.</p></div>`}
      </div>
      <div class="row-flex" style="margin-top:16px">
        <button class="btn primary" id="add-ms" style="flex:1">${icon('key', 16)} Microsoft account</button>
        <button class="btn" id="add-off" style="flex:1">${icon('user', 16)} Offline account</button>
      </div>`;
    body.querySelectorAll('[data-use]').forEach((b) => (b.onclick = async () => { store.accounts = await invoke('set_active_account', { uuid: b.dataset.use }); refreshAccounts(); render(); }));
    body.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog('Remove account?', 'You can add it again any time.', { ok: 'Remove', danger: true }))) return;
      store.accounts = await invoke('remove_account', { uuid: b.dataset.rm }); refreshAccounts(); render();
    }));
    body.querySelector('#add-ms').onclick = () => { m.close(); microsoftLogin(); };
    body.querySelector('#add-off').onclick = () => offlineForm();
  };
  const offlineForm = () => {
    body.innerHTML = `
      <div class="field"><label>Player name</label><input class="input" id="off-name" maxlength="16" placeholder="Steve" /><div class="hint">3–16 letters, numbers or underscores. Offline accounts work in singleplayer and on offline-mode servers.</div></div>
      <div class="row-flex" style="margin-top:16px;justify-content:flex-end"><button class="btn ghost" id="off-back">Back</button><button class="btn primary" id="off-add">Add account</button></div>`;
    const input = body.querySelector('#off-name');
    const add = async () => {
      try { store.accounts = await invoke('add_offline_account', { name: input.value }); await refreshAccounts(); toast(`Playing as ${input.value.trim()}`, 'good'); render(); }
      catch (e) { toast(errText(e), 'bad'); }
    };
    body.querySelector('#off-add').onclick = add;
    body.querySelector('#off-back').onclick = render;
    input.onkeydown = (e) => e.key === 'Enter' && add();
    setTimeout(() => input.focus(), 30);
  };
  render();
}

export async function microsoftLogin() {
  let code;
  try {
    code = await invoke('msa_start');
  } catch (e) {
    const msg = errText(e);
    if (msg.includes('MSA_CLIENT_ID_MISSING')) return clientIdHelp();
    return toast(msg, 'bad', { title: 'Microsoft sign-in' });
  }
  let finished = false;
  const m = modal({
    title: 'Sign in with Microsoft',
    body: `
      <p class="muted" style="margin:0 0 14px">Open the Microsoft link page and enter this code:</p>
      <div class="code-box">${esc(code.userCode)}</div>
      <div class="row-flex" style="margin-top:14px">
        <button class="btn primary" id="ms-open" style="flex:1">${icon('external', 16)} Open microsoft.com/link</button>
        <button class="btn" id="ms-copy">${icon('copy', 16)} Copy code</button>
      </div>
      <div class="row-flex dim" style="margin-top:18px;font-size:12.5px"><div class="spinner"></div> Waiting for you to finish signing in…</div>`,
    onClose: () => { if (!finished) invoke('msa_cancel', { deviceCode: code.deviceCode }); },
  });
  m.el.querySelector('#ms-open').onclick = () => openUrl(code.verificationUri);
  m.el.querySelector('#ms-copy').onclick = () => { navigator.clipboard.writeText(code.userCode); toast('Code copied', 'good'); };
  try {
    store.accounts = await invoke('msa_finish', { deviceCode: code.deviceCode, interval: code.interval });
    finished = true;
    m.close();
    await refreshAccounts();
    toast(`Signed in as ${activeAccount()?.name}`, 'good', { title: 'Welcome back' });
  } catch (e) {
    finished = true;
    const msg = errText(e);
    m.close();
    if (!msg.includes('cancelled')) toast(msg, 'bad', { title: 'Sign-in failed' });
  }
}

function clientIdHelp() {
  const m = modal({
    title: 'Set up Microsoft sign-in',
    body: `
      <div class="callout info">${icon('info', 18)}<div>
        Every third-party launcher signs in through its own Azure app. Orbit needs a <b>client ID</b> from one that Mojang has approved for Minecraft.
        <ol style="margin:8px 0 0;padding-left:18px">
          <li>Register an app at <a href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade">portal.azure.com</a> (personal Microsoft accounts, “Allow public client flows” on).</li>
          <li>Request Minecraft API access at <a href="https://aka.ms/mce-reviewappid">aka.ms/mce-reviewappid</a>.</li>
          <li>Paste the Application (client) ID below.</li>
        </ol>
      </div></div>
      <div class="field" style="margin-top:16px"><label>Azure client ID</label><input class="input mono" id="cid" placeholder="00000000-0000-0000-0000-000000000000" value="${esc(store.settings.msClientId || '')}" /></div>
      <p class="hint" style="margin-top:12px">Until then, an offline account works for singleplayer and offline-mode servers.</p>`,
    foot: `<button class="btn ghost" data-close>Later</button><button class="btn primary" id="cid-save">Save &amp; sign in</button>`,
  });
  m.el.querySelector('#cid-save').onclick = async () => {
    await saveSettings({ msClientId: m.el.querySelector('#cid').value.trim() });
    m.close();
    microsoftLogin();
  };
}

// ───────────────────────── create instance ─────────────────────────

export async function createInstanceModal({ group = '' } = {}) {
  const groups = [...new Set(store.instances.map((i) => i.group).filter(Boolean))];
  const state = { mc: null, loader: 'vanilla', loaderVersion: '', filter: store.settings.showSnapshots ? 'snapshot' : 'release', accent: Object.keys(ACCENTS)[Math.floor(Math.random() * 6)], nameTouched: false };
  const m = modal({
    title: 'New instance',
    wide: true,
    body: `
      <div class="fields two" style="align-items:start">
        <div class="fields">
          <div class="field"><label>Name</label><input class="input" id="ci-name" placeholder="My world" /></div>
          <div class="field"><label>Minecraft version</label>
            <div class="row-flex">
              <div class="search" style="flex:1">${icon('search', 15)}<input class="input sm" id="ci-vsearch" placeholder="Search versions" /></div>
              <div class="seg" id="ci-vfilter"><button data-f="release" class="${state.filter === 'release' ? 'on' : ''}">Releases</button><button data-f="snapshot" class="${state.filter === 'snapshot' ? 'on' : ''}">Snapshots</button><button data-f="old">Old</button></div>
            </div>
            <div class="vlist" id="ci-vlist"><div class="loading-row"><div class="spinner"></div></div></div>
          </div>
        </div>
        <div class="fields">
          <div class="field"><label>Mod loader</label>
            <div class="loader-tiles" id="ci-loaders">
              ${Object.entries(LOADERS).map(([k, v]) => `<button class="loader-tile ${k === 'vanilla' ? 'on' : ''}" data-l="${k}"><span style="width:26px;height:26px;display:block">${GLYPHS[k]}</span>${v}</button>`).join('')}
            </div>
          </div>
          <div class="field" id="ci-lv-field" style="display:none"><label>Loader version</label><select class="select" id="ci-lv"></select></div>
          <div class="field"><label>Group <span class="dim">(optional)</span></label><input class="input" id="ci-group" list="ci-groups" value="${esc(group)}" placeholder="e.g. Survival, Modded" /><datalist id="ci-groups">${groups.map((g) => `<option value="${esc(g)}">`).join('')}</datalist></div>
          <div class="field"><label>Accent</label><div class="swatches" id="ci-acc">${Object.entries(ACCENTS).map(([k, [a, b]]) => `<div class="swatch ${k === state.accent ? 'on' : ''}" data-a="${k}" style="background:${a}"></div>`).join('')}</div></div>
        </div>
      </div>`,
    foot: `<button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="ci-create" disabled>${icon('plus', 16)} Create instance</button>`,
  });
  const el = m.el;
  const nameInput = el.querySelector('#ci-name');
  const createBtn = el.querySelector('#ci-create');
  nameInput.oninput = () => (state.nameTouched = !!nameInput.value);
  const autoName = () => {
    if (state.nameTouched || !state.mc) return;
    nameInput.value = state.loader === 'vanilla' ? `Minecraft ${state.mc}` : `${LOADERS[state.loader]} ${state.mc}`;
  };

  let versions = [];
  try { versions = await mcVersions(); } catch (e) { el.querySelector('#ci-vlist').innerHTML = `<div class="loading-row">${esc(errText(e))}</div>`; }
  const renderVersions = () => {
    const q = el.querySelector('#ci-vsearch').value.trim().toLowerCase();
    const list = versions.filter((v) => (state.filter === 'release' ? v.type === 'release' : state.filter === 'snapshot' ? v.type === 'snapshot' : v.type.startsWith('old'))).filter((v) => !q || v.id.toLowerCase().includes(q));
    const box = el.querySelector('#ci-vlist');
    box.innerHTML = list.slice(0, 400).map((v) => `<button data-v="${esc(v.id)}" class="${v.id === state.mc ? 'on' : ''}"><span>${esc(v.id)}</span><span class="dt">${fmtDate(v.releaseTime)}</span></button>`).join('') || '<div class="loading-row">No matches</div>';
    box.querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => { state.mc = b.dataset.v; renderVersions(); autoName(); loadLoaderVersions(); }));
  };
  if (versions.length) {
    state.mc = versions.find((v) => v.type === 'release')?.id;
    renderVersions();
    autoName();
    createBtn.disabled = false;
  }
  el.querySelector('#ci-vsearch').oninput = debounce(renderVersions, 120);
  el.querySelectorAll('#ci-vfilter button').forEach((b) => (b.onclick = () => {
    el.querySelectorAll('#ci-vfilter button').forEach((x) => x.classList.toggle('on', x === b));
    state.filter = b.dataset.f; renderVersions();
  }));
  el.querySelectorAll('#ci-acc .swatch').forEach((s) => (s.onclick = () => { state.accent = s.dataset.a; el.querySelectorAll('#ci-acc .swatch').forEach((x) => x.classList.toggle('on', x === s)); }));

  let lvToken = 0;
  const loadLoaderVersions = async () => {
    const field = el.querySelector('#ci-lv-field');
    const sel = el.querySelector('#ci-lv');
    if (state.loader === 'vanilla' || !state.mc) { field.style.display = 'none'; createBtn.disabled = !state.mc; return; }
    field.style.display = '';
    sel.innerHTML = '<option>Loading…</option>';
    sel.disabled = true;
    createBtn.disabled = true;
    const token = ++lvToken;
    try {
      const list = await invoke('get_loader_versions', { loader: state.loader, mc: state.mc });
      if (token !== lvToken) return;
      if (!list.length) { sel.innerHTML = `<option>${LOADERS[state.loader]} doesn't support ${esc(state.mc)}</option>`; return; }
      const best = list.find((v) => v.stable) || list[0];
      sel.innerHTML = list.slice(0, 150).map((v) => `<option value="${esc(v.id)}" ${v.id === best.id ? 'selected' : ''}>${esc(v.id)}${v.stable && v.id === best.id ? '  (recommended)' : ''}</option>`).join('');
      sel.disabled = false;
      state.loaderVersion = best.id;
      createBtn.disabled = false;
    } catch (e) {
      if (token === lvToken) sel.innerHTML = `<option>${esc(errText(e))}</option>`;
    }
  };
  el.querySelector('#ci-lv').onchange = (e) => (state.loaderVersion = e.target.value);
  el.querySelectorAll('#ci-loaders .loader-tile').forEach((b) => (b.onclick = () => {
    state.loader = b.dataset.l;
    el.querySelectorAll('#ci-loaders .loader-tile').forEach((x) => x.classList.toggle('on', x === b));
    autoName(); loadLoaderVersions();
  }));

  createBtn.onclick = async () => {
    createBtn.disabled = true;
    try {
      const inst = await invoke('create_instance', {
        name: nameInput.value || `Minecraft ${state.mc}`,
        mcVersion: state.mc,
        loader: state.loader,
        loaderVersion: state.loader === 'vanilla' ? null : state.loaderVersion,
        group: el.querySelector('#ci-group').value,
        accent: state.accent,
      });
      m.close();
      await refreshInstances();
      toast(`${inst.name} is ready to play`, 'good', { title: 'Instance created', actions: pref('openAfterCreate') ? [] : [{ label: 'Open', run: () => go('instance', { id: inst.id }) }] });
      if (pref('openAfterCreate')) go('instance', { id: inst.id });
    } catch (e) {
      createBtn.disabled = false;
      toast(errText(e), 'bad');
    }
  };
}

// ───────────────────────── import ─────────────────────────

const LAUNCHER_COLORS = {
  'Prism Launcher': ['#7ee08a', '#2fa36b'], PolyMC: ['#b18cff', '#6b4dff'], MultiMC: ['#ffd166', '#c78a1a'],
  'Prism / MultiMC': ['#7ee08a', '#2fa36b'], CurseForge: ['#ff8a5c', '#f16436'], 'Modrinth App': ['#3ef0a1', '#1bd96a'],
  ATLauncher: ['#5cc8ff', '#2b6bff'], GDLauncher: ['#ff6b9a', '#a35cff'], 'Minecraft Launcher': ['#b8d982', '#5d9c3a'], Folder: ['#9aa3ba', '#5e6782'],
};

/** Render a list of instances found in other launchers, with per-row and per-launcher import. */
async function renderExternal(container, list, { emptyText } = {}) {
  if (!list.length) {
    container.innerHTML = `<div class="empty"><div class="glyph">${icon('search', 28)}</div><h3>Nothing to import here</h3><p>${emptyText || 'No Minecraft instances were found.'}</p></div>`;
    return;
  }
  const releases = (await mcVersions().catch(() => [])).filter((v) => v.type === 'release').map((v) => v.id);
  const groups = [...new Set(list.map((e) => e.launcher))];
  container.innerHTML = groups.map((g) => {
    const items = list.map((e, i) => [e, i]).filter(([e]) => e.launcher === g);
    const [c1, c2] = LAUNCHER_COLORS[g] || LAUNCHER_COLORS.Folder;
    return `<div class="ext-group">
      <div class="group-head"><span class="launcher-dot" style="background:${c1}"></span><span class="eyebrow" style="color:var(--text)">${esc(g)}</span><span class="dim mono" style="font-size:11px">${items.length}</span><div class="line"></div>${items.length > 1 ? `<button class="btn sm ghost" data-all="${esc(g)}">${icon('import', 13)} Import all</button>` : ''}</div>
      <div class="list">${items.map(([e, i]) => `
        <div class="item" data-row="${i}">
          <div class="ic" style="background:${c2};color:${c1};font-family:var(--display);font-weight:700;font-size:16px">${esc((e.name || '?').trim().charAt(0).toUpperCase())}</div>
          <div class="main">
            <div class="t">${esc(e.name)}</div>
            <div class="s">${e.mcVersion ? `Minecraft ${esc(e.mcVersion)}` : '<span style="color:var(--warn)">Minecraft version unknown</span>'} · ${esc(LOADERS[e.loader] || e.loader)}${e.loaderVersion ? ` ${esc(shortLoaderVersion(e.loader, e.loaderVersion))}` : ''}${e.mods ? ` · ${e.mods} mods` : ''}${e.worlds ? ` · ${e.worlds} world${e.worlds === 1 ? '' : 's'}` : ''}${e.guessed ? ' · detected from mods' : ''}${e.shared ? ' · mods, worlds &amp; settings only' : ''}</div>
          </div>
          ${!e.mcVersion || e.guessed ? `<select class="select sm" data-mc="${i}" style="width:130px"><option value="">Version…</option>${releases.map((v) => `<option ${v === e.mcVersion ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>` : ''}
          ${e.guessed ? `<select class="select sm" data-ld="${i}" style="width:120px">${Object.entries(LOADERS).map(([k, l]) => `<option value="${k}" ${k === e.loader ? 'selected' : ''}>${l}</option>`).join('')}</select>` : ''}
          <div class="actions"><button class="btn sm primary" data-imp="${i}" style="opacity:1">${icon('import', 14)} Import</button></div>
        </div>`).join('')}</div>
    </div>`;
  }).join('');
  container.querySelectorAll('[data-mc]').forEach((s) => (s.onchange = () => (list[+s.dataset.mc].mcVersion = s.value)));
  container.querySelectorAll('[data-ld]').forEach((s) => (s.onchange = () => { list[+s.dataset.ld].loader = s.value; list[+s.dataset.ld].loaderVersion = null; }));
  const importOne = async (i) => {
    const b = container.querySelector(`[data-imp="${i}"]`);
    const e = list[i];
    if (!e.mcVersion) { toast(`Pick a Minecraft version for ${e.name} first`, 'info'); container.querySelector(`[data-mc="${i}"]`)?.focus(); return false; }
    b.disabled = true;
    b.innerHTML = '<div class="spinner" style="width:14px;height:14px"></div> Copying';
    try {
      const inst = await invoke('import_external_instance', { instance: e });
      await refreshInstances();
      b.outerHTML = `<span class="chip good">${icon('check', 12, 2.5)} Imported</span>`;
      toast(`${inst.name} is in your library`, 'good', { title: `Imported from ${e.launcher}`, actions: [{ label: 'Open', run: () => go('instance', { id: inst.id }) }] });
      return true;
    } catch (err) { b.disabled = false; b.innerHTML = 'Retry'; toast(errText(err), 'bad'); return false; }
  };
  container.querySelectorAll('[data-imp]').forEach((b) => (b.onclick = () => importOne(+b.dataset.imp)));
  container.querySelectorAll('[data-all]').forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    for (const [e, i] of list.map((e, i) => [e, i]).filter(([e]) => e.launcher === b.dataset.all)) {
      if (container.querySelector(`[data-imp="${i}"]`)) await importOne(i);
    }
  }));
}

export async function importModal(start = 'launchers') {
  const m = modal({
    title: 'Import',
    wide: true,
    body: `
      <div class="tabs" id="im-tabs">
        <button class="tab" data-t="launchers">${icon('library', 16)} Other launchers</button>
        <button class="tab" data-t="folder">${icon('folder', 16)} Choose a folder</button>
        <button class="tab" data-t="file">${icon('modpack', 16)} Modpack or backup file</button>
      </div>
      <div id="im-body"></div>`,
  });
  const body = m.el.querySelector('#im-body');
  let showToken = 0; // results from a tab you've since left are dropped
  const show = async (t) => {
    const mine = ++showToken;
    m.el.querySelectorAll('#im-tabs .tab').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
    if (t === 'folder') {
      body.innerHTML = `<div class="empty"><div class="glyph">${icon('folder', 28)}</div><h3>Import from any folder</h3><p>Point Orbit at another launcher's folder, its instances folder, a single instance, or any <span class="mono">.minecraft</span>. It recognises the launcher — or works out the version and loader from the mods inside.</p><div class="row-flex"><button class="btn primary" id="im-folder">${icon('folder', 16)} Choose folder</button></div></div>`;
      body.querySelector('#im-folder').onclick = async () => {
        const path = await invoke('pick_folder', { title: 'Choose a launcher or instance folder' });
        if (!path || mine !== showToken) return;
        body.innerHTML = '<div class="loading-row"><div class="spinner"></div> Looking inside…</div>';
        try {
          const list = await invoke('scan_import_folder', { path });
          if (mine !== showToken) return;
          body.innerHTML = `<div class="row-flex" style="margin-bottom:12px"><span class="dim mono" style="font-size:11.5px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(path)}</span><button class="btn sm ghost" id="im-again">${icon('folder', 13)} Another folder</button></div><div id="im-found"></div>`;
          body.querySelector('#im-again').onclick = () => show('folder');
          renderExternal(body.querySelector('#im-found'), list, { emptyText: "That folder doesn't look like it holds Minecraft instances. Try the launcher's main folder or an instance inside it." });
        } catch (e) { body.innerHTML = `<div class="empty"><h3>Couldn't read that folder</h3><p>${esc(errText(e))}</p></div>`; }
      };
      return;
    }
    if (t === 'file') {
      body.innerHTML = `<div class="empty"><div class="glyph">${icon('modpack', 28)}</div><h3>Import a modpack or backup</h3><p>Pick a Modrinth <span class="mono">.mrpack</span>, a CurseForge modpack <span class="mono">.zip</span> or an Orbit backup. You can also drag one onto the window.</p><div class="row-flex"><button class="btn primary" id="im-pick">${icon('import', 16)} Choose file</button></div></div>`;
      body.querySelector('#im-pick').onclick = async () => {
        const path = await invoke('pick_file', { title: 'Choose a modpack', extensions: ['mrpack', 'zip'] });
        if (!path) return;
        m.close();
        importPackFile(path);
      };
      return;
    }
    body.innerHTML = '<div class="loading-row"><div class="spinner"></div> Looking for other launchers…</div>';
    const list = await invoke('list_external_instances');
    if (mine !== showToken) return;
    body.innerHTML = `<p class="muted" style="margin:0 0 4px;font-size:13px">Found in Prism, PolyMC, MultiMC, CurseForge, Modrinth App, ATLauncher, GDLauncher and the Minecraft Launcher. Everything is copied — the other launcher is left untouched.</p><div id="im-found"></div>`;
    renderExternal(body.querySelector('#im-found'), list, { emptyText: 'No other launchers were found in their usual places. If yours lives somewhere else (a portable MultiMC, say), use “Choose a folder”.' });
  };
  m.el.querySelectorAll('#im-tabs .tab').forEach((b) => (b.onclick = () => show(b.dataset.t)));
  show(start);
}

export async function importPackFile(path) {
  try {
    const r = await invoke('import_modpack_file', { path });
    await refreshInstances();
    packDone(r);
  } catch (e) { toast(errText(e), 'bad', { title: 'Import failed' }); }
}

export function packDone(r) {
  if (r.blocked?.length) blockedModal(r);
  else toast(`${r.instance.name} is installed`, 'good', { title: 'Modpack ready', actions: [{ label: 'Open', run: () => go('instance', { id: r.instance.id }) }] });
}

function blockedModal(r) {
  const m = modal({
    title: 'A few files need a manual download',
    body: `<p class="muted" style="margin:0 0 14px;line-height:1.6">These authors don't allow other launchers to download their files. Grab each one from CurseForge and drop it into the instance's mods folder.</p>
      <div class="list">${r.blocked.map((b, i) => `<div class="item"><div class="ic">${icon('cube', 18)}</div><div class="main"><div class="t">${esc(b.name)}</div></div>${b.url ? `<button class="btn sm" data-u="${i}">${icon('external', 14)} Download</button>` : ''}</div>`).join('')}</div>`,
    foot: `<button class="btn" id="bm-folder">${icon('folder', 16)} Open mods folder</button><button class="btn primary" data-close>Done</button>`,
  });
  m.el.querySelectorAll('[data-u]').forEach((b) => (b.onclick = () => openUrl(r.blocked[+b.dataset.u].url)));
  m.el.querySelector('#bm-folder').onclick = () => invoke('open_instance_folder', { id: r.instance.id, sub: 'mods' });
}

export async function deleteInstance(inst) {
  if (!(await confirmDialog(`Delete ${inst.name}?`, 'This permanently removes the instance with all its worlds, mods and screenshots.', { ok: 'Delete instance', danger: true }))) return false;
  try {
    await invoke('delete_instance', { id: inst.id });
    await refreshInstances();
    toast(`${inst.name} deleted`, 'info');
    return true;
  } catch (e) { toast(errText(e), 'bad'); return false; }
}

export async function duplicateInstance(inst) {
  try {
    const copy = await invoke('duplicate_instance', { id: inst.id });
    await refreshInstances();
    toast(`Created ${copy.name}`, 'good');
  } catch (e) { toast(errText(e), 'bad'); }
}

export async function changeIcon(inst) {
  const path = await invoke('pick_file', { title: 'Choose an icon', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] });
  if (!path) return;
  try { await invoke('set_instance_icon', { id: inst.id, path }); await refreshInstances(); } catch (e) { toast(errText(e), 'bad'); }
}

export async function resetIcon(inst) {
  try { await invoke('set_instance_icon', { id: inst.id, path: null }); await refreshInstances(); } catch (e) { toast(errText(e), 'bad'); }
}

export function exportModal(inst) {
  const m = modal({
    title: `Export ${inst.name}`,
    body: `
      <div class="export-options">
        <button class="glass glass-hover export-opt" data-f="zip">
          <div class="q-icon">${icon('archive', 20)}</div>
          <div><div class="t">Orbit backup <span class="chip mono">.zip</span></div><div class="d">Everything — worlds, mods, configs, notes and settings. Re-import it on any PC.</div></div>
        </button>
        <button class="glass glass-hover export-opt" data-f="mrpack">
          <div class="q-icon">${icon('modpack', 20)}</div>
          <div><div class="t">Modrinth modpack <span class="chip mono">.mrpack</span></div><div class="d">Shareable pack: Modrinth mods are linked, everything else plus configs is bundled. Worlds aren't included.</div></div>
        </button>
      </div>`,
  });
  m.el.querySelectorAll('[data-f]').forEach((b) => (b.onclick = async () => {
    const format = b.dataset.f;
    const ext = format === 'mrpack' ? 'mrpack' : 'zip';
    const path = await invoke('pick_save', { title: 'Save export', defaultName: `${inst.name}.${ext}`, extension: ext });
    if (!path) return;
    m.close();
    try {
      await invoke('export_instance', { instanceId: inst.id, format, path });
      toast(path, 'good', { title: 'Export saved' });
    } catch (e) { toast(errText(e), 'bad', { title: 'Export failed' }); }
  }));
}

export function instanceMenuItems(inst, { onDeleted } = {}) {
  return [
    { label: store.running.has(inst.id) ? 'Stop' : 'Play', icon: store.running.has(inst.id) ? 'stop' : 'play', run: () => (store.running.has(inst.id) ? stop(inst) : launch(inst)) },
    { label: 'Open folder', icon: 'folder', run: () => invoke('open_instance_folder', { id: inst.id }) },
    { label: 'Change icon', icon: 'image', run: () => changeIcon(inst) },
    ...(inst.icon ? [{ label: 'Reset icon', icon: 'refresh', run: () => resetIcon(inst) }] : []),
    { label: 'Duplicate', icon: 'dupe', run: () => duplicateInstance(inst) },
    { label: 'Export…', icon: 'export', run: () => exportModal(inst) },
    '-',
    { label: 'Delete', icon: 'trash', danger: true, run: async () => { if (await deleteInstance(inst)) onDeleted?.(); } },
  ];
}
