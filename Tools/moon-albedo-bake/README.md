# Lunar surface bake pipelines (NASA SVS 4720 "CGI Moon Kit") — Campaign 12, C12-24 + C12-25

Two reproducible offline pipelines, both fed from the same NASA/GSFC SVS **CGI
Moon Kit** product and sharing one verify → derive → encode →
verify-the-encoded-bytes → manifest → install structure:

| bake                    | source                      | ships                                            | sections |
| ----------------------- | --------------------------- | ------------------------------------------------ | -------- |
| `bake-lroc-color.mjs`   | 2019 colour map             | `lroc_color_poles_2k.jpg` — 2048×1024 **albedo** | §1–§6    |
| `bake-lola-normals.mjs` | `ldem_16` LOLA displacement | `ldem_normal_1k.png` — 1024×512 **normal map**   | §7       |

The albedo replaces the 256×128 `moonSmall.jpg` inherited from upstream Cesium,
whose visible hemisphere was only 128 texels across (0.67 texels/px at a ~190 px
disc — under-resolved). The normal map adds terminator relief, which the disc
never had at all: before C12-25 the moon was a geometrically perfect sphere.

Both are selected together by `Moon.Variant.LROC_COLOR_2K`, the default;
`Moon.Variant.SMALL` keeps the historical albedo and no normal map.

> **Licence:** neither map is MIT. Both are bundled under their own terms in the
> repo-root `LICENSE.md` → _Bundled Engine Assets_ → _Lunar albedo map_ and
> _Lunar normal map_. Keep the `NASA/GSFC SVS`,
> `NASA/GSFC/Arizona State University` (albedo) and `NASA/GSFC/MIT` (LOLA)
> credits.

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

4. **C12-25 (LOLA normal map).** ✅ **DONE** — see §7.

---

## 7. Normal-map bake — `bake-lola-normals.mjs` (C12-25)

### 7.1 Source, and a corrected premise

NASA ships **displacement**, not normals, so this is a derivation rather than a
repackage. It is also **not** a 2K source: the C12-25 brief assumed a "2K
displacement map" exists on the 4720 page, and it does not. Verified by direct
HEAD request against the SVS host:

| file                        | status  |
| --------------------------- | ------- |
| `ldem_4.tif` (1440×720)     | 200     |
| `ldem_16.tif` (5760×2880)   | 200     |
| `ldem_64.tif` (23040×11520) | 200     |
| `ldem_*_uint.tif` (×3)      | 200     |
| `ldem_2k.tif`               | **404** |
| `ldem_1k.tif`               | **404** |
| `ldem_512.tif`              | **404** |

The family is 4 / 16 / 64 pixels per degree only. So:

|              |                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------- |
| Product      | "CGI Moon Kit", NASA SVS ID **4720** — LOLA displacement member                          |
| Variant      | **`ldem_16.tif`** — the smallest member FINER than the output grid                       |
| Format taken | **TIFF**, float32, 1 channel, no ICC profile                                             |
| **URL**      | `https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/ldem_16.tif`                      |
| **SHA-256**  | `1ea42bf44f7e9d694f79c3afa7145f97fbf06cc67372067d9fe73dce43bad796`                       |
| Bytes        | 66,378,634                                                                               |
| Pixels       | 5760 × 2880 (16 px/deg)                                                                  |
| Units        | **kilometres** relative to a **1737.4 km** sphere; measured range −8.982 km … +10.686 km |
| Projection   | equirectangular / plate carrée, centred on 0° longitude, north at the top                |
| Retrieved    | 2026-08-02                                                                               |

`ldem_4` was **rejected as the source**: at 1440×720 it is _coarser_ than the
output grid, so using it would have upsampled invented detail. The `_uint`
variants (uint16 half-metres) would also have worked — 0.5 m over a 10.7 km
texel is a slope quantization of 2×10⁻⁵, four orders below the median slope —
but the float32 member is the primary product and costs only download size,
which is not bundled anyway.

