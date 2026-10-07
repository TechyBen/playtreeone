// Procedural forest ambience: wind and synthesised birds, no audio samples.
//
// Birds come in phases, so the soundscape breathes instead of looping:
//   rest   ~10 min: wind, plus now and then one distant bird
//   active ~3 min:  2-4 birds; activity fades in over 30 s and out over 30 s
// Each bird is an individual with its own pitch, tempo and a small repertoire
// of phrases. Like real songbirds it repeats a phrase a few times, then
// switches, with slight variation each time. Calls follow a loose per-bird
// rhythm (interval +-jitter), and birds sometimes answer each other.

import { Rng } from './rng.js';

const SPECIES = {
  // weight: how common; gap: seconds between calls; level: loudness; lp: tone ceiling (Hz)
  flute:   { weight: 3, gap: [3, 8],   level: 0.5,  lp: 9000 },  // blackbird-like phrases
  trill:   { weight: 2, gap: [6, 14],  level: 0.32, lp: 11000 }, // wren-like rattle
  twonote: { weight: 2, gap: [7, 16],  level: 0.38, lp: 10000 }, // great-tit "tea-cher"
  coo:     { weight: 1, gap: [14, 35], level: 0.7,  lp: 1100 },  // wood pigeon
  seep:    { weight: 1, gap: [9, 25],  level: 0.3,  lp: 12000 }, // thin high whistle
  chip:    { weight: 2, gap: [2.5, 8], level: 0.4,  lp: 10000 }, // contact calls
};
const WEIGHTS = Object.fromEntries(Object.entries(SPECIES).map(([k, v]) => [k, v.weight]));

function gainNode(ctx, value, dest) {
  const g = ctx.createGain();
  g.gain.value = value;
  if (dest) g.connect(dest);
  return g;
}

function noiseBuffer(ctx, secs, brown) {
  const len = Math.floor(ctx.sampleRate * secs);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    else d[i] = w;
  }
  return buf;
}

// Simple decaying-noise impulse: a soft forest "room".
function impulse(ctx, secs) {
  const len = Math.floor(ctx.sampleRate * secs);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  return buf;
}

// A phrase is a list of notes: start t, duration d, glide f0 -> f1, amplitude a.
function makePhrase(species, r) {
  const notes = [];
  let t = 0;
  const add = (d, f0, f1, a, extra = {}) => { notes.push({ t, d, f0, f1, a, ...extra }); t += d; };
  switch (species) {
    case 'flute': {
      const n = r.int(3, 6);
      for (let i = 0; i < n; i++) {
        const f0 = r.float(1500, 3000);
        add(r.float(0.08, 0.28), f0, f0 * r.float(0.75, 1.3), r.float(0.6, 1), { vib: 0.015 });
        t += r.float(0.03, 0.1);
      }
      if (r.chance(0.5)) {
        for (let i = 0, k = r.int(2, 4); i < k; i++) {
          const f0 = r.float(4000, 6000);
          add(0.03, f0, f0 * 0.8, 0.4);
          t += 0.02;
        }
      }
      break;
    }
    case 'trill': {
      const n = r.int(10, 22), f0 = r.float(3500, 6000), drift = r.float(-0.25, 0.15), gap = r.float(0.018, 0.03);
      for (let i = 0; i < n; i++) {
        const f = f0 * (1 + (drift * i) / n);
        add(0.035, f, f * 0.7, 0.5);
        t += gap;
      }
      break;
    }
    case 'twonote': {
      const f1 = r.float(4000, 5200), f2 = f1 * r.float(0.72, 0.85);
      for (let i = 0, reps = r.int(3, 7); i < reps; i++) {
        add(0.1, f1, f1 * 0.97, 0.6); t += 0.06;
        add(0.1, f2, f2 * 0.95, 0.55); t += 0.12;
      }
      break;
    }
    case 'coo': {
      const base = r.float(420, 560);
      const shape = [[0.35, 1], [0.55, 1.08], [0.3, 0.95], [0.3, 1], [0.45, 0.97]];
      for (const [d, k] of shape) {
        add(d, base * k * 0.97, base * k * 1.02, 0.8, { type: 'triangle' });
        t += 0.12;
      }
      break;
    }
    case 'seep': {
      for (let i = 0, n = r.int(1, 3); i < n; i++) {
        const f0 = r.float(7000, 8500);
        add(r.float(0.12, 0.2), f0, f0 * 0.93, 0.3);
        t += 0.4;
      }
      break;
    }
    default: { // chip
      for (let i = 0, n = r.int(1, 4); i < n; i++) {
        const f0 = r.float(3000, 5000);
        add(r.float(0.015, 0.025), f0, f0 * 0.85, 0.5);
        t += r.float(0.15, 0.5);
      }
    }
  }
  return notes;
}

