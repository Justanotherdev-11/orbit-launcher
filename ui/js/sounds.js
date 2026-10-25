// Small synthesized UI sounds (no audio files): short square/triangle blips, like a game menu.
import { pref } from './store.js';

let ctx = null;

function tone(freq, start, dur, { type = 'square', gain = 0.12, slide = 0 } = {}) {
  ctx = ctx || new AudioContext();
  const t = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slide) osc.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
  const vol = gain * (pref('volume') / 100);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

const SOUNDS = {
  click: () => tone(880, 0, 0.05, { gain: 0.06 }),
  toggle: () => tone(660, 0, 0.04, { type: 'triangle', gain: 0.1 }),
  launch: () => { tone(220, 0, 0.35, { type: 'triangle', slide: 3, gain: 0.14 }); tone(440, 0.12, 0.25, { type: 'square', slide: 2, gain: 0.05 }); },
  success: () => { tone(784, 0, 0.09, { type: 'triangle' }); tone(1175, 0.09, 0.16, { type: 'triangle' }); },
  error: () => { tone(196, 0, 0.12, { gain: 0.08 }); tone(147, 0.12, 0.2, { gain: 0.08 }); },
  break: () => { for (let i = 0; i < 5; i++) tone(120 + Math.random() * 200, i * 0.03, 0.08, { type: 'square', gain: 0.05, slide: 0.5 }); },
};

export function play(name) {
  if (!pref('sounds') || !SOUNDS[name]) return;
  try { SOUNDS[name](); } catch { /* audio unavailable */ }
}

/** Click and toggle feedback for primary controls anywhere in the app. */
export function initSounds() {
  document.addEventListener('click', (e) => {
    if (e.target.closest('.play-btn, .fab')) return; // launches have their own sound
    if (e.target.closest('.btn.primary, .rail-btn, .tab, .seg button, .chip-btn')) play('click');
  });
  document.addEventListener('change', (e) => { if (e.target.closest('.switch')) play('toggle'); });
}
