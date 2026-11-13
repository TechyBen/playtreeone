// Procedural "pixel candidates": tiny leaf blades and needle sprays are
// rasterised straight into low-res tiles, so no photo texels are ever used.
//
// Tiles store palette indices, not colours (PS1 CLUT style):
//   R = tone 0..1, the position on a palette ramp (with cluster shading baked in)
//   G = 255 for twig pixels (drawn with the bark ramp), 0 for foliage
//   B = random byte per leaf (the shader compares it to the accent chance)
//   A = coverage, strictly 0 or 255 (alpha-tested, never blended)
//
// An atlas is one row of 4 cluster tiles; leaf cards pick a column.

import { Rng, fbm, hash2 } from './rng.js';

export const ATLAS_COLUMNS = 4;

const clamp01 = v => Math.min(1, Math.max(0, v));

// Half-width profile of a blade along its length t in [0,1].
const BLADES = {
  broad: t => Math.pow(Math.sin(Math.PI * t), 0.9) * (1 - 0.35 * t),
  lobed: t => Math.pow(Math.sin(Math.PI * t), 0.7) * (0.6 + 0.4 * Math.abs(Math.cos(t * Math.PI * 3.5))),
  round: t => Math.sqrt(Math.max(0, 1 - (2 * t - 1) ** 2)),
};
// [length px, width px] at a 32px tile, and blades per tile at density 1.
const BLADE_SIZE = { broad: [5, 3, 80], lobed: [6.5, 4.2, 48], round: [3.4, 2.8, 120] };

// Fake light used to shade a cluster as if it were a ball of leaves
// (pixel space, so -y is up).
const LIGHT = (() => {
  const v = [-0.45, -0.7, 0.55];
  const n = Math.hypot(...v);
  return v.map(c => c / n);
})();
function ballLight(nx, ny) {
  const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
  return clamp01(nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
}

class Tile {
  constructor(data, stride, ox, size) {
    this.data = data; this.stride = stride; this.ox = ox; this.T = size;
  }
  plot(x, y, tone, twig, rnd) {
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.T || y >= this.T) return;
    const i = (y * this.stride + this.ox + x) * 4;
    this.data[i] = Math.round(clamp01(tone) * 255);
    this.data[i + 1] = twig ? 255 : 0;
    this.data[i + 2] = rnd;
    this.data[i + 3] = 255;
  }
  line(x0, y0, x1, y1, t0, t1, twig, rnd) {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    for (let i = 0; i <= n; i++) {
      const k = i / n;
      this.plot(x0 + (x1 - x0) * k, y0 + (y1 - y0) * k, t0 + (t1 - t0) * k, twig, rnd);
    }
  }
  // Flower tiles use G as a class: 0 petal, 128 flower centre, 255 green.
  px(x, y, tone, g) {
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.T || y >= this.T) return;
    const i = (y * this.stride + this.ox + x) * 4;
    this.data[i] = Math.round(clamp01(tone) * 255);
    this.data[i + 1] = g;
    this.data[i + 2] = 0;
    this.data[i + 3] = 255;
  }
  // Blade from base (bx,by) pointing along `ang`.
  blade(bx, by, ang, len, wid, shape, tone, rnd, midrib) {
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const ex = bx + ca * len, ey = by + sa * len;
    const minx = Math.floor(Math.min(bx, ex) - wid), maxx = Math.ceil(Math.max(bx, ex) + wid);
    const miny = Math.floor(Math.min(by, ey) - wid), maxy = Math.ceil(Math.max(by, ey) + wid);
    let any = false;
    for (let y = miny; y <= maxy; y++) {
      for (let x = minx; x <= maxx; x++) {
        const dx = x + 0.5 - bx, dy = y + 0.5 - by;
        const t = (dx * ca + dy * sa) / len;
        if (t < 0 || t > 1) continue;
        const ly = -dx * sa + dy * ca;
        const hw = shape(t) * wid * 0.5 + 0.2;
        if (Math.abs(ly) > hw) continue;
        let tn = tone + (ly / hw) * 0.06;
        if (midrib && Math.abs(ly) < 0.5) tn -= 0.1;
        this.plot(x, y, tn, false, rnd);
        any = true;
      }
    }
    if (!any) this.plot(bx + ca * len * 0.5, by + sa * len * 0.5, tone, false, rnd);
  }
}