export class Ambience {
  constructor(opts = {}) {
    this.opts = { master: 0.6, wind: 0.35, birds: 0.6, activeMins: 3, restMins: 10, ...opts };
    this.rng = new Rng(opts.seed ?? (Date.now() & 0xffffff));
    this.gust = 0.4;
    this.gustTarget = 0.4;
    this.gustTc = 3;
    this.windiness = 0.5; // from live weather: 0 still .. 1 gale
    this.rain = 0;
    this.hail = 0;
  }

  start() {
    if (this.ctx) return;
    const ctx = (this.ctx = new AudioContext());
    const out = ctx.createDynamicsCompressor();
    out.threshold.value = -18;
    out.ratio.value = 3;
    out.connect(ctx.destination);
    this.master = gainNode(ctx, this.opts.master, out);
    this.windBus = gainNode(ctx, this.opts.wind, this.master);
    this.birdBus = gainNode(ctx, this.opts.birds, this.master);
    this.verb = ctx.createConvolver();
    this.verb.buffer = impulse(ctx, 2.8);
    this.verb.connect(gainNode(ctx, 0.35, this.birdBus));
    this.startWind();
    this.startRain();
    this.birds = [];
    // A short first rest so the first birds arrive within a minute.
    this.phase = { kind: 'rest', start: ctx.currentTime, end: ctx.currentTime + this.rng.float(15, 40) };
    this.timer = setInterval(() => this.tick(), 200);
  }

  resume() { this.ctx?.resume(); }
  get running() { return this.ctx?.state === 'running'; }

  stop() {
    clearInterval(this.timer);
    this.ctx?.close();
    this.ctx = null;
  }

