# Lunar albedo bake pipeline (NASA SVS 4720 "CGI Moon Kit") — Campaign 12, C12-24

Reproducible offline pipeline that turns the NASA/GSFC SVS **CGI Moon Kit** 2019
colour map into the 2048×1024 albedo the engine ships as
`Moon.Variant.LROC_COLOR_2K` — the default moon texture since C12-24. It
replaces the 256×128 `moonSmall.jpg` inherited from upstream Cesium, whose
visible hemisphere was only 128 texels across (0.67 texels/px at a ~190 px
disc — under-resolved).

> **Licence:** the map is **not** MIT. It is bundled under its own terms in the
> repo-root `LICENSE.md` → _Bundled Engine Assets_ → _Lunar albedo map_. Keep
> the `NASA/GSFC SVS` and `NASA/GSFC/Arizona State University` credits.

---

## 1. Source

|              |                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------- |
| Product      | "CGI Moon Kit", NASA SVS ID **4720**, released 2019-09-06                                         |
| Variant      | the **2019** colour map (`lroc_color_poles` family), _not_ the 2025 `lroc_color` family — see §2  |
| Format taken | **TIFF**, 24-bit RGB, no ICC profile                                                              |
| **URL**      | `https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_2k.tif`                   |
| **SHA-256**  | `13b797422e8c4b8607ff2b2623ac3a046a6da0132d567c2d272d92fad7052c4a`                                |
| Bytes        | 3,339,438                                                                                         |
| Pixels       | 2048 × 1024                                                                                       |
| Projection   | equirectangular / plate carrée, **centred on 0° longitude** (SVS's own wording), north at the top |
| Retrieved    | 2026-08-01                                                                                        |
| Underlying   | LROC Wide Angle Camera "Hapke Normalized" mosaic (ASU), gamma corrected + white balanced by SVS   |

Download (kept out of git, under `work/`):

```bash
mkdir -p Tools/moon-albedo-bake/work
curl -L -o Tools/moon-albedo-bake/work/lroc_color_poles_2k.tif \
  https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_2k.tif
sha256sum Tools/moon-albedo-bake/work/lroc_color_poles_2k.tif
# 13b797422e8c4b8607ff2b2623ac3a046a6da0132d567c2d272d92fad7052c4a
```

The bake verifies that hash before doing anything and aborts on a mismatch — a
silent SVS re-issue must fail loudly rather than quietly change the shipped moon.

---

## 2. Why the 2019 map, and why the official 2K

SVS publishes **two** colour maps on the 4720 page:

- **2025** (`lroc_color_16bit_srgb_*.tif`, plus a float16 EXR) — reprocessed in
  December 2025 with commercial software; SVS says it "preserves more of the
  colour and dynamic range of the source data and adds greater detail in the
  polar regions".
- **2019** (`lroc_color_poles_*.tif`) — the original, "used successfully in a
  number of visualizations".

The **2019** family is taken here for three reasons: it is published at exactly
2048×1024 (the shipped size, so the bake adds no resampling kernel of its own);
it is 8-bit RGB, matching the 8-bit `rgba8unorm` / `RGB8` texture the moon path
allocates on both backends, so no bit-depth reduction is invented in the bake;
and its smallest member of the 2025 family is 4096×2048, which would force a
downsample whose filter choice would have to be defended. Moving to the 2025 map
is a clean follow-up (§6) once a downsample filter is agreed — the alignment
convention is identical, so nothing but the pinned hash and size would change.

The larger 2019 members (4k / 8k / 16k / the 27360×13680 master) exist and are
drop-in for a higher-resolution variant, gated on the mipmap work in §6.

---

## 3. Stages

### 1. Verify

Pinned SHA-256 + a 2048×1024 dimension assert.

### 2. Transfer — **none**

Unlike SVS 3572 (the star map, which SVS documents as _"colour standard SMPTE
with a gamma of 1.8"_ and which therefore needed the gamma-1.8 → sRGB fix in
`Tools/skybox-bake`), SVS states **no** non-sRGB colour standard for the CGI
Moon Kit colour map, and the source carries **no ICC profile**. It is consumed
as sRGB, which is exactly how the engine treats it. No transfer is applied.

### 3. Exposure match — **none needed** (measured, not assumed)

A resolution swap must not become a lighting change. Measured relative
luminance over the **nearside** (|lat| < 70°, |lon| < 80° — the hemisphere Earth
actually sees):

| map                       | nearside mean | nearside median |
| ------------------------- | ------------- | --------------- |
| `moonSmall.jpg` (shipped) | 138.1         | 139             |
| `lroc_color_poles_2k`     | 133.1         | 139             |

The medians are **identical** and the means differ by 3.6%; the gamma that would
map one median onto the other is **1.0016**, i.e. the identity. So no tone curve
is applied and the visible disc brightness is unchanged by the swap.

(The two maps differ substantially in _global_ mean — 139.5 vs 150.7 — but
entirely on the farside and near the poles, which the old map rendered poorly
and which is never visible from Earth.)

### 4. Resample — **none**

SVS publishes this product at exactly the shipped 2048×1024.

### 5. Encode

**JPEG quality 90, 4:4:4 chroma** — the same encode as the C12-10 star faces,
the fork's precedent for bundled NASA celestial imagery. Measured alternatives:

| encoding              | size    |
| --------------------- | ------- |
| JPEG q90 **4:4:4** ✅ | 550 KB  |
| JPEG q90 4:2:0        | 531 KB  |
| JPEG q95 4:4:4        | 848 KB  |
| WebP q90              | 491 KB  |
| PNG (24-bit, lvl 9)   | 1672 KB |

4:2:0 saves only 19 KB (3.5%) and smears the subtle mare colour differences that
are the entire reason for shipping a _colour_ map — rejected. PNG is 3× the size
for no visible gain on a photographic source — rejected. WebP is marginally
smaller but the engine's bundled-asset path has no WebP precedent.

**KTX2 was preferred but is not produced** — see §6.

### 6. Verify the _encoded_ bytes

The alignment checks run on the JPEG that will actually ship, decoded back —
not on the source TIFF. Nothing is written or installed unless every check
passes.

### 7. Manifest

`moon-albedo-manifest.json` (checked in, next to this README) records the
provenance, the encode settings, the shipped file's SHA-256, and the measured
landmark luminances.
`Tools/visual-regression/moon-albedo-asset.spec.mjs` re-derives the shipped
file's hash and **rejects the manifest if they disagree**, so the recorded
evidence can never drift away from the asset it describes.

---

## 4. Alignment verification — what is actually pinned

A texture swap can be silently wrong in ways that still render a plausible grey
ball: longitude shifted 180° (nearside painted on the farside), longitude
mirrored (east/west), latitude mirrored (north/south), or a combination. None of
those crash, 404, or produce an obviously broken frame.

The engine unwraps the sphere with `czm_ellipsoidTextureCoordinates` (GLSL) and
its WGSL twin `ellipsoidTexCoords`, both of which are literally the same
expression:

```
u = atan2(n.y, n.x) / (2π) + 0.5
v = asin(n.z) / π + 0.5
```

evaluated on the surface normal in the Moon's IAU body-fixed frame (+X at 0°
longitude, +Y at 90° east, +Z at the north pole). So `u = 0.5` at 0° longitude,
`u` grows eastward, and `v = 1` at the north pole. Combined with the `flipY:true`
upload both backends now use, that means the stored image must be an
**equirectangular map, centred on 0° longitude, east to the right, north at the
top of the file.**