The bake verifies the pinned hash **and** asserts the decoded relief falls
inside the published LOLA extremes before deriving anything. A dimension check
alone would not catch a decode that silently normalised the field to 0…1, and
that failure produces a plausible-looking but wrongly-scaled normal map.

### 7.2 The derivation

Heights `h(lon, lat)` on a sphere of radius `R = 1 737 400 m`:

```text
dNorth = R * (PI / H)                  = 10 660.6 m/texel  (constant)
dEast  = R * cos(lat) * (2*PI / W)     = 10 660.6 m/texel at the equator
n      = normalize( -dh/dEast, -dh/dNorth, 1 )
```

Three details carry the whole correctness argument:

1. **Downsample the heights first, then differentiate.** The height field is
   area-averaged from 5760×2880 to the shipped grid — each output texel is the
   mean elevation of the ground it covers — and the central differences are
   taken _there_. So the shipped normals are exactly the normals of the
   shipped-resolution surface, and there is no filter-order argument to have.
   The filter is an **area average specifically because the next step
   differentiates**: a Lanczos downsample would ring at every crater rim, and
   differentiating an overshoot turns it into a false slope reversal.

2. **The `1/cos(lat)` problem is solved by widening the stencil, not by
   clamping the divisor.** At the top row of a 512-row map `cos(lat)` is
   0.0031, so a one-texel east difference would be divided by ~33 m of ground
   and any noise becomes a cliff. Instead the east stencil widens to
   `k = round(1/cos(lat))` texels, which holds the east baseline at
   ~`R·2π/W` metres of GROUND at every latitude — with `W = 2H` that is
   exactly the north baseline, so the derivative stencil is isotropic on the
   sphere everywhere. `k` is capped at `W/4` so it can never wrap onto itself.

3. **Poles wrap ACROSS, they do not clamp.** The neighbour north of `(x, 0)` is
   `(x + W/2, 0)` — genuinely one latitude step away over the top of the
   sphere. Clamping instead would halve the baseline and paint a ring of false
   slope around both poles, which is precisely the artifact that would be
   invisible in a nadir screenshot and obvious at a grazing terminator.

Measured on the shipped 1024×512 map:

| quantity     | value                                             |
| ------------ | ------------------------------------------------- |
| ground scale | 10 660.6 m/texel (north, and east at the equator) |
| slope \|∇h\| | median 0.0343, p90 0.112, p99 0.186, max 0.382    |
| surface tilt | mean 2.73°, p99 10.53°, max 20.90°                |

A p99 tilt of 10.5° is the number that matters: near the terminator `N·L ≈ 0`,
so a 10° facet is the difference between lit and unlit. At full phase
`N·L ≈ 1`, the cosine is flat, and the same 10° changes brightness by ~1.6%.
That asymmetry is the feature.

### 7.3 Tangent frame and encoding

Stored tangent-space in a **geographic** east-north-up frame — x = east,
y = north, z = up (the geodetic normal) — as `stored = n * 0.5 + 0.5`, so flat
is `(128, 128, 255)` and blue is always ≥ 0.5.

Because the frame is geographic and not image-space, there is **no "OpenGL vs
DirectX green channel" ambiguity** to inherit: +G means the surface tilts
toward the lunar north pole, full stop. Both backends rebuild that basis in
MODEL space from the same expression (see §9), and the image's own row order is
reconciled at the upload layer by the same `flipY: true` convention C12-24
established — so the albedo and the relief register texel for texel.

### 7.4 Output resolution — why 1024×512 and not 2048×1024

The albedo is 2048×1024, so the obvious choice is to match it. Measured, that
costs **2.92 MB** (PNG) against **664 KB**, and buys resolution the renderer
cannot currently use:

- **Neither backend mipmaps the moon** — tracked as `C12-33`. WebGL's
  `Material.js` never calls `generateMipmap()`; WebGPU creates the texture with
  `mipLevelCount` 1 and samples `textureSampleLevel(…, 0.0)`.
