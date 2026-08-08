# CesiumJS - WebGPU Fork

## THIS FORK IS A MASSIVE WORK IN PROGRESS — HUGE OVERHAUL TO NOT JUST ADD WEBGPU BUT FIX TECH DEBT AND ARCHITECTURE ISSUES — NOT CURRENTLY READY FOR USE

[![Build Status](https://github.com/CesiumGS/cesium/actions/workflows/dev.yml/badge.svg)](https://github.com/CesiumGS/cesium/actions/workflows/dev.yml)
[![npm](https://img.shields.io/npm/v/cesium)](https://www.npmjs.com/package/cesium)
[![Docs](https://img.shields.io/badge/docs-online-orange.svg)](https://cesium.com/learn/)

![Cesium](https://github.com/CesiumGS/cesium/wiki/logos/Cesium_Logo_Color.jpg)

CesiumJS is a JavaScript library for creating 3D globes and 2D maps in a web browser without a plugin. It uses WebGL for hardware-accelerated graphics, and is cross-platform, cross-browser, and tuned for dynamic-data visualization.

Built on open formats, CesiumJS is designed for robust interoperability and scaling for massive datasets.

---

[**Examples**](https://sandcastle.cesium.com/) :earth_asia: [**Docs**](https://cesium.com/learn/cesiumjs-learn/) :earth_americas: [**Website**](https://cesium.com/cesiumjs) :earth_africa: [**Forum**](https://community.cesium.com/) :earth_asia: [**User Stories**](https://cesium.com/user-stories/)

---

## :rocket: Get started

Visit the [Downloads page](https://cesium.com/downloads/) to download a pre-built copy of CesiumJS.

### npm & yarn

If you’re building your application using a module bundler such as Webpack, Parcel, or Rollup, you can install CesiumJS via the [`cesium` npm package](https://www.npmjs.com/package/cesium):

```sh
npm install cesium --save
```

Then, import CesiumJS in your app code. Import individual modules to benefit from tree shaking optimizations through most build tools:

```js
import { Viewer } from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";

const viewer = new Viewer("cesiumContainer");
```

In addition to the `cesium` package, CesiumJS is also [distributed as scoped npm packages for better dependency management](https://cesium.com/blog/2022/12/07/modular-structure-in-cesiumjs/):

- [`@cesium/engine`](./packages/engine/README.md) - CesiumJS's core, rendering, and data APIs
- [`@cesium/widgets`](./packages/widgets/README.md) - A widgets library for use with CesiumJS

### What next?

See our [Quickstart Guide](https://cesium.com/learn/cesiumjs-learn/cesiumjs-quickstart/) for more information on getting a CesiumJS app up and running.

Instructions for serving local data are in the CesiumJS
[Offline Guide](./Documentation/OfflineGuide/README.md).

Interested in contributing? See [CONTRIBUTING.md](CONTRIBUTING.md). :heart:

### Development

`npm start` serves the repository at <http://localhost:8080/>. The CesiumViewer
application there starts on WebGPU, falling back to WebGL when the browser does
not support it, and otherwise matches upstream CesiumViewer.

`npm run start-dev-ui` serves the same content and additionally prints the
CesiumViewer URL that enables this fork's development chrome — the
WebGL/WebGPU/Split renderer switcher and the FPS toggle. That chrome is built
only for a page loaded with `?devUi=true` (`?devUi=1` also works); every other
URL, including `?renderer=webgl` and `?renderer=webgpu`, leaves it out
entirely.

## :green_book: License

[Apache 2.0](http://www.apache.org/licenses/LICENSE-2.0.html). CesiumJS is free for both commercial and non-commercial use.

## :earth_americas: Where does the Global 3D Content come from?

The Cesium platform follows an [open-core business model](https://cesium.com/why-cesium/open-ecosystem/cesium-business-model/) with open source runtime engines such as CesiumJS and optional commercial subscription to Cesium ion.

CesiumJS can stream [3D content such as terrain, imagery, and 3D Tiles from the commercial Cesium ion platform](https://cesium.com/platform/cesium-ion/content/) alongside open standards from other offline or online services. We provide Cesium ion as the quickest option for all users to get up and running, but you are free to use any combination of content sources with CesiumJS that you please.

Bring your own data for tiling, hosting, and streaming from Cesium ion. [Using Cesium ion](https://cesium.com/ion/signup/) helps support CesiumJS development.

## :white_check_mark: Features

- Stream in 3D Tiles and other standard formats from Cesium ion or another source
- Visualize and analyze on a high-precision WGS84 globe
- Share with users on desktop or mobile

See more in the [CesiumJS Features Checklist](https://github.com/CesiumGS/cesium/wiki/CesiumJS-Features-Checklist).

## :books: References & Credits

> **Licensing note:** all fork-specific work (the WebGPU backend, WGSL
> shaders, and tooling) is available under the same Apache-2.0 terms as
> upstream CesiumJS — see the [Fork-Specific Work](LICENSE.md#fork-specific-work)
> section of the license. Credit to the fork author is appreciated but not
> required.

The rendering work in this fork stands on published research, on datasets
published by public agencies, and on a handful of open-source projects whose
approach it follows. Everything named below is credited in the source file that
uses it as well; this section collects them in one place so the debts are
visible without reading the tree.

**This is credit, not licensing.** Where code, data or an asset was actually
copied or adapted, the terms travel with it in [`LICENSE.md`](LICENSE.md) — in
its `# Third-Party Code` and `# Bundled Engine Assets` sections, mirrored into
[`packages/engine/LICENSE.md`](packages/engine/LICENSE.md) for anything that
ships inside `@cesium/engine`. A name here is not a grant. The reasoning behind
each of those entries, including the questions that are still open, is recorded
in
[`migration_doc/LICENSE_DETERMINATIONS_2026-08-10.md`](migration_doc/LICENSE_DETERMINATIONS_2026-08-10.md),
and `node Tools/c16/verify-packaged-notices.mjs` checks that every notice it
requires actually reaches the published artifacts.

### Rendering techniques

| Work                                                                                                                                                                                                                         | Used for                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Bruneton & Neyret, _Precomputed Atmospheric Scattering_ (2008) — [paper](https://hal.inria.fr/inria-00288758)                                                                                                                | Transmittance and inscatter lookup tables for the sky and the ground pass            |
| Hillaire, _A Scalable and Production Ready Sky and Atmosphere Rendering Technique_ (2020) — [paper](https://sebh.github.io/publications/egsr2020.pdf)                                                                        | Multiple scattering, sky-view parameterisation, aerial-perspective froxels           |
| Nishita et al., _Display of the Earth Taking into Account Atmospheric Scattering_ (SIGGRAPH 1993)                                                                                                                            | The single-scattering integral both backends' sky shaders evaluate                   |
| O'Neil, _Accurate Atmospheric Scattering_, GPU Gems 2 (2005) — [site](http://sponeil.net/)                                                                                                                                   | The analytic scattering fallback inherited from upstream                             |
| Karis, _Real Shading in Unreal Engine 4_ (SIGGRAPH 2013)                                                                                                                                                                     | Split-sum image-based lighting, the environment BRDF table, the Smith geometry remap |
| Karis, _High Quality Temporal Supersampling_ (SIGGRAPH 2014)                                                                                                                                                                 | Temporal anti-aliasing resolve and neighbourhood clamping                            |
| Walter et al., _Microfacet Models for Refraction through Rough Surfaces_ (EGSR 2007)                                                                                                                                         | The GGX / Trowbridge-Reitz distribution used throughout the PBR path                 |
| Schlick, _An Inexpensive BRDF Model for Physically-based Rendering_ (1994)                                                                                                                                                   | The Fresnel approximation                                                            |
| Belcour & Barla, _A Practical Extension to Microfacet Theory for the Modeling of Varying Iridescence_ (2017)                                                                                                                 | Thin-film iridescence for `KHR_materials_iridescence`                                |
| Khronos Group — [glTF specification](https://github.com/KhronosGroup/glTF), [Sample Renderer](https://github.com/KhronosGroup/glTF-Sample-Renderer), [ToneMapping](https://github.com/KhronosGroup/ToneMapping)              | The glTF material model, its reference formulations, and the PBR Neutral operator    |
| Wronski, _Volumetric Fog_ (SIGGRAPH 2014)                                                                                                                                                                                    | The froxel volume and the inject / scatter / integrate decomposition                 |
| Hillaire, _Physically Based and Unified Volumetric Rendering in Frostbite_ (SIGGRAPH 2015)                                                                                                                                   | Energy-conserving volumetric integration                                             |
| Henyey & Greenstein, _Diffuse Radiation in the Galaxy_ (1941)                                                                                                                                                                | The scattering phase function                                                        |
| Schneider & Vos, _The Real-Time Volumetric Cloudscapes of Horizon Zero Dawn_ (SIGGRAPH 2015) and Schneider, GPU Pro 7 (2016)                                                                                                 | Perlin-Worley cloud noise and the erosion ladder                                     |
| Worley, _A Cellular Texture Basis Function_ (SIGGRAPH 1996)                                                                                                                                                                  | The cellular noise the cloud bake is built from                                      |
| McGuire & Mara, _Efficient GPU Screen-Space Ray Tracing_, JCGT (2014) — [paper](https://jcgt.org/published/0003/04/04/)                                                                                                      | Screen-space reflections                                                             |
| Therrien, Levesque & Gilet, _Screen Space Indirect Lighting with Visibility Bitmask_ (2023) — [arXiv](https://arxiv.org/abs/2301.11376)                                                                                      | Screen-space global illumination                                                     |
| Jimenez et al., _Practical Realtime Strategies for Accurate Indirect Occlusion_ (2016)                                                                                                                                       | Ground-truth ambient occlusion                                                       |
| Jimenez et al., _Next Generation Post Processing in Call of Duty: Advanced Warfare_ (SIGGRAPH 2014)                                                                                                                          | Interleaved-gradient noise                                                           |
| Hill & Collin, _Practical, Dynamic Visibility for Games_, GPU Pro 2 (2011)                                                                                                                                                   | Hierarchical-Z occlusion culling                                                     |
| Heitz, Dupuy, Hill & Neubelt, _Real-Time Polygonal-Light Shading with Linearly Transformed Cosines_ (SIGGRAPH 2016) — [project](https://eheitzresearch.wordpress.com/415-2/), [code](https://github.com/selfshadow/ltc_code) | Analytic area lights                                                                 |
| Kerbl, Kopanas, Leimkühler & Drettakis, _3D Gaussian Splatting for Real-Time Radiance Field Rendering_ (2023) — [project](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/)                                         | The Gaussian-splat renderer                                                          |
| Lottes, _FXAA 3.11_ (NVIDIA)                                                                                                                                                                                                 | Fast approximate anti-aliasing                                                       |
| Reinhard et al. (2002), Hable, _Filmic Tonemapping Operators_ (2010), Narkowicz, _ACES Filmic Tone Mapping Curve_ (2016)                                                                                                     | The tone-mapping operators                                                           |
| Tessendorf, _Simulating Ocean Water_ (SIGGRAPH course notes, 1999-2004)                                                                                                                                                      | The ocean spectrum and its inverse-FFT synthesis                                     |
| Sloan, _Stupid Spherical Harmonics (SH) Tricks_ (GDC 2008)                                                                                                                                                                   | Spherical-harmonic projection of the radiance environment                            |
| Ramamoorthi & Hanrahan, _An Efficient Representation for Irradiance Environment Maps_ (2001)                                                                                                                                 | The nine-coefficient irradiance result                                               |
| Cigolle et al., _A Survey of Efficient Representations for Independent Unit Vectors_, JCGT (2014)                                                                                                                            | Octahedral normal encoding                                                           |
| Gjøl & Svendsen, _The Rendering of Inside_ (GDC 2016)                                                                                                                                                                        | Screen-space contact shadows                                                         |
| Mitchell, _Volumetric Light Scattering as a Post-Process_, GPU Gems 3                                                                                                                                                        | Screen-space light shafts                                                            |
| CIE 135/1:1999, _Disability Glare_                                                                                                                                                                                           | The veiling-glare falloff behind the solar halo                                      |

### Algorithms & data structures

| Work                                                                                                                                                                                                  | Used for                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Batcher, _Sorting Networks and their Applications_ (1968)                                                                                                                                             | The bitonic sort networks used for splats and point clouds |
| Merrill & Garland, _Single-pass Parallel Prefix Scan with Decoupled Look-back_ (2016) — [paper](https://research.nvidia.com/publication/2016-03_single-pass-parallel-prefix-scan-decoupled-look-back) | Single-dispatch prefix sums                                |
| van der Zijp, _Fast Half Float Conversions_ (2008)                                                                                                                                                    | Table-driven half-float encoding on the CPU                |
| Dammertz, _Hammersley Points on the Hemisphere_                                                                                                                                                       | Quasi-random sampling for the BRDF table                   |
| Pogson (1856); Ballesteros, _New insights into black bodies_ (2012)                                                                                                                                   | Star magnitudes and B−V to colour temperature              |
| Moffat, _A Theoretical Investigation of Focal Stellar Images_ (1969)                                                                                                                                  | The stellar point-spread profile                           |
| Claret (2000); _Allen's Astrophysical Quantities_ (2000)                                                                                                                                              | Solar limb darkening                                       |
| Meeus, _Astronomical Algorithms_ (1998)                                                                                                                                                               | Eclipse cone geometry                                      |
| Hapke (1986); Buratti, Hillier & Wang (1996)                                                                                                                                                          | The lunar opposition surge                                 |
| Patat et al. (2006); Crumey (2014)                                                                                                                                                                    | Twilight sky brightness and naked-eye limiting magnitude   |
| Doodson (1921); Cartwright & Tayler (1971); Schureman, _Manual of Harmonic Analysis and Prediction of Tides_ (1940); Simon et al. (1994); IERS Conventions (2010)                                     | Tidal constituents, node factors and the equilibrium tide  |
| Pavlis et al., _The development and evaluation of EGM2008_ (2012)                                                                                                                                     | The geoid undulation model                                 |
| lolengine, _RGB to HSV in GLSL_ (2013) — [post](http://lolengine.net/blog/2013/07/27/rgb-to-hsv-in-glsl)                                                                                              | Branch-free colour-space conversion                        |

### Open-source projects whose approach this fork follows

| Project                                                                                                                                                        | Used for                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [gfx-rs/naga](https://github.com/gfx-rs/wgpu/tree/trunk/naga)                                                                                                  | Vendored WebAssembly shader translator for runtime GLSL to WGSL                |
| [KhronosGroup/glTF-Sample-Renderer](https://github.com/KhronosGroup/glTF-Sample-Renderer) and [glTF-WebGL-PBR](https://github.com/KhronosGroup/glTF-WebGL-PBR) | The reference glTF material implementations                                    |
| [mrdoob/three.js](https://github.com/mrdoob/three.js)                                                                                                          | Reference implementations for screen-space global illumination and iridescence |
| [cdrinmatane/SSRT3](https://github.com/cdrinmatane/SSRT3)                                                                                                      | The visibility-bitmask global-illumination formulation                         |
| [gasgiant/FFT-Ocean](https://github.com/gasgiant/FFT-Ocean)                                                                                                    | The compute decomposition of the spectral ocean                                |
| [BarthPaleologue/WebTide](https://github.com/BarthPaleologue/WebTide)                                                                                          | The WGSL form of the twiddle precompute and butterfly stages                   |
| [Popov72/OceanDemo](https://github.com/Popov72/OceanDemo)                                                                                                      | Spectrum packing and displacement reassembly                                   |
| [mapbox/webgl-wind](https://github.com/mapbox/webgl-wind)                                                                                                      | The ping-pong particle integrator behind the wind layer                        |
| [RaymanNg/3D-Wind-Field](https://github.com/RaymanNg/3D-Wind-Field)                                                                                            | Advecting that integrator in geographic coordinates on a globe                 |
| [Orillusion/orillusion](https://github.com/Orillusion/orillusion)                                                                                              | The depth-gated light-shaft variant                                            |
| [linebender/vello](https://github.com/linebender/vello)                                                                                                        | The WebGPU rendering of decoupled look-back                                    |
| [selfshadow/ltc_code](https://github.com/selfshadow/ltc_code)                                                                                                  | The fitted area-light lookup tables                                            |
| [Takram three-geospatial](https://github.com/takram-design-engineering/three-geospatial)                                                                       | Geospatial atmosphere reference for cross-checking                             |
| Tommy Ettinger's Mulberry32 — [gist](https://gist.github.com/tommyettinger/46a874533244883189143505d203312c)                                                   | The deterministic generator seeding the wind-particle field                    |

### Datasets & assets

| Source                                                                                                                                        | Used for                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [NASA/GSFC Scientific Visualization Studio — The Tycho Catalog Skymap](https://svs.gsfc.nasa.gov/3572/)                                       | The star-map cube faces, and the diffuse Milky Way variant derived from them |
| [NASA/GSFC SVS — CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/)                                                                               | The lunar albedo map and the normal map derived from LOLA elevation          |
| NASA LRO LROC team, Arizona State University — [WAC mosaic](http://wms.lroc.asu.edu/lroc/view_rdr/WAC_HAPKE_NORMALIZED)                       | The mosaic underlying that albedo map                                        |
| ESA — Hipparcos and Tycho-2 catalogues                                                                                                        | The catalogues the star map was rendered from                                |
| [Yale Bright Star Catalogue, 5th revised edition](https://heasarc.gsfc.nasa.gov/W3Browse/star-catalog/bsc5p.html), served by NASA HEASARC     | The bright-star catalogue the point starfield draws                          |
| U.S. National Geospatial-Intelligence Agency — EGM2008                                                                                        | The bundled geoid undulation grid                                            |
| [Natural Earth](https://www.naturalearthdata.com/) — 1:10m Lakes, via [natural-earth-vector](https://github.com/nvkelso/natural-earth-vector) | The inland-lake water mask                                                   |
| NOAA — Global Forecast System                                                                                                                 | Sample wind velocity fields for the flow-field layer                         |

_Assembled from the attribution census run over every fork-changed file, and
kept in step with `LICENSE.md` by `Tools/c16/verify-packaged-notices.mjs`. If a
work is used here and missing from this section, that is a defect worth
reporting._
