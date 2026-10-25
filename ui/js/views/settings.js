import { invoke } from '../api.js';
import { store, on, saveSettings } from '../store.js';
import { icon, esc, avatarUrl, toast, debounce, setRangeFill, confirmDialog } from '../ui.js';
import { accountsModal, microsoftLogin, importModal } from '../actions.js';
import { SECTIONS as CUSTOMIZE, sectionsHtml as customizeHtml, mountCustomize } from '../customize.js';

const BASE = [
  ['accounts', 'user', 'Accounts'],
  ['game', 'window', 'Game'],
  ['java', 'java', 'Java'],
  ['integrations', 'key', 'Integrations'],
];
const TAIL = [
  ['sharing', 'export', 'Sharing'],
  ['launcher', 'settings', 'Launcher'],
];
const SECTIONS = [...BASE, ...CUSTOMIZE.map((c) => [c.id, c.icon, c.title]), ...TAIL];

const JVM_PRESETS = [
  ['', 'Custom'],
  ['-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 -XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1', "Aikar's flags (smooth, popular)"],
  ['-XX:+UnlockExperimentalVMOptions -XX:+UseZGC -XX:+ZGenerational', 'ZGC (big modpacks, Java 21+)'],
  ['-XX:+UseSerialGC -XX:TieredStopAtLevel=1', 'Low-end PC'],
];

function navHtml() {
  const btn = ([id, ic, l], i) => `<button data-sec="${id}" class="${i === 0 ? 'on' : ''}">${icon(ic, 17)}<span>${l}</span></button>`;
  return BASE.map(btn).join('')
    + '<div class="label-row eyebrow">Customize</div>' + CUSTOMIZE.map((c) => btn([c.id, c.icon, c.title], 1)).join('')
    + '<div class="label-row eyebrow">Orbit</div>' + TAIL.map((t) => btn(t, 1)).join('');
}