- At the **default** camera the disc is ~16 px across, so a 2048-wide map is
  ~64:1 minification off mip 0. Aliasing in a _normal_ map is worse than in an
  albedo: it flickers the **lighting** under camera motion rather than the
  colour, and it does so worst at the terminator — exactly where this asset is
  supposed to be read.
- At the ~190 px **zoomed** disc the feature is actually for, 1024×512 still
  leaves ~2.7 texels/px. It is not the binding constraint.

So the 1K map is the right pairing _today_, and `--width 2048` re-bakes the
larger one in one flag once `C12-33` lands. Both are gated on the same source.

### 7.5 Encoding — PNG, measured not assumed

Normal maps are not photographs. After the RGB→YCbCr rotation the two
_informative_ channels land in the chroma planes, so JPEG's usual advantage
inverts. Fidelity is quoted as **mean/max angular error of the decoded normal**,
which is the unit that matters, with both sides renormalised (as the shaders do):

| encoding (1024×512)          | size    | tilt error mean | max     |
| ---------------------------- | ------- | --------------- | ------- |
| **PNG 8-bit RGB (lvl 9)** ✅ | 664 KB  | **0.173°**      | 0.347°  |
| PNG 16-bit RGB (lvl 9)       | 1244 KB | ~0°             | ~0°     |
| JPEG q90 4:4:4               | 116 KB  | 1.262°          | 9.468°  |
| JPEG q90 4:2:0               | 75 KB   | 1.677°          | 14.666° |
| WebP lossless                | 458 KB  | 0.173°          | 0.347°  |

JPEG is **rejected on the measurement, not the principle**: 1.26° of mean error
against a signal whose own mean tilt is 2.73° corrupts 46% of the payload, and
the 9.5° worst case lands on the crater rims that are the entire point.
16-bit PNG is rejected as 1.9× the size to remove an error (0.17°) already
14× below the median signal. WebP ties PNG on fidelity and is 31% smaller, but
the engine's bundled-asset path has no WebP precedent — the same reasoning
C12-24 applied.

The 2048×1024 table, for the C12-33 follow-up: PNG-8 2918 KB / 0.173°, PNG-16
5137 KB, JPEG 4:4:4 538 KB / 1.320°, JPEG 4:2:0 348 KB / 1.854°, WebP lossless
1969 KB.

### 7.6 Relief verification — what is actually pinned

A derived normal map can be silently wrong in ways that still render a plausible
moon: a mirrored green channel lights every crater from the wrong side, a
mirrored red channel does the same east/west, an x/y transpose rotates all
relief 90°, and a broken height decode yields a uniformly flat map that passes
every polarity test vacuously. None of those crash or look broken at full
phase — they only show at the terminator.

`lunar-relief.mjs` pins them against a physical fact: **craters are bowls, so on
the inner wall the surface normal tilts INWARD.** That is independently signed
in east/west and in north/south, so each mirror gets its own named check.

| check                      | what it measures                                                | fails on                   |
| -------------------------- | --------------------------------------------------------------- | -------------------------- |
| `normalsAreUnitAndOutward` | unit length + z > 0 everywhere                                  | corrupt encode             |
| `reliefIsPresent`          | RMS tangential component                                        | flat / dead height map     |
| `craterEastWestPolarity`   | west wall `nx` > 0 > east wall `nx`                             | **mirrored red**           |
| `craterNorthSouthPolarity` | south wall `ny` > 0 > north wall `ny`                           | **mirrored green**         |
| `craterLitFromTestAzimuth` | Lambert shade, grazing light, 4 azimuths — lit wall is brighter | either mirror (end-to-end) |
| `channelsAreNotSwapped`    | the E/W signal lives in `nx`, not `ny`                          | **x/y transpose**          |

`craterLitFromTestAzimuth` is the one that speaks the language of the bug: it
composes the stored normals exactly as the shaders do, at 10° elevation
(terminator geometry), and requires the wall facing the light to be the
brighter one. A user would only ever report this defect as "the craters are lit
from the wrong side".