`lunar-landmarks.mjs` asserts exactly that, against named features whose
relative albedo is a physical fact:

| check                       | what it measures                                                       | fails on                     |
| --------------------------- | ---------------------------------------------------------------------- | ---------------------------- |
| `nearsideDarkerThanFarside` | mean luminance of \|lon\|≤60° vs \|lon\|≥120°                          | **180° longitude phase**     |
| `crisiumRingContrast`       | Mare Crisium (59.1°E, 17.0°N) ring-minus-centre, vs the same at 59.1°W | **east/west mirror**         |
| `tychoBrighterThanMirror`   | Tycho (11.4°W, 43.3°S) vs its equatorial reflection (43.3°N)           | **north/south mirror**       |
| `copernicusLocalContrast`   | Copernicus (20.1°W, 9.6°N) vs its surroundings                         | gross longitude drift        |
| `mariaDarkerThanHighlands`  | brightest named mare vs darkest named bright feature                   | any scramble (global sanity) |

Why the checks are shaped the way they are:

- **Crisium** is the east/west discriminator because it is a _compact dark oval
  completely ringed by bright highlands_. Its longitude mirror (−59°) lands
  inside Oceanus Procellarum — also dark, so a naive point sample cannot tell
  them apart. The **ring** can: measured ring-minus-centre is **55.8** at +59°E
  versus **14.3** at −59°E.
