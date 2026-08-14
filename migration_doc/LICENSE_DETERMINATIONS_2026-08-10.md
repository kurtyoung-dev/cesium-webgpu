# License determinations — C16-01 (2026-08-10)

The attribution census run for Campaign 16 flagged **20 files as
`needs-license-review`**: places where the fork ships code, data or a binary
whose provenance is third-party and whose terms the repository had not recorded.
This document resolves each of them, one by one, with the source of truth that
established the answer. It is the authority the packaging check reads —
`node Tools/c16/verify-packaged-notices.mjs` parses the manifest in §5 and fails
when a determination that requires a shipped notice cannot be found in the
artifacts that actually ship.

Scope note: this file records **determinations**, not legal advice and not a
clearance. Where the answer could not be established from anything available
inside this repository, the determination says so and states the exact question
that closes it. Nothing here asserts terms the project has not read.

## 1. How each determination was reached

Four kinds of evidence were available, in descending order of strength:

1. **A licence file vendored in this repository.** The strongest form —
   `packages/engine/Source/ThirdParty/naga-wasm/LICENSE-MIT` names its copyright
   holder, so the notice can be reproduced verbatim.
2. **A copyright line recorded by the fork's own source at the point of use.**
   Several shader headers record the holder and year they took the technique
   from. That is the project's own contemporaneous record of what it read, and
   it is used where no vendored file exists.
3. **A published terms-of-use statement quoted in an existing `LICENSE.md`
   entry.** The bundled-asset entries added earlier already quote NASA, NGA,
   HEASARC and Natural Earth terms; assets covered by those entries need no new
   determination, only confirmation that the coverage reaches the flagged file.
4. **Nothing.** Where none of the above exists, the determination is
   `NEEDS-MAINTAINER`, with the question written so it can be answered in one
   lookup.

What was deliberately **not** used: recollection of what a licence "usually
says". A standard MIT or ISC permission body is reproducible because it is
standardised text; a copyright line is not, and no entry in this batch invents
one.

## 2. Determinations

Status values: **RESOLVED** — the required notice now ships. **COVERED** — an
existing entry already reaches the file; nothing was owed. **PARTIAL** — the
notice ships and the terms are stated, but one transcribable detail is
outstanding. **NEEDS-MAINTAINER** — the project cannot answer this from what it
holds.

### L-01 — `mulberry32` in `Scene/FlowFieldWindLayer.js` · ✅ CLOSED (Batch 965, `3c1d4c5a47`) — ~~NEEDS-MAINTAINER~~

> **CLOSED — stamped 2026-08-09, handover audit FIX 31.** The network pass at
> Batch 965 established mulberry32 as **EXPLICIT CC0**, so **no replacement is
> needed** and no maintainer answer is outstanding. The "provenance
> unestablishable offline" framing below is the *pre-closure* state, retained
> for the reasoning; it fell to going online, not to a ruling.

**What was found.** Lines 13-22 are a verbatim copy of Tommy Ettinger's
Mulberry32 generator, down to the constants `0x6d2b79f5`, `1 | a`, `61 | t` and
the `>>> 15` / `>>> 7` / `>>> 14` shift schedule. It seeds the initial
flow-field particle set so a given seed reproduces a given field. Two further
copies exist under `Tools/`, which ships in neither npm package nor the release
archive and is therefore out of scope.

**Source of truth attempted.** No licence text for this snippet exists anywhere
in the repository: the function carries no notice, no dependency in
`node_modules` vendors it, and the author's gist is not mirrored here. The
generator is widely redistributed as public-domain work, but *widely
redistributed* is not a grant, and this batch does not assert one it has not
read.

**Determination.** Provenance is recorded in the `# Third-Party Code` section of
both `LICENSE.md` files under **Mulberry32 pseudo-random generator**, with the
notice status stated as unresolved. The code is unchanged.

**Exact question for the maintainer.** *Does
<https://gist.github.com/tommyettinger/46a874533244883189143505d203312c> carry a
public-domain, CC0 or other explicit grant in its text or its comments? If yes,
paste that sentence and the entry converts to a normal notice. If no — or if the
gist is silent, which under GitHub's terms leaves it all-rights-reserved — the
cheaper closure is to replace the function.*

**Replacement, if that is the answer chosen.** A 32-bit generator written from
scratch is roughly ten lines and has no external constraint to satisfy beyond
determinism, but it changes every particle's starting position, so it is a
**code** change and not an attribution change: it needs its own batch with a
rendered acceptance run, and it cannot ride C16-01, which is comment-and-notice
only. Filed as a follow-up rather than done here.

### L-02, L-04, L-08 — vendored naga (`ThirdParty/naga-wasm/`) · RESOLVED