// Broadleaf cluster: twigs from the bottom, then blades scattered inside a
// noisy round envelope, thinner toward the rim, drawn back to front.
function broadTile(tile, kind, rng, density, scale) {
  const T = tile.T, k = T / 32;
  const cx = T * 0.5, cy = T * 0.5, R = T * 0.46;
  const seed = rng.int(0, 99999);
  const env = a => R * (0.7 + 0.3 * fbm(Math.cos(a) * 1.3 + 7, Math.sin(a) * 1.3 + 7, 3, seed));
  const bx = cx + rng.float(-0.1, 0.1) * T, by = T - 1;

  const twigs = rng.int(2, 4);
  for (let i = 0; i < twigs; i++) {
    const a = -Math.PI / 2 + rng.float(-0.9, 0.9);
    const len = R * rng.float(0.8, 1.3);
    tile.line(bx, by, bx + Math.cos(a) * len, by + Math.sin(a) * len, 0.3, 0.55, true, 0);
  }

  const [bl, bw, per] = BLADE_SIZE[kind];
  const count = Math.round((per * density) / (scale * scale));
  const leaves = [];
  for (let tries = 0; leaves.length < count && tries < count * 8; tries++) {
    const a = rng.float(0, Math.PI * 2), rr = Math.sqrt(rng.next());
    if (rng.next() < Math.pow(rr, 3) * 0.6) continue;
    const e = env(a);
    const x = cx + Math.cos(a) * rr * e, y = cy + Math.sin(a) * rr * e * 0.9;
    const nx = (x - cx) / R, ny = (y - cy) / R;
    const z = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny)) * rng.float(0.4, 1);
    leaves.push({ x, y, z, nx, ny });
  }
  leaves.sort((p, q) => p.z - q.z);
  for (const l of leaves) {
    const len = bl * k * scale * rng.float(0.75, 1.3);
    const wid = bw * k * scale * rng.float(0.8, 1.2);
    const ang = Math.atan2(l.y - by, l.x - bx) + rng.float(-1.0, 1.0);
    const tone = 0.12 + 0.72 * ballLight(l.nx, l.ny) * (0.55 + 0.45 * l.z) + rng.float(-0.08, 0.08);
    tile.blade(l.x - Math.cos(ang) * len * 0.5, l.y - Math.sin(ang) * len * 0.5, ang, len, wid,
      BLADES[kind], tone, rng.int(0, 255), kind !== 'round' && len > 5);
  }
}

// Conifer cluster: several sagging sprays radiating from the centre.
// 'spray' = fir-like combs of needles, 'tuft' = larch-like rosettes.
function needleTile(tile, kind, rng, density, scale) {
  const T = tile.T, k = T / 32;
  const cx = T * 0.5, cy = T * 0.5;
  const sprays = kind === 'spray' ? rng.int(4, 6) : rng.int(3, 5);
  const a0 = rng.float(0, Math.PI * 2);
  const order = [...Array(sprays).keys()].map(i => ({ i, z: rng.next() })).sort((p, q) => p.z - q.z);
  const every = kind === 'spray' ? 1 : Math.max(2, Math.round(3 * k * scale));
  for (const { i, z } of order) {
    const a = a0 + i * (Math.PI * 2 / sprays) + rng.float(-0.35, 0.35);
    const len = T * rng.float(0.3, 0.46);
    const ex = cx + Math.cos(a) * len, ey = cy + Math.sin(a) * len * 0.85;
    const sag = len * rng.float(0.05, 0.15);
    const steps = Math.ceil(len);
    const rnd = rng.int(0, 255);
    const shade = 0.55 + 0.45 * z;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = cx + (ex - cx) * t, y = cy + (ey - cy) * t + Math.sin(t * Math.PI) * sag;
      if (t < 0.9) tile.plot(x, y, 0.35, true, 0);
      if (s % every || rng.next() > density) continue;
      const env = Math.sin(Math.PI * (0.1 + 0.9 * t));
      const nl = ((kind === 'spray' ? 4.5 : 3) * env + 1) * k * scale;
      const n = kind === 'spray' ? 2 : 5;
      const spin = rng.float(0, Math.PI * 2);
      for (let j = 0; j < n; j++) {
        const na = kind === 'spray'
          ? a + (j ? 1 : -1) * rng.float(0.7, 1.1)
          : spin + j * (Math.PI * 2 / n) + rng.float(-0.3, 0.3);
        const L = nl * rng.float(0.7, 1.1);
        const x2 = x + Math.cos(na) * L, y2 = y + Math.sin(na) * L;
        const tone = 0.1 + 0.78 * ballLight((x2 - cx) / (T * 0.5), (y2 - cy) / (T * 0.5)) * shade;
        tile.line(x, y, x2, y2, tone - 0.08, tone + 0.06, false, rnd);
      }
    }
  }
}

