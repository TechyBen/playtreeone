import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { PRESETS, presetById } from './presets.js';
import { SPECIES, generateTree } from './treegen.js';
import { buildBranchGeometry, buildLeafGeometry, buildImpostorQuad } from './treemesh.js';
import { makeLeafAtlas, makeBarkTexture, makeGroundTexture } from './leafgen.js';
import {
  U, buildRampTexture, dataTexture, makeBranchMaterial, makeLeafMaterial, makeImpostorMaterial,
  makeGroundMaterial, makeSkyMaterial, makeMotesMaterial,
} from './materials.js';
import { bakeImpostor, makeShadowTarget, renderShadowMap } from './impostor.js';
import { Pipeline } from './post.js';
import { Rng, fbm, hash2 } from './rng.js';

// Palette hex values are used as-is (no sRGB<->linear conversion): PS1 style.
THREE.ColorManagement.enabled = false;

const params = {
  preset: PRESETS[0].id,
  // render
  pixelHeight: 240, vertexSnap: 1, affine: true, colorBits: 5, dither: 1,
  rampSteps: 6, rampDither: 0.8,
  // light & fog (filled from the preset)
  sunElevation: 14, sunAzimuth: 6, sunStrength: 0.75, godrays: 0.6,
  fogDensity: 0.03, fogBase: 2, fogFalloff: 0.08, fogNoise: 0.35,
  shadows: true, shadowRes: 512, shadowSize: 70,
  motes: true, wind: 1,
  // forest
  seed: 7, trees: 450, shrubs: 300, variants: 3, polyDetail: 1,
  lodDistance: 38, impostorViews: 8, impostorRes: 96,
  // leaves
  leafTile: 32, leafDensity: 1, leafScale: 1,
  showAtlases: false,
};

const AREA = 120; // half-size of the forest square, metres

// ---------------------------------------------------------------- renderer
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.info.autoReset = false;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 4 / 3, 0.1, 600);
camera.position.set(0, 1.7, 14);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 5, -4);
controls.enableDamping = true;
controls.maxDistance = 120;

const pipe = new Pipeline(renderer);
let shadowRT = makeShadowTarget(params.shadowRes);
const lightCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 300);

const barkTex = dataTexture(makeBarkTexture(3), true);
const groundTex = dataTexture(makeGroundTexture(5), true);
const branchMat = makeBranchMaterial(barkTex);

// ---------------------------------------------------------------- terrain
function terrainHeight(x, z) {
  const r = Math.hypot(x, z);
  const rough = 0.25 + 0.75 * THREE.MathUtils.smoothstep(r, 8, 40);
  return (fbm(x * 0.015 + 50, z * 0.015 + 50, 4, 3) - 0.5) * 8 * rough
    + Math.pow(Math.max(0, r - 30) / 90, 2) * 14;
}

const groundGeo = new THREE.PlaneGeometry(AREA * 2 + 60, AREA * 2 + 60, 96, 96);
groundGeo.rotateX(-Math.PI / 2);
{
  const p = groundGeo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, terrainHeight(p.getX(i), p.getZ(i)));
  groundGeo.computeVertexNormals();
}
const ground = new THREE.Mesh(groundGeo, makeGroundMaterial(groundTex));
ground.frustumCulled = false;
scene.add(ground);

const sky = new THREE.Mesh(new THREE.SphereGeometry(400, 24, 12), makeSkyMaterial());
sky.frustumCulled = false;
sky.renderOrder = -1;
scene.add(sky);