**What was found.** `naga_wasm.js` (wasm-bindgen glue), `naga_wasm_bg.wasm`
(1,288,724 bytes) and `naga_wasm.d.ts`, built from `packages/wasm-naga/` around
the `naga` crate at version **27.0.3** (pinned in `packages/wasm-naga/Cargo.lock`).
Loaded lazily by `Renderer/WebGPU/WebGPUNagaTranspiler.ts` through a dynamic
import carrying `@vite-ignore` and `webpackIgnore` magic comments, so the blob is
never inlined into a bundle and is fetched only by applications that hit a GLSL
`compileShader` path on the WebGPU backend.

**Source of truth.** `packages/engine/Source/ThirdParty/naga-wasm/LICENSE-MIT`,
which reads `Copyright (c) 2025 The gfx-rs developers`, and the matching
`LICENSE-APACHE` beside it — evidence class 1.

**Determination.** naga is dual-licensed MIT OR Apache-2.0. The Apache-2.0 half
matches this project's own licence, so redistribution under Apache-2.0 needs no
further permission. Three gaps existed and are now closed:

- Neither `LICENSE.md` named naga at all. A **naga** entry now exists in both,
  reproducing the MIT notice so it also reaches consumers who receive only a
  built bundle rather than the source tree.
- `ThirdParty.extra.json` had no row, so the generated `ThirdParty.json` — the
  dependency manifest the root `cesium` package ships — did not list it. A row
  is now present, with the crate version and a note recording that it is
  vendored rather than installed.
- The two vendored licence files reach the npm tarball (they are under `Source`)
  and the build output (`copyEngineAssets` copies everything under
  `Source/**` except `.js`, `.ts`, `.glsl`, `.css` and `.md`, and extension-less
  files are not excluded). The vendored `README.md`, by contrast, is excluded by
  that `.md` rule — which is why the notice could not be left to live only
  there.

### L-03 — Khronos lineage in `Shaders/WebGPU/Model/ModelPBRComplete.wgsl` · RESOLVED

The census asked for a copied-versus-re-derived determination. It splits three
ways, and the three answers differ.

**(a) The metallic-roughness core — re-derived from this project's own GLSL.**
The function set is `distributionGGX`, `geometrySchlickGGX`, `geometrySmith`,
`fresnelSchlick`, `smithVisibilityGGX`, `fresnelSchlickRoughness`. Those are
CesiumJS's own GLSL builtin names (`czm_smithVisibilityGGX`) and the
LearnOpenGL teaching names — **not** the glTF Sample Viewer's, which are
`D_GGX`, `V_GGX`, `F_Schlick` and `BRDF_specularGGX`. A shader transliterated
from the Sample Viewer would carry the Sample Viewer's identifiers. This one
carries Cesium's, because it is a port of Cesium's GLSL, which is already
covered by the existing **gltf-WebGL-PBR** entry. Nothing new is owed.

**(b) The thin-film iridescence term — adapted, not re-derived.** The block at
lines 2723-2800 uses the Khronos reference formulation's own working-variable
names in order: `R0_12`, `R12`, `T121`, `phi12`, `phi21`, `R0_23`, `R23`,
`phi23`, `opd`, `R123`, `r123`, `Rs`. Two independent implementations of
Belcour & Barla 2017 do not converge on that naming. The file's own comment
already says it follows "the Khronos reference impl" and three.js's
`iridescenceFresnel`. Treated as **copied-shape**: new `LICENSE.md` entries for
**glTF Sample Renderer** (Apache-2.0, the same licence as this project) and
**three.js** (MIT) now exist in both files.

**(c) The Khronos PBR Neutral tonemap — upstream precedent, nothing owed.**
`pbrNeutralTonemap` is a port of Cesium's own
`Shaders/Builtin/Functions/pbrNeutralTonemapping.glsl`, whose first line is the
citation `// KhronosGroup https://github.com/KhronosGroup/ToneMapping/tree/main/PBR_Neutral`
and for which upstream added no `LICENSE.md` entry. KhronosGroup/ToneMapping is
Apache-2.0, identical to this project's licence. The fork mirrors upstream's
treatment; the inline citation stays and no entry is added, so that a future
upstream merge does not conflict over one.

### L-05, L-07, L-09 — Tycho-2 star-map faces · COVERED

`Assets/Textures/SkyBox/tycho2t5_80_pz.jpg` and the fork-added
`tycho2t5_80_diffuse_mx.jpg` / `_my.jpg` were flagged as having no verifiable
provenance. They do: **Star map cube maps — NASA/GSFC Scientific Visualization
Studio** under `# Bundled Engine Assets` covers all three variants explicitly by
filename pattern, pins the source product (SVS 3572) and its SHA-256, documents
the full derivation chain including the diffuse variant's Gaussian low-pass, and
states the terms position for both the NASA product and the underlying ESA
catalogues. The entry is mirrored into `packages/engine/LICENSE.md`, so it
reaches npm consumers. **Nothing was owed; the census flag was a false positive
caused by reading the asset directory without reading `LICENSE.md`.**