- **Tycho** is the north/south discriminator because its equatorial reflection
  lands in Mare Imbrium, one of the darkest places on the nearside. Measured:
  **195.6** vs **95.1**.

### Measured results on the shipped asset

```
PASS  nearsideDarkerThanFarside    36.23  (need >= 12)
      nearside(|lon|<=60) mean 120.61 vs farside(|lon|>=120) mean 156.84
PASS  crisiumRingContrast          55.84  (need >= 25 and >= mirror+15)
      Crisium(+59E) ring-centre 55.84 vs mirror(-59E) 14.25
PASS  tychoBrighterThanMirror     100.53  (need >= 40)
      Tycho(-11E,-43) 195.60 vs N/S mirror(-11E,+43) 95.07
PASS  copernicusLocalContrast      54.22  (need >= 15)
      Copernicus 165.31 vs surround 111.09
PASS  mariaDarkerThanHighlands     77.23  (need >= 10)
      darkest bright feature 163.08 vs brightest mare 85.86
```

### The checks are adversarially validated

A discriminator that never fires is not a discriminator. The spec re-runs the
whole battery against five deliberate mis-orientations and requires every one to
be **rejected**:

| case         | nearsideDark | crisiumRing | tychoBrighter | copernicus | mariaDarker | verdict    |
| ------------ | ------------ | ----------- | ------------- | ---------- | ----------- | ---------- |
| _identity_   | pass         | pass        | pass          | pass       | pass        | **ACCEPT** |
| `shift180`   | FAIL         | FAIL        | FAIL          | FAIL       | FAIL        | REJECT     |
| `mirrorLon`  | pass         | FAIL        | FAIL          | FAIL       | FAIL        | REJECT     |
| `mirrorLat`  | pass         | FAIL        | FAIL          | FAIL       | FAIL        | REJECT     |
| `mirrorBoth` | pass         | FAIL        | FAIL          | pass       | FAIL        | REJECT     |
| `rot180`     | FAIL         | FAIL        | FAIL          | FAIL       | FAIL        | REJECT     |

### Independent cross-check against the map being replaced

Before any of the above, the new map's orientation was confirmed against the
_shipped_ `moonSmall.jpg` by normalized cross-correlation over
{longitude mirror} × {latitude mirror} × {all 256 longitude shifts}, low-passed
so the large-scale mare pattern dominates and restricted to |lat| < 60° to
exclude the old map's polar smear. The winner is decisive and is the identity:

| orientation family                 | best shift | NCC       |
| ---------------------------------- | ---------- | --------- |
| **none (identity)**                | **0°**     | **0.622** |
| longitude mirrored                 | 296.7°     | 0.446     |
| latitude mirrored                  | 277.0°     | 0.243     |
| both mirrored                      | 268.6°     | 0.247     |
| identity family, +180° (antipodal) | 180°       | −0.317    |

So the new map is a drop-in for the old one: same projection, same centring,
same handedness. WebGL renders it correctly with no change at all.

---

## 5. Both-backends wiring

The swap is **texture-only — no shader change**, so no
`SHADER_PAIRS_LOCKSTEP.md` row is needed. The GLSL/WGSL UV twins are untouched
and the spec asserts they stay character-identical.

One backend fix _was_ required, at the upload layer:

> **The WebGPU moon albedo was rendering vertically mirrored against WebGL.**
> WebGL reaches the moon texture through `Material.ImageType` → `Texture`, which
> defaults to `flipY: true`, so image row 0 lands at `t = 1` and the north pole
> (v = 1) samples the **top** row of the file. The WebGPU path
> (`WebGPUEnvironmentRenderer._loadRealMoonTexture`) called
> `WebGPUImageUpload.uploadImageToTexture` with no options, and
> `copyExternalImageToTexture` defaults to `flipY: false` — so the WebGPU north
> pole sampled the **bottom** row. Both backends share the identical
> `v = asin(n.z)/π + 0.5` unwrap, so the two conventions cannot both be right.
> The 256×128 `moonSmall.jpg` is soft and low-contrast enough that nobody saw
> it; on this map it is obvious (Tycho's ray system lands in the wrong
> hemisphere).
>
> Fixed by passing `flipY: true` at the **upload**, not by flipping `v` in the
> WGSL — so it holds for any user-supplied `moon.textureUrl` too, and the shader
> twins stay identical. Pinned by the spec.

The historical map is preserved behind the config switch as
`Moon.Variant.SMALL`; `Moon.Variant.LROC_COLOR_2K` is the new
`Moon.defaultVariant`. An explicit `options.textureUrl` still overrides both.

---

## 6. Known follow-ups (NOT done here)

1. **KTX2 / Basis encode — deferred, tooling absent.** No KTX2 encoder is
   available in this repo or on the build machine: `toktx`, `ktx` and `basisu`
   are all absent from `PATH`, and the `ktx-parse` package that _is_ installed
   is a container parser, not a BasisU/UASTC encoder. A UASTC or ETC1S KTX2
   would cut both the download and the VRAM footprint (JPEG decompresses to
   8 MB of `rgba8unorm`; a transcoded BC7/ASTC would be 2 MB). Adding a
   `toktx` step is the follow-up; the bake is already structured so only the
   encode stage changes.