const motes = (() => {
  const n = 600, r = new Rng(99);
  const pos = new Float32Array(n * 3), seed = new Float32Array(n);
  for (let i = 0; i < n; i++) { pos.set([r.next(), r.next(), r.next()], i * 3); seed[i] = r.next(); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const m = new THREE.Points(g, makeMotesMaterial());
  m.frustumCulled = false;
  return m;
})();
scene.add(motes);

// ---------------------------------------------------------------- forest
const forest = new THREE.Group();
scene.add(forest);
let variants = [];
let leafAtlases = {}; // species -> { tex, img }

const preset = () => presetById(params.preset);

function sunDir() {
  const el = THREE.MathUtils.degToRad(params.sunElevation);
  const az = THREE.MathUtils.degToRad(params.sunAzimuth);
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

function disposeForest() {
  for (const v of variants) {
    v.branchGeo.dispose();
    v.leafGeo?.dispose();
    v.impGeo?.dispose();
    v.impMat?.dispose();
    v.imp?.rt.dispose();
  }
  for (const k in leafAtlases) { leafAtlases[k].tex.dispose(); leafAtlases[k].mat.dispose(); }
  forest.clear();
  variants = [];
  leafAtlases = {};
}

function bake(v) {
  v.imp?.rt.dispose();
  v.imp = bakeImpostor(renderer, v, { views: params.impostorViews, cellH: params.impostorRes });
  if (v.impMat) {
    v.impMat.uniforms.uAtlas.value = v.imp.texture;
    v.impMat.uniforms.uViews.value = v.imp.views;
  }
}

function rebakeAll() {
  const t0 = performance.now();
  variants.forEach(bake);
  status.bake = performance.now() - t0;
}

function buildForest() {
  const t0 = performance.now();
  disposeForest();
  const p = preset();
  const rng = new Rng(params.seed);
  const mix = { ...p.forest };
  const speciesIds = Object.keys(mix).filter(k => mix[k] > 0);
  if (params.shrubs > 0 && p.shrubs > 0) speciesIds.push('shrub');

  // Leaf atlases: one per species, shared by all its variants.
  for (const sid of speciesIds) {
    const sp = SPECIES[sid];
    if (!sp.leaf) continue;
    const img = makeLeafAtlas(sp.leaf, {
      tile: params.leafTile, density: params.leafDensity, scale: params.leafScale,
      seed: params.seed * 31 + sid.length * 7 + sid.charCodeAt(0),
    });
    const tex = dataTexture(img);
    leafAtlases[sid] = { img, tex, mat: makeLeafMaterial(tex, sp.ramp), kind: sp.leaf };
  }

  // Variants.
  const bySpecies = {};
  for (const sid of speciesIds) {
    bySpecies[sid] = [];
    for (let i = 0; i < params.variants; i++) {
      const tree = generateTree(sid, Math.floor(hash2(params.seed, i, sid.charCodeAt(0) + sid.length * 101) * 1e9));
      const v = {
        species: sid, tree,
        branchGeo: buildBranchGeometry(tree, params.polyDetail),
        leafGeo: tree.clusters.length && leafAtlases[sid] ? buildLeafGeometry(tree, params.leafTile) : null,
        branchMat, leafMat: leafAtlases[sid]?.mat, instances: [],
      };
      bySpecies[sid].push(v);
      variants.push(v);
    }
  }

  // Placement: jittered grid thinned by a density noise (natural gaps),
  // with a clearing around the start position. Sizes follow a Weibull.
  const place = (sid, x, z, scale) => {
    const list = bySpecies[sid];
    const v = list[rng.int(0, list.length - 1)];
    const pos = new THREE.Vector3(x, terrainHeight(x, z) - 0.1, z);
    const m = new THREE.Matrix4().compose(pos,
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.float(0, Math.PI * 2)),
      new THREE.Vector3(scale, scale, scale));
    v.instances.push({ pos, m, scale });
  };
  const treeMix = Object.fromEntries(Object.entries(mix).filter(([, w]) => w > 0));
  if (Object.keys(treeMix).length && params.trees > 0) {
    const cell = (AREA * 2) / Math.sqrt(params.trees / 0.75);
    for (let gz = -AREA; gz < AREA; gz += cell) {
      for (let gx = -AREA; gx < AREA; gx += cell) {
        const x = gx + rng.float(0.1, 0.9) * cell, z = gz + rng.float(0.1, 0.9) * cell;
        if (Math.hypot(x, z) < 9) continue;
        if (fbm(x * 0.03 + 9, z * 0.03 + 9, 3, params.seed) < 0.36) continue;
        place(rng.weighted(treeMix), x, z, 0.75 + rng.weibull(2.2, 0.35));
      }
    }
  }
  if (bySpecies.shrub) {
    const n = Math.round(params.shrubs * p.shrubs);
    for (let i = 0; i < n; i++) {
      const a = rng.float(0, Math.PI * 2), r = 4 + Math.pow(rng.next(), 0.7) * (AREA - 4);
      place('shrub', Math.cos(a) * r, Math.sin(a) * r, rng.float(0.7, 1.4));
    }
  }

  // Instanced meshes per variant: near (branches + leaf cards) and far (impostor).
  for (const v of variants) {
    const n = Math.max(1, v.instances.length);
    v.fadeNear = new THREE.InstancedBufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage);
    v.fadeFar = new THREE.InstancedBufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage);
    bake(v);
    v.branchGeo.setAttribute('aFade', v.fadeNear);
    v.near = new THREE.InstancedMesh(v.branchGeo, branchMat, n);
    v.near.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    v.near.frustumCulled = false;
    v.near.count = 0;
    forest.add(v.near);
    if (v.leafGeo) {
      v.leafGeo.setAttribute('aFade', v.fadeNear);
      v.leaves = new THREE.InstancedMesh(v.leafGeo, v.leafMat, n);
      v.leaves.instanceMatrix = v.near.instanceMatrix;
      v.leaves.frustumCulled = false;
      v.leaves.count = 0;
      forest.add(v.leaves);
    }
    v.impGeo = buildImpostorQuad();
    v.impGeo.setAttribute('aFade', v.fadeFar);
    v.impMat = makeImpostorMaterial(v.imp);
    v.far = new THREE.InstancedMesh(v.impGeo, v.impMat, n);
    v.far.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    v.far.frustumCulled = false;
    v.far.count = 0;
    forest.add(v.far);
  }
  status.build = performance.now() - t0;
  status.instances = variants.reduce((s, v) => s + v.instances.length, 0);
  if (params.showAtlases) showAtlases();
}