### L-06 — `Assets/Textures/Moon/lroc_color_poles_2k.jpg` · COVERED

Covered by **Lunar albedo map — NASA/GSFC Scientific Visualization Studio (CGI
Moon Kit)**, which pins the source TIFF's SHA-256, records the encode, credits
NASA/GSFC and the LROC team at Arizona State University, and states the terms.
Mirrored into the engine package. Nothing owed.

### L-10 — `Shaders/WebGPU/PostProcess/SSGIGenerate.wgsl` · RESOLVED

**What was found.** The header cites Therrien, Levesque & Gilet 2023 and states
that the shader is derived, technique only, from the MIT-licensed three.js
`SSGINode` and from `cdrinmatane/SSRT3`, with no source copied verbatim — but
routed the licence itself to an internal research document rather than to
`LICENSE.md`, where a reader of the shipped package would look.

**Source of truth.** The shader header itself records both holders — three.js
authors, and `(c) 2024 CDRIN` — evidence class 2.

**Determination.** RESOLVED by adding **three.js** and **SSRT3** entries to both
`LICENSE.md` files. The comment standard would allow a reference block alone for
a technique-only derivation; the standard's own tie-breaker is that an
unnecessary entry costs a paragraph and a missing one is a defect that ships, so
both entries are present.

### L-11 — `Shaders/WebGPU/PostProcess/GodRayGenerate.wgsl` · PARTIAL

Mitchell's GPU Gems 3 radial blur is a published technique and needs a reference
block only. The depth-gating variant is credited in the header to Orillusion's
`GodRayPost.ts` — another engine, so a notice is owed. An **Orillusion** entry
now exists in both files with the standard MIT body. **Outstanding:** the
copyright line, which no in-repo source records. See §3.

### L-12 — `Shaders/WebGPU/FlowFieldAdvect.wgsl` and `WebGPUFlowFieldRenderer.ts` · PARTIAL

Two lineages, both credited in the shader header and neither previously in
`LICENSE.md`: `mapbox/webgl-wind` (ISC) for the ping-pong particle-state
integrator, and `RaymanNg/3D-Wind-Field` (MIT) for advancing that state in
longitude and latitude against an ellipsoid. Entries for both now exist in both
files. The NOAA GFS velocity samples the layer consumes are US-Government work
and carry no notice obligation. **Outstanding:** both copyright lines. See §3.

### L-13, L-14, L-15, L-19, L-20 — the FFT ocean shaders · RESOLVED / PARTIAL

Five shaders under `Shaders/WebGPU/Ocean/` name three projects between them and
none of the three appeared in `LICENSE.md`:

| Shader | What it takes | From |
| --- | --- | --- |
| `OceanTwiddle.wgsl` | precomputed twiddle-and-index kernel | FFT-Ocean, WebTide |
| `OceanIFFT.wgsl` | inverse-conjugated butterfly stages | FFT-Ocean, WebTide |
| `OceanTimeSpectrum.wgsl` | two-for-one Hermitian spectrum packing | FFT-Ocean, OceanDemo |
| `OceanMerge.wgsl` | Jacobian-threshold foam term | FFT-Ocean |
| `OceanSurface.wgsl` | displacement and normal reassembly | FFT-Ocean, OceanDemo |

The headers claim independent re-derivation and CPU validation against a
brute-force inverse discrete Fourier transform, which is credible and is the
reason the *equations* need no notice. It is not the reason a notice is not
owed: the kernel decomposition — which stage is a separate dispatch, what the
twiddle texture holds, how the two Hermitian fields share one transform — is the
reference project's design, and the comment standard classes a shader chunk
adapted from a reference renderer as owing an entry. **FFT-Ocean** (MIT,
`(c) 2020 Ivan Pensionerov`) and **WebTide** (MIT,
`(c) 2024 Barthelemy Paleologue`) are RESOLVED from copyright lines the fork's
own `OceanIFFT.wgsl` header records. **OceanDemo** is PARTIAL — its copyright
line is recorded nowhere in the repository. See §3.

`OceanInitialSpectrum.wgsl` is untouched: it states Tessendorf and Phillips as
published equations with no code copied, which is a reference block and nothing
more.

### L-16 — `Renderer/WebGPU/WebGPULTCLUTData.ts` · RESOLVED (a real packaging gap)

**What was found.** The two fitted 64×64 lookup tables are base64 payloads
converted from `selfshadow/ltc_code`, whose licence is BSD-3-Clause-shaped with
an added paper-citation clause and whose first condition is that
*redistributions of source code must retain the above copyright notice*.

The root `LICENSE.md` has carried a full **Linearly Transformed Cosines (LTC)
area lights** entry all along, so the census flag looked like another false
positive. It was not. `packages/engine/LICENSE.md` — the only licence file
inside the published `@cesium/engine` tarball — **did not have it**, while
`WebGPULTCLUTData.ts` ships in that tarball under `Source/`. An npm consumer
therefore received the copied tables under an unqualified Apache-2.0 grant with
the required notice nowhere in the package.

