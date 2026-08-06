# Star-map bake pipeline (Tycho SVS 3572 t5) — Campaign 12, C12-10

Reproducible offline pipeline that turns the NASA/GSFC SVS 3572 "Tycho Catalog
Skymap v2.0" **t5** equirectangular into the six cube faces the engine ships as
`SkyBox.Variant.TYCHO_T5`. It replaces the previous hand-edited Paint.NET
downsample with a deterministic, documented derivation.

> **Licence:** the t5 faces are **not** MIT. They are bundled under their own
> terms in the repo-root `LICENSE.md` → _Bundled Engine Assets_ → _Star map cube
> maps_, cleared for this project's scope per `migration_doc/QUEUE_2026-07-19_CAMPAIGN12.md`
> §6f. Keep the `Credit: ESA` + `NASA/GSFC SVS` attributions.

---

## 1. Source

|              |                                                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Product      | "The Tycho Catalog Skymap — Version 2.0", NASA SVS ID **3572**, released 2009-01-26                                         |
| Variant      | `TychoSkymapII.t5_16384x08192` (threshold magnitude 5.0 — SVS: _"the Milky Way is very bright and bright stars are large"_) |
| Format taken | **TIFF** (highest fidelity offered — chosen over the 23.9 MB JPEG)                                                          |
| **URL**      | `https://svs.gsfc.nasa.gov/vis/a000000/a003500/a003572/TychoSkymapII.t5_16384x08192.tif`                                    |
| **SHA-256**  | `2eb9baf5796c62bb04d8c87625b93356cd5ff4172bc56d6b731df554393de04f`                                                          |
| Bytes        | 402,653,312 (384 MB)                                                                                                        |
| Pixels       | 16384 × 8192, 8-bit RGB, **no ICC profile**                                                                                 |
| Projection   | equirectangular / plate carrée in equatorial (RA/Dec) coordinates                                                           |

Download (kept out of git, under `work/`):

```bash
curl -L -o Tools/skybox-bake/work/TychoSkymapII.t5_16384x08192.tif \
  https://svs.gsfc.nasa.gov/vis/a000000/a003500/a003572/TychoSkymapII.t5_16384x08192.tif
sha256sum Tools/skybox-bake/work/TychoSkymapII.t5_16384x08192.tif
# 2eb9baf5796c62bb04d8c87625b93356cd5ff4172bc56d6b731df554393de04f
```

The 16384×8192 TIFF was available; no downgrade to a smaller t5 was needed.

---

## 2. Stage 1 — SMPTE gamma-1.8 → sRGB transfer