// Fern cluster: two to four fronds fanning up from the base and arching
// over at the tip, each a green rachis with paired leaflets (pinnae), longest
// mid-frond and short at the base and tip, drawn back to front.
function frondTile(tile, rng, density, scale) {
  const T = tile.T, k = T / 32;
  const fronds = rng.int(2, 4);
  const bx = T * (0.5 + rng.float(-0.12, 0.12)), by = T - 1;
  const order = [...Array(fronds).keys()].map(i => ({ i, z: rng.next() })).sort((p, q) => p.z - q.z);
  for (const { i, z } of order) {
    const a = -Math.PI / 2 + ((i + 0.5) / fronds - 0.5) * 1.9 + rng.float(-0.25, 0.25);
    const len = T * rng.float(0.62, 0.9);
    const curl = rng.float(0.6, 1.2) * (Math.cos(a) >= 0 ? 1 : -1);
    const steps = Math.ceil(len);
    const every = Math.max(1, Math.round(1.6 * k * scale));
    const shade = 0.55 + 0.45 * z;
    const rnd = rng.int(0, 255);
    let x = bx, y = by;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const ang = a + curl * t * t;
      x += Math.cos(ang); y += Math.sin(ang);
      tile.plot(x, y, 0.3 * shade, false, rnd);
      if (s % every || t < 0.06 || rng.next() > density) continue;
      const pl = (1.2 + 4.2 * Math.sin(Math.PI * (0.06 + 0.94 * t)) * (1 - 0.3 * t)) * k * scale;
      for (const side of [-1, 1]) {
        const pa = ang + side * (Math.PI / 2 - 0.4) + rng.float(-0.12, 0.12);
        // Ferns read light and fresh against the dark floor.
        const tone = 0.36 + 0.66 * ballLight((x - T / 2) / (T / 2), (y - T / 2) / (T / 2)) * shade + rng.float(-0.06, 0.06);
        tile.blade(x, y, pa, pl, Math.max(1.2, 1.5 * k), BLADES.broad, tone, rnd, false);
      }
    }
  }
}

// Wildflowers. Column 0 of a flower atlas is the plant's leafy base; columns
// 1-3 are stems rising from the bottom of the tile to flower heads drawn in
// one of a few shapes, which together give an approximate likeness of a
// species (its colours come from the material). G marks petal (0), centre
// (128) or green (255) pixels.
const FLOWER_SHAPES = ['daisy', 'cup', 'star', 'bell', 'spike', 'umbel', 'cluster', 'trumpet'];
export { FLOWER_SHAPES };
const GREEN = 255, CENTRE = 128, PETAL = 0;

function stem(tile, x0, y0, x1, y1, rng) {
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
  const bow = rng.float(-1.5, 1.5);
  let px = x0, py = y0;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    px = x0 + (x1 - x0) * t + Math.sin(t * Math.PI) * bow;
    py = y0 + (y1 - y0) * t;
    tile.px(px, py, 0.35 + 0.2 * t, GREEN);
  }
}

function leafBlade(tile, x, y, ang, len, wid, rng) {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  for (let i = 0; i <= len * 2; i++) {
    const t = i / (len * 2), w = Math.sin(Math.PI * t) * wid * 0.5;
    for (let j = -w; j <= w; j += 0.5) tile.px(x + ca * t * len - sa * j, y + sa * t * len + ca * j, 0.3 + 0.4 * t + rng.float(-0.05, 0.05), GREEN);
  }
}

