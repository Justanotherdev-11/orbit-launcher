// App-wide state and a tiny event bus.
import { invoke } from './api.js';

export const store = {
  instances: [],
  accounts: [],
  settings: {},
  running: new Set(), // includes instances that are still starting
  starting: new Set(),
  updates: new Map(), // instance id -> available mod updates (from the startup check)
  logs: new Map(), // instance id -> [{line, level}]
  mcVersions: null,
  dropTarget: null, // {instanceId, kind, label} while an instance content tab is open
};

const subs = new Map();
export function on(evt, fn) {
  if (!subs.has(evt)) subs.set(evt, new Set());
  subs.get(evt).add(fn);
  return () => subs.get(evt)?.delete(fn);
}
export function emit(evt, data) {
  subs.get(evt)?.forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } });
}

export async function refreshInstances() {
  store.instances = await invoke('list_instances');
  emit('instances');
  return store.instances;
}

export async function refreshAccounts() {
  store.accounts = await invoke('list_accounts');
  emit('accounts');
  return store.accounts;
}

export async function refreshRunning() {
  const list = await invoke('get_running');
  store.running = new Set(list.map((r) => r.id));
  store.starting = new Set(list.filter((r) => r.starting).map((r) => r.id));
  emit('running');
}

export async function loadSettings() {
  store.settings = await invoke('get_settings');
  emit('settings');
}

export async function saveSettings(patch) {
  store.settings = { ...store.settings, ...patch };
  emit('settings');
  await invoke('save_settings', { settings: store.settings });
}

// ───── UI preferences (Settings → Customize). Defaults live here so every module agrees. ─────

export const PREF_DEFAULTS = {
  theme: 'dark', accentCustom: '', corners: 'chamfer', uiScale: 100, density: 'comfortable',
  headingFont: 'chakra', bodyFont: 'plex',
  background: 'dots', bgImage: '', bgDim: 70, bgBlur: 0,
  tileMaterial: 'stone', tileOre: 'normal',
  railSide: 'left', railLabels: true, showSearch: true, showClock: false, scrollbars: 'thin',
  motion: 'full', speed: 1, fxLaunch: true, fxWipe: true, fxTilt: true, fxDecode: true, fxCascade: true, fxHover: true, loadGame: true, loadTips: true,
  sounds: false, volume: 40,
  homeHero: true, homeRecent: true, homeQuick: true, homePopular: true, popularDays: 30, popularKind: 'mod',
  libView: 'grid', cardSize: 'medium', libSort: 'recent', libGroups: true, libPlaytime: true, libArt: true,
  toastPos: 'top-right', toastSecs: 4, taskPos: 'bottom-right', taskAutoHide: true,
  relativeTimes: true, clock24: true,
  consoleSize: 12, consoleWrap: true, consoleColors: true, consoleFollow: true, maxLogLines: 20000,
  updateCheck: 'startup', updatesIncludePacks: false, bgImageStamp: 0,
  startPage: 'home', confirmDeletes: true, openAfterCreate: true, openLogOnLaunch: false,
  discoverSource: 'modrinth', discoverSort: 'relevance', discoverView: 'grid',
};

export function pref(key) {
  const ui = store.settings.ui || {};
  return key in ui ? ui[key] : PREF_DEFAULTS[key];
}

export function setPref(key, value) {
  return saveSettings({ ui: { ...(store.settings.ui || {}), [key]: value } });
}

export function resetPrefs() {
  return saveSettings({ ui: {}, accent: 'emerald' });
}

export async function mcVersions() {
  if (!store.mcVersions) store.mcVersions = await invoke('get_mc_versions');
  return store.mcVersions;
}

export const activeAccount = () => store.accounts.find((a) => a.active) || null;

export function pushLog(id, line, level) {
  if (!store.logs.has(id)) store.logs.set(id, []);
  const arr = store.logs.get(id);
  arr.push({ line, level });
  const max = Number(pref('maxLogLines')) || 20000;
  if (arr.length > max * 1.2) arr.splice(0, arr.length - max);
}

let navigate = () => {};
export const setNavigator = (fn) => (navigate = fn);
export const go = (route, params = {}) => navigate(route, params);