  setVolumes({ master, wind, birds }) {
    Object.assign(this.opts, Object.fromEntries(Object.entries({ master, wind, birds }).filter(([, v]) => v !== undefined)));
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.opts.master, now, 0.1);
    this.windBus.gain.setTargetAtTime(this.opts.wind, now, 0.1);
    this.birdBus.gain.setTargetAtTime(this.opts.birds, now, 0.1);
  }

  // Live weather: how windy (0..1) and how hard it is raining (0..1).
  setWeather({ wind, rain, hail }) {
    if (wind !== undefined && Math.abs(wind - this.windiness) > 0.02) { this.windiness = wind; this.nextGust = 0; }
    if (rain !== undefined) this.rain = rain;
    if (hail !== undefined) this.hail = hail;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.rainHiss.gain.setTargetAtTime(0.09 * this.rain, now, 3);
    this.rainLow.gain.setTargetAtTime(0.05 * this.rain * this.rain, now, 3);
  }

  // Rain: a soft hiss, a low wash in heavy rain, and scattered drips (in tick).
  startRain() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, 4, false);
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2600;
    bp.Q.value = 0.4;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    this.rainHiss = gainNode(ctx, 0, this.windBus);
    this.rainLow = gainNode(ctx, 0, this.windBus);
    src.connect(bp).connect(this.rainHiss);
    src.connect(lp).connect(this.rainLow);
    src.start();
    this.setWeather({});
  }

  // A raindrop tick, or a sharper, brighter one for hail.
  drip(now, hard = false) {
    const ctx = this.ctx, r = this.rng;
    const o = ctx.createOscillator();
    const f = hard ? r.float(3000, 7000) : r.float(1400, 4200);
    o.frequency.setValueAtTime(f, now);
    o.frequency.exponentialRampToValueAtTime(f * 0.6, now + 0.03);
    const g = gainNode(ctx, 0, null);
    g.gain.setValueAtTime((hard ? 0.022 : 0.015) * r.float(0.3, 1), now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + (hard ? 0.018 : 0.04));
    const pan = ctx.createStereoPanner();
    pan.pan.value = r.float(-0.9, 0.9);
    o.connect(g).connect(pan).connect(this.windBus);
    o.start(now);
    o.stop(now + 0.06);
  }

  // 0..1 smoothed gust strength, so the trees can sway with what you hear.
  windLevel() { return this.gust; }

  startWind() {
    const ctx = this.ctx;
    const body = ctx.createBufferSource();
    body.buffer = noiseBuffer(ctx, 6, true);
    body.loop = true;
    const leaves = ctx.createBufferSource();
    leaves.buffer = noiseBuffer(ctx, 5, false);
    leaves.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 400;
    this.windFilter.Q.value = 0.7;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3000;
    this.windBody = gainNode(ctx, 0, this.windBus);
    this.windLeaves = gainNode(ctx, 0, this.windBus);
    body.connect(this.windFilter).connect(this.windBody);
    leaves.connect(hp).connect(this.windLeaves);
    body.start();
    leaves.start();
    this.nextGust = 0;
  }

  // Wind is a slow random walk between lulls and swells.
  windTick(now) {
    this.gust += (this.gustTarget - this.gust) * (1 - Math.exp(-0.2 / this.gustTc));
    if (now < this.nextGust) return;
    const r = this.rng;
    // Mostly gentle: the walk is pulled toward calm, and swells are rare and capped.
    const cap = 0.45 + 0.6 * this.windiness, loud = 0.5 + this.windiness;
    let g = Math.min(cap, Math.max(0.08, this.gustTarget * 0.9 + r.float(-0.25, 0.25)));
    if (r.chance(0.15)) g = r.float(0.05, 0.2);
    else if (r.chance(0.05)) g = r.float(0.6, 0.85);
    const dur = r.float(5, 14);
    this.gustTarget = g;
    this.gustTc = dur / 3;
    this.windBody.gain.setTargetAtTime((0.025 + 0.08 * g) * loud, now, this.gustTc);
    this.windLeaves.gain.setTargetAtTime((0.004 + 0.018 * g ** 1.5) * loud, now, this.gustTc);
    this.windFilter.frequency.setTargetAtTime(250 + 500 * g, now, this.gustTc);
    this.nextGust = now + dur;
  }

  tick() {
    const now = this.ctx.currentTime;
    this.windTick(now);
    if (now >= this.phase.end) this.nextPhase(now);
    // Drips: a few per second in steady rain.
    for (let i = 0, n = this.rng.int(0, Math.round(this.rain * 4)); i < n; i++) this.drip(now + this.rng.float(0, 0.2));
    for (let i = 0, n = this.rng.int(0, Math.round(this.hail * 8)); i < n; i++) this.drip(now + this.rng.float(0, 0.2), true);
    // Birds go quiet in rain.
    const env = this.envelope(now) * (1 - 0.85 * Math.min(1, this.rain + this.hail));
    for (const b of this.birds) {
      if (now < b.next) continue;
      const gap = this.rng.range(SPECIES[b.species].gap) * b.tempo;
      if (this.rng.next() < env * b.eager) {
        const len = this.sing(b, now + 0.05, 0.35 + 0.65 * env);
        b.next = now + len + gap;
        this.answer(b, now + len);
      } else {
        b.next = now + gap * 0.5;
      }
    }
  }

  nextPhase(now) {
    const r = this.rng;
    if (this.phase.kind === 'rest') {
      const dur = 60 + this.opts.activeMins * 60 * r.float(0.6, 1.5);
      this.phase = { kind: 'active', start: now, end: now + dur };
      this.birds = Array.from({ length: r.int(2, 4) }, () => this.makeBird(now));
    } else {
      this.phase = { kind: 'rest', start: now, end: now + this.opts.restMins * 60 * r.float(0.7, 1.3) };
      this.birds = r.chance(0.6)
        ? [this.makeBird(now, { distant: true, eager: 0.25, species: r.chance(0.5) ? 'coo' : 'seep' })]
        : [];
    }
  }

  // Bird activity 0..1: fades in over 30 s and out over 30 s in an active phase.
  envelope(now) {
    const ph = this.phase;
    if (ph.kind === 'rest') return 0.35;
    return Math.max(0, Math.min(1, (now - ph.start) / 30, (ph.end - now) / 30));
  }

  makeBird(now, o = {}) {
    const r = this.rng;
    const species = o.species ?? r.weighted(WEIGHTS);
    return {
      species,
      pan: r.float(-0.85, 0.85),
      dist: o.distant ? r.float(0.6, 0.95) : r.float(0.1, 0.8),
      pitch: r.float(0.9, 1.12),
      tempo: r.float(0.85, 1.2),
      eager: o.eager ?? r.float(0.6, 1),
      phrases: Array.from({ length: r.int(2, 4) }, () => makePhrase(species, r)),
      cur: 0, reps: 0, repLimit: r.int(2, 4),
      next: now + r.float(1, 12),
    };
  }

  // Sometimes a neighbour answers shortly after a call ends.
  answer(caller, at) {
    for (const b of this.birds) {
      if (b !== caller && this.rng.chance(0.25)) b.next = Math.min(b.next, at + this.rng.float(0.8, 3));
    }
  }

  sing(b, when, vol) {
    const ctx = this.ctx, r = this.rng, sp = SPECIES[b.species];
    if (b.reps >= b.repLimit && b.phrases.length > 1) {
      b.cur = (b.cur + 1 + r.int(0, b.phrases.length - 2)) % b.phrases.length;
      b.reps = 0;
      b.repLimit = r.int(1, 4);
    }
    b.reps++;
    let notes = b.phrases[b.cur];
    if (notes.length > 2 && r.chance(0.2)) notes = notes.slice(0, r.int(Math.ceil(notes.length / 2), notes.length - 1));
    const tempo = b.tempo * r.float(0.94, 1.06);
    const shift = b.pitch * r.float(0.98, 1.02);

    // Per-call chain: amp -> distance lowpass -> pan -> bus, plus a reverb send
    // that grows with distance.
    const amp = gainNode(ctx, vol * (1 - b.dist * 0.75) * sp.level * 0.25);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(sp.lp, 12000 - b.dist * 8000);
    const pan = ctx.createStereoPanner();
    pan.pan.value = b.pan;
    const send = gainNode(ctx, 0.2 + 0.6 * b.dist, this.verb);
    amp.connect(lp).connect(pan).connect(this.birdBus);
    pan.connect(send);

    for (const n of notes) {
      const t0 = when + n.t * tempo, d = n.d * tempo;
      const o = ctx.createOscillator();
      o.type = n.type || 'sine';
      o.frequency.setValueAtTime(n.f0 * shift, t0);
      o.frequency.exponentialRampToValueAtTime(n.f1 * shift, t0 + d);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(n.a, t0 + Math.min(0.012, d * 0.3));
      g.gain.setTargetAtTime(0, t0 + d * 0.6, d * 0.15);
      if (n.vib) {
        const lfo = ctx.createOscillator();
        lfo.frequency.value = r.float(24, 34);
        lfo.connect(gainNode(ctx, n.f0 * shift * n.vib, o.frequency));
        lfo.start(t0);
        lfo.stop(t0 + d + 0.2);
      }
      o.connect(g).connect(amp);
      o.start(t0);
      o.stop(t0 + d + 0.2);
    }
    const last = notes[notes.length - 1];
    const len = (last.t + last.d) * tempo;
    setTimeout(() => { amp.disconnect(); lp.disconnect(); pan.disconnect(); send.disconnect(); },
      (when - ctx.currentTime + len + 4) * 1000);
    return len;
  }
}
