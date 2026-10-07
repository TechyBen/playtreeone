// Night sky: ~5000 real stars (to magnitude 6) placed by right ascension and
// declination, turned to your sky with latitude and local sidereal time.
// Rendered as 1-2 px points at the far plane (depth = 1), so trees hide them
// and the god-ray pass still treats them as open sky.

import * as THREE from 'three';
import { U } from './materials.js';
import { STAR_COUNT, STAR_DATA } from './stardata.js';

function decode() {
  const bin = atob(STAR_DATA);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const v = new Int16Array(bytes.buffer);
  const raDec = new Float32Array(STAR_COUNT * 2), magBv = new Float32Array(STAR_COUNT * 2);
  const rad = Math.PI / 180;
  for (let i = 0; i < STAR_COUNT; i++) {
    raDec[i * 2] = (v[i * 4] / 90) * rad;
    raDec[i * 2 + 1] = (v[i * 4 + 1] / 100) * rad;
    magBv[i * 2] = v[i * 4 + 2] / 100;
    magBv[i * 2 + 1] = v[i * 4 + 3] / 100;
  }
  return { raDec, magBv };
}

export function makeStars() {
  const { raDec, magBv } = decode();
  const g = new THREE.BufferGeometry();
  // `position` is unused but three.js needs it to size the draw.
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(STAR_COUNT * 3), 3));
  g.setAttribute('aRaDec', new THREE.BufferAttribute(raDec, 2));
  g.setAttribute('aMagBv', new THREE.BufferAttribute(magBv, 2));
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uRes: U.uRes, uTime: U.uTime, uFogDensity: U.uFogDensity,
      uLst: { value: 0 }, uLat: { value: 0.9 }, uNight: { value: 0 }, uStarScale: { value: 1 },
    },
    vertexShader: /* glsl */ `
uniform vec2 uRes;
uniform float uTime;
uniform float uFogDensity;
uniform float uLst;
uniform float uLat;
uniform float uNight;
uniform float uStarScale;
attribute vec2 aRaDec;
attribute vec2 aMagBv;
varying vec3 vCol;
varying float vB;
varying float vTw;
void main() {
  // Equatorial -> horizontal (azimuth clockwise from north; -Z is north, +X east).
  float H = uLst - aRaDec.x, d = aRaDec.y;
  float sinAlt = sin(uLat) * sin(d) + cos(uLat) * cos(d) * cos(H);
  float cosAlt = sqrt(max(0.0, 1.0 - sinAlt * sinAlt));
  float az = atan(-sin(H) * cos(d), sin(d) * cos(uLat) - cos(d) * sin(uLat) * cos(H));
  vec3 dir = vec3(sin(az) * cosAlt, sinAlt, -cos(az) * cosAlt);
  vec4 clip = projectionMatrix * viewMatrix * vec4(cameraPosition + dir * 380.0, 1.0);
  gl_Position = clip.xyww;

  float mag = aMagBv.x, bv = aMagBv.y;
  float flux = pow(10.0, -0.4 * (mag - 2.0)); // magnitude 2 = 1.0
  float horizon = smoothstep(0.0, 0.2, sinAlt); // extinction near the horizon
  vB = min(flux, 3.0) * uNight * horizon * exp(-uFogDensity * 25.0) * uStarScale;
  // Twinkle: a slow, soft swell (10-25 s, two waves so it never repeats),
  // a little stronger low in the sky. It only tints the star; it never
  // decides whether the star is drawn, so nothing blinks out.
  float ph = aRaDec.x * 37.0 + aRaDec.y * 19.0;
  float w1 = 0.25 + 0.35 * fract(ph * 0.173), w2 = 0.4 + 0.3 * fract(ph * 0.311);
  float amp = 0.05 + 0.1 * (1.0 - smoothstep(0.1, 0.6, sinAlt));
  vTw = 1.0 + amp * (0.6 * sin(uTime * w1 + ph) + 0.4 * sin(uTime * w2 + ph * 1.7));

  // B-V colour index: blue-white (hot) .. white .. orange (cool).
  vec3 hot = vec3(0.72, 0.82, 1.0), sunlike = vec3(1.0, 0.96, 0.88), cool = vec3(1.0, 0.72, 0.48);
  vCol = bv < 0.6 ? mix(hot, sunlike, clamp((bv + 0.3) / 0.9, 0.0, 1.0))
                  : mix(sunlike, cool, clamp((bv - 0.6) / 1.0, 0.0, 1.0));
  float px = max(1.0, floor(uRes.y / 240.0 + 0.5));
  gl_PointSize = (mag < 1.0 ? 2.0 : 1.0) * px;
}`,
    fragmentShader: /* glsl */ `
varying vec3 vCol;
varying float vB;
varying float vTw;
void main() {
  if (vB < 0.04) discard;
  // A floor keeps faint stars as visible single pixels after 5-bit quantising.
  gl_FragColor = vec4(vCol * (0.16 + 0.8 * min(vB, 1.0)) * vTw, 1.0);
}`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const points = new THREE.Points(g, mat);
  points.frustumCulled = false;
  return points;
}
