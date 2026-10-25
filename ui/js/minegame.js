// "Mine while you wait": glowing ore pops up on the launch tile; click it before it fades.
import { play } from './sounds.js';

const BEST_KEY = 'orbit-mine-best';

function loadBest() {
  try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; }
}
function saveBest(v) {
  try { localStorage.setItem(BEST_KEY, String(v)); } catch { /* storage unavailable */ }
}

/**
 * Runs on the launch canvas. `grid` gives the tile's current { size, ox, oy } (it changes on resize).
 * Call update(now) + draw(ctx, now) each frame and click(x, y) on clicks.
 */
export function createMineGame({ W, H, grid, accent }) {
  const ores = new Map(); // cell index -> { born, life }
  const particles = [];
  const floaters = [];
  let score = 0, mined = 0, combo = 0, lastMine = 0, nextSpawn = 0, started = 0;
  const best = loadBest();

  const cellAt = (x, y) => {
    const { size, ox, oy } = grid;
    const gx = Math.floor((x - ox) / size), gy = Math.floor((y - oy) / size);
    return gx >= 0 && gx < W && gy >= 0 && gy < H ? gy * W + gx : -1;
  };

  return {
    get score() { return score; },
    get mined() { return mined; },
    best,

    update(now) {
      if (!started) { started = now; nextSpawn = now + 400; }
      // Spawn faster as you score; at most five ores at once.
      if (now >= nextSpawn && ores.size < 5) {
        let i, tries = 0;
        do { i = Math.floor(Math.random() * W * H); } while (ores.has(i) && ++tries < 20);
        ores.set(i, { born: now, life: Math.max(1300, 2600 - mined * 40) });
        nextSpawn = now + Math.max(320, 900 - mined * 18) * (0.6 + Math.random() * 0.8);
      }
      for (const [i, o] of ores) {
        if (now - o.born > o.life) { ores.delete(i); combo = 0; }
      }
      for (const p of particles) { p.vy += 0.35; p.x += p.vx; p.y += p.vy; p.life -= 1; }
      for (let i = particles.length - 1; i >= 0; i--) if (particles[i].life <= 0) particles.splice(i, 1);
      for (const f of floaters) { f.y -= 0.6; f.life -= 1; }
      for (let i = floaters.length - 1; i >= 0; i--) if (floaters[i].life <= 0) floaters.splice(i, 1);
    },

    draw(ctx, now) {
      const { size, ox, oy } = grid;
      for (const [i, o] of ores) {
        const x = ox + (i % W) * size, y = oy + Math.floor(i / W) * size;
        const age = (now - o.born) / o.life;
        const pop = Math.min(1, (now - o.born) / 140);
        const flicker = age > 0.75 && Math.floor(now / 90) % 2 === 0;
        const s = (size - 1) * (0.6 + 0.4 * pop);
        const off = (size - 1 - s) / 2;
        ctx.globalAlpha = flicker ? 0.45 : 1;
        ctx.fillStyle = accent;
        ctx.fillRect(x + off, y + off, s, s);
        // Ore flecks so it reads as a mineral, not a plain square.
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        const q = Math.max(1, size * 0.16);
        ctx.fillRect(x + size * 0.22, y + size * 0.25, q, q);
        ctx.fillRect(x + size * 0.6, y + size * 0.55, q, q);
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(x + size * 0.45, y + size * 0.2, q, q);
        // Countdown ring around the block.
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.5 * (1 - age);
        ctx.strokeRect(x - 3, y - 3, size + 5, size + 5);
        ctx.globalAlpha = 1;
      }
      for (const p of particles) {
        ctx.globalAlpha = Math.min(1, p.life / 20);
        ctx.fillStyle = p.c;
        ctx.fillRect(p.x, p.y, p.s, p.s);
      }
      ctx.globalAlpha = 1;
      ctx.textAlign = 'center';
      for (const f of floaters) {
        ctx.globalAlpha = Math.min(1, f.life / 25);
        ctx.fillStyle = accent;
        ctx.font = `700 ${f.big ? 18 : 14}px "Chakra Petch", sans-serif`;
        ctx.fillText(f.text, f.x, f.y);
      }
      ctx.globalAlpha = 1;

      // HUD above the tile.
      const top = oy - 14;
      ctx.font = '600 12px "Chakra Petch", sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fillText(mined ? `ORE MINED ${mined}` : 'CLICK THE GLOWING ORE TO MINE IT', ox, top);
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fillText(`BEST ${Math.max(best, score)}`, ox + W * size, top);
      ctx.fillStyle = accent;
      ctx.font = '700 16px "Chakra Petch", sans-serif';
      const comboText = combo > 1 ? `  ×${combo}` : '';
      ctx.fillText(`${score}${comboText}`, ox + W * size - 74, top + 1);
      ctx.textAlign = 'left';
    },

    /** Returns true if the click mined something. */
    click(x, y, now) {
      const i = cellAt(x, y);
      if (i < 0 || !ores.has(i)) return false;
      const { size, ox, oy } = grid;
      ores.delete(i);
      combo = now - lastMine < 1400 ? combo + 1 : 1;
      lastMine = now;
      mined += 1;
      const gain = 10 * combo;
      score += gain;
      const cx = ox + (i % W) * size + size / 2, cy = oy + Math.floor(i / W) * size + size / 2;
      for (let k = 0; k < 14; k++) {
        particles.push({
          x: cx, y: cy, s: Math.max(2, size * (0.12 + Math.random() * 0.15)),
          vx: (Math.random() - 0.5) * 7, vy: -Math.random() * 6 - 1,
          c: Math.random() < 0.55 ? accent : ['#2a2d33', '#3a3e46', '#ffffff'][k % 3], life: 30 + Math.random() * 20,
        });
      }
      floaters.push({ x: cx, y: cy - size * 0.6, text: `+${gain}`, life: 45, big: combo > 2 });
      play(combo > 2 ? 'success' : 'click');
      return true;
    },

    /** Persist the best score; returns true for a new record. */
    finish() {
      if (score > best) { saveBest(score); return true; }
      return false;
    },
  };
}