export function render(root) {
  const s = store.settings;
  root.innerHTML = `<div class="page">
    <div class="page-head"><div><div class="sub">PREFERENCES</div><h1>Settings</h1></div><div class="spacer"></div><span class="dim mono" id="saved" style="font-size:11px"></span></div>
    <div class="settings-layout">
      <nav class="glass subnav" style="top:0;max-height:calc(100vh - var(--titlebar) - 40px);overflow:auto">${navHtml()}</nav>
      <div>
        <section class="glass settings-section" id="sec-accounts">
          <h3>${icon('user', 18)} Accounts</h3>
          <div id="acc-list" class="list" style="gap:8px;margin:14px 0"></div>
          <div class="row-flex" style="margin-bottom:18px"><button class="btn primary" id="acc-ms">${icon('key', 15)} Add Microsoft account</button><button class="btn" id="acc-manage">${icon('user', 15)} Manage accounts</button></div>
        </section>

        <section class="glass settings-section" id="sec-game">
          <h3>${icon('window', 18)} Game</h3>
          <div class="setting-row"><div class="txt"><div class="t">Memory</div><div class="d">How much RAM Minecraft may use. 4–6 GB suits most modpacks; vanilla is happy with 2–3 GB.</div></div>
            <div class="ctl"><input type="range" class="range" id="mem" min="1024" max="16384" step="512" value="${s.memoryMb}" style="width:260px" /><span class="mem-readout" id="mem-v"></span></div></div>
          <div class="setting-row"><div class="txt"><div class="t">Window size</div><div class="d">Default starting resolution. Leave blank for Minecraft's default.</div></div>
            <div class="ctl"><input class="input sm mono" id="gw" style="width:90px" placeholder="Width" value="${s.gameWidth || ''}" /><span class="dim">×</span><input class="input sm mono" id="gh" style="width:90px" placeholder="Height" value="${s.gameHeight || ''}" /></div></div>
          <div class="setting-row"><div class="txt"><div class="t">Start in fullscreen</div></div><div class="ctl"><label class="switch"><input type="checkbox" id="fs" ${s.fullscreen ? 'checked' : ''} /><span></span></label></div></div>
          <div class="setting-row"><div class="txt"><div class="t">Hide launcher while playing</div><div class="d">Orbit tucks away when the game starts and returns when it closes.</div></div><div class="ctl"><label class="switch"><input type="checkbox" id="hide" ${s.hideOnLaunch ? 'checked' : ''} /><span></span></label></div></div>
        </section>

        <section class="glass settings-section" id="sec-java">
          <h3>${icon('java', 18)} Java</h3>
          <div class="callout info" style="margin:14px 0">${icon('info', 18)}<div>Orbit downloads the exact Java runtime Mojang ships for each Minecraft version, so you don't need to install Java yourself.</div></div>
          <div class="eyebrow" style="margin:6px 0 8px">Installed runtimes</div>
          <div id="java-list" class="list"></div>
          <div class="field" style="margin-top:18px"><label>Global Java override</label><div class="row-flex"><input class="input mono" id="java" value="${esc(s.javaPath)}" placeholder="Automatic (recommended)" /><button class="btn" id="java-pick">Browse</button></div></div>
          <div class="field" style="margin:16px 0 18px"><label>Extra JVM arguments</label>
            <div class="row-flex"><select class="select" id="jvm-preset" style="width:250px">${JVM_PRESETS.map(([v, l]) => `<option value="${esc(v)}" ${v && v === s.jvmArgs ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select><input class="input mono" id="jvm" value="${esc(s.jvmArgs)}" placeholder="Applied to every instance" /></div>
            <div class="hint">Presets are well-known garbage-collector tunings. Orbit already applies sensible defaults, so leave this empty if unsure.</div></div>
        </section>

        <section class="glass settings-section" id="sec-integrations">
          <h3>${icon('key', 18)} Integrations</h3>
          <div class="field" style="margin-top:14px"><label>CurseForge API key</label>
            <div class="row-flex"><input class="input mono" id="cf" type="password" value="${esc(s.curseforgeKey)}" placeholder="Paste your key" /><button class="btn" id="cf-show" title="Show or hide the key">${icon('search', 15)}</button><button class="btn primary" id="cf-test">Test</button></div>
            <div class="hint" id="cf-result" style="min-height:18px"></div>
            <div class="hint">Needed to browse CurseForge. Get one free at <a href="https://console.curseforge.com/">console.curseforge.com</a>. Modrinth needs no key.</div></div>
          <div class="field" style="margin:18px 0"><label>Microsoft (Azure) client ID</label><input class="input mono" id="cid" value="${esc(s.msClientId)}" placeholder="00000000-0000-0000-0000-000000000000" />
            <div class="hint">Microsoft sign-in runs through an Azure app that Mojang has approved for Minecraft. Register one at <a href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade">portal.azure.com</a> (personal accounts, public client flows on), request access at <a href="https://aka.ms/mce-reviewappid">aka.ms/mce-reviewappid</a>, then paste its client ID here.</div></div>
        </section>

        ${customizeHtml()}

        <section class="glass settings-section" id="sec-sharing">
          <h3>${icon('export', 18)} Sharing</h3>
          <div class="callout info" style="margin:14px 0">${icon('info', 18)}<div>Orbit is a single app with nothing to install. To give it to a friend, zip the folder that holds <b>Orbit Launcher.exe</b> and send it — it works on any Windows 10 or 11 PC. Your Microsoft sign-in is never included.</div></div>
          <div class="setting-row"><div class="txt"><div class="t">Portable mode <span id="pm-chip"></span></div><div class="d" id="pm-desc">Keep instances and settings in an <span class="mono">OrbitData</span> folder next to the launcher, so they travel with it when you copy or share the folder.</div></div><div class="ctl" id="pm-ctl"></div></div>
          <div class="setting-row"><div class="txt"><div class="t">Pass your keys along</div><div class="d">Saves <span class="mono">orbit-defaults.json</span> next to the launcher so CurseForge and Microsoft sign-in work for whoever you send it to. Anyone with the folder can use these keys.</div>
              <div class="row-flex" style="margin-top:10px;gap:18px">
                <label class="row-flex hint"><span class="switch"><input type="checkbox" id="sd-cf" /><span></span></span> CurseForge API key</label>
                <label class="row-flex hint"><span class="switch"><input type="checkbox" id="sd-ms" /><span></span></span> Microsoft client ID</label>
              </div></div>
            <div class="ctl"><button class="btn sm" id="sd-save">${icon('check', 14)} Save</button></div></div>
          <div class="setting-row"><div class="txt"><div class="t">Launcher folder</div><div class="d mono" id="exe-dir"></div></div><div class="ctl"><button class="btn sm" id="exe-open">${icon('folder', 14)} Open</button></div></div>
        </section>

        <section class="glass settings-section" id="sec-launcher">
          <h3>${icon('settings', 18)} Launcher</h3>
          <div class="setting-row"><div class="txt"><div class="t">Data folder</div><div class="d mono" id="data-dir"></div></div><div class="ctl"><button class="btn sm" id="data-open">${icon('folder', 14)} Open</button></div></div>
          <div class="setting-row"><div class="txt"><div class="t">Import from another launcher</div><div class="d">Prism, PolyMC, MultiMC, CurseForge, Modrinth App, ATLauncher, GDLauncher, the Minecraft Launcher — or any folder.</div></div><div class="ctl"><button class="btn sm" id="prism">${icon('import', 14)} Import</button></div></div>
          <div class="setting-row"><div class="txt"><div class="t">Orbit Launcher</div><div class="d">Version 0.1.0 · Built with Tauri</div></div></div>
        </section>
      </div>
    </div>
  </div>`;

  const $ = (q) => root.querySelector(q);
  const savedEl = $('#saved');
  // Field edits are batched; each batch is sent once, so it can't later overwrite newer values.
  const pending = {};
  const save = debounce(async () => {
    const patch = { ...pending };
    for (const k of Object.keys(pending)) delete pending[k];
    await saveSettings(patch);
    savedEl.textContent = 'SAVED ✓';
    setTimeout(() => (savedEl.textContent = ''), 1600);
  }, 350);
  const queue = (patch) => { Object.assign(pending, patch); save(); };

  // accounts
  const drawAccounts = () => {
    const el = $('#acc-list');
    el.innerHTML = store.accounts.length ? store.accounts.map((a) => `<div class="acct ${a.active ? 'on' : ''}"><img src="${avatarUrl(a)}" /><div style="flex:1"><div style="font-weight:600">${esc(a.name)}</div><div class="dim mono" style="font-size:11px">${a.kind === 'msa' ? 'MICROSOFT' : 'OFFLINE'}</div></div>${a.active ? `<span class="chip accent">${icon('check', 12, 2.5)} Active</span>` : ''}</div>`).join('') : '<div class="dim" style="font-size:13px">No accounts yet.</div>';
  };
  drawAccounts();
  $('#acc-ms').onclick = microsoftLogin;
  $('#acc-manage').onclick = accountsModal;

  // game
  const mem = $('#mem');
  const showMem = () => { $('#mem-v').textContent = `${(mem.value / 1024).toFixed(1)} GB`; setRangeFill(mem); };
  invoke('system_memory').then((total) => { mem.max = Math.max(2048, Math.floor((total * 0.85) / 512) * 512); showMem(); });
  showMem();
  mem.oninput = () => { showMem(); queue({ memoryMb: +mem.value }); };
  const num = (v) => (parseInt(v, 10) > 0 ? parseInt(v, 10) : 0);
  $('#gw').oninput = () => queue({ gameWidth: num($('#gw').value) });
  $('#gh').oninput = () => queue({ gameHeight: num($('#gh').value) });
  $('#fs').onchange = (e) => queue({ fullscreen: e.target.checked });
  $('#hide').onchange = (e) => queue({ hideOnLaunch: e.target.checked });

  // java
  invoke('list_java').then((list) => {
    $('#java-list').innerHTML = list.length ? list.map((j) => `<div class="item"><div class="ic">${icon('java', 18)}</div><div class="main"><div class="t">Java ${esc(j.version)}</div><div class="s mono">${esc(j.component)}</div></div></div>`).join('') : '<div class="dim" style="font-size:12.5px">None yet — they download the first time you launch.</div>';
  });
  $('#java').oninput = () => queue({ javaPath: $('#java').value.trim() });
  $('#java-pick').onclick = async () => {
    const p = await invoke('pick_file', { title: 'Choose java.exe', extensions: ['exe'] });
    if (p) { $('#java').value = p; queue({ javaPath: p }); }
  };
  $('#jvm').oninput = () => { queue({ jvmArgs: $('#jvm').value }); $('#jvm-preset').value = JVM_PRESETS.some(([v]) => v && v === $('#jvm').value) ? $('#jvm').value : ''; };
  $('#jvm-preset').onchange = (e) => { if (!e.target.value) return; $('#jvm').value = e.target.value; queue({ jvmArgs: e.target.value }); };

  // integrations
  $('#cf').oninput = () => { queue({ curseforgeKey: $('#cf').value.trim() }); $('#cf-result').textContent = ''; };
  $('#cf-show').onclick = () => ($('#cf').type = $('#cf').type === 'password' ? 'text' : 'password');
  $('#cf-test').onclick = async () => {
    const out = $('#cf-result');
    out.style.color = 'var(--text-3)';
    out.textContent = 'Testing…';
    const r = await invoke('test_curseforge_key', { key: $('#cf').value });
    out.style.color = r.ok ? 'var(--good)' : 'var(--bad)';
    out.textContent = r.message;
    if (r.ok) queue({ curseforgeKey: $('#cf').value.trim() });
  };
  $('#cid').oninput = () => queue({ msClientId: $('#cid').value.trim() });

  const offCustomize = mountCustomize(root);

  // sharing
  invoke('share_info').then((info) => {
    $('#exe-dir').textContent = info.exeDir;
    $('#exe-open').onclick = () => invoke('open_launcher_folder');
    const ctl = $('#pm-ctl');
    if (info.portable) {
      $('#pm-chip').innerHTML = `<span class="chip good" style="margin-left:8px">${icon('check', 11, 2.5)} On</span>`;
      $('#pm-desc').innerHTML = `Everything lives in <span class="mono">${esc(info.dataDir)}</span>. Delete that folder (with Orbit closed) to go back to normal mode.${info.inOnedrive ? ' <span style="color:var(--warn)">It\'s inside OneDrive, so it will sync — game files can take a few GB.</span>' : ''}`;
    } else {
      ctl.innerHTML = `<button class="btn sm primary" id="pm-on">${icon('export', 14)} Make portable</button>`;
      $('#pm-on').onclick = async () => {
        const warn = info.inOnedrive ? ' The launcher is in a OneDrive folder, so OrbitData will sync to OneDrive.' : '';
        if (!(await confirmDialog('Switch to portable mode?', `Your instances and settings are copied into an OrbitData folder next to Orbit Launcher.exe and Orbit restarts. Java and game files re-download when needed.${warn}`, { ok: 'Make portable' }))) return;
        try { await invoke('enable_portable'); } catch (e) { toast(String(e), 'bad'); }
      };
    }
    $('#sd-cf').checked = info.defaultsFile && !!s.curseforgeKey;
    $('#sd-ms').checked = info.defaultsFile && !!s.msClientId;
  });
  $('#sd-save').onclick = async () => {
    try {
      const path = await invoke('write_shared_defaults', { curseforge: $('#sd-cf').checked, clientId: $('#sd-ms').checked });
      toast(path ? 'Keys saved next to the launcher' : 'Removed shared keys', 'good');
    } catch (e) { toast(String(e), 'bad'); }
  };

  // launcher
  invoke('data_folder').then((p) => ($('#data-dir').textContent = p));
  $('#data-open').onclick = () => invoke('open_data_folder');
  $('#prism').onclick = importModal;

  // section nav
  const view = document.getElementById('view');
  root.querySelectorAll('[data-sec]').forEach((b) => (b.onclick = () => $(`#sec-${b.dataset.sec}`).scrollIntoView({ behavior: 'smooth', block: 'start' })));
  const onScroll = () => {
    let cur = SECTIONS[0][0];
    for (const [id] of SECTIONS) { const el = $(`#sec-${id}`); if (el && el.getBoundingClientRect().top < 200) cur = id; }
    root.querySelectorAll('[data-sec]').forEach((b) => b.classList.toggle('on', b.dataset.sec === cur));
  };
  view.addEventListener('scroll', onScroll);
  const off = on('accounts', drawAccounts);
  return () => { off(); offCustomize(); view.removeEventListener('scroll', onScroll); };
}