SVS states on the [3572 page](https://svs.gsfc.nasa.gov/3572/), verbatim:

> _"We have also set the color standard to SMPTE with a gamma of 1.8."_

The shipped JPEGs carry **no ICC profile**, so the engine (and any sRGB canvas)
treats their code values as sRGB. In the default SDR path `czm_gammaCorrect` is a
**no-op on both backends** (it only linearizes when `HDR` is defined), so the
stored 8-bit value is handed straight to the sRGB canvas and shown by the display
under its ~sRGB EOTF. A gamma-1.8-authored image shown that way is displayed as
`v^2.2` instead of the intended `v^1.8` → **too dark, flattened** (the queue's
"absolute faint look" contributor, shared by both backends — not a parity bug).

**Exact transfer applied** (per channel, `v ∈ [0,1]`):

```
# 1. decode SMPTE gamma 1.8 to linear light
L = v ^ 1.8

# 2. encode sRGB (IEC 61966-2-1 OETF)
sRGB(L) = 12.92 * L                        if L <= 0.0031308
        = 1.055 * L^(1/2.4) - 0.055        otherwise
```

Implemented as a 256→256 per-channel LUT (`buildTransferLut()`), applied to every
source pixel before reprojection. After this, `sRGB_EOTF(v') = v^1.8`, i.e. the
map appears at the brightness SVS intended on a gamma-1.8 display, reproduced on
an sRGB display.

### Measured effect (why it is a brighten _and_ a contrast increase)

The transfer is **not** a uniform brighten. Because the sRGB OETF has a linear
toe near black, it crosses `v^1.8`≈`identity` around code value ~10:

| source `v`  | 1   | 3   | 10  | 30  | 80  | 160 |
| ----------- | --- | --- | --- | --- | --- | --- |
| output `v'` | 0   | 1   | 10  | 40  | 99  | 176 |

- **Milky-Way band + stars (mid/high codes) brighten** — e.g. `v=30 → 40`,
  `v=80 → 99`. Face-level `P99` rises (pz `18 → 23`, mz `20 → 26`).
- **Empty inter-star sky (deep shadow, ~90% of pixels at `v ≤ 7`) is held or
  darkened by a code or two** — correct: space between stars is near-black.

Net: the visible structure gets brighter and the background gets darker →
**higher contrast**, which is the "un-flatten" the campaign wanted. See §6 for
the full before/after census against the shipped t3 faces.

Resampling is done in the (transferred) sRGB-encoded domain, matching how the
original t3 downsample was produced; the transfer itself is a per-pixel op
independent of resampling.

---

## 3. Stage 2 — reprojection & face orientation

Equirect → six GL cube faces. The face **orientation had to match the existing
`tycho2t3_80_*` faces** (same NASA product, so the content must land on the same
faces in the same rotation). It was **derived empirically**, not guessed:

1. Fixed the hardware GL cube-map face→direction reconstruction (OpenGL ES 3.0
   Table 3.21: `POSITIVE_X sc=-rz,tc=-ry,ma=rx`, etc.).
2. Searched every candidate convention = { 48 signed-permutation 3-D rotations }
   × { 8 dihedral uv orientations of the square }, reprojecting the t5 equirect
   for each and scoring it by low-pass **normalized cross-correlation** against
   the corresponding t3 face (low-pass so the diffuse Milky Way band — identical
   across t3/t5 — dominates over individual point-star position/size deltas).
3. Winner was **decisive**: NCC sum 5.705/6.0 with every face ≥ 0.89
   (px 0.97, mx 0.89, py 0.92, my 0.98, pz 0.98, mz 0.97); runner-up 5.510 with
   weaker px/mx. Confirmed visually (band structure and orientation align on all
   four galactic-plane faces).

**Derived convention** (folded into `faceSphereDir()`), with
`sc = 2·(col+0.5)/N − 1` across columns and `tc = 2·(row+0.5)/N − 1` down rows
(row 0 = top of the output image):

| face              | sphere direction `(x, y, z)` |
| ----------------- | ---------------------------- |
| `px` (POSITIVE_X) | `(-1,  tc, -sc)`             |
| `mx` (NEGATIVE_X) | `( 1,  tc,  sc)`             |
| `py` (POSITIVE_Y) | `(-sc, 1,  -tc)`             |
| `my` (NEGATIVE_Y) | `(-sc,-1,   tc)`             |
| `pz` (POSITIVE_Z) | `(-sc, tc,  1 )`             |
| `mz` (NEGATIVE_Z) | `( sc, tc, -1 )`             |

Relative to the raw GL face direction this is: **negate X**, and **flip the face
v-axis** (`t → 1−t`). Equirect lookup from a sphere direction:

```
lon = atan2(y, x)            # wrapped to [0, 2π)
lat = asin(z)
u   = lon / (2π)             # column
v   = (π/2 − lat) / π        # row; row 0 (top) = +Z = north celestial pole
```

Sampling is **bilinear** with longitude wrap and latitude clamp, so faces are
seam-continuous (they sample one continuous equirect) and the RA=0/360 meridian
has no seam.

The GL face convention here is the same one the engine consumes: `SkyBoxFS.glsl`
samples `czm_textureCube(u_cubeMap, normalize(v_texCoord))` where `v_texCoord`
is the raw box position, and `CubeMap.FaceName` maps `px…mz` to
`POSITIVE_X…NEGATIVE_Z`. The empirical match against the shipped faces is the
authority; this paragraph is the corroborating "why".

---

## 4. Stage 3 — outputs (blurred + un-blurred)

Reprojected at a master **4096/face**, then emitted at 4096 and downsampled
(Lanczos-3) to **2048/face**. Two variants, per DR-01 (§6c) which requires the
seam decision be reversible without a re-bake:

| file (under `out/`, gitignored)       | size     | what                                       |
| ------------------------------------- | -------- | ------------------------------------------ |
| `tycho2t5_80_{face}.jpg`              | **2048** | un-blurred — **the shipped default faces** |
| `tycho2t5_80_4096_{face}.jpg`         | 4096     | un-blurred — opt-in / VRAM policy (C12-12) |
| `tycho2t5_80_diffuse_{face}.jpg`      | 2048     | blurred diffuse-only (DR-01)               |
| `tycho2t5_80_diffuse_4096_{face}.jpg` | 4096     | blurred diffuse-only (DR-01)               |

### What actually ships (checked into git)

**Both** 2048 sets, at JPEG **quality 90, 4:4:4** chroma (the C12 G3 gate fails
under 4:2:0), under
`packages/engine/Source/Assets/Textures/SkyBox/`:

| set                              | installed by        | `SkyBox.Variant`   | total   | role                              |
| -------------------------------- | ------------------- | ------------------ | ------- | --------------------------------- |
| `tycho2t5_80_diffuse_{face}.jpg` | `--install-diffuse` | `TYCHO_T5_DIFFUSE` | 0.36 MB | **the default** — DR-01 seam      |
| `tycho2t5_80_{face}.jpg`         | `--install`         | `TYCHO_T5`         | 4.16 MB | DR-01 reversal artifact, retained |

`C12-11` (2026-08-06) completed the DR-01 seam: the cube map carries diffuse
Milky Way light only, and the 2,868-record sprite catalogue owns every resolved
star. `C12-10` had shipped the un-blurred faces first because the catalogue was
not yet deep enough to take over — with both sources painting the same stars, a
census measured the entire sprite field as worth ~3 px.

The diffuse set is **~12× smaller** than the un-blurred one (0.36 MB vs
4.16 MB): once the point sources are gone, what remains is a smooth band that
JPEG codes very cheaply. Note this is not a general rule — see §6.1 for the
measurement that contradicts the intuition in the other direction.

> **Note on face size.** At 2048/face a texel spans ~0.044°, while the diffuse
> content is band-limited to a ~1.03° FWHM — roughly 20× oversampled. A smaller
> diffuse face would be visually indistinguishable after bilinear magnification.
> 2048 is kept here because it is what `C12-11` ratified and it matches the
> reversal artifact texel-for-texel; revisiting it belongs with the `C12-12`
> VRAM/face-size policy, not here.

### Two defects found in this pipeline by `C12-11` (2026-08-06)

The diffuse faces had never been _consumed_ before `C12-11`, and when they were,
both of the following turned out to be true of `blurEquirectWrapped`. Recorded
because each was silent and each survived a plausible-looking sanity check:

1. **The blur never ran.** The helper chained `.blur(σ)` onto a
   `sharp({create}).composite([...])` pipeline. sharp applies `composite`
   **last**, regardless of chain order — so the blur hit the empty black base
   and the un-blurred strips were pasted on top of the result. The "diffuse"
   output was as sharp as its input.
2. **The result was mis-strided.** `composite()` returns RGB**A** even when the
   base is `channels: 3` and no input carries alpha; the caller read it back
   with a 3-byte stride, rotating channels against the pixel grid. That alone
   made the map ~29× too bright and added synthetic high-frequency edges.

Both are now fixed: the wrap padding is built with explicit `Buffer.copy` calls
and the blur runs in its own pipeline, with sentinels asserting the channel
count and byte length.

**The measurement lesson.** A whole-image **mean is invariant under blur**, so
it cannot distinguish "blurred" from "not blurred" — the first fix attempt
verified mean conservation and looked correct while the blur was still a no-op.
Only a **peak or point-source metric** discriminates: a genuine σ=20 low-pass
drops a synthetic star field's max from 250 to 65, while the broken path left it
at 250. That is why `starmap-census.mjs` exists and why the DR-01 gate is a
point census rather than any band statistic.

### Blurred (diffuse-only) variant parameters

- Low-pass = Gaussian on the corrected equirect, **σ default = 20 source-equirect
  pixels** (16384 px wide ⇒ 45.5 px/°, so σ ≈ 0.44°, FWHM ≈ 1.03°). That
  annihilates point sources (Tycho stars render < 0.1°) while preserving the
  degrees-scale Milky Way band. Override with `--sigma <px>`.
- Blur is applied with **horizontal wrap padding** (pad = ⌈3σ⌉ columns copied
  around the RA=0/360 seam) so the diffuse map has no meridian seam.

---

## 5. Running it

```bash
# one-time: fetch the source (see §1)

# bake every variant into out/ (gitignored):
node Tools/skybox-bake/bake-tycho-t5.mjs

# bake + copy the 2048 un-blurred faces into the engine Assets dir:
node Tools/skybox-bake/bake-tycho-t5.mjs --install

# re-run only the diffuse (blur) variant with a different sigma:
node Tools/skybox-bake/bake-tycho-t5.mjs --only-diffuse --sigma 28
```

Flags: `--input <tif>` `--out <dir>` `--faceSize 4096` `--shipSize 2048`
`--quality 90` `--chroma 4:4:4` `--sigma 20` `--install` `--only-diffuse`
`--only-unblurred`.

Large inputs need headroom: run under
`node --max-old-space-size=8192 Tools/skybox-bake/bake-tycho-t5.mjs …`.

### Dependency

Uses [`sharp`](https://sharp.pixelplumbing.com/) for all image ops. It resolves
transitively in this repo today; it **must** be added as an explicit
`devDependency` (a separate in-flight batch is landing that). If it fails to
resolve, `npm i -D sharp` at the repo root.

---

## 6. Measured result vs the shipped t3 faces

Shipped set (2048/face un-blurred, q90 4:4:4), total **4.355 MB** across 6 faces:

| face | px    | mx    | py    | my    | pz    | mz    |
| ---- | ----- | ----- | ----- | ----- | ----- | ----- |
| MB   | 0.618 | 0.589 | 0.764 | 0.782 | 0.757 | 0.845 |

All faces ≤ 0.85 MB — under the ~2 MB/face budget, so no quality drop was needed.

**Bright-content census** (share of face pixels above a grey threshold; corrected
t5 vs shipped t3), the actual "richer sky" upgrade:

| face | metric              | corrected t5           | t3                     |
| ---- | ------------------- | ---------------------- | ---------------------- |
| pz   | > 30 / > 60 / > 120 | 1.70% / 0.23% / 0.020% | 1.07% / 0.09% / 0.011% |
| mz   | > 30 / > 60 / > 120 | 2.23% / 0.29% / 0.024% | 1.75% / 0.15% / 0.017% |
| my   | > 30 / > 60 / > 120 | 1.40% / 0.16% / 0.016% | 1.13% / 0.09% / 0.011% |

t5 has **~2–2.5× more bright pixels** (denser Milky Way, more resolved stars) and
**~1.5–2× more very-bright pixels** (bright stars are larger, per SVS), while its
inter-star background sits correctly darker. This is a density + contrast win,
not a regression — the lower whole-face _mean_ is only the correctly-black empty
sky, not the band.

> ⚠ **For the visual reviewer:** because the repo's t3 faces were hand-brightened
> (lifted floor, P50≈4-5) above even the raw SVS t5 (P50≈1), a naive whole-frame
> mean reads corrected-t5 as "darker overall". It is darker _only between stars_.
> The band and stars are brighter and denser (table above). This is
> correct-by-spec; the maintainer's serial-Edge check is the place to confirm the
> look is preferred over the old hazy floor.

---

## 6.1 DR-01 seam census (`C12-11`, 2026-08-06)

Measured by `starmap-census.mjs` over the shipped 2048 faces and recorded, with
each file's SHA-256, in `skybox-manifest.json`. `points` counts **resolved point
sources** — strict local maxima rising above a _local_ ring background, so
diffuse brightness cannot register as a star.

| face | diffuse `points` | diffuse peak | un-blurred `points` | un-blurred peak | band kept |
| ---- | ---------------- | ------------ | ------------------- | --------------- | --------- |
| px   | **0**            | 8.1          | 4,482               | 252.3           | 88.5%     |
| mx   | **0**            | 11.1         | 4,099               | 250.9           | 83.5%     |
| py   | **0**            | 28.1         | 7,352               | 253.2           | 94.4%     |
| my   | **0**            | 15.1         | 8,050               | 254.3           | 93.3%     |
| pz   | **0**            | 26.0         | 8,318               | 255.0           | 91.2%     |
| mz   | **0**            | 27.1         | 10,960              | 254.9           | 94.6%     |

Every diffuse face carries **zero** resolved sources while retaining 83–95% of
its un-blurred band structure — the two-sided DR-01 claim (stars gone, Milky Way
kept). "Band kept" is measured against the _same_ face's un-blurred twin because
band strength depends on where a face points: `px`/`mx` look away from the
galactic centre and legitimately carry ~2.5× less structure than `mz`, so an
absolute floor would either reject a correct `px` or accept a half-wiped `mz`.

> ⚠ **A file-size intuition that is wrong here.** Blur usually shrinks a JPEG,
> but the _corrupt_ pre-fix artifacts were 1.64 MB/face — **larger** than the
> 0.62–0.89 MB un-blurred ones. The un-blurred t5 is ~90% pure black, which
> codes to almost nothing; anything that lifts light into every block costs
> bytes. Only after the blur genuinely ran did the faces fall to 0.05–0.08 MB.
> Size moved in both directions here, so it is a poor correctness signal — use
> the point census.

## 7. Files

- `bake-tycho-t5.mjs` — the pipeline (checked in).
- `README.md` — this file.
- `.gitignore` — excludes `work/` (source TIFF, intermediates) and `out/`
  (all baked artifacts). The **only** version-controlled outputs are the six
  `tycho2t5_80_*.jpg` under the engine Assets dir.