2. **Mipmaps — the real blocker on going above 2K, and a live aliasing
   concern.** _Neither_ backend mipmaps the moon texture today:

   - WebGL: `Material.js` never calls `generateMipmap()`, and the sampler is
     plain `LINEAR`.
   - WebGPU: the moon texture is created with `mipLevelCount` 1, the sampler
     has no `mipmapFilter`, and `Moon.wgsl` deliberately uses
     `textureSampleLevel(..., 0.0)` because it is called from non-uniform
     control flow.

   At the _default_ camera the moon disc is only ~16 px across (0.52° in a ~36°
   vertical FOV at 1080 px), while the visible hemisphere of a 2048-wide map is
   1024 texels — roughly **64:1 minification, sampled at mip 0**. The old
   256-wide map was ~8:1 in the same view, so this swap makes an existing
   aliasing/shimmer condition measurably worse under camera motion, even though
   it is a large win at the zoomed views C12-24 was raised for (~5.4:1 at a
   190 px disc, versus the old map's 0.67 texels/px).

   This is _not_ fixed here because it is genuinely cross-cutting rather than
   moon-specific: WebGL needs mipmap support added to `Material.js` (which every
   image material shares), and WebGPU needs mip generation plus an explicit-LOD
   path in `Moon.wgsl` — a shader change, hence a lockstep pair. Sketch of the
   fix: generate mips on both backends, and feed the WGSL a single CPU-computed
   LOD uniform derived from the moon's projected disc diameter in pixels
   (`lod = log2((texWidth/2) / discDiameterPx)`, clamped at 0). That is
   constant across the disc, so it needs no derivatives and sidesteps the
   non-uniform-control-flow restriction entirely. **Flagged for the maintainer
   as the immediate next item** — see the C12-24 notes in
   `migration_doc/QUEUE_2026-07-19_CAMPAIGN12.md`.

3. **2025 colour map.** Higher dynamic range and better polar detail; needs a
   defended downsample filter (smallest published member is 4096×2048) and a
   re-pin of the hash. Same alignment convention, so §4 carries over unchanged.

4. **C12-25 (LOLA normal map) readiness.** See §7.

---

## 7. C12-25 readiness notes — LOLA-derived normal map

`C12-25` wants terminator relief from the LOLA displacement map. What this bake
establishes for it:

- **Same page, same projection, same centring.** The displacement maps
  (`ldem_*.tif`, SVS 4720) are documented as "centred on 0° longitude" exactly
  like the colour map, at 4 / 16 / 64 pixels per degree (1440×720, 5760×2880,
  23040×11520). So `lunar-landmarks.mjs` and its coordinate helpers apply
  unchanged — a derived normal map can be alignment-checked with the _same_
  geometry, and should be (a normal map with a mirrored green channel is
  precisely the kind of silent error §4 exists to catch; add a slope-sign check
  against a known crater rim).
- **Units.** `ldem_*.tif` is float32 kilometres relative to a 1737.4 km sphere;
  `ldem_*_uint.tif` is uint16 half-metres relative to 1727400 m. The normal
  derivation must scale the horizontal step by the _lunar_ radius, and must
  divide the longitude step by cos(latitude) or the relief will shear toward the
  poles.
- **Ship the derived normals, not the heights.** NASA ships displacement; the
  Sobel/central-difference derivation is an offline step that belongs in a
  sibling `bake-lola-normals.mjs` reusing this file's verify/manifest/install
  structure.
- **The binding it needs — this is the actual gate.** The moon is drawn through
  `Material.fromType(Material.ImageType)`, and `Material.ImageType` has **one**
  image slot and no normal-map slot. So:
  - **WebGL** needs a new material type (or an extension of `ImageType`) that
    carries a second sampler and writes `material.normal` in tangent space via
    `materialInput.tangentToEyeMatrix` — `EllipsoidFS.glsl` already computes
    that matrix (`czm_eastNorthUpToEyeCoordinates`) and currently throws it
    away, so the plumbing exists but the material does not. This is the
    "material extension, not a one-liner" the queue row warns about.
  - **WebGPU** needs `@group(0) @binding(3) var normalTex: texture_2d<f32>`
    added to `Moon.wgsl` (binding 3 is free — 0/1/2 are the UB, albedo texture
    and sampler), the sampler at binding 2 reused, plus the matching entries in
    the moon bind-group layout and bind group in
    `WebGPUEnvironmentRenderer.js`. The uniform block has **no** spare room at
    a 16-byte boundary before its 336-byte tail, so any new scalar (e.g. a
    normal-strength dial) must extend the buffer — add-only at the tail, per
    the existing comment discipline in `Moon.wgsl`.
  - Both need the **same `flipY: true` upload convention** established here, or
    the relief will light from the wrong side on one backend only.
  - The normal map should be a **second variant-gated asset**, not
    unconditional: `Moon.Variant` already exists as the switch, and a normal map
    only makes sense paired with an albedo of comparable resolution.

---

## 8. Running it

```bash
# one-time: fetch the source (see §1)

node Tools/moon-albedo-bake/bake-lroc-color.mjs            # bake into out/
node Tools/moon-albedo-bake/bake-lroc-color.mjs --install  # + copy into Assets
node Tools/moon-albedo-bake/bake-lroc-color.mjs --verify   # re-check the INSTALLED asset

node --test Tools/visual-regression/moon-albedo-asset.spec.mjs
```

Flags: `--input <tif>` `--out <dir>` `--install` `--verify` `--skip-hash-check`
(the last only for a deliberate re-pin — update `SOURCE` and `LICENSE.md` in the
same change).

### Dependency

Uses [`sharp`](https://sharp.pixelplumbing.com/), declared in the root
`package.json` devDependencies.

---

## 9. Files

- `bake-lroc-color.mjs` — the pipeline (checked in).
- `lunar-landmarks.mjs` — dependency-free landmark table + alignment checks,
  shared by the bake and the spec (checked in).
- `moon-albedo-manifest.json` — provenance + alignment evidence (checked in).
- `README.md` — this file.
- `.gitignore` — excludes `work/` (source TIFF) and `out/` (bake artifacts).
  The **only** version-controlled output is
  `packages/engine/Source/Assets/Textures/Moon/lroc_color_poles_2k.jpg`.
