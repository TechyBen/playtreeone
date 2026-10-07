// Rain streaks and snowflakes in a box that wraps around the camera (like the
// dust motes), so a few thousand particles fill the view wherever you are.
// Intensity 0..1 decides how many of them are switched on.

import * as THREE from 'three';
import { U } from './materials.js';

const BOX = 26;

const WRAP = /* glsl */ `
uniform float uBox;
uniform float uTime;
uniform float uAmount;
uniform float uFall;
uniform vec2 uDrift;
uniform vec3 uFogColor;
uniform float uFogDensity;
attribute vec3 aSeed;
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

function material(fall, vs, fs) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uRes: U.uRes, uTime: U.uTime, uFogColor: U.uFogColor, uFogDensity: U.uFogDensity,
      uBox: { value: BOX }, uAmount: { value: 0 }, uFall: { value: fall }, uDrift: { value: new THREE.Vector2() },
    },
    vertexShader: WRAP + vs,
    fragmentShader: fs,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}

export function makePrecip() {
  const rain = new THREE.LineSegments(geometry(2500, 2), material(9, /* glsl */ `
attribute float aEnd;
varying float vA;
void main() {
  float keep, fade;
  vec3 p = wrapped(keep, fade);
  // Tail of the streak trails back along the fall direction.
  p -= normalize(vec3(uDrift.x, -uFall, uDrift.y)) * aEnd * 0.45;
  vA = keep * fade;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`, /* glsl */ `
uniform vec3 uFogColor;
varying float vA;
void main() {
  if (vA < 0.02) discard;
  gl_FragColor = vec4((uFogColor * 0.5 + 0.08) * vA * 0.45, 1.0);
}`));

  const snow = new THREE.Points(geometry(2600, 1), material(1.1, /* glsl */ `
uniform vec2 uRes;
varying float vA;
void main() {
  float keep, fade;
  vec3 p = wrapped(keep, fade);
  p.x += sin(uTime * 0.9 + aSeed.y * 40.0) * 0.35;
  p.z += cos(uTime * 0.7 + aSeed.x * 30.0) * 0.35;
  vA = keep * fade;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  gl_PointSize = (length(p - cameraPosition) < 9.0 ? 2.0 : 1.0) * max(1.0, floor(uRes.y / 240.0 + 0.5));
}`, /* glsl */ `
uniform vec3 uFogColor;
varying float vA;
void main() {
  if (vA < 0.02) discard;
  gl_FragColor = vec4((uFogColor * 0.3 + 0.7) * min(1.0, vA * 1.3), 1.0);
}`));

  for (const o of [rain, snow]) o.frustumCulled = false;
  const group = new THREE.Group();
  group.add(rain, snow);

  return {
    group,
    set({ rain: r = 0, snow: s = 0, wind = 0.3 }) {
      rain.material.uniforms.uAmount.value = r;
      snow.material.uniforms.uAmount.value = s;
      rain.visible = r > 0.001;
      snow.visible = s > 0.001;
      const drift = wind * 2.5; // blow roughly from the west
      rain.material.uniforms.uDrift.value.set(drift, drift * 0.3);
      snow.material.uniforms.uDrift.value.set(drift * 0.6, drift * 0.2);
    },
  };
}
