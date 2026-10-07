# treeps1 (playtreeone)

A PS1-style tree rendering experiment for the browser. Low-res, vertex-snapped, palette-dithered forests with fog, chunky shadow-mapped dapple and screen-space god rays. The trees are fully procedural: no photo textures. Leaves are rasterised as tiny "pixel candidate" sprites from code and noise. Branches come from L-system-style growth maths. Distant trees switch to baked billboards.

![Misty Dawn preset with the tuning panel](examples/dash.png)

## Run

It's a static site with no build step (Three.js and lil-gui load from a CDN through an import map).

```bash
python -m http.server 8173 --directory .
```

Then open http://localhost:8173. ES modules need a local server; double-clicking `index.html` won't work.

Controls: drag to orbit, right-drag to pan, wheel to zoom, WASD to walk (hold Shift to run). Preset pills are at the top left; every tuning knob is in the panel at the top right.

## How it works

| Stage | File | Notes |
|---|---|---|
| Seeded RNG and value noise | `src/rng.js` | Everything reproduces from `seed`. Tree sizes use a Weibull distribution. |
| Palettes | `src/presets.js` | Picked from `/examples`. Each preset has 5 ramps (leaf, leaf2, accent, bark, ground), resampled to *N* steps like a CLUT. |
| Pixel leaves | `src/leafgen.js` | Rasterises blades (broad / lobed / round) or needle sprays (spray / tuft) into 4 cluster tiles. Tiles store **tone indices**, not colours, so a palette swap is free. |
| Tree skeletons | `src/treegen.js` | Honda / Weber–Penn style recursion: branch angle, length ratio, golden-angle roll, crown envelope, tropism, and da Vinci radius rule. Conifers are monopodial whorls on a cone envelope. Species: fir, larch, beech, oak, laurel, bare, snag, shrub. |
| Geometry | `src/treemesh.js` | 3–6 sided tapered prisms for limbs. Leaf clusters are single quads that the vertex shader turns to face the camera. |
| Shaders | `src/materials.js` | Vertex snapping, affine UVs, ramp lookup with Bayer dithering, height fog with drifting noise, 1-tap nearest shadow map, dithered LOD cross-fade. |
| Impostors | `src/impostor.js` | Each variant is baked (lit and self-shadowed) from *N* angles into one atlas row. Far trees are Y-axis billboards that pick the nearest angle. |
| Post | `src/post.js` | The scene renders at e.g. 427×240 with depth. A composite pass adds radial-blur god rays (sky and fog-faded geometry let light through), then quantises to *n*-bit colour with ordered dither. The canvas is CSS-upscaled with `image-rendering: pixelated`. |

Useful knobs to tune pixel size and density: **pixel height**, **cluster tile px** (8–64), **leaf density**, **leaf size**, **palette steps**, **billboard px** and **billboard angles**, and **billboard distance**. Turn on **show atlases** to see the generated leaf tiles and baked billboards.

## References

- Honda, *Description of the form of trees by the parameters of the tree-like body* (1971)
- Aono & Kunii, *Botanical tree image generation* (1984)
- Weber & Penn, *Creation and Rendering of Realistic Trees* (SIGGRAPH 1995)
- Runions, Lane & Prusinkiewicz, *Modeling Trees with a Space Colonization Algorithm* (2007), a possible next step for broadleaf crowns
- Mitchell, *Volumetric Light Scattering as a Post-Process* (GPU Gems 3), the basis for the god rays

## Examples folder

`/examples` holds colour-reference photos. They're kept out of git, since some are Unsplash+ licensed. Only `examples/README.md` and `examples/dash.png` (our own render) are tracked.
