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

## Ambient mode

Add `?saver` to the URL for a hands-off view with no UI (`src/saver.js`). Scenes come in two styles: the original six are *sparse* (open woods around a wide clearing), and *dense* has a version of each of those plus Fern Hollow and Moss Ravine (closer stands, trails, slopes, ferns and moss). `&style=sparse` or `&style=dense` limits the rotation to one style. For example, `http://localhost:8173/?saver&mins=1` changes scene every minute. Click once to allow sound.
- **Scenes**: every *N* minutes (15 by default), fog rolls in over 20 s, a new preset, seed and camera path load behind it, and the fog clears over 25 s.
- **Camera**: a slow circle in the clearing, looking out at the trees, with slow head turns, a slight bob and a gently drifting sun.
- **Sound** (`src/ambience.js`, procedural, no samples): wind that wanders between lulls and swells and also drives the tree sway. Birds come in phases: a 30 s fade-in, a few minutes of activity, then about 10 minutes of quiet. Six call types are synthesised. Each bird has its own pitch, tempo and a small repertoire it repeats with variation, and neighbours sometimes answer. Sound can also be switched on from the panel in the normal view.

## How it works

| Stage | File | Notes |
|---|---|---|
| Seeded RNG and value noise | `src/rng.js` | Everything reproduces from `seed`. Tree sizes use a Weibull distribution. |
| Palettes | `src/presets.js` | Picked from `/examples`. Each preset has 5 ramps (leaf, leaf2, accent, bark, ground), plus an optional moss ramp, resampled to *N* steps like a CLUT. A preset can also set its land (`relief`: rolling amount, hillside `slope`, a `ravine`), how dense the forest is (`density`, `gaps`, `clearing`), `trails` kept clear through it, `ferns`, and `moss` on the bark. |
| Pixel leaves | `src/leafgen.js` | Rasterises blades (broad / lobed / round) or needle sprays (spray / tuft) into 4 cluster tiles. Tiles store **tone indices**, not colours, so a palette swap is free. |
| Tree skeletons | `src/treegen.js` | Honda / Weber–Penn style recursion: branch angle, length ratio, golden-angle roll, crown envelope, tropism, and da Vinci radius rule. Conifers are monopodial whorls on a cone envelope. Species: fir, larch, beech, oak, laurel, bare, snag, shrub, and for the Pacific Northwest scenes Douglas fir (long bare trunks, high narrow crowns), bigleaf maple (leaning, sparse) and sword fern (a rosette of frond cards with a pinnate leaf tile). |
| Geometry | `src/treemesh.js` | 3–6 sided tapered prisms for limbs. Leaf clusters are single quads that the vertex shader turns to face the camera. |
| Shaders | `src/materials.js` | Vertex snapping, affine UVs, ramp lookup with Bayer dithering, height fog with drifting noise, 1-tap nearest shadow map, dithered LOD cross-fade. |
| Impostors | `src/impostor.js` | Each variant is baked (lit and self-shadowed) from *N* angles into one atlas row. Far trees are Y-axis billboards that pick the nearest angle. |
| Post | `src/post.js` | The scene renders at e.g. 427×240 with depth. A composite pass adds radial-blur god rays (sky and fog-faded geometry let light through), then quantises to *n*-bit colour with ordered dither. The canvas is CSS-upscaled with `image-rendering: pixelated`. |

Useful knobs to tune pixel size and density: **pixel height**, **cluster tile px** (8–64), **leaf density**, **leaf size**, **palette steps**, **billboard px** and **billboard angles**, and **billboard distance**. Turn on **show atlases** to see the generated leaf tiles and baked billboards.

## Night sky

At night, with the real-time sun on, `src/stars.js` draws about 5,000 real stars down to magnitude 6. They're placed for your latitude and the current sidereal time and tinted by colour index. They fade in at dusk and dim near the horizon and in fog. Twinkling is a slow, soft swell of ±5–15% over 10–25 seconds (stronger low in the sky), so no star ever blinks out. The catalogue (`src/stardata.js`) is packed from [d3-celestial](https://github.com/ofrohn/d3-celestial)'s Hipparcos-derived `stars.6.json`, © 2015 Olaf Frohn, BSD 3-clause; see [licenses/d3-celestial.txt](licenses/d3-celestial.txt).

## Moon

`src/sun.js` also computes the moon's position and phase (the Almanac's low-precision series, about 0.3°, with parallax). `src/moon.js` draws it at its true size, about 0.5° across, which is roughly 2 pixels at 240 lines; the sky's glow gives it a soft halo. Each pixel is shaded as a sphere lit by the true sun direction, so at higher pixel heights the phase and the tilt of the crescent show. At a pixel or two, its brightness follows the lit fraction instead. At night the real moon is the light source: moonlit shadows and faint moonbeams, with brighter nights near full moon. It also shows faintly in the daytime sky. The **time shift (days)** slider moves the sun, moon and stars together to preview other nights.

## Weather