**Determination.** RESOLVED: the entry is now mirrored into
`packages/engine/LICENSE.md`, verbatim apart from the documented path-prefix
difference. This is the class of defect that motivated the whole of part (c);
the check added in `Tools/c16/verify-packaged-notices.mjs` fails on exactly this
shape.

### L-17 — `Shaders/WebGPU/PostProcess/FXAA_f16.wgsl` · COVERED

A hand-tuned half-precision mirror of `FXAA.wgsl`, itself FXAA 3.11 by Timothy
Lottes. **NVIDIA GameWorks FXAA Shader** is present in the root `LICENSE.md`
*and* already mirrored into `packages/engine/LICENSE.md`. Nothing owed.

### L-18 — `Shaders/WebGPU/Compute/DecoupledLookbackScan.wgsl` · PARTIAL

Merrill & Garland 2016 is a published algorithm and is already cited with a URL
in the file. The header additionally credits the Vello `pathtag_scan` port, and
the partition-state flag encoding, the backward walk and the bounded spin follow
it — WebGPU forbids `storageBarrier` in the single-lane branch that does the
walk, so the watchdog budget replacing it is this project's. A **Vello** entry
now exists in both files. Vello is dual-licensed Apache-2.0 OR MIT and the
Apache-2.0 half matches this project's licence, so the grant is unambiguous;
what is outstanding is only the copyright line. See §3.

### L-21 — `Assets/WaterMask/ne10mLakes.bin` · RESOLVED

Flagged by the census under `needs-citation`, but it is a shipped binary and
cannot hold a comment, so it is resolved here rather than in the citation pass.
912,548 bytes of Natural Earth 1:10m lake polygons, built by
`Tools/build-lake-water-mask.mjs` from `ne_10m_lakes.geojson` and
`ne_10m_lakes_north_america.geojson`, fetched at runtime only when
`globe.lakeWaterMask` is on. Natural Earth is public domain and asks for no
attribution; the existing `# Example Applications` entry covers the example
apps' Natural Earth imagery, not an asset shipped inside `@cesium/engine`. An
**Inland-lake polygon mask — Natural Earth 1:10m Lakes** entry now sits under
`# Bundled Engine Assets` in both files, recording the source files, the
quantized `LWM1` container, the ~17 m worst-case quantization error, and the
customary credit.

### L-22 — two engine dependencies missing from the generated manifest · RESOLVED

Found while auditing the generator rather than by the census.
`@spz-loader/core` (Apache-2.0) and `@cesium/wasm-splats` (Apache-2.0) are
runtime dependencies of `packages/engine`, and `wasm_splats_bg.wasm` is copied
into `Source/ThirdParty/` by the `prepare` task, so both ship. Neither had a row
in `ThirdParty.extra.json`, and since `buildThirdParty` generates
`ThirdParty.json` *only* from that file, neither appeared in the manifest the
root package ships. Rows added; both resolve through npm metadata.

### L-23 — the WGSL build strips licence banners · ✅ CLOSED (Batch 966, `b446b662f1`, maintainer-directed) — ~~NEEDS-MAINTAINER~~

> **CLOSED — stamped 2026-08-09, handover audit FIX 31.** `wgslToJavaScript` now
> mirrors `glslToJavaScript`'s `@license` extraction, so a notice-bearing WGSL
> banner survives minification into the shipped bundle. **All 23 determinations
> in this document are closed.**

Found while tracing how notices reach `Build/**`. `glslToJavaScript` in
`scripts/build.js` extracts `@license` docblocks before minifying and re-emits
them at the top of the generated module, so a licence banner in a `.glsl` file
survives into the shipped bundle. `wgslToJavaScript`, twenty lines below, strips
**every** comment in minify mode with no such carve-out. A licence banner placed
in a `.wgsl` file today would be silently deleted from the minified build.

Nothing currently depends on this — every WGSL notice this batch adds lives in
`LICENSE.md`, deliberately, and no `.wgsl` file carries an `@license` block. It
is recorded because the *next* person to reach for the obvious mechanism will
find it quietly broken.

**Exact question for the maintainer.** *Should `wgslToJavaScript` mirror
`glslToJavaScript`'s `@license` extraction? It is a ten-line change to
`scripts/build.js`, but it is a build-script change and therefore outside a
comment-and-notice batch.*

### L-24 — Takram `three-geospatial` across five subsystems · RESOLVED

Opened by maintainer directive on 2026-08-08 — *double check any effects or
features inspired by the Takram work is credited to them and their main
author* — and not by the census, which never flagged it. That is the finding
worth recording: **the census could not have flagged it.** Its `needs-license-review`
rule keys on files whose provenance is third-party and unrecorded. Every Takram
site already carried prose credit, so each one read as *recorded* and passed.
What none of them had was a notice in either `LICENSE.md`.