// Per frame: split each variant's instances into near / far with a dithered
// cross-fade band just inside the LOD distance.
function updateLod() {
  const cam = camera.position;
  const lod = params.lodDistance, band = Math.max(2, lod * 0.2);
  for (const v of variants) {
    let nn = 0, nf = 0;
    for (const inst of v.instances) {
      const d = cam.distanceTo(inst.pos);
      const f = THREE.MathUtils.smoothstep(d, lod - band, lod);
      if (f < 1) { v.near.setMatrixAt(nn, inst.m); v.fadeNear.array[nn++] = f; }
      if (f > 0) { v.far.setMatrixAt(nf, inst.m); v.fadeFar.array[nf++] = f; }
    }
    v.near.count = nn;
    if (v.leaves) v.leaves.count = nn;
    v.far.count = nf;
    v.near.instanceMatrix.needsUpdate = true;
    v.far.instanceMatrix.needsUpdate = true;
    v.fadeNear.needsUpdate = true;
    v.fadeFar.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- uniforms
let rampKey = '';
function syncUniforms() {
  const p = preset();
  U.uSunDir.value.copy(sunDir());
  U.uSunColor.value.set(p.sun.color);
  U.uSunStrength.value = params.sunStrength;
  U.uAmbient.value.set(p.ambient);
  U.uSkyTop.value.set(p.sky.top);
  U.uSkyHorizon.value.set(p.sky.horizon);
  U.uFogColor.value.set(p.fog.color);
  U.uFogDensity.value = params.fogDensity;
  U.uFogBase.value = params.fogBase;
  U.uFogFalloff.value = params.fogFalloff;
  U.uFogNoise.value = params.fogNoise;
  U.uAccentChance.value = p.accent;
  U.uSnap.value = params.vertexSnap;
  U.uAffine.value = params.affine ? 1 : 0;
  U.uRampSteps.value = params.rampSteps;
  U.uRampDither.value = params.rampDither;
  U.uWind.value = params.wind;
  U.uShadowOn.value = params.shadows ? 1 : 0;
  const key = p.id + ':' + params.rampSteps;
  if (key !== rampKey) {
    U.uRamp.value?.dispose?.();
    U.uRamp.value = buildRampTexture(p, params.rampSteps);
    rampKey = key;
  }
  const pu = pipe.uniforms;
  pu.uGodray.value = params.godrays;
  pu.uSunColor.value.set(p.sun.color);
  pu.uFogDensity.value = params.fogDensity;
  pu.uBits.value = params.colorBits;
  pu.uDither.value = params.dither;
  motes.visible = params.motes;
}

function applyPreset(id) {
  const p = presetById(id);
  Object.assign(params, {
    preset: p.id,
    sunElevation: p.sun.elevation, sunAzimuth: p.sun.azimuth, sunStrength: p.sun.strength, godrays: p.sun.godrays,
    fogDensity: p.fog.density, fogBase: p.fog.base, fogFalloff: p.fog.falloff, fogNoise: p.fog.noise,
  });
  syncUniforms();
  gui?.controllersRecursive().forEach(c => c.updateDisplay());
  document.querySelectorAll('#presets button').forEach(b => b.classList.toggle('on', b.dataset.id === p.id));
  buildForest();
}

function resize() {
  const h = Math.round(params.pixelHeight);
  const w = Math.max(1, Math.round((h * innerWidth) / innerHeight));
  renderer.setSize(w, h, false);
  pipe.setSize(w, h);
  U.uRes.value.set(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

// ---------------------------------------------------------------- UI
const status = { build: 0, bake: 0, instances: 0 };

const pills = document.getElementById('presets');
for (const p of PRESETS) {
  const b = document.createElement('button');
  b.textContent = p.name;
  b.dataset.id = p.id;
  b.onclick = () => applyPreset(p.id);
  pills.appendChild(b);
}

const gui = new GUI({ title: 'treeps1' });
gui.close();
const rebuild = () => buildForest();
{
  const f = gui.addFolder('Render');
  f.add(params, 'pixelHeight', 120, 720, 1).name('pixel height').onChange(resize);
  f.add(params, 'vertexSnap', 0, 4, 0.25).name('vertex snap px').onChange(syncUniforms);
  f.add(params, 'affine').name('affine textures').onChange(syncUniforms);
  f.add(params, 'colorBits', 2, 8, 1).name('colour bits').onChange(syncUniforms);
  f.add(params, 'dither', 0, 2, 0.05).name('screen dither').onChange(syncUniforms);
  f.add(params, 'rampSteps', 2, 16, 1).name('palette steps').onChange(syncUniforms).onFinishChange(rebakeAll);
  f.add(params, 'rampDither', 0, 2, 0.05).name('palette dither').onChange(syncUniforms).onFinishChange(rebakeAll);
}
{
  const f = gui.addFolder('Light & fog');
  f.add(params, 'sunElevation', 2, 85, 1).name('sun elevation').onChange(syncUniforms).onFinishChange(rebakeAll);
  f.add(params, 'sunAzimuth', -180, 180, 1).name('sun azimuth').onChange(syncUniforms).onFinishChange(rebakeAll);
  f.add(params, 'sunStrength', 0, 2, 0.05).name('sun strength').onChange(syncUniforms).onFinishChange(rebakeAll);
  f.add(params, 'godrays', 0, 2, 0.05).name('god rays').onChange(syncUniforms);
  f.add(params, 'shadows').onChange(syncUniforms);
  f.add(params, 'shadowRes', [128, 256, 512, 1024, 2048]).name('shadow res').onChange(v => {
    shadowRT.dispose();
    shadowRT = makeShadowTarget(v);
  });
  f.add(params, 'shadowSize', 20, 160, 1).name('shadow area m');
  f.add(params, 'fogDensity', 0, 0.12, 0.001).name('fog density').onChange(syncUniforms);
  f.add(params, 'fogBase', -5, 20, 0.5).name('fog base height').onChange(syncUniforms);
  f.add(params, 'fogFalloff', 0, 0.4, 0.005).name('fog falloff').onChange(syncUniforms);
  f.add(params, 'fogNoise', 0, 1, 0.01).name('fog noise').onChange(syncUniforms);
  f.add(params, 'motes').name('dust motes').onChange(syncUniforms);
  f.add(params, 'wind', 0, 3, 0.05).onChange(syncUniforms);
}
{
  const f = gui.addFolder('Forest');
  f.add(params, 'seed', 1, 9999, 1).onFinishChange(rebuild);
  f.add(params, 'trees', 0, 2000, 10).onFinishChange(rebuild);
  f.add(params, 'shrubs', 0, 2000, 10).onFinishChange(rebuild);
  f.add(params, 'variants', 1, 6, 1).name('variants / species').onFinishChange(rebuild);
  f.add(params, 'polyDetail', 0.5, 2, 0.25).name('branch sides x').onFinishChange(rebuild);
  f.add(params, 'lodDistance', 0, 150, 1).name('billboard distance');
  f.add(params, 'impostorViews', [4, 6, 8, 12, 16]).name('billboard angles').onChange(rebakeAll);
  f.add(params, 'impostorRes', [24, 32, 48, 64, 96, 128, 192]).name('billboard px').onChange(rebakeAll);
}
{
  const f = gui.addFolder('Leaves');
  f.add(params, 'leafTile', [8, 12, 16, 24, 32, 48, 64]).name('cluster tile px').onChange(rebuild);
  f.add(params, 'leafDensity', 0.1, 3, 0.05).name('leaf density').onFinishChange(rebuild);
  f.add(params, 'leafScale', 0.4, 3, 0.05).name('leaf size').onFinishChange(rebuild);
  f.add(params, 'showAtlases').name('show atlases').onChange(v => (v ? showAtlases() : hideAtlases()));
}

// Debug overlay: leaf atlases (coloured through the palette) and baked impostors.
const atlasBox = document.getElementById('atlas');
function hideAtlases() { atlasBox.style.display = 'none'; atlasBox.innerHTML = ''; }
function showAtlases() {
  atlasBox.innerHTML = '';
  atlasBox.style.display = 'block';
  const p = preset();
  const ramp = (row, t) => {
    const stops = p.ramps[row];
    const hex = stops[Math.min(stops.length - 1, Math.round(t * (stops.length - 1)))];
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const addCanvas = (label, w, h, fill, zoom) => {
    const div = document.createElement('div');
    div.textContent = label;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.style.width = w * zoom + 'px';
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    fill(img.data);
    ctx.putImageData(img, 0, 0);
    div.appendChild(c);
    atlasBox.appendChild(div);
  };
  for (const [sid, a] of Object.entries(leafAtlases)) {
    const row = SPECIES[sid].ramp ? 'leaf2' : 'leaf';
    addCanvas(`${sid} leaves (${a.kind}, ${a.img.width}x${a.img.height})`, a.img.width, a.img.height, d => {
      for (let i = 0; i < d.length; i += 4) {
        const s = a.img.data;
        if (!s[i + 3]) continue;
        const rgb = ramp(s[i + 1] > 127 ? 'bark' : row, s[i] / 255);
        d.set([...rgb, 255], i);
      }
    }, Math.max(2, Math.round(256 / a.img.width)));
  }
  for (const v of variants.filter((_, i) => i % params.variants === 0)) {
    const { rt } = v.imp;
    const w = rt.width, h = rt.height, buf = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    addCanvas(`${v.species} billboard (${params.impostorViews} views, ${w}x${h})`, w, h, d => {
      for (let y = 0; y < h; y++) d.set(buf.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    }, Math.max(1, Math.min(3, Math.floor(400 / w))));
  }
}

// WASD / arrows walk the camera and its orbit target together.
const keys = new Set();
addEventListener('keydown', e => { if (!(e.target instanceof HTMLInputElement)) keys.add(e.code); });
addEventListener('keyup', e => keys.delete(e.code));
function walk(dt) {
  const f = new THREE.Vector3();
  camera.getWorldDirection(f);
  f.y = 0;
  f.normalize();
  const r = new THREE.Vector3(-f.z, 0, f.x);
  const m = new THREE.Vector3();
  if (keys.has('KeyW') || keys.has('ArrowUp')) m.add(f);
  if (keys.has('KeyS') || keys.has('ArrowDown')) m.sub(f);
  if (keys.has('KeyD') || keys.has('ArrowRight')) m.add(r);
  if (keys.has('KeyA') || keys.has('ArrowLeft')) m.sub(r);
  if (m.lengthSq() === 0) return;
  m.normalize().multiplyScalar(dt * (keys.has('ShiftLeft') ? 18 : 6));
  // Follow the terrain so the head (camera + orbit target) keeps its height above ground.
  const p = camera.position;
  m.y = terrainHeight(p.x + m.x, p.z + m.z) - terrainHeight(p.x, p.z);
  p.add(m);
  controls.target.add(m);
}

// ---------------------------------------------------------------- loop
const hud = document.getElementById('hud');
const fwd = new THREE.Vector3();
let last = performance.now(), fpsAcc = 0, fpsN = 0, fps = 0;

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  renderer.info.reset();
  walk(dt);
  controls.update();
  const floor = terrainHeight(camera.position.x, camera.position.z) + 0.6;
  if (camera.position.y < floor) {
    // Lift the target too, so the clamp doesn't tilt the view direction.
    controls.target.y += floor - camera.position.y;
    camera.position.y = floor;
  }
  U.uTime.value = now / 1000;
  updateLod();

  // Shadow map follows the view, snapped to texels to avoid shimmering.
  if (params.shadows) {
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    fwd.normalize();
    const S = params.shadowSize, texel = S / params.shadowRes;
    const c = camera.position.clone().addScaledVector(fwd, S * 0.3);
    c.x = Math.round(c.x / texel) * texel;
    c.z = Math.round(c.z / texel) * texel;
    c.y = terrainHeight(c.x, c.z);
    lightCam.left = -S / 2; lightCam.right = S / 2; lightCam.top = S / 2; lightCam.bottom = -S / 2;
    lightCam.updateProjectionMatrix();
    lightCam.position.copy(c).addScaledVector(U.uSunDir.value, 150);
    lightCam.lookAt(c);
    lightCam.updateMatrixWorld();
    sky.visible = false;
    motes.visible = false;
    renderShadowMap(renderer, scene, lightCam, shadowRT, 0.35);
    sky.visible = true;
    motes.visible = params.motes;
  }

  renderer.setRenderTarget(pipe.rt);
  renderer.setClearColor(U.uFogColor.value, 1);
  renderer.clear();
  renderer.render(scene, camera);
  pipe.composite(camera, U.uSunDir.value);

  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
  const info = renderer.info.render;
  hud.textContent =
    `${fps.toFixed(0)} fps  ${U.uRes.value.x}x${U.uRes.value.y}  ` +
    `${(info.triangles / 1000).toFixed(1)}k tris  ${info.calls} draws\n` +
    `${status.instances} plants, ${variants.length} variants  build ${status.build.toFixed(0)}ms  bake ${status.bake.toFixed(0)}ms`;
  requestAnimationFrame(frame);
}

resize();
applyPreset(params.preset);
requestAnimationFrame(frame);

// Handy for poking at things from the devtools console.
window.treeps1 = { THREE, params, variants: () => variants, camera, controls, U, buildForest, rebakeAll };
