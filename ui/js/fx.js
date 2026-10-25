// Motion: launch sequence, card tilt, block-glyph text decode, pixel wipe between pages.
import { tileCells, esc, toast } from './ui.js';
import { createMineGame } from './minegame.js';
import { randomTips } from './tips.js';
import { pref } from './store.js';
import { play } from './sounds.js';

/** An effect runs only with full motion and its own toggle on (Settings → Motion). */
const allowed = (toggle) => pref('motion') === 'full' && !document.documentElement.classList.contains('reduce-motion') && pref(toggle);
const ms = (n) => n / Math.max(0.25, Number(pref('speed')) || 1);
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

// ───────────────────────── text decode ─────────────────────────

const GLYPHS = '▖▗▘▙▚▛▜▝▞▟▀▄█▌▐░▒';

/** Resolve an element's text left-to-right out of block characters. */
export function decodeText(el, duration = 520) {
  if (!el || !allowed('fxDecode')) return;
  duration = ms(duration);
  const final = el.textContent;
  if (!final.trim() || final.length > 60) return;
  const start = performance.now();
  const order = [...final].map((_, i) => (i / final.length) * 0.75 + Math.random() * 0.25);
  const frame = (now) => {
    const t = (now - start) / duration;
    if (t >= 1) { el.textContent = final; return; }
    el.textContent = [...final].map((c, i) => (c === ' ' || t >= order[i] ? c : GLYPHS[(Math.random() * GLYPHS.length) | 0])).join('');
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ───────────────────────── card tilt ─────────────────────────

/** Cards marked data-tilt lean towards the cursor; their art layer drifts for depth. */
export function initTilt() {
  let current = null;
  const reset = (el) => {
    el.classList.remove('tilting');
    ['--rx', '--ry', '--px', '--py'].forEach((v) => el.style.removeProperty(v));
  };
  document.addEventListener('mousemove', (e) => {
    const el = allowed('fxTilt') ? e.target.closest?.('[data-tilt]') : null;
    if (current && current !== el) reset(current);
    current = el;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    el.classList.add('tilting');
    el.style.setProperty('--rx', `${(-y * 7).toFixed(2)}deg`);
    el.style.setProperty('--ry', `${(x * 9).toFixed(2)}deg`);
    el.style.setProperty('--px', `${(-x * 10).toFixed(1)}px`);
    el.style.setProperty('--py', `${(-y * 8).toFixed(1)}px`);
    el.style.setProperty('--mx', `${((x + 0.5) * 100).toFixed(1)}%`);
    el.style.setProperty('--my', `${((y + 0.5) * 100).toFixed(1)}%`);
  });
  document.addEventListener('mouseleave', () => current && reset(current));
}

// ───────────────────────── pixel wipe ─────────────────────────

/** Sweep a wall of blocks across the view, swap the page underneath, then sweep it away. */
export function pixelWipe(swap) {
  const view = document.getElementById('view');
  if (!allowed('fxWipe') || !view) return swap();
  const r = view.getBoundingClientRect();
  const canvas = document.createElement('canvas');
  canvas.className = 'wipe-fx';
  const dpr = window.devicePixelRatio || 1;
  Object.assign(canvas.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  canvas.width = r.width * dpr;
  canvas.height = r.height * dpr;
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const size = 34, cols = Math.ceil(r.width / size), rows = Math.ceil(r.height / size);
  const fill = cssVar('--surface-2') || '#16181c', edge = cssVar('--a') || '#c3ee3a';
  const span = cols + rows;
  const jitter = Array.from({ length: cols * rows }, () => Math.random() * 3);
  const COVER = ms(170), REVEAL = ms(230);
  const start = performance.now();
  let swapped = false;
  const frame = (now) => {
    const el = now - start;
    ctx.clearRect(0, 0, r.width, r.height);
    const covering = el < COVER;
    const p = covering ? el / COVER : Math.min(1, (el - COVER) / REVEAL);
    if (!covering && !swapped) { swapped = true; swap(); }
    const front = p * (span + 4);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const d = x + y + jitter[y * cols + x];
      const shown = covering ? d < front : d >= front;
      if (!shown) continue;
      const nearFront = Math.abs(d - front) < 1.6;
      ctx.fillStyle = nearFront ? edge : fill;
      ctx.globalAlpha = nearFront ? 0.85 : 1;
      ctx.fillRect(x * size, y * size, size - 1, size - 1);
    }
    ctx.globalAlpha = 1;
    if (!covering && p >= 1) return canvas.remove();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ───────────────────────── launch sequence ─────────────────────────

/**
 * Full-view launch animation: the instance's blocks fly in and assemble, light up with real
 * progress, then shatter and fall when the game starts.
 * Returns { progress(fraction|-1, detail), success(), fail(message) }.
 */
export function launchSequence(inst) {
  const view = document.getElementById('view');
  play('launch');
  if (!allowed('fxLaunch') || !view) return { progress() {}, success() { play('success'); }, fail() { play('error'); } };

  const { W, H, cells } = tileCells(inst.id, inst.accent);
  const root = document.createElement('div');
  root.className = 'launch-fx';
  root.innerHTML = `<canvas></canvas>
    <div class="lfx-info">
      <div class="lfx-label">Launching</div>
      <div class="lfx-name">${esc(inst.name)}</div>
      <div class="lfx-row"><span class="lfx-pct"></span><span class="lfx-detail">Preparing…</span></div>
      <div class="lfx-tip"></div>
    </div>
    <button class="btn sm ghost lfx-hide">Hide — keep launching in the background</button>`;
  document.body.append(root);
  const canvas = root.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  decodeText(root.querySelector('.lfx-name'), 700);

  // Layout follows the view: it's recomputed if the window is resized or maximised mid-launch.
  let r, size, ox, oy;
  const grid = { get size() { return size; }, get ox() { return ox; }, get oy() { return oy; } };
  const blocks = cells.map((c, i) => {
    const ang = Math.random() * Math.PI * 2;
    return {
      c, gx: i % W, gy: Math.floor(i / W),
      fx: Math.cos(ang) * (300 + Math.random() * 500), fy: Math.sin(ang) * (300 + Math.random() * 500), // fly-in offset
      rot: (Math.random() - 0.5) * 3,
      delay: ((i % W) / W) * 380 + Math.random() * 260,
      vx: 0, vy: 0, vr: 0,
    };
  });
  const layout = () => {
    r = view.getBoundingClientRect();
    Object.assign(root.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    const dpr = window.devicePixelRatio || 1;
    canvas.width = r.width * dpr;
    canvas.height = r.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    size = Math.max(4, Math.floor(Math.min((r.width * 0.62) / W, (r.height * 0.4) / H)));
    ox = (r.width - size * W) / 2;
    oy = r.height * 0.42 - (size * H) / 2;
    for (const b of blocks) {
      b.tx = ox + b.gx * size; b.ty = oy + b.gy * size;
      b.sx = b.tx + b.fx; b.sy = b.ty + b.fy;
    }
  };
  layout();
  window.addEventListener('resize', layout);
  const accent = cssVar('--a') || '#c3ee3a';

  const t0 = performance.now();
  const ASSEMBLE = ms(950);
  let target = -1, shown = 0, phase = 'build', phaseAt = 0, done = false, failed = false, pendingSuccess = false;
  const pctEl = root.querySelector('.lfx-pct'), detailEl = root.querySelector('.lfx-detail');

  // Something to do while waiting: a mining mini-game on the tile, and rotating facts.
  const game = pref('loadGame') ? createMineGame({ W, H, grid, accent }) : null;
  if (game) {
    canvas.style.cursor = 'crosshair';
    canvas.addEventListener('mousedown', (e) => {
      const now = performance.now();
      if (phase === 'build' && now - t0 > ASSEMBLE) game.click(e.offsetX, e.offsetY, now);
    });
  }
  const tipEl = root.querySelector('.lfx-tip');
  let tipTimer = null;
  if (pref('loadTips')) {
    const tips = randomTips();
    let n = 0;
    const showTip = () => {
      tipEl.classList.remove('in');
      setTimeout(() => { tipEl.textContent = tips[n++ % tips.length]; tipEl.classList.add('in'); }, 250);
    };
    tipTimer = setTimeout(function loop() { showTip(); tipTimer = setTimeout(loop, 7000); }, 900);
  }
  const finishGame = () => {
    clearTimeout(tipTimer);
    if (!game || !game.mined) return;
    const record = game.finish();
    toast(`You mined ${game.mined} ore while it loaded — ${game.score} points${record ? '. New best!' : `. Best: ${game.best}`}`, 'good', { title: record ? 'New high score' : 'Nice mining' });
  };

  const drawBlock = (b, x, y, rot, alpha, lit) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x + size / 2, y + size / 2);
    if (rot) ctx.rotate(rot);
    ctx.fillStyle = b.c;
    ctx.fillRect(-size / 2, -size / 2, size - 1, size - 1);
    // Bevel: lighter top edge, darker bottom edge, like a block face.
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.fillRect(-size / 2, -size / 2, size - 1, Math.max(1, size * 0.12));
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(-size / 2, size / 2 - 1 - Math.max(1, size * 0.12), size - 1, Math.max(1, size * 0.12));
    if (!lit) { ctx.fillStyle = 'rgba(11,12,14,0.62)'; ctx.fillRect(-size / 2, -size / 2, size - 1, size - 1); }
    ctx.restore();
  };

  const startExplode = () => {
    phase = 'explode';
    finishGame();
    play(failed ? 'error' : 'break');
    phaseAt = performance.now();
    const cx = ox + (W * size) / 2, cy = oy + (H * size) / 2;
    for (const b of blocks) {
      const dx = b.tx - cx, dy = b.ty - cy;
      const d = Math.hypot(dx, dy) || 1;
      const force = failed ? 1.5 : 9 + Math.random() * 9;
      b.vx = (dx / d) * force + (Math.random() - 0.5) * 4;
      b.vy = failed ? Math.random() * 2 : (dy / d) * force - 6 - Math.random() * 6;
      b.vr = (Math.random() - 0.5) * 0.5;
      b.x = b.tx; b.y = b.ty; b.r = 0;
    }
    root.classList.add(failed ? 'failed' : 'leaving');
  };

  const frame = (now) => {
    if (done) return;
    ctx.clearRect(0, 0, r.width, r.height);
    const el = now - t0;
    if (target >= 0) shown += (target - shown) * 0.12;
    const litCols = target < 0 ? -1 : Math.round(shown * W);
    const scan = target < 0 ? Math.floor(((el / 70) % (W * 2))) : -1;
    const scanCol = scan >= W ? W * 2 - 1 - scan : scan;

    if (phase === 'build') {
      for (const b of blocks) {
        const t = Math.min(1, Math.max(0, (el - ms(b.delay)) / ms(520)));
        if (t <= 0) continue;
        const e = easeOut(t);
        const lit = litCols < 0 ? Math.abs(b.gx - scanCol) < 2 : b.gx < litCols;
        drawBlock(b, b.sx + (b.tx - b.sx) * e, b.sy + (b.ty - b.sy) * e, b.rot * (1 - e), Math.min(1, t * 1.6), lit);
      }
      // Hairline frame + progress rail under the tile.
      const railY = oy + H * size + 18;
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(ox, railY, W * size, 2);
      ctx.fillStyle = accent;
      if (target >= 0) ctx.fillRect(ox, railY, W * size * shown, 2);
      else ctx.fillRect(ox + Math.max(0, scanCol) * size, railY, size * 3, 2);
      if (game && el > ASSEMBLE) { game.update(now); game.draw(ctx, now); }
      if (pendingSuccess && el > ASSEMBLE + 250) startExplode();
    } else {
      const pe = now - phaseAt;
      const life = ms(failed ? 900 : 1300);
      for (const b of blocks) {
        b.vy += failed ? 0.9 : 0.55;
        b.vx *= 0.99;
        b.x += b.vx; b.y += b.vy; b.r += b.vr;
        drawBlock(b, b.x, b.y, b.r, Math.max(0, 1 - pe / life), true);
      }
      if (pe > life) { done = true; window.removeEventListener('resize', layout); root.remove(); return; }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  root.querySelector('.lfx-hide').onclick = () => { done = true; finishGame(); window.removeEventListener('resize', layout); root.remove(); };

  return {
    progress(p, detail) {
      if (done || phase !== 'build') return;
      if (p >= 0) target = Math.max(target, Math.min(1, p));
      pctEl.textContent = target < 0 ? '' : String(Math.round(target * 100)).padStart(2, '0');
      if (detail) detailEl.textContent = detail;
    },
    success() {
      if (done) return;
      target = 1;
      pctEl.textContent = '100';
      detailEl.textContent = 'Game started';
      pendingSuccess = true;
      if (performance.now() - t0 > ASSEMBLE + 250) startExplode();
    },
    fail(message) {
      if (done) return;
      failed = true;
      detailEl.textContent = message || 'Launch failed';
      setTimeout(startExplode, 700);
    },
  };
}
