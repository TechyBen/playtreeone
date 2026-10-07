// Screensaver mode (index.html?saver). Everything is driven by the wall clock,
// so several windows (one per monitor) stay in sync without talking:
//  - time is cut into scenes of `mins` minutes; each scene's preset, seed and
//    camera path come from a hash of the scene number
//  - fog rolls in over the last 20 s, the scene swaps behind it, and the fog
//    clears over 25 s
//  - within a scene the camera circles slowly inside the clearing, looking out
//    at the trees, with slow head turns, a slight bob and a drifting sun
//
// Query options: mins, layout (panorama | same | separate), screen, pan
// (monitor offset from the primary: -1 = left), pa (primary aspect),
// audio (0/1), vol, wind, birds (0-100), rest, active (bird phase minutes).

import { PRESETS } from './presets.js';
import { Rng, hash2 } from './rng.js';
import { Ambience } from './ambience.js';

const FADE_OUT = 20, HOLD = 4, FADE_IN = 25, BOOT_FADE = 6;
const TAU = Math.PI * 2;
const smooth = t => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };

export function startSaver(api, q) {
  const { THREE, params, camera, controls, U, pipe } = api;
  const num = (k, d) => (q.get(k) !== null && q.get(k) !== '' && isFinite(+q.get(k)) ? +q.get(k) : d);
  const T = Math.max(60, num('mins', 15) * 60);
  const screen = num('screen', 0), pan = num('pan', 0), primaryAspect = num('pa', 0);
  const layout = q.get('layout') || 'panorama';
  const salt = layout === 'separate' ? screen * 7919 : 0;

  function plan(slot) {
    const r = new Rng(Math.floor(hash2(slot, 17, 4242 + salt) * 2 ** 31));
    const base = s => Math.floor(hash2(s, 3, 99 + salt) * PRESETS.length);
    let idx = base(slot);
    if (idx === base(slot - 1)) idx = (idx + 1) % PRESETS.length;
    const high = r.chance(0.2);
    return {
      slot,
      preset: PRESETS[idx].id,
      seed: r.int(1, 9999),
      cx: r.float(-2, 2), cz: r.float(-2, 2), R: r.float(3, 5.5),
      th0: r.float(0, TAU), dir: r.chance(0.5) ? 1 : -1,
      eye: high ? r.float(4, 7) : r.float(1.5, 2.6),
      bias: r.float(-0.6, 0.6),
      sunBias: r.float(0.2, 0.7),
      ph: [r.float(0, TAU), r.float(0, TAU), r.float(0, TAU)],
    };
  }

  let current = null, bootAt = null;
  let base = { el: 0, az: 0, fog: 0 };
  let sunAt = 0;
  const fogFrom = new THREE.Color(), fadeCol = new THREE.Color(), black = new THREE.Color(0, 0, 0);
  const look = new THREE.Vector3();

  function enter(p) {
    const prev = U.uFogColor.value.clone();
    params.seed = p.seed;
    api.applyPreset(p.preset);
    base = { el: params.sunElevation, az: params.sunAzimuth, fog: params.fogDensity };
    current = p;
    return prev;
  }

  let amb = null;
  if (num('audio', 1)) {
    amb = new Ambience({
      master: num('vol', 60) / 100, wind: num('wind', 35) / 100, birds: num('birds', 60) / 100,
      restMins: num('rest', 10), activeMins: num('active', 3),
    });
    amb.start();
    // A normal browser needs a click before sound; the screensaver host allows autoplay.
    if (!amb.running) addEventListener('pointerdown', () => amb.resume(), { once: true });
    api.ambience = amb;
  }

  api.beforeFrame.push(now => {
    const t = Date.now() / 1000;
    const slot = Math.floor(t / T), u = t - slot * T;
    if (!current) { enter(plan(slot)); fogFrom.copy(black); bootAt = now; }
    else if (current.slot !== slot) fogFrom.copy(enter(plan(slot)));
    const p = current;

    // Fog-roll transition.
    let fade = 0, col = U.uFogColor.value;
    if (u > T - FADE_OUT) {
      fade = smooth((u - (T - FADE_OUT)) / FADE_OUT);
    } else if (u < HOLD + FADE_IN) {
      fade = 1 - smooth((u - HOLD) / FADE_IN);
      col = fadeCol.lerpColors(fogFrom, U.uFogColor.value, smooth(u / HOLD));
    }
    const boot = 1 - smooth((now - bootAt) / 1000 / BOOT_FADE);
    if (boot > fade) { fade = boot; col = black; }
    pipe.uniforms.uFade.value = fade;
    pipe.uniforms.uFadeColor.value.copy(col);
    U.uFogDensity.value = pipe.uniforms.uFogDensity.value = base.fog * (1 + 3 * fade);

    // Sun: the real one from the clock (refreshed every few seconds), or a slow
    // drift around the preset's sun. Billboards are rebaked at each scene change.
    if (params.realSun) {
      if (now - sunAt > 5000) { sunAt = now; api.updateRealSun(); api.syncUniforms(); }
    } else if (!api.light.moon) {
      const el = THREE.MathUtils.degToRad(base.el + 2 * Math.sin((TAU * u) / T + p.ph[0]));
      const az = THREE.MathUtils.degToRad(base.az + 8 * Math.sin((TAU * u) / (T * 2) + p.ph[1]));
      U.uSunDir.value.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    }
    pipe.uniforms.uGodray.value = api.light.godrays * (0.75 + 0.25 * Math.sin((TAU * u) / 173 + p.ph[2])) * (1 - fade);

    // Trees sway with the wind you can hear.
    if (amb) U.uWind.value = 0.5 + 1.2 * amb.windLevel();

    // Camera: slow circle in the clearing, gaze outward, leaning toward the sun.
    const th = p.th0 + (p.dir * u * TAU) / (T * 1.6);
    const x = p.cx + Math.cos(th) * p.R, z = p.cz + Math.sin(th) * p.R;
    const y = api.terrainHeight(x, z) + p.eye + 0.1 * Math.sin(u * 0.4 + p.ph[0]);
    const out = Math.atan2(z, x);
    const sd = U.uSunDir.value;
    const sunPsi = Math.atan2(sd.z, sd.x);
    const toSun = Math.atan2(Math.sin(sunPsi - out), Math.cos(sunPsi - out));
    let psi = out + p.bias + toSun * p.sunBias
      + 0.45 * Math.sin((TAU * u) / 97 + p.ph[1]) + 0.2 * Math.sin((TAU * u) / 41 + p.ph[2]);
    const pitch = (p.eye > 3.5 ? 0 : 0.16) + 0.1 * Math.sin((TAU * u) / 131 + p.ph[0]);

    // Panorama: monitors beside the primary continue the view sideways.
    if (layout === 'panorama' && pan) {
      const vf = THREE.MathUtils.degToRad(camera.fov);
      const hf = a => 2 * Math.atan(Math.tan(vf / 2) * a);
      psi += Math.abs(pan) === 1 && primaryAspect
        ? (Math.sign(pan) * (hf(primaryAspect) + hf(camera.aspect))) / 2
        : pan * hf(camera.aspect);
    }
    camera.position.set(x, y, z);
    look.set(Math.cos(psi) * Math.cos(pitch), Math.sin(pitch), Math.sin(psi) * Math.cos(pitch));
    controls.target.copy(camera.position).addScaledVector(look, 5);
  });

  // In the Windows host, any real input ends the screensaver.
  const host = window.chrome?.webview;
  if (host) {
    const quit = () => host.postMessage('exit');
    let origin = null;
    for (const ev of ['keydown', 'mousedown', 'wheel', 'touchstart']) addEventListener(ev, quit);
    addEventListener('mousemove', e => {
      if (!origin) { origin = [e.screenX, e.screenY]; return; }
      if (Math.hypot(e.screenX - origin[0], e.screenY - origin[1]) > 12) quit();
    });
  }
}