Craters used: **Tycho** (11.4°W, 43.3°S, 85 km, 4.8 km deep) and **Copernicus**
(20.1°W, 9.6°N, 93 km, 3.8 km deep) — the same two the albedo checks use, so a
single landmark-table error cannot pass one asset and fail the other silently.

#### Measured results on the shipped asset

```text
PASS  normalsAreUnitAndOutward     0.001003 (minZ 0.937255, max |len-1| 0.004741)
PASS  reliefIsPresent              0.064285 (RMS tangential; mean tilt 3.69 deg)
PASS  craterEastWestPolarity       0.170308 (need >= 0.08)
      tycho:      W-wall nx  0.114706 vs E-wall nx -0.146078   (sep 0.260784)
      copernicus: W-wall nx  0.085154 vs E-wall nx -0.085154   (sep 0.170308)
PASS  craterNorthSouthPolarity     0.160483 (need >= 0.08)
      tycho:      S-wall ny  0.104314 vs N-wall ny -0.116340   (sep 0.220654)
      copernicus: S-wall ny  0.083560 vs N-wall ny -0.076923   (sep 0.160483)
PASS  craterLitFromTestAzimuth     2.631915 (need >= 1.3)
      worst lit:unlit wall ratio over {tycho, copernicus} x {E, W, N, S}
PASS  channelsAreNotSwapped        0.160224 (need >= 0.04)
      tycho:      E/W separation in nx 0.260784 vs in ny 0.006863
      copernicus: E/W separation in nx 0.170308 vs in ny 0.010084
```

The cross-channel leakage (0.007 / 0.010 against an in-channel 0.26 / 0.17) is
the strongest single statement here: the east/west relief is 25–38× more
present in red than in green, which is what a correctly-oriented tangent frame
looks like.

#### The checks are adversarially validated

A discriminator that never fires is not a discriminator. The spec re-runs the
whole battery against deliberately corrupted maps and requires every one to be
**rejected** — including the flipped-Y case the C12-25 brief calls out by name:

| case           | corruption                     | verdict    |
| -------------- | ------------------------------ | ---------- |
| _identity_     | —                              | **ACCEPT** |
| `flipGreen`    | `ny -> -ny` (flipped-Y map)    | REJECT     |
| `flipRed`      | `nx -> -nx`                    | REJECT     |
| `swapChannels` | `nx <-> ny`                    | REJECT     |
| `mirrorLat`    | image flipped north/south      | REJECT     |
| `mirrorLon`    | image flipped east/west        | REJECT     |
| `flatten`      | every texel -> (128, 128, 255) | REJECT     |

---

## 8. Both-backends wiring (C12-25)

Unlike C12-24 (texture-only), this **is** a shader change, so it carries a
`migration_doc/SHADER_PAIRS_LOCKSTEP.md` row. The twins are
`EllipsoidFS.glsl`'s `LUNAR_NORMAL_MAP` block and the `u.normalStrength > 0.0`
block in `Shaders/WebGPU/Environment/Moon.wgsl`.

Both rebuild the east-north-up basis **in model space**, from the same
expression on the same vectors:

```text
up    = normalMC                                   (geodetic normal, side-flipped)
east  = normalize(-positionMC.y, positionMC.x, 0)  (guarded at the poles)
north = cross(up, east)
N'    = normalize(east*n.x + north*n.y + up*n.z)
```

This is identical to what `czm_eastNorthUpToEyeCoordinates` builds (column 0 =
east, column 1 = up × east = north, column 2 = up). The GLSL side does **not**
call that builtin, and that is deliberate: the WGSL side has no `czm_normal` to
lean on and does all its lighting in model space, so doing it inline on both
keeps the twins the same expression instead of "equivalent if you work it out".
The inline form also guards the pole degeneracy, where `(-y, x, 0)` vanishes and
the builtin would normalise a zero vector.