function flowerHead(tile, shape, x, y, s, rng) {
  const lit = (dx, dy) => 0.35 + 0.6 * ballLight(clamp01(dx / (s + 1)) * Math.sign(dx), clamp01(dy / (s + 1)) * Math.sign(dy));
  if (shape === 'daisy' || shape === 'cup' || shape === 'star') {
    const petals = shape === 'daisy' ? rng.int(10, 13) : 5;
    const len = shape === 'daisy' ? s : s * 0.9, wid = shape === 'daisy' ? 1.2 : shape === 'cup' ? s * 0.9 : 1.1;
    const a0 = rng.float(0, Math.PI * 2);
    for (let i = 0; i < petals; i++) {
      const a = a0 + (i / petals) * Math.PI * 2;
      for (let t = 0.2; t <= 1; t += 0.12) {
        const w = Math.sin(Math.PI * Math.min(1, t * 1.1)) * wid * 0.5;
        for (let j = -w; j <= w; j += 0.5) {
          const dx = Math.cos(a) * t * len - Math.sin(a) * j, dy = (Math.sin(a) * t * len + Math.cos(a) * j) * 0.85;
          tile.px(x + dx, y + dy, lit(dx, dy), PETAL);
        }
      }
    }
    const c = shape === 'daisy' ? Math.max(1, s * 0.32) : Math.max(0.6, s * 0.22);
    for (let dy = -c; dy <= c; dy += 0.5) for (let dx = -c; dx <= c; dx += 0.5) if (dx * dx + dy * dy <= c * c) tile.px(x + dx, y + dy, lit(dx, dy) * 0.9, CENTRE);
  } else if (shape === 'bell') {
    // A nodding stalk with bells hanging down one side.
    const n = rng.int(3, 5), side = rng.chance(0.5) ? 1 : -1;
    for (let i = 0; i < n; i++) {
      const bx = x + side * (i * s * 0.45), by = y + i * s * 0.75 + i * i * 0.3;
      for (let t = 0; t <= 1; t += 0.1) {
        const w = (0.35 + 0.65 * t) * s * 0.45;
        for (let j = -w; j <= w; j += 0.5) tile.px(bx + j, by + t * s * 0.9, lit(j, t * s - s / 2), PETAL);
      }
      tile.px(bx, by - 1, 0.4, GREEN);
    }
  } else if (shape === 'spike') {
    // Florets crowded up the top of the stem, smaller toward the tip.
    // Separate florets, alternating sides, nodding outward and down.
    const h = s * 4;
    let sd = rng.chance(0.5) ? 1 : -1;
    for (let t = 0; t <= 1; t += 0.085) {
      const len = (1 - t * 0.6) * s * 0.85 + 0.8;
      const yy = y + h * (1 - t);
      const ang = sd > 0 ? 0.45 : Math.PI - 0.45;
      tile.blade(x, yy, ang, len, Math.max(1.4, len * 0.7), BLADES.broad, lit(sd * len, yy - y - h / 2) + rng.float(-0.06, 0.06), 0, false);
      sd = -sd;
    }
    tile.line(x, y, x, y + h, 0.35, 0.45, true, 0);
  } else if (shape === 'umbel') {
    // Rays from a point up to a flat-topped dome of tiny florets.
    const rays = rng.int(7, 10), r = s * 1.5;
    for (let i = 0; i < rays; i++) {
      const a = -Math.PI / 2 + ((i / (rays - 1)) - 0.5) * 2.2;
      const ex = x + Math.cos(a) * r, ey = y + Math.sin(a) * r * 0.5 + r * 0.4;
      tile.line(x, y + r * 0.9, ex, ey, 0.4, 0.5, true, 0);
      for (let k = 0; k < 10; k++) { const dx = rng.float(-1.7, 1.7), dy = rng.float(-1.3, 0.6); tile.px(ex + dx, ey + dy, lit(ex - x + dx, dy), PETAL); }
    }
  } else if (shape === 'cluster') {
    // A round head of florets (clover, thistle, scabious).
    for (let dy = -s; dy <= s; dy += 0.5) for (let dx = -s; dx <= s; dx += 0.5) {
      if (dx * dx + dy * dy > s * s || rng.next() < 0.15) continue;
      tile.px(x + dx, y + dy, lit(dx, dy) + rng.float(-0.08, 0.08), PETAL);
    }
  } else {
    // Trumpet: a funnel opening upward, darker in the throat.
    const h = s * 1.6;
    for (let t = 0; t <= 1; t += 0.08) {
      const w = (0.2 + 0.8 * t * t) * s * 0.7;
      for (let j = -w; j <= w; j += 0.5) tile.px(x + j, y + h * (1 - t), t > 0.85 && Math.abs(j) < w * 0.4 ? 0.25 : lit(j, -t * h), t > 0.85 && Math.abs(j) < w * 0.35 ? CENTRE : PETAL);
    }
  }
}