Under **Weather** in the panel, choose `live` to use [Open-Meteo](https://open-meteo.com/) (free, no key, non-commercial use), or `manual` to test with sliders. **look up town** turns a place name into coordinates, rounded to 0.1° (about 10 km), from a list built into the page (`src/citydata.js`: the 34,000 towns of 15,000 people or more, from [GeoNames](https://www.geonames.org), CC BY 4.0, see [licenses/geonames.txt](licenses/geonames.txt); written by `tools/cities/build.py`), so no place names are searched online. It also takes `lat, lon`, and `Portland, US` picks a country. Weather requests only ever send the rounded location. Readings refresh every 30 minutes and are cached for offline starts.

| Reading | Effect |
|---|---|
| Cloud cover | Dims the sun or moon, light shafts, stars and moon disc; flattens the sky |
| Visibility, fog codes | Fog density |
| Wind speed, gusts and direction | Wind strength and direction for the sway, the wind sound and the drift of rain and snow |
| Drizzle to heavy rain | Streaks get faster, longer and brighter with intensity; heavy rain adds ground splashes. Rain hiss and drips, fewer birds |
| Sleet (rain and snow together, freezing rain, snow grains) | Short white slanting streaks |
| Hail (thunderstorm with hail) | Bright pellets, white skitter on the ground, sharp ticking |
| Snowfall (or precipitation below about 1°C) | Drifting flakes; close ones are 3–7 px pixel crystals that slowly tumble between + and × |

**Wind sway** is one shared function used by branches, leaves and billboards, so leaves stay on their branches and switching to billboards doesn't pop. Trees bend from the root (sway grows with height squared), and gust waves drift across the forest in the wind direction, so you can see a gust roll through. Each tree has its own gentle oscillation and a little cross-wind wobble, with a small leaf flutter on top. Strength follows the gusts you hear when sound is on. Sway also applies in the shadow pass, so shadows move, and is off when billboards are baked.

Live weather can't run inside the claude.ai artifact, because artifacts block outside requests; the manual sliders still work there.

## Wildflowers

The forest floor gets the wildflowers that bloom where you are, at this time of year. The trees stay general. `src/flowerdata.js` holds 300 species and, for each 10° cell of the world, the dozen most often recorded in flower there, with the quarters of the year they bloom. `src/flowers.js` picks the ones flowering now in your cell, using the same rough location as the sun, estimated from your time zone. Nothing is looked up online. The **time shift** slider moves the season too. If fewer than three species flower that quarter, a few from the neighbouring quarters fill in.

Each species is an approximate likeness, not a botanical drawing: a petal colour, a centre colour, a head shape and a height. There are eight head shapes, drawn from code into leaf-card tiles like the leaves (`makeFlowerAtlas` in `src/leafgen.js`): daisy, cup, star, bell, spike, umbel, cluster and trumpet. Flowers grow in single-species clumps, mostly where there's light: round the clearing, along trail edges and in gaps. They're denser than in real life so you find them without hunting. Small ones are drawn about 1.4× larger than life, and tall ones at their true size. The **wildflowers** slider sets how many. `?flowers=0` in the address turns them off, and `?lat=…&lon=…` sets the place, for the sun as well as the flowers.

The data comes from [iNaturalist](https://www.inaturalist.org): counts of research-grade observations annotated as flowering. `tools/flowers/fetch_inat.py` downloads the counts per cell and quarter (cached, resumable, about one request a second). `tools/flowers/build.py` then picks the 300 species round robin across cells, so every region keeps its own common flowers rather than the best-recorded places taking over. It skips plants that aren't forest-floor wildflowers and gives each kept one its likeness, both automatically, in `tools/flowers/traits_auto.py`. That script reads each species' family from iNaturalist and uses it to skip grasses, sedges, trees, shrubs, cacti and water plants, and to choose the head shape and height from tables by family and genus. It measures the colours from the species' default iNaturalist photo, a 75 px thumbnail that's only read during the build and never kept: ignoring green, brown and dark pixels, the main colour round the middle is the petal, and a clearly different colour at the very middle is the centre. Hand corrections in `tools/flowers/traits.json` override the automatic ones (`traits.auto.json`), and `tools/flowers/sheet.html` shows every species' tiles for review. Then `build.py` writes `src/flowerdata.js`.

## References

- Honda, *Description of the form of trees by the parameters of the tree-like body* (1971)
- Aono & Kunii, *Botanical tree image generation* (1984)
- Weber & Penn, *Creation and Rendering of Realistic Trees* (SIGGRAPH 1995)
- Runions, Lane & Prusinkiewicz, *Modeling Trees with a Space Colonization Algorithm* (2007), a possible next step for broadleaf crowns
- Mitchell, *Volumetric Light Scattering as a Post-Process* (GPU Gems 3), the basis for the god rays

## Examples folder

`/examples` holds colour-reference photos. They're kept out of git, since some are Unsplash+ licensed. Only `examples/README.md` and `examples/dash.png` (our own render) are tracked.