**What was found.** Twenty-one Takram references across nine files under
`packages/engine/Source`, in two distinct shapes.

*Shape one — credited, but the licence routed to an internal document.* Five
subsystems from the 2026-06 celestial/atmosphere track name Takram in their
headers and then send the reader to
`migration_doc/RESEARCH_TAKRAM_GEOSPATIAL_VISUALS.md` for the terms. That
document is not published in any npm package, any bundle, or the release
archive. This is precisely the L-10 defect — a licence routed to a research
note rather than to the file a recipient of the code would open — and it had
been sitting in the atmosphere shaders since Batch 306.

*Shape two — the credit had become a codename.* The cloud-aware god-ray work
was tracked as `TAKRAM-9` and the marker was carried into the code itself, in
the god-ray shaders, `WebGPUGodRayEffect.ts` and
`WebGPUPostProcessStageCollection.ts`. A tracker tag is not attribution: it
names an internal work item, and to a reader outside this repository it says
nothing at all. The C16-03 cloud pass had already removed two such tags from
`ProceduralClouds.wgsl` (the god-ray transmittance mask and the
`Takram/AAA perspective step`) and banked them in
`migration_doc/DEV_NOTES_clouds.md`, explicitly leaving open whether either
technique derives from Takram and therefore owes a notice. This determination
closes that question.

**Source of truth.** The upstream repository, read over the network — evidence
class 1. `LICENSE` at
<https://github.com/takram-design-engineering/three-geospatial> reads
`The MIT License (MIT)` / `Copyright (c) 2024 Shota Matsuda`, with a body
confirmed to match the canonical OSI template word for word apart from that
line. `packages/clouds/package.json` gives the author as
`Shota Matsuda <shota@takram.com>` and the licence as MIT. The two techniques
the directive singled out were verified in their own source rather than assumed:
`packages/clouds/src/shaders/clouds.frag` contains both
`stepSize *= perspectiveStepScale` and the `maxRayDistance` break, and writes a
`marchShadowLength`-derived shadow length alongside the transmittance integral;
`qualityPresets.ts` carries `maxRayDistance` as a tunable preset field.
`AerialPerspectiveEffect.ts`, `SunDirectionalLight.ts` and `SkyLightProbe.ts`
all exist in `packages/atmosphere/src`, confirming the three class names the
fork's headers already cited.

**Classification.** Every site is **DERIVED-TECHNIQUE**; none is
DERIVED-CODE. The evidence for that is positive, not merely an absence:

| Site | Their mechanism | Ours |
| --- | --- | --- |
| Cloud march step growth | `stepSize *= perspectiveStepScale`, accumulated per iteration | `fineStep * pow(marchStepGrowth, k)`, a stateless closed form |
| Cloud occlusion of shafts | shadow-length integral to a separate target | view-ray transmittance product into an `r8unorm` mask |
| Aerial perspective | `AerialPerspectiveEffect`, three.js post-processing | WGSL fullscreen pass on the fork's log-depth contract |
| Atmosphere-derived lighting | `SunDirectionalLight` + `SkyLightProbe` | `AtmosphereDerivedLighting.js` against `frameState.light` |
| Star colour | Planckian-locus fit | same published fit, reimplemented |

The shared identifier `maxRayDistance` is the one name in common, and it is an
ordinary descriptive term for the quantity it holds. The underlying atmosphere
model is Bruneton & Neyret's published work in both projects, not Takram's, so
the atmosphere sites owe Takram credit for the *structure* they adopted rather
than for the physics.

**Determination.** RESOLVED. Under the standard's own tie-breaker — an
unnecessary entry costs a paragraph, a missing one is a defect that ships — a
**Takram three-geospatial** entry now exists in both `LICENSE.md` files,
reproducing the MIT notice with its copyright line and listing all five
subsystems. The MIT notice condition is thereby satisfied for consumers of the
`@cesium/engine` tarball, which is the artifact the affected code ships in and
which never sees the root file (§4). `ThirdParty.extra.json` is deliberately
**not** touched: nothing is vendored or installed from the project, and that
manifest lists dependencies rather than techniques.

**Comment changes made here.** Reference blocks naming the project, the author,
the licence and the repository URL were added to the three files that end this
batch marker-clean: `ProceduralClouds.wgsl` at both the step-growth site and
the transmittance-mask entry point — restoring, with a real citation, the
provenance C16-03 had to drop — and `GodRayGenerate.wgsl`, whose existing
`References:` block gained a Takram line. The `TAKRAM-9` codename is gone from
`GodRayGenerate.wgsl` and `GodRayGenerate_f16.wgsl`.

