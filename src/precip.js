// Precipitation in boxes that wrap around the camera (like the dust motes), so
// a few thousand particles fill the view wherever you are.
//
//  rain   - streaks whose speed, length and brightness grow with intensity:
//           drizzle is slow, short and faint; a downpour is long, fast and
//           bright, with splashes flickering on the ground
//  sleet  - short, whitish, mid-speed streaks
//  hail   - small bright pellets falling fast, skittering on the ground
//  snow   - drifting flakes; close ones are 3-7 px pixel-art crystals that
//           slowly "tumble" between + and x shapes
//
// Everything drifts with the shared wind direction.

import * as THREE from 'three';
import { U } from './materials.js';

const BOX = 26;

const WRAP = /* glsl */ `
uniform float uBox;
uniform float uTime;
uniform float uAmount;
uniform float uFall;
uniform vec2 uDrift;
uniform float uFogDensity;
uniform vec2 uRes;
attribute vec3 aSeed;
float pxScale() { return max(1.0, floor(uRes.y / 240.0 + 0.5)); }
vec3 wrapped(out float keep, out float fade) {
  vec3 c = cameraPosition;
  vec3 p = aSeed * uBox;
  p.y -= uTime * uFall * (0.85 + 0.3 * fract(aSeed.x * 53.1));
  p.xz += uDrift * uTime;
  p = mod(p - c + uBox * 0.5, uBox) - uBox * 0.5 + c;
  keep = step(fract(aSeed.z * 91.7 + aSeed.x * 13.3), uAmount);
  float dist = length(p - c);
  fade = (1.0 - smoothstep(uBox * 0.2, uBox * 0.5, dist)) * step(0.6, dist) * exp(-dist * uFogDensity);
  return p;
}
`;

function geometry(n, perParticle) {
  const seeds = new Float32Array(n * perParticle * 3), ends = new Float32Array(n * perParticle);
  for (let i = 0; i < n; i++) {
    const s = [Math.random(), Math.random(), Math.random()];
    for (let k = 0; k < perParticle; k++) {
      seeds.set(s, (i * perParticle + k) * 3);
      ends[i * perParticle + k] = k;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * perParticle * 3), 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
  g.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
  return g;
}

function material(extraUniforms, vs, fs) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uRes: U.uRes, uTime: U.uTime, uFogColor: U.uFogColor, uFogDensity: U.uFogDensity,
      uBox: { value: BOX }, uAmount: { value: 0 }, uFall: { value: 9 }, uDrift: { value: new THREE.Vector2() },
      ...extraUniforms,
    },
    vertexShader: WRAP + vs,
    fragmentShader: fs,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}

// Falling streaks (rain and sleet).
function streaks(n) {
  return new THREE.LineSegments(geometry(n, 2), material(
    { uLen: { value: 0.45 }, uBright: { value: 0.45 }, uTint: { value: 0.08 } }, /* glsl */ `
uniform float uLen;
attribute float aEnd;
varying float vA;
void main() {
  float keep, fade;
  vec3 p = wrapped(keep, fade);
  // The tail trails back along the fall direction.
  p -= normalize(vec3(uDrift.x, -uFall, uDrift.y)) * aEnd * uLen;
  vA = keep * fade;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`, /* glsl */ `
uniform vec3 uFogColor;
uniform float uBright;
uniform float uTint;
varying float vA;
void main() {
  if (vA < 0.02) discard;
  gl_FragColor = vec4((uFogColor * 0.5 + uTint) * vA * uBright, 1.0);
}`));
}

// Splashes (rain) and skittering pellets (hail): brief flashes at random
// spots on the ground near the camera, each re-placed every cycle.
function splashes(n) {
  return new THREE.Points(geometry(n, 1), material(
    { uGround: { value: 0 }, uWhite: { value: 0 } }, /* glsl */ `
uniform float uGround;
varying float vA;
float h11(float x) { return fract(sin(x * 127.1) * 43758.5453); }
void main() {
  float period = 0.35 + 0.45 * aSeed.y;
  float t = uTime / period + aSeed.z * 17.0;
  float cycle = floor(t), life = fract(t);
  float r = 12.0 * sqrt(h11(cycle + aSeed.x * 91.0));
  float a = 6.2831 * h11(cycle * 1.7 + aSeed.y * 57.0);
  vec3 p = vec3(cameraPosition.x + cos(a) * r, uGround + 0.03, cameraPosition.z + sin(a) * r);
  float keep = step(fract(aSeed.z * 91.7 + aSeed.x * 13.3), uAmount);
  vA = keep * (1.0 - smoothstep(0.0, 0.18, life)) * step(1.0, r) * exp(-r * uFogDensity);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  gl_PointSize = (r < 5.0 ? 2.0 : 1.0) * pxScale();
}`, /* glsl */ `
uniform vec3 uFogColor;
uniform float uWhite;
varying float vA;
void main() {
  if (vA < 0.05) discard;
  gl_FragColor = vec4(mix(uFogColor * 0.6 + 0.1, vec3(0.95), uWhite) * vA * 0.6, 1.0);
}`));
}

