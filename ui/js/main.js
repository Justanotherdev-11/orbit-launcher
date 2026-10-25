import { invoke, listen, appWindow, webview, openUrl } from './api.js';
import { store, emit, on, refreshInstances, refreshAccounts, refreshRunning, loadSettings, setNavigator, pushLog, activeAccount, go, pref } from './store.js';
import { icon, esc, toast, avatarUrl, iconUrl, $ } from './ui.js';
import { accountsModal, importPackFile, createInstanceModal } from './actions.js';
import { togglePalette } from './palette.js';
import { pixelWipe, decodeText, initTilt } from './fx.js';
import { applyPrefs, clockText } from './prefs.js';
import { initSounds, play } from './sounds.js';
import { checkAllUpdates } from './updates.js';
import * as home from './views/home.js';
import * as library from './views/library.js';
import * as instance from './views/instance.js';
import * as discover from './views/discover.js';
import * as settings from './views/settings.js';

const VIEWS = { home, library, instance, discover, settings };
const NAV = [
  ['home', 'home', 'Home'],
  ['library', 'library', 'Library'],
  ['discover', 'discover', 'Discover'],
  ['settings', 'settings', 'Settings'],
];

let current = { route: null, params: {}, cleanup: null };

const section = (route) => (route === 'instance' ? 'library' : route);

let navToken = 0;
let pendingRoute = null; // the route a running page wipe is heading to

function navigate(route, params = {}) {
  const token = ++navToken;
  const from = pendingRoute ?? current.route;
  const changingSection = from && section(from) !== section(route);
  pendingRoute = route;
  document.querySelectorAll('.rail-btn').forEach((b) => b.classList.toggle('on', b.dataset.route === section(route)));
  const swap = () => {
    if (token !== navToken) return; // a newer navigation already replaced this one
    pendingRoute = null;
    emit('navigate'); // page-owned overlays (project drawer, menus) close themselves
    document.querySelectorAll('.menu').forEach((x) => x.remove());
    if (typeof current.cleanup === 'function') current.cleanup();
    store.dropTarget = null;
    const entry = { route, params, cleanup: null };
    current = entry;
    const view = document.getElementById('view');
    view.scrollTop = 0;
    view.innerHTML = '';
    const cleanup = VIEWS[route].render(view, params);
    // If render redirected (e.g. a deleted instance → Library), that newer page owns `current`;
    // this view is already gone, so release its listeners straight away.
    if (current === entry) {
      entry.cleanup = cleanup;
      entrance(view);
    } else if (typeof cleanup === 'function') cleanup();
  };
  changingSection ? pixelWipe(swap) : swap();
}

/** First-paint motion for a freshly rendered page: titles decode, cards cascade in. */
function entrance(view) {
  const page = view.querySelector('.page');
  if (!page) return;
  page.classList.add('enter');
  setTimeout(() => page.classList.remove('enter'), 1000);
  if (!pref('fxCascade')) page.classList.remove('enter');
  view.querySelectorAll('.inst-grid, .recent-row, .quick').forEach((grid) => [...grid.children].forEach((c, i) => c.style.setProperty('--i', Math.min(i, 14))));
  view.querySelectorAll('.page-head h1, .hero-content h1, .inst-header h1, .welcome h1').forEach((h) => decodeText(h));
}
setNavigator(navigate);

function renderRail() {
  const rail = document.getElementById('rail');
  rail.innerHTML = NAV.map(([r, ic, label], i) => `<button class="rail-btn" data-route="${r}" title="${label} (Ctrl+${i + 1})">${icon(ic, 21)}<span>${label}</span></button>`).join('') + '<div class="rail-spacer"></div><div id="rail-running"></div>';
  rail.querySelectorAll('.rail-btn').forEach((b) => (b.onclick = () => navigate(b.dataset.route)));
}

function renderAccountChip() {
  const acc = activeAccount();
  const chip = document.getElementById('account-chip');
  chip.innerHTML = acc
    ? `<img src="${avatarUrl(acc, 48)}" alt="" /><span>${esc(acc.name)}</span>`
    : `<div class="avatar-empty">${icon('user', 14)}</div><span>Sign in</span>`;
}

function renderStatus() {
  const el = document.getElementById('title-status');
  const running = store.instances.filter((i) => store.running.has(i.id));
  el.innerHTML = running.map((i) => {
    const starting = store.starting.has(i.id);
    return `<span class="live ${starting ? 'starting' : ''}" data-tauri-drag-region>${starting ? 'STARTING · ' : ''}${esc(i.name)}</span>`;
  }).join('');
  const rr = document.getElementById('rail-running');
  if (rr) {
    rr.innerHTML = running.length ? `<div class="rail-running" title="${esc(running[0].name)} is running" style="cursor:pointer">${instanceThumb(running[0])}</div>` : '';
    rr.onclick = () => running.length && go('instance', { id: running[0].id, tab: 'log' });
  }
}

function instanceThumb(inst) {
  return inst.icon ? `<img src="${esc(iconUrl(inst.icon))}" style="width:100%;height:100%;object-fit:cover" />` : `<div style="width:100%;height:100%;display:grid;place-items:center;color:var(--good)">${icon('play', 16)}</div>`;
}

// ───────────────────────── task tray ─────────────────────────