**Deliberately left for the owning shards.** Eight files still route their
Takram credit to the internal research document, or still carry the `TAKRAM-9`
codename: `AtmosphereLUT.wgsl`, `AerialPerspective.wgsl`, `StarField.wgsl`,
`WebGPUAerialPerspectiveEffect.ts`, `AtmosphereDerivedLighting.js`,
`WebGPUGodRayEffect.ts`, `WebGPUPostProcessStageCollection.ts` and `Scene.js`.
Each carries substantial pre-existing marker debt — 91 markers in the two
post-process TypeScript files alone — so editing them here would either leave
them failing the guard or turn an attribution batch into an unreviewed comment
rewrite of files whose shards (C16-04 onward) have not run. **The licensing
obligation does not wait for them:** it is discharged by the `LICENSE.md`
entries above, which name those files explicitly. What remains for the shards
is the local citation quality, and this paragraph is the instruction for it —
replace the `migration_doc/…` routing and the `TAKRAM-9` tag with a reference
block in the shape used in `ProceduralClouds.wgsl`.

**Shard follow-through, C16-04 (celestial).** One of the eight is celestial
scope and is now done: `StarField.wgsl`'s blackbody colour-temperature credit
no longer routes to `migration_doc/RESEARCH_TAKRAM_GEOSPATIAL_VISUALS.md` and
instead carries a reference block naming Shota Matsuda, Takram, the
`three-geospatial` project, MIT and
<https://github.com/takram-design-engineering/three-geospatial>, in the
`ProceduralClouds.wgsl` shape. The sentence stating that the fit was
reimplemented with no third-party code copied is retained, because that is
what makes the block a citation rather than an open licensing question, and it
matches this determination's DERIVED-TECHNIQUE classification of the star
colour site. The remaining seven belong to the atmosphere, post-process and
scene shards (C16-05, C16-07, C16-11) and are untouched here — this shard does
not edit files outside its own subsystem.

**Shard follow-through, C16-07 (post-process & effects), 2026-08-09.** Four
more of the eight are post-process scope and are now done, leaving three:

| File | Was | Now |
| --- | --- | --- |
| `AerialPerspective.wgsl` | prose credit routed to `migration_doc/RESEARCH_TAKRAM_GEOSPATIAL_VISUALS.md` | `References:` block naming Shota Matsuda, Takram, `three-geospatial`, MIT, the repository URL |
| `WebGPUAerialPerspectiveEffect.ts` | headline credit routed to the same research note, in the module docblock | `References:` block, plus a Bruneton & Neyret line for the transmittance LUT it samples |
| `WebGPUGodRayEffect.ts` | `TAKRAM-9` codename at five sites, no citation anywhere | `References:` block in the module docblock (Mitchell for the radial blur, Takram for the cloud-transmittance occlusion), codename gone |
| `WebGPUPostProcessStageCollection.ts` | `TAKRAM-9` codename at two sites | codename gone; the technique is cited at its implementation site in `WebGPUGodRayEffect.ts`, which this file only drives |

The wording follows `ProceduralClouds.wgsl` and `StarField.wgsl`: the project,
the author, the licence, the URL, the specific mechanism adopted, and the
sentence stating that no source was copied — which is what keeps each block a
citation rather than an open licensing question, and matches this
determination's DERIVED-TECHNIQUE classification of every post-process site.

**Still outstanding: three files.** `AtmosphereLUT.wgsl` and
`AtmosphereDerivedLighting.js` belong to the atmosphere shard; both still route
their Takram credit to the internal research document, and a repository-wide
grep for `RESEARCH_TAKRAM_GEOSPATIAL_VISUALS` under `packages/engine/Source`
now returns those two lines and nothing else. `Scene.js` belongs to the
scene/architecture shard (`C16-11`) and is a different shape from the other
seven: it carries no routing and no codename, only a passing prose reference to
"the Takram talk" in a comment about the aerial-perspective gate. That is a
naked mention rather than a citation, and the shard that owns the file should
either point it at the reference block now in
`WebGPUAerialPerspectiveEffect.ts` or drop it. The licensing obligation remains
discharged by the `LICENSE.md` entries in every case; what is owed is the local
citation quality, on the same instruction as above.

## 3. Outstanding items, and exactly what closes each

Every item below has a complete entry in both `LICENSE.md` files, stating what
was taken, the licence identifier, and the standard permission body. What is
missing in each case is one line: the upstream copyright statement, which this
project has not read and will not guess.

