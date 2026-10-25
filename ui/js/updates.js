// Startup mod-update check: finds outdated mods/packs/shaders across instances and offers to update them.
import { invoke } from './api.js';
import { store, emit, pref, go } from './store.js';
import { icon, esc, toast, modal, errText } from './ui.js';

let notice = null; // close() of the visible notification

const total = (results) => results.reduce((n, r) => n + r.updates.length, 0);

/** Check every eligible instance; notify if anything is out of date. */
export async function checkAllUpdates({ notify = true } = {}) {
  const eligible = store.instances.filter((i) => pref('updatesIncludePacks') || !i.pack);
  const results = [];
  for (const inst of eligible) {
    try {
      const updates = await invoke('check_updates', { instanceId: inst.id });
      if (updates.length) results.push({ inst, updates });
    } catch { /* offline or Modrinth unreachable — try again next launch */ }
  }
  store.updates = new Map(results.map((r) => [r.inst.id, r.updates]));
  emit('updates');
  if (notify && results.length) showNotice(results);
  return results;
}

function showNotice(results) {
  notice?.();
  const n = total(results);
  const names = results.map((r) => r.inst.name);
  const where = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names[0]} and ${names.length - 1} other instances`;
  notice = toast(`${n} mod update${n === 1 ? '' : 's'} for ${where}.`, 'info', {
    title: 'Updates available',
    timeout: Infinity,
    actions: [
      { label: 'Update all', run: () => updateAll(results) },
      { label: 'Review', run: () => reviewModal(results) },
    ],
  });
}

async function applyFor(inst, updates) {
  const r = await invoke('apply_updates', {
    instanceId: inst.id,
    updates: updates.map((u) => ({ file: u.file, versionId: u.versionId, title: u.title })),
  });
  const left = (store.updates.get(inst.id) || []).filter((u) => !updates.some((x) => x.file === u.file));
  if (left.length) store.updates.set(inst.id, left); else store.updates.delete(inst.id);
  emit('updates');
  emit('content-changed');
  return r;
}

async function updateAll(results) {
  let updated = 0;
  const skipped = [];
  for (const { inst, updates } of results) {
    if (store.running.has(inst.id)) { skipped.push(inst.name); continue; }
    try { updated += (await applyFor(inst, updates)).updated; } catch (e) { skipped.push(`${inst.name} (${errText(e)})`); }
  }
  if (updated) toast(`${updated} file${updated === 1 ? '' : 's'} updated`, 'good', { title: 'All up to date' });
  if (skipped.length) toast(`Skipped: ${skipped.join(', ')}. Close the game and try again from the Mods tab.`, 'info');
}

function reviewModal(results) {
  const m = modal({
    title: 'Updates available',
    wide: true,
    body: `<p class="muted" style="margin:0 0 6px;font-size:13px">Untick anything you'd rather keep on its current version.</p>
      ${results.map(({ inst, updates }, gi) => `
        <div class="group-head" style="margin:16px 0 6px"><span class="eyebrow" style="color:var(--text)">${esc(inst.name)}</span><span class="dim mono" style="font-size:11px">${updates.length}</span><div class="line"></div>
          <button class="btn sm ghost" data-open="${gi}">${icon('external', 13)} Open</button></div>
        <div class="list">${updates.map((u, ui) => `
          <label class="item" style="cursor:pointer">
            <span class="switch"><input type="checkbox" data-u="${gi}:${ui}" checked /><span></span></span>
            <div class="ic">${u.icon ? `<img src="${esc(u.icon)}" />` : icon('mods', 18)}</div>
            <div class="main"><div class="t">${esc(u.title)}</div><div class="s mono">${esc(u.current || 'installed')} → <span style="color:var(--a)">${esc(u.latest)}</span></div></div>
          </label>`).join('')}</div>`).join('')}`,
    foot: `<button class="btn ghost" data-close>Later</button><button class="btn primary" id="rv-go">${icon('download', 15)} Update selected</button>`,
  });
  m.el.querySelectorAll('.ic img').forEach((img) => (img.onerror = () => img.remove()));
  m.el.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => { m.close(); go('instance', { id: results[+b.dataset.open].inst.id, tab: 'mod' }); }));
  m.el.querySelector('#rv-go').onclick = async () => {
    const picked = results
      .map(({ inst, updates }, gi) => ({ inst, updates: updates.filter((_, ui) => m.el.querySelector(`[data-u="${gi}:${ui}"]`).checked) }))
      .filter((r) => r.updates.length);
    m.close();
    notice?.();
    if (picked.length) await updateAll(picked);
  };
}
