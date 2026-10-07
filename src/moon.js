// The moon: a chunky pixel disc at the far plane, about 4x its real size so it
// reads at 240 lines. Each pixel is shaded as a sphere lit by the true sun
// direction, so the phase and the tilt of the crescent come out right on their
// own. Drawn additively, so the unlit side simply isn't there against the sky.

import * as THREE from 'three';
import { U } from './materials.js';

const ANGULAR_RADIUS = 0.02; // radians (real moon: ~0.0045)

export function makeMoon() {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uFogDensity: U.uFogDensity,
      uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunTrue: { value: new THREE.Vector3(0, -1, 0) },
      uDay: { value: 0 },
      uCloud: { value: 0 },
      uSize: { value: ANGULAR_RADIUS },
    },
    vertexShader: /* glsl */ `
uniform vec3 uMoonDir;
uniform float uSize;
varying vec2 vUv;
varying vec3 vRight;
varying vec3 vUp;
varying vec3 vM;
void main() {
  vec3 m = normalize(uMoonDir);
  vec3 right = normalize(cross(m, abs(m.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(right, m);
  vUv = position.xy * 2.0;
  vRight = right; vUp = up; vM = m;
  vec3 p = cameraPosition + (m + (right * position.x + up * position.y) * 2.0 * uSize) * 370.0;
  gl_Position = (projectionMatrix * viewMatrix * vec4(p, 1.0)).xyww;
}`,
    fragmentShader: /* glsl */ `
uniform vec3 uSunTrue;
uniform float uDay;
uniform float uCloud;
uniform float uFogDensity;
varying vec2 vUv;
varying vec3 vRight;
varying vec3 vUp;
varying vec3 vM;
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
  // Sphere normal of the near face (the viewer looks along +m).
  vec3 n = normalize(vRight * vUv.x + vUp * vUv.y - vM * sqrt(1.0 - r2));
  float lit = smoothstep(-0.04, 0.1, dot(n, normalize(uSunTrue)));
  // Darker "seas" so it reads as the moon, not a coin.
  float maria = vnoise(vUv * 2.6 + 11.0) * 0.65 + vnoise(vUv * 6.0 + 3.0) * 0.35;
  float albedo = mix(0.6, 1.0, smoothstep(0.38, 0.62, maria));
  float limb = 0.8 + 0.2 * sqrt(1.0 - r2);
  vec3 col = vec3(0.95, 0.94, 0.88) * albedo * limb * lit;
  // Fainter by day, behind cloud, near the horizon and in thick fog.
  float vis = mix(1.0, 0.3, uDay) * (1.0 - 0.85 * uCloud) * smoothstep(-0.02, 0.08, vM.y) * exp(-uFogDensity * 12.0);
  gl_FragColor = vec4(col * vis, 1.0);
}`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  mesh.frustumCulled = false;
  return mesh;
}