| Item | Project | Licence | What closes it |
| --- | --- | --- | --- |
| L-11 | Orillusion | MIT | Transcribe the copyright line from `LICENSE` at <https://github.com/Orillusion/orillusion> |
| L-12 | mapbox/webgl-wind | ISC | Transcribe the copyright line from `LICENSE` at <https://github.com/mapbox/webgl-wind> |
| L-12 | RaymanNg/3D-Wind-Field | MIT | Transcribe the copyright line from `LICENSE` at <https://github.com/RaymanNg/3D-Wind-Field> |
| L-13 | Popov72/OceanDemo | MIT | Transcribe the copyright line from `LICENSE` at <https://github.com/Popov72/OceanDemo> |
| L-18 | linebender/vello | Apache-2.0 OR MIT | Transcribe the copyright line from the chosen half at <https://github.com/linebender/vello> |
| ~~L-01~~ | Mulberry32 | **CC0** | ✅ **CLOSED Batch 965 (`3c1d4c5a47`)** — explicit CC0 established by network pass; no grant to transcribe, no replacement to schedule. *(Stamped 2026-08-09, handover audit FIX 31.)* |
| ~~L-23~~ | — | — | ✅ **CLOSED Batch 966 (`b446b662f1`, maintainer-directed)** — `wgslToJavaScript` mirrors the `@license` extraction. *(Stamped 2026-08-09, handover audit FIX 31.)* |

None of these blocks release. Each entry already names the project, the licence
and what was taken, which is what a redistributor needs in order to comply; the
missing line is an attribution detail, not a permission.

## 4. What ships, and where

The audit behind part (c). Three artifacts carry notices, and they carry
different things:

| Artifact | Carries | Mechanism |
| --- | --- | --- |
| `cesium` npm package | root `LICENSE.md`, `ThirdParty.json` | no `files` field, so `.npmignore` governs and both are included |
| `@cesium/engine` npm package | `packages/engine/LICENSE.md`, `Source/ThirdParty/**` licence files | `files` lists `LICENSE.md` and `Source`; it does **not** list `ThirdParty.json` |
| `@cesium/widgets` npm package | `packages/widgets/LICENSE.md` | same shape |
| `Build/**` bundles | the `@license` header from `Source/copyrightHeader.js`, which points at the repository `LICENSE.md` by URL | `scripts/build.js` prepends it |
| release archive | all three `LICENSE.md` files | `gulpfile.makezip.js` names each explicitly |

Two consequences follow, and both are why L-16 was a live defect rather than a
formality:

1. **The engine package never sees the root `LICENSE.md`.** Anything whose code
   ships from `packages/engine/Source` must have its notice in
   `packages/engine/LICENSE.md`, or the notice does not travel. The
   `# Bundled Engine Assets` section already said this in prose; the check now
   enforces it for `# Third-Party Code` as well.
2. **`Build/**` bundles carry a pointer, not the text.** That is upstream's
   long-standing arrangement and this batch does not change it — but it means a
   bundle consumer's only route to these notices is the URL in the header, so
   the notices must be correct in the repository file that URL resolves to.

## 5. Machine-readable manifest

`Tools/c16/verify-packaged-notices.mjs` parses the block below. Each entry names
the `LICENSE.md` heading that must exist, and the files in which it must exist.
`root` is `LICENSE.md`; `engine` is `packages/engine/LICENSE.md`. `thirdPartyJson`
names a row that must be present in the generated `ThirdParty.json`.

```json
{
  "notices": [
    { "id": "L-01", "heading": "Mulberry32 pseudo-random generator", "files": ["root", "engine"], "status": "RESOLVED" },
    { "id": "L-02", "heading": "naga", "files": ["root", "engine"], "thirdPartyJson": "naga", "status": "RESOLVED" },
    { "id": "L-03a", "heading": "gltf-WebGL-PBR", "files": ["root", "engine"], "status": "COVERED" },
    { "id": "L-03b", "heading": "glTF Sample Renderer (Khronos)", "files": ["root", "engine"], "status": "RESOLVED" },
    { "id": "L-05", "heading": "Star map cube maps — NASA/GSFC Scientific Visualization Studio", "files": ["root", "engine"], "status": "COVERED" },
    { "id": "L-06", "heading": "Lunar albedo map — NASA/GSFC Scientific Visualization Studio (CGI Moon Kit)", "files": ["root", "engine"], "status": "COVERED" },
    { "id": "L-10a", "heading": "three.js", "files": ["root", "engine"], "status": "RESOLVED" },
    { "id": "L-10b", "heading": "SSRT3", "files": ["root", "engine"], "status": "RESOLVED" },
    { "id": "L-11", "heading": "Orillusion", "files": ["root", "engine"], "status": "PARTIAL" },
    { "id": "L-12a", "heading": "webgl-wind", "files": ["root", "engine"], "status": "PARTIAL" },
    { "id": "L-12b", "heading": "3D-Wind-Field", "files": ["root", "engine"], "status": "PARTIAL" },
    { "id": "L-13a", "heading": "FFT-Ocean", "files": ["root", "engine"], "status": "RESOLVED" },
    { "id": "L-13b", "heading": "WebTide", "files": ["root", "engine"], "status": "RESOLVED" },
    { "id": "L-13c", "heading": "OceanDemo", "files": ["root", "engine"], "status": "PARTIAL" },
    { "id": "L-16", "heading": "Linearly Transformed Cosines (LTC) area lights", "files": ["root", "engine"], "status": "RESOLVED" },
    { "id": "L-17", "heading": "NVIDIA GameWorks FXAA Shader", "files": ["root", "engine"], "status": "COVERED" },
    { "id": "L-18", "heading": "Vello", "files": ["root", "engine"], "status": "PARTIAL" },
    { "id": "L-21", "heading": "Inland-lake polygon mask — Natural Earth 1:10m Lakes", "files": ["root", "engine"], "status": "RESOLVED" },
    { "id": "L-22a", "heading": null, "files": [], "thirdPartyJson": "@spz-loader/core", "status": "RESOLVED" },
    { "id": "L-22b", "heading": null, "files": [], "thirdPartyJson": "@cesium/wasm-splats", "status": "RESOLVED" },
    { "id": "L-24", "heading": "Takram three-geospatial", "files": ["root", "engine"], "status": "RESOLVED" },
    { "id": "L-25", "heading": "Astronomy Engine", "files": ["root", "engine"], "thirdPartyJson": "astronomy-engine", "status": "RESOLVED" }
  ]
}
```