Perturbing `material.normal` / `m.normal` — the **lighting** normal, not the UV
normal — is what makes the relief ride whichever disc law is selected: the
Lommel-Seeliger term (C12-20) and the Phong fallback both light against it.

Two deliberate **wiring** asymmetries, neither of which is a math asymmetry:

|           | WebGL                                                                                                        | WebGPU                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| off state | `LUNAR_NORMAL_MAP` define absent — sampler compiled out entirely                                             | binding 3 always present, bound to a 1×1 flat `(128,128,255)` placeholder; `normalStrength = 0` skips the fetch |
| why       | `EllipsoidFS.glsl` is shared by **every** `EllipsoidPrimitive`, so it must not grow an unconditional sampler | `Moon.wgsl` is moon-only, so one pipeline with no variants is strictly better                                   |

Both reach the **exact** identity when off: strength 0 drives `nTS` to
`(0, 0, z)`, and `normalize(east*0 + north*0 + up*z) = up`, bit-for-bit the
unperturbed normal.

The strength itself is resolved **once, backend-agnostically**, in
`Moon.update()` — it folds together the `enableLunarNormalMap` toggle, the
variant gate, and the user's dial, then publishes
`frameState.moonNormalMapStrength`. Both backends read that one number, so they
cannot disagree about whether relief is on.

The WebGL texture is owned by `Moon.js` rather than by `Material`:
`Material.ImageType` carries exactly one image and has no normal channel, and
growing the shared material system for one body would touch every image
material in the engine. It follows the same private-uniform route the four
existing C12 moon terms already use on `EllipsoidPrimitive`.

The uniform buffer grows **336 → 352 bytes**, add-only at the tail (the
320..335 slot was already full: `inscatter` vec3 + `oppositionSurge`). Every
existing offset is frozen.

---

## 9. Running them

```bash
# one-time: fetch the sources (see §1 and §7.1)
mkdir -p Tools/moon-albedo-bake/work
curl -L -o Tools/moon-albedo-bake/work/lroc_color_poles_2k.tif \
  https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_2k.tif
curl -L -o Tools/moon-albedo-bake/work/ldem_16.tif \
  https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/ldem_16.tif

node Tools/moon-albedo-bake/bake-lroc-color.mjs --install
node Tools/moon-albedo-bake/bake-lola-normals.mjs --install

node --test Tools/visual-regression/moon-albedo-asset.spec.mjs
node --test Tools/visual-regression/moon-normal-map-asset.spec.mjs
```

Shared flags: `--input <tif>` `--out <dir>` `--install` `--verify`
`--skip-hash-check` (the last only for a deliberate re-pin — update `SOURCE`
and `LICENSE.md` in the same change). `bake-lola-normals.mjs` adds
`--width <px>` (output width; height is half) and `--encodings` (print the
size/fidelity table and stop).

### Dependency

Uses [`sharp`](https://sharp.pixelplumbing.com/), declared in the root
`package.json` devDependencies.

---

## 10. Files

- `bake-lroc-color.mjs` — the albedo pipeline (checked in).
- `bake-lola-normals.mjs` — the normal-map pipeline (checked in).
- `lunar-landmarks.mjs` — dependency-free landmark table + **albedo**
  alignment checks, shared by the albedo bake and its spec (checked in).
- `lunar-relief.mjs` — dependency-free normal derivation + **relief** checks,
  shared by the normal bake and its spec (checked in).
- `moon-albedo-manifest.json` — albedo provenance + alignment evidence.
- `moon-normal-manifest.json` — normal-map provenance, derivation constants,
  slope statistics + relief evidence.
- `README.md` — this file.
- `.gitignore` — excludes `work/` (source TIFFs) and `out/` (bake artifacts).
  The **only** version-controlled outputs are
  `packages/engine/Source/Assets/Textures/Moon/lroc_color_poles_2k.jpg` and
  `packages/engine/Source/Assets/Textures/Moon/ldem_normal_1k.png`.

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