function flowerTile(tile, shape, variant, rng, scale) {
  const T = tile.T, k = T / 32;
  if (variant === 0) {
    // The leafy base: a low rosette of leaves.
    const n = rng.int(7, 11);
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + rng.float(-1.45, 1.45);
      leafBlade(tile, T / 2 + rng.float(-3, 3) * k, T - 1, a, rng.float(0.35, 0.6) * T, rng.float(2, 4) * k, rng);
    }
    return;
  }
  const heads = { daisy: [2, 3], cup: [2, 3], star: [5, 8], bell: [1, 2], spike: [1, 2], umbel: [1, 2], cluster: [2, 3], trumpet: [1, 2] }[shape];
  const n = rng.int(...heads);
  const s = ({ star: 2.2, daisy: 4.2, cup: 4.2, bell: 3.2, spike: 3.0, umbel: 3.4, cluster: 3.4, trumpet: 4.4 }[shape]) * k * scale;
  const tops = [];
  for (let i = 0; i < n; i++) {
    const x = T * (0.2 + 0.6 * (n === 1 ? 0.5 : i / (n - 1))) + rng.float(-2, 2) * k;
    const y = shape === 'spike' ? T * rng.float(0.05, 0.2) : T * rng.float(0.1, 0.45);
    tops.push([x, y]);
  }
  for (const [x, y] of tops) {
    stem(tile, T / 2 + rng.float(-2, 2) * k, T - 1, x, y + (shape === 'spike' ? s * 4 : shape === 'bell' ? 0 : s * 0.3), rng);
    if (rng.chance(0.6)) leafBlade(tile, T / 2, T - 1 - rng.float(2, 8) * k, -Math.PI / 2 + rng.float(-1.2, 1.2), rng.float(4, 8) * k, 2 * k, rng);
  }
  for (const [x, y] of tops) flowerHead(tile, shape, x, y, s, rng);
}

export function makeFlowerAtlas(shape, { tile = 32, scale = 1, seed = 1 } = {}) {
  const W = tile * ATLAS_COLUMNS;
  const data = new Uint8Array(W * tile * 4);
  const rng = new Rng(seed);
  for (let v = 0; v < ATLAS_COLUMNS; v++) flowerTile(new Tile(data, W, v * tile, tile), shape, v, rng, scale);
  return { data, width: W, height: tile };
}

export function makeLeafAtlas(kind, { tile = 32, density = 1, scale = 1, seed = 1 } = {}) {
  const W = tile * ATLAS_COLUMNS;
  const data = new Uint8Array(W * tile * 4);
  const rng = new Rng(seed);
  for (let v = 0; v < ATLAS_COLUMNS; v++) {
    const t = new Tile(data, W, v * tile, tile);
    if (kind === 'spray' || kind === 'tuft') needleTile(t, kind, rng, density, scale);
    else if (kind === 'frond') frondTile(t, rng, density, scale);
    else broadTile(t, kind, rng, density, scale);
  }
  return { data, width: W, height: tile };
}

// Tileable bark tone: vertical streaks, dark cracks, light speckles.
export function makeBarkTexture(seed = 1, w = 16, h = 32) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const streak = fbm((x / w) * 8, (y / h) * 2, 3, seed, 8, 2);
      const crack = fbm((x / w) * 4, (y / h) * 6, 2, seed + 9, 4, 6);
      let t = 0.3 + 0.55 * streak;
      if (crack > 0.62) t *= 0.55;
      if (hash2(x, y, seed + 3) < 0.07) t += 0.15;
      const i = (y * w + x) * 4;
      data[i] = Math.round(clamp01(t) * 255);
      data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

// Tileable ground tone: broad patches, grass clumps, speckle.
export function makeGroundTexture(seed = 1, size = 64) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm((x / size) * 4, (y / size) * 4, 4, seed, 4, 4);
      const clump = fbm((x / size) * 16, (y / size) * 16, 2, seed + 5, 16, 16);
      let t = 0.2 + 0.6 * n + (clump - 0.5) * 0.35;
      const h = hash2(x, y, seed + 11);
      if (h < 0.12) t += 0.18;
      else if (h > 0.93) t -= 0.18;
      const i = (y * size + x) * 4;
      data[i] = Math.round(clamp01(t) * 255);
      data[i + 3] = 255;
    }
  }
  return { data, width: size, height: size };
}