## 6. Citation pass

The census's other 32 flags were `needs-citation`: files implementing a
published technique with no reference to it. Those carry no licensing weight and
were resolved by adding reference blocks to the files themselves, in the shape
`Documentation/Contributors/CodingGuide/ForkCommentStandard.md` §6.1 defines.
One of the 32, `Assets/WaterMask/ne10mLakes.bin`, is a binary and is resolved
above as L-21 instead. The `README.md` References & Credits section lists every
work named by either pass.

## 7. Closure addendum — 2026-08-10, Batch 965 (orchestrator, network pass)

CO-38 ran sandboxed; the orchestrator re-ran the six network lookups the
batch could not. Results, transcribed into both `LICENSE.md` files:

| Item | Finding | Status |
| --- | --- | --- |
| L-01 | The gist opens with an explicit CC0 public-domain dedication ("Written in 2017 by Tommy Ettinger ... dedicated all copyright and related and neighboring rights ... to the public domain worldwide", linking creativecommons.org/publicdomain/zero/1.0). | **RESOLVED — public domain; no replacement needed** |
| L-11 | Orillusion `LICENSE`: "Copyright (c) 2024 Orillusion", MIT. | **RESOLVED** |
| L-12 | mapbox/webgl-wind `LICENSE`: "Copyright (c) 2016, Mapbox", ISC. RaymanNg/3D-Wind-Field `LICENSE`: "Copyright (c) 2019 RaymanNg", MIT. | **RESOLVED** |
| L-13 | Popov72/OceanDemo `LICENSE.md` (branch `main`): "Copyright (c) 2020 Ivan Pensionerov" — the port retains the FFT-Ocean author's line; transcribed as found. | **RESOLVED** |
| L-18 | linebender/vello `LICENSE-MIT`: "Copyright 2020 the Vello Authors". Apache-2.0 half remains the operative grant. | **RESOLVED** |

**L-23 CLOSED — Batch 966 (maintainer-directed):** `wgslToJavaScript` now mirrors `glslToJavaScript`'s `@license` extraction (the docblock is re-emitted above the minified module); pinned by a mirror test in `verify-packaged-notices.spec.mjs` so the asymmetry cannot return. ~~The sole remaining open item is L-23~~ **All 23 determinations are now closed.** (should `wgslToJavaScript` mirror
`glslToJavaScript`'s `@license` extraction — a build-script decision).

## 8. Addendum — 2026-08-08, maintainer directive (Takram attribution)

`L-24` was added after the twenty-three above, by maintainer directive rather
than by the census, and is RESOLVED. **All 24 determinations are now closed.**

It is worth separating why it exists from what it changed. The census reads a
file as compliant when its provenance is *recorded somewhere*; every Takram
site recorded provenance in prose, so none was flagged, and the gap survived
from Batch 306 to here. A prose credit pointing at a document that ships in no
artifact is not a notice. The lesson generalises past this entry: **the census
detects unrecorded provenance, not unpublished notices** — the second is what
`Tools/c16/verify-packaged-notices.mjs` exists to catch, and it can only catch
it for headings the manifest in §5 actually names.

## 9. Addendum — 2026-08-13, Astronomy Engine dependency

`L-25` records the exact `astronomy-engine@2.1.19` dependency used only by the
opt-in high-precision celestial-ephemeris path. The upstream tag's `LICENSE`
is MIT, copyright 2019–2023 Don Cross. The npm tarball declares MIT but omits a
standalone license file, so the full upstream notice is mirrored in both
shipped `LICENSE.md` files and the dependency is named in `ThirdParty.json`.
The frozen registry-tarball and installed-file fingerprints live in
`Tools/visual-regression/fixtures/astronomy-engine-2.1.19-provenance.json`.