const tasks = new Map();
function renderTask(t) {
  const root = document.getElementById('tasks');
  let el = tasks.get(t.id)?.el;
  if (!el) {
    el = document.createElement('div');
    el.className = 'task';
    el.innerHTML = '<div class="top"><div class="tt"></div><button class="btn icon sm ghost" title="Dismiss">' + icon('x', 14) + '</button></div><div class="td"></div><div class="bar"><i></i></div>';
    el.querySelector('button').onclick = () => dismiss(t.id);
    root.append(el);
    tasks.set(t.id, { el });
  }
  el.className = `task ${t.state}`;
  el.querySelector('.tt').textContent = t.title;
  el.querySelector('.td').textContent = t.detail;
  const bar = el.querySelector('.bar');
  bar.classList.toggle('ind', t.progress < 0);
  bar.querySelector('i').style.width = `${Math.max(0, Math.min(1, t.progress)) * 100}%`;
  if (t.state === 'done' && pref('taskAutoHide')) setTimeout(() => dismiss(t.id), 2600);
}
function dismiss(id) {
  const t = tasks.get(id);
  if (!t) return;
  tasks.delete(id);
  t.el.classList.add('out');
  setTimeout(() => t.el.remove(), 350);
}

// ───────────────────────── drag & drop ─────────────────────────

async function setupDragDrop() {
  const overlay = document.getElementById('drop-overlay');
  const describe = (paths) => {
    const pack = paths.find((p) => /\.mrpack$/i.test(p) || (/\.zip$/i.test(p) && !store.dropTarget));
    if (store.dropTarget) return { title: `Add to ${store.dropTarget.label}`, sub: store.dropTarget.instanceName, glyph: 'download' };
    if (pack) return { title: 'Import modpack', sub: 'Creates a new instance', glyph: 'modpack' };
    return null;
  };
  let lastPaths = [];
  await webview().onDragDropEvent(async (e) => {
    const p = e.payload;
    if (p.type === 'enter' || p.type === 'over') {
      if (p.paths) lastPaths = p.paths;
      const d = describe(lastPaths);
      if (d) {
        $('#drop-title').textContent = d.title;
        $('#drop-sub').textContent = d.sub;
        $('#drop-glyph').innerHTML = icon(d.glyph, 40, 1.5);
        overlay.classList.add('show');
      }
    } else if (p.type === 'leave') {
      overlay.classList.remove('show');
    } else if (p.type === 'drop') {
      overlay.classList.remove('show');
      const paths = p.paths || [];
      if (store.dropTarget) {
        try {
          const n = await invoke('add_local_files', { instanceId: store.dropTarget.instanceId, kind: store.dropTarget.kind, paths });
          toast(`Added ${n} file${n === 1 ? '' : 's'}`, 'good');
          emit('content-changed');
        } catch (err) { toast(String(err), 'bad'); }
      } else {
        const pack = paths.find((x) => /\.(mrpack|zip)$/i.test(x));
        if (pack) importPackFile(pack);
      }
    }
  });
}

// ───────────────────────── boot ─────────────────────────

async function boot() {
  $('#win-min').onclick = () => appWindow.minimize();
  $('#win-max').onclick = () => appWindow.toggleMaximize();
  $('#win-close').onclick = () => appWindow.close();
  $('#account-chip').onclick = accountsModal;
  $('#palette-btn').onclick = togglePalette;
  initTilt();
  document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const modalOpen = !!document.querySelector('.modal-backdrop, .drawer, .lightbox, .launch-fx');
    if (k === 'k') { e.preventDefault(); togglePalette(); }
    else if (k === 'n' && !modalOpen) { e.preventDefault(); createInstanceModal(); }
    else if (k === 'f') {
      const search = document.querySelector('#view .search input');
      if (search) { e.preventDefault(); search.focus(); search.select(); }
    } else if (/^[1-4]$/.test(k) && !modalOpen) { e.preventDefault(); navigate(NAV[+k - 1][0]); }
  });
  document.addEventListener('contextmenu', (e) => { if (!e.target.closest('input, textarea, .selectable, .console, .md')) e.preventDefault(); });
  // Every external link opens in the real browser, never inside the launcher.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (/^https?:/i.test(href)) { e.preventDefault(); openUrl(href); }
    else if (!href.startsWith('#')) e.preventDefault();
  });

  renderRail();
  on('settings', applyPrefs);
  await Promise.all([loadSettings(), refreshInstances(), refreshAccounts(), refreshRunning()]).catch((e) => toast(String(e), 'bad'));
  applyPrefs();
  initSounds();
  const clock = $('#clock');
  const tick = () => (clock.textContent = clockText());
  tick();
  setInterval(tick, 15000);
  renderAccountChip();
  renderStatus();
  on('accounts', renderAccountChip);
  on('running', renderStatus);
  on('instances', renderStatus);

  listen('task', renderTask);
  listen('game-state', () => refreshRunning());
  listen('game-log', (batch) => {
    const touched = new Set();
    for (const l of batch) { pushLog(l.id, l.line, l.level); touched.add(l.id); }
    touched.forEach((id) => emit('log', id));
  });
  listen('game-exit', async (e) => {
    await refreshRunning();
    await refreshInstances();
    const inst = store.instances.find((i) => i.id === e.id);
    pushLog(e.id, `── Game exited${e.code != null ? ` with code ${e.code}` : ''} ──`, e.crashed ? 'ERROR' : 'SYS');
    emit('log', e.id);
    if (e.crashed && inst) {
      play('error');
      toast(`Exit code ${e.code}. The log usually says why.`, 'bad', { title: `${inst.name} crashed`, actions: [{ label: 'View log', run: () => go('instance', { id: inst.id, tab: 'log' }) }] });
    }
  });
  setupDragDrop().catch(() => {});
  // Give the first page a moment to settle, then look for outdated mods.
  if (pref('updateCheck') === 'startup') setTimeout(() => checkAllUpdates().catch(() => {}), 2500);
  const start = pref('startPage');
  const lastPlayed = store.instances.find((i) => i.lastPlayed);
  if (start === 'last' && lastPlayed) navigate('instance', { id: lastPlayed.id });
  else navigate(['home', 'library', 'discover'].includes(start) ? start : 'home');
}

boot();