// Round pellets / flakes drawn as points. uFlakes = 1 gives close flakes
// pixel-art crystal shapes; 0 draws plain round pellets (hail).
function pellets(n, flakes) {
  return new THREE.Points(geometry(n, 1), material(
    { uFlakes: { value: flakes }, uWobble: { value: flakes ? 0.35 : 0 } }, /* glsl */ `
uniform float uFlakes;
uniform float uWobble;
varying float vA;
varying float vSize;
varying float vKind;
varying float vSpin;
void main() {
  float keep, fade;
  vec3 p = wrapped(keep, fade);
  p.x += sin(uTime * 0.9 + aSeed.y * 40.0) * uWobble;
  p.z += cos(uTime * 0.7 + aSeed.x * 30.0) * uWobble;
  vA = keep * fade;
  float dist = length(p - cameraPosition);
  // Odd pixel sizes so a crystal has a centre pixel.
  vSize = uFlakes > 0.5
    ? (dist < 2.5 ? (aSeed.y > 0.5 ? 7.0 : 5.0) : dist < 4.5 ? 5.0 : dist < 9.0 ? 3.0 : 1.0)
    : (dist < 4.0 ? 3.0 : dist < 10.0 ? 2.0 : 1.0);
  vKind = fract(aSeed.x * 37.3);
  vSpin = step(0.5, fract(uTime * (0.15 + 0.2 * aSeed.z) + aSeed.y));
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  gl_PointSize = vSize * pxScale();
}`, /* glsl */ `
uniform vec3 uFogColor;
uniform float uFlakes;
varying float vA;
varying float vSize;
varying float vKind;
varying float vSpin;
void main() {
  if (vA < 0.02) discard;
  vec2 c = floor(gl_PointCoord * vSize) - floor(vSize * 0.5); // pixel offset from centre
  float r = floor(vSize * 0.5);
  float d = max(abs(c.x), abs(c.y));
  float glow = 1.0;
  if (uFlakes > 0.5 && vSize > 2.0) {
    bool axis = c.x == 0.0 || c.y == 0.0;
    bool diag = abs(c.x) == abs(c.y);
    if (vSpin > 0.5) { bool t = axis; axis = diag; diag = t; } // slow tumble: + <-> x
    bool on;
    if (vSize < 4.0) on = axis;                                             // tiny +
    else if (vKind < 0.34) on = axis || (diag && d <= r - 1.0);             // + with short x stubs
    else if (vKind < 0.67) on = axis || diag;                               // full 8-arm star
    else on = (axis && d != r - 1.0) || (diag && d == 1.0);                 // arms with gaps: dendrite
    if (!on) discard;
    glow = d == 0.0 ? 1.0 : 0.75 - 0.25 * d / max(r, 1.0);
  } else if (uFlakes < 0.5 && vSize > 2.5 && d >= r && abs(c.x) == abs(c.y)) {
    discard; // round-ish pellet: drop the corners
  }
  gl_FragColor = vec4((uFogColor * 0.3 + 0.7) * min(1.0, vA * 1.3) * glow, 1.0);
}`));
}

export function makePrecip() {
  const rain = streaks(2500);
  const sleet = streaks(1600);
  const splash = splashes(700);
  const hail = pellets(1400, 0);
  const snow = pellets(2600, 1);
  const all = [rain, sleet, splash, hail, snow];
  for (const o of all) o.frustumCulled = false;
  const group = new THREE.Group();
  group.add(...all);

  const lerp = (a, b, t) => a + (b - a) * t;
  const set = (o, amount) => { o.material.uniforms.uAmount.value = amount; o.visible = amount > 0.001; };

  return {
    group,
    // dir: unit [x, z] the wind blows toward; wind 0..1.
    set({ rain: r = 0, sleet: sl = 0, hail: h = 0, snow: s = 0, wind = 0.3, dir = [0.9, -0.42] }) {
      // Drizzle -> downpour: more drops, and each faster, longer and brighter.
      const ru = rain.material.uniforms;
      set(rain, Math.min(1, 0.25 + 0.75 * r) * (r > 0.001 ? 1 : 0));
      ru.uFall.value = lerp(4, 11, r);
      ru.uLen.value = lerp(0.1, 0.6, r);
      ru.uBright.value = lerp(0.22, 0.55, r);
      const su = sleet.material.uniforms;
      set(sleet, sl);
      su.uFall.value = 4.5;
      su.uLen.value = 0.14;
      su.uBright.value = 0.7;
      su.uTint.value = 0.35;
      set(hail, h);
      hail.material.uniforms.uFall.value = 12;
      set(snow, s);
      snow.material.uniforms.uFall.value = 1.1;
      // Splashes only in real rain; white skitter for hail.
      const splashAmount = Math.max(Math.max(0, r - 0.25) / 0.75, h);
      set(splash, splashAmount);
      splash.material.uniforms.uWhite.value = h > r ? 1 : 0;
      // Lighter things drift further in the wind.
      for (const [o, k] of [[rain, 1.2], [sleet, 1.8], [hail, 0.6], [snow, 2.4]]) {
        o.material.uniforms.uDrift.value.set(dir[0], dir[1]).multiplyScalar(wind * k * 3.5);
      }
    },
    // Splashes sit on the ground under the camera (terrain is smooth nearby).
    setGround(y) { splash.material.uniforms.uGround.value = y; },
  };
}
