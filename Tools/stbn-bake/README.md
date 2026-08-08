# `Tools/stbn-bake` — in-repo spatiotemporal blue-noise generation

Campaign-13 row **`C13-11`**, unblocked by maintainer ruling **`R-2026-08-10-5`**
("generate our own, ground up"). This directory contains a reproducible build
tool that **computes** a spatiotemporal blue-noise (STBN) mask from published
algorithms, certifies it against the published spectral characterisation of
blue noise, and installs it into the engine's bundled assets.

```bash
node Tools/stbn-bake/bake-stbn.mjs                # bake + certify into out/
node Tools/stbn-bake/bake-stbn.mjs --install      # + install into Assets/Textures/Noise
node Tools/stbn-bake/bake-stbn.mjs --verify       # re-certify the INSTALLED asset
node Tools/stbn-bake/bake-stbn.mjs --repro        # bake twice, assert identical sha256
node --test Tools/visual-regression/stbn-asset.spec.mjs   # the gate
```

No dependencies beyond Node built-ins.

---

## 1. Why this tool exists at all

The procedural-cloud renderer dithers its half-resolution sampling with a 4×4
ordered Bayer matrix and its ray-march start phase with an analytic
interleaved-gradient hash. Both are cheap and both are visible: an ordered
matrix repeats on a 4-pixel lattice, and neither is decorrelated along the time
axis, so the temporal accumulator averages a _structured_ error rather than a
random one. Replacing them with a mask that is blue in space **and** blue in
time is the standing quality win — `C13-11`.

The blocker was never technical. It was provenance. The obvious source,
NVIDIA's STBN SDK, ships both a generator and pre-baked masks under a
"Non-Commercial Use License" that restricts use to research or evaluation and
forces same-licence redistribution — incompatible with this Apache-2.0 fork.
Research lane R-STBN (2026-07-06) ruled the textures, the generator, and every
blog or Shadertoy mirror of those textures out of bounds. `C13-11` sat BLOCKED
until ruling `R-2026-08-10-5` chose the remaining honest option: build it
ourselves.

**So the provenance story here is not "we found a permissive source". It is
"there is no source".** The asset is arithmetic. That is why `LICENSE.md` gains
no third-party entry for it — only a note explaining that the absence is
deliberate, so a future auditor does not read it as an oversight.

---

## 2. Provenance discipline

Everything in this directory was written from **algorithm descriptions** in the
open literature. No implementation was copied, adapted, or consulted.

| Piece                                                       | Method                       | Source                                                                                                                   |
| ----------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Per-slice spatial mask                                      | Void-and-cluster             | Ulichney, Proc. SPIE 1913 (1993), DOI [10.1117/12.152707](https://doi.org/10.1117/12.152707)                             |
| Pairwise energy minimised by swaps                          | Blue-noise dithered sampling | Georgiev & Fajardo, SIGGRAPH 2016 Talks art. 35, DOI [10.1145/2897839.2927430](https://doi.org/10.1145/2897839.2927430)  |
| Separable spatiotemporal criterion + its spectral signature | Spatiotemporal blue noise    | Wolfe, Morrical, Akenine-Möller & Ramamoorthi, EGSR 2022, DOI [10.2312/sr.20221161](https://doi.org/10.2312/sr.20221161) |

Two consequences of taking that seriously:

- **The PRNG is not a borrowed snippet.** The C16 audit flagged a verbatim
  `mulberry32` elsewhere in this repository, and swapping one borrowed snippet
  for another would have missed the point. `stbn-rng.mjs` draws from
  **AES-256-CTR over a zero plaintext, keyed by SHA-256 of the seed string**,
  through Node's built-in `crypto`. Two published NIST standards (FIPS 197 +
  SP 800-38A, FIPS 180-4), zero copied lines, and — the property that actually
  matters here — a stream that is byte-identical on every machine, OS and Node
  version, so the SHA-256 pin means something.
- **The PNG codec is ours too.** `stbn-png.mjs` is ~200 lines written from the
  PNG specification, handling exactly one shape (8-bit greyscale,
  non-interlaced). `sharp` is already a devDependency and the sibling
  `Tools/moon-albedo-bake/` uses it, but the _decoder_ is needed inside a
  `node --test` spec that should not require a native binary to be installed.

Where a paper leaves a free choice — kernel radii, the relative weight of the
two energy terms, the swap proposal distribution, the cooling schedule — we
chose, named the choice as a parameter, wrote down the default, and let the
spectrum gate decide whether the choice was good. **Correctness here is
measured, not inherited.**

---

## 3. The algorithm

### 3.1 Stage 1 — void-and-cluster, per slice

`voidAndCluster()` in `stbn-core.mjs`. Standard Ulichney: build an initial
binary pattern at 10% fill, refine it by repeatedly moving the tightest cluster
into the largest void until the move becomes a no-op, then rank every pixel —
downward through the prototype's ones, upward through the remaining zeros. The
"void filter" is a σ = 1.5 texel Gaussian on a torus, truncated at radius 6.

One implementation note worth recording, because it looks like a missing phase:
**the paper's phases II and III are one loop here.** Phase III "reverses the
roles of minority and majority pixels" and inserts at the tightest cluster of
_zeros_. On a torus with a fixed kernel every pixel is either a one or a zero,
so `E_zeros(p) = C − E_ones(p)` for the constant `C = Σ_{q≠p} K(p,q)` — which
makes "the zero with the largest zero-density" and "the zero with the smallest
one-density" **the same pixel**. Phase III's selection rule is therefore
identical to phase II's, and the two differ only in how the procedure is
described. Deriving that identity is also a fair proof that this was
implemented from the description rather than transcribed from someone's code.

The result: 64 slices, each a permutation of `0 … 16383`, each spatially blue.

At this point the volume measures **spatial low band 0.0001** (superb) and
**temporal low band 0.9999** — i.e. _exactly white along the time axis_. A
stack of independent blue-noise slices is not spatiotemporal blue noise, and
this is the number that says so.

### 3.2 Stage 2 — separable spatiotemporal descent

`anneal()` in `stbn-core.mjs`. The energy is the Georgiev-Fajardo pairwise
functional, split into two terms that are summed rather than multiplied:

```text
E = λs · Σ_slices  Σ_{p,q in slice}  Ks(|p−q|) · V(|v_p − v_q|)
  + λt · Σ_pixels  Σ_{t,t' at pixel} Kt(|t−t'|) · V(|v_t − v_t'|)

Ks(d) = exp(−d² / 2σs²)     σs = 1.9 texels, radius 4
Kt(d) = exp(−d² / 2σt²)     σt = 1.5 frames, radius 3
V(Δ)  = exp(−√(Δ/(n−1)) / σv²)   σv = 1.0   (scalar value ⇒ exponent d/2 = ½)
```

The **sum**, not a product, is the whole point. It asks for each 2D slice to be
blue and each 1D time line to be blue, _independently_, which is Wolfe et al.'s
separable criterion; a product form would instead pull toward isotropic 3D blue
noise, which is blue in neither its slices nor its lines. Each term is
normalised by its own kernel mass, so `temporalWeight` means "how much does a
frame of temporal neighbourhood count against a ring of spatial neighbourhood"
rather than "how many taps did each kernel happen to have" — changing a radius
does not silently re-weight the objective.

Moves are **swaps of two ranks inside one slice**. That keeps every slice an
exact permutation — a uniform histogram is an invariant of the data structure,
not something the energy has to defend — while still reaching both terms,
because a pixel's time line is edited by moving values around inside the slices
it passes through. The delta is exact; the one subtlety is that when the two
swapped pixels fall inside each other's spatial neighbourhood their mutual term
must be excluded from all four partial sums (it is unchanged by the swap, and
scoring it against the pre-swap array would read it as `V(0)` — the largest
entry in the table — biasing the optimiser against every nearby swap).

Descent is greedy by default (`startTemperature = endTemperature = 0`).
Void-and-cluster already hands over a good spatial configuration; this stage's
job is to trade a little of it for temporal structure, not to melt it. A
Metropolis schedule is available and unused.

### 3.3 A cheaper construction that was rejected

Take one blue mask `M` and set slice `t` to `(M + c_t) mod n` for a
temporally-blue offset sequence `c_t`. It costs one void-and-cluster instead of
64, needs no annealing, and scores beautifully on both spectra: every slice is
a value-rotation of a blue mask, and every pixel's time line is the same blue
sequence.

**Rejected.** Every pixel then shares one time line up to an offset, so the
whole screen's dither pattern marches coherently frame to frame — exactly the
correlated structure a temporal filter cannot break up. Both published spectra
are blind to it, which is why the certification carries a third measurement:
`crossPixelTemporalCorrelation()` samples the correlation between randomly
chosen pixels' time lines and reports it as a multiple of the chance level
`1/√(frames−1)`. The shipped bake scores **1.166×** chance; the rejected
construction would score roughly `√63 ≈ 7.9×`. The bar is 2×.

---

## 4. Parameters and the evidence behind them

Defaults live in `DEFAULT_PARAMS` (`stbn-core.mjs`) and every one of them is
copied into the manifest with each bake. The two that were actually tuned:

**`temporalWeight`** — measured at 64×64×32, 40 sweeps:

| `temporalWeight` | spatial low | temporal low | temporal high |
| ---------------- | ----------- | ------------ | ------------- |
| 0.25             | 0.031       | 0.150        | 1.426         |
| **0.5**          | **0.050**   | **0.115**    | **1.459**     |
| 0.75             | 0.068       | 0.101        | 1.475         |

Half weight buys most of the temporal gain for about a third of the spatial
cost, so 0.5 is the default.

**`temporalRadius` / `temporalSigma`** — measured at 64×64×64, 20 sweeps. The
intuition (a wider temporal kernel suppresses more of the low band) runs the
wrong way:

| radius / σ  | spatial low | temporal low | temporal high |
| ----------- | ----------- | ------------ | ------------- |
| **3 / 1.5** | 0.057       | 0.127        | **1.486**     |
| 5 / 2.5     | 0.048       | 0.113        | 1.270         |
| 8 / 4.0     | 0.040       | 0.155        | 1.148         |

Wider kernels spread the suppression across the band instead of pushing energy
to the top of it. Radius 3 wins the high band decisively and is within noise on
the low band.

**`sweeps = 64`** — returns flatten after ~20 (at full size: spatial low
0.098 → 0.074 → 0.058 → 0.051 → 0.048 at sweeps 5/10/20/30/40). 64 sits
comfortably past the knee and still finishes in about three minutes.

---

## 5. Output

|             |                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| Volume      | 128 × 128 × 64, single channel, 8-bit unorm                                                                             |
| Raw         | `out/stbn_scalar_128x128x64.bin`, 1,048,576 bytes, slice-major                                                          |
| Shipped     | `packages/engine/Source/Assets/Textures/Noise/stbn_scalar_128x128x64.png`                                               |
| Atlas       | 1024 × 1024, 8×8 tiles of 128×128, one tile per slice, origin top-left                                                  |
| Encode      | PNG, 8-bit greyscale (colour type 0), non-interlaced, filter None, deflate level 9                                      |
| Bytes       | 1,049,988 (blue noise is incompressible; the PNG is ~0.13% larger than the raw volume, which is the container overhead) |
| Raw SHA-256 | `130ef37280c7b503e60ab63e558d5a6331df256506e2e68ae2a6a6d36c52ce43`                                                      |
| PNG SHA-256 | `8dd44e0b07bc69dea20955f67d9b9f78c0cf51a4f59b771b9eb3e7936cb2d579`                                                      |

All three axes are **toroidal**: the mask tiles across the screen with no seam
and loops in time with no discontinuity, so a frame counter can be reduced
modulo 64 freely.

Quantisation is `byte = floor(rank · 256 / 16384)`, which is exact and
histogram-preserving — every byte value occurs exactly 64 times per slice. The
spectra are measured on **these bytes**, not on the ranks, because these are
what the shader samples.

**Why 128×128×64.** 64 temporal slices match the existing 64-phase golden-ratio
frame rotation in the cloud ray phase, so the consuming change keeps its frame
bookkeeping and swaps only the sampling. 128×128 tiles 16× across a 2048-wide
canvas, which is the tiling density R-STBN recommended. Nothing hard-codes
either number: `--width/--height/--frames` take any powers of two whose slice
size is a multiple of 256, and cost is roughly linear in the voxel count.

---

## 6. Certification

Ulichney characterises blue noise by its **radially-averaged power spectrum**:
energy suppressed below a principal frequency, rising above it, radially
isotropic. Wolfe et al. add the property that makes a mask _spatiotemporal_ —
the same suppression must hold along each pixel's time line, independently.

Those are qualitative. `stbn-spectrum.mjs` turns them into numbers against two
anchors:

1. **The white-noise null.** Every band figure is normalised by the spectrum's
   own mean, so white noise scores **exactly 1.000** on all of them. "Suppressed
   at low frequency" therefore means "materially below 1", and the null is not
   a fitted constant — it is what the metric returns for the thing blue noise
   is defined against.
2. **Measured margin.** Each bar sits strictly between the null and what a
   healthy bake achieves, so white fails wide and a good bake passes wide.

Bands are fractions of the Nyquist range (LOW = bottom eighth, HIGH = top
half), so the same bars apply at any volume size.

### Shipped result

| Metric                           | Measured          | Bar        | White noise |
| -------------------------------- | ----------------- | ---------- | ----------- |
| Spatial low band                 | **0.0432**        | ≤ 0.30     | 1.000       |
| Spatial mid band                 | 0.4245            | (rising)   | 1.000       |
| Spatial high band                | **1.1936**        | ≥ 1.10     | 1.000       |
| Spatial anisotropy               | 0.02 dB           | diagnostic | 0 dB        |
| Temporal low band                | **0.1047**        | ≤ 0.60     | 1.000       |
| Temporal high band               | **1.5008**        | ≥ 1.05     | 1.000       |
| Cross-pixel temporal correlation | **1.166×** chance | ≤ 2×       | 1×          |

Plus a shape check the two band bars do not imply on their own: the radial
spectrum must actually _rise_, `low < mid < high`.

Anisotropy is **reported, not gated**. On a mask — as opposed to a thresholded
binary pattern — the statistic is dominated by the exponential sampling noise
of individual frequency bins, which makes it a good diagnostic and a bad gate.

### The mutants

A gate that never fails is not a gate. `stbn-asset.spec.mjs` derives three
mutants by **exact transformations of the shipped volume**, so a failure is
unambiguous — it means the criterion stopped discriminating, not that some
second generator happened to be bad.

| Mutant                 | Construction                                                                                                                                                                                                      | Must fail     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| **White**              | Independent uniform permutation per slice. Histogram stays exactly uniform, so the gate cannot be passing on a histogram artefact.                                                                                | both criteria |
| **Spatial-only blue**  | Every slice is a toroidal _shift_ of slice 0. The power spectrum is shift-invariant, so spatial blueness is preserved **exactly**; each pixel's time line becomes 64 readings of the mask at unrelated positions. | temporal only |
| **Temporal-only blue** | One global pixel permutation applied to _every_ slice. Each time line moves intact to a new position, so the temporal spectrum is unchanged; the spatial arrangement is scrambled.                                | spatial only  |

The spatial-only mutant is the one the row's whole temporal half exists to
reject — a stack of independent blue-noise slices is the thing that is easy to
build by accident. It is also a _stronger_ test than running a degraded
generator would be, because there is no doubt at all about its spatial quality.
A fourth test states the point sharply: the spatial-only mutant and pure white
noise must be **indistinguishable along the time axis**.

---

## 7. Cost and reproducibility

Measured on the development machine (Windows 10, Node v22.23.1), full
128×128×64 bake:

| Stage                                                                        | Wall clock  |
| ---------------------------------------------------------------------------- | ----------- |
| Void-and-cluster, 64 slices                                                  | 42.4 s      |
| Spatiotemporal descent, 64 sweeps (67.1 M proposals, 2.28 M accepted = 3.4%) | 117.0 s     |
| Certification + PNG encode + round-trip verify                               | ~1.3 s      |
| **Total**                                                                    | **160.7 s** |

The descent does what it was asked to: mean temporal energy falls
1.6202 → 1.4679 (−9.4%) while mean spatial energy rises only
0.5862 → 0.5882 (+0.3%). Both figures are in the manifest.

Well inside the row's ~10 minute budget, so the full volume ships rather than a
reduced one. Scaling up is linear in voxels: 256×256×64 would be ~11 minutes.

`--repro` regenerates the volume a second time and asserts both SHA-256s are
unchanged; the shipped asset was produced with it and passed. Determinism comes
from the AES-CTR stream plus the fact that every stage draws from its own
labelled sub-stream (`…|void-and-cluster|slice=7`, `…|anneal`), so changing
`sweeps` cannot perturb an earlier slice's draws.

One caveat, stated rather than hidden: the **raw** volume hash is pure
arithmetic and cannot drift. The **PNG** hash additionally depends on zlib's
deflate output for a given compression level, which is stable within a zlib
version but is not a specification guarantee across them. The spec therefore
checks both, and the raw hash is the one that carries the meaning: if a future
toolchain ever changes the PNG bytes without changing the volume, the raw check
passes, the PNG check fails loudly, and the fix is a re-pin rather than an
investigation.

Nothing installs unless certification passes, and **the manifest moves only
when the asset does** — it is written under `--install` and nowhere else.
Otherwise an experimental `node … --width 64 --frames 32` would leave the
checked-in evidence describing a volume nobody installed, silently, while every
console line read `PASS`.

---

## 8. Part 2 — the cloud-jitter consumption seam (NOT in this batch)

`C13-11` has two halves. This batch delivers generation, import and
certification. The consuming change — replacing the current jitter with STBN
taps — is **deliberately not wired here**: it needs a bind-group entry, a
texture upload, a quality-flag gate and a loading fallback, and landing it
inside the generation batch would have shipped shader changes that no probe had
measured. `packages/engine/Source/Scene/StbnNoiseVolume.js` is the seam, and
per CLAUDE.md principle 7 it is scaffolding for that follow-up, not dead code.

### What is already true

|                  |                                                                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Asset            | bundled, hash-pinned, certified                                                                                                                                        |
| Loader           | `StbnNoiseVolume.load()` — `Resource.fetchImage` with `preferImageBitmap`, `flipY: false`, `skipColorSpaceConversion: true`                                            |
| Slice addressing | `StbnNoiseVolume.getSliceOffset(frame)`, mirrored by the shader arithmetic below                                                                                       |
| Frame counter    | already a 6-bit 0…63 sequence (`WebGPUProceduralCloudRenderer.ts`, uniform slot 76, C13-36 widened it) — **no change needed**, `slice = u32(cloud.frameCounter) & 63u` |
| Free bind slot   | `@group(0) @binding(14)` (13 is the last used)                                                                                                                         |
| Free quality bit | bit 14 (`QF_PLANET_DENSITY` is bit 13)                                                                                                                                 |

### The three consumption sites

All in `packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl`:

1. **Half-resolution sub-pixel UV jitter** (`fragmentMain`, the `BAYER4`
   lookup). An ordered 4×4 matrix cycled on `frameCounter & 15`. Two decorrelated
   STBN taps replace `bx`/`by`. _Highest-value site_ — the Bayer lattice is the
   most visible of the three.
2. **Ray-march start phase** (`cloudRaySamplePhase` →
   `interleavedGradientNoise`). Already gated on `QF_JITTER` (bit 3) and
   animated only when `QF_TEMPORAL` is set. One scalar STBN tap replaces the
   IGN hash; the surrounding gate logic is unchanged.
3. **Cone-light jitter** (`coneJitter`, `hash33`, `frameCounter & 15`). Wants a
   **vec3** and this asset is scalar — see the open question below.

### Sketch of the tap

```wgsl
@group(0) @binding(14) var stbnTex: texture_2d<f32>;   // no sampler by design

fn stbnScalar(pixelCoord: vec2<u32>, frame: u32) -> f32 {
  let slice = frame & 63u;
  let tile  = vec2<u32>((slice & 7u) * 128u, (slice >> 3u) * 128u);
  return textureLoad(stbnTex, vec2<i32>(tile + (pixelCoord & vec2<u32>(127u))), 0).r;
}
```

`textureLoad` with **no sampler** is not a micro-optimisation: bilinear
filtering across a tile boundary would blend two unrelated temporal slices, and
an sRGB view or premultiplied upload would remap the mask's values. Upload as
`r8unorm`.

### Design decisions the follow-up owes

- **Default state.** Follow the house convention: gate on a new `qualityFlags`
  bit, default **off**, keep the Bayer and IGN branches verbatim as the `else`
  path so `defines = 0` stays byte-identical and the loading window has a
  self-healing fallback (same shape as the temporal-history fallback).
- **Site 3 needs a vector mask.** Two independent scalar taps are _not_ the
  same object as a jointly-optimised vec2/vec3 STBN, which Wolfe et al. treat
  separately. Options: (a) leave `coneJitter` on `hash33` — it is the least
  visible of the three; (b) bake a second scalar volume with a different seed
  and accept the approximation; (c) extend the generator's energy to a vector
  value term. The generator already takes `--seed`, so (b) is nearly free and
  (c) is a contained change to `buildValueTable` plus the delta evaluation.
  **Recommendation: ship sites 1 and 2 first, measure, and decide site 3 on
  evidence.**
- **RGBA packing.** R-STBN proposed one `rgba8unorm` array texture (R = scalar,
  GB = vec2, A = second scalar). Deferred with site 3: a 1.0 MiB scalar atlas
  today beats a 4 MiB RGBA one whose G/B/A channels nothing reads yet.
- **Acceptance.** Off-path byte-identity, then an on-path probe at a
  cloud-filling saved view comparing half-res temporal residual against the
  Bayer baseline. Per CLAUDE.md principle 8 this is a Playwright probe, not a
  request that the user reload and look.

---

## 9. Files

| File                                       | Role                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------ |
| `bake-stbn.mjs`                            | CLI: generate → quantise → certify → encode → manifest → install               |
| `stbn-core.mjs`                            | Void-and-cluster, spatiotemporal descent, quantisation, atlas pack/unpack      |
| `stbn-spectrum.mjs`                        | FFT, radial + temporal spectra, cross-pixel correlation, the bars, the mutants |
| `stbn-rng.mjs`                             | Deterministic AES-CTR stream                                                   |
| `stbn-png.mjs`                             | 8-bit greyscale PNG encoder + decoder                                          |
| `stbn-manifest.json`                       | Checked in: provenance, parameters, hashes, measured spectra, timings          |
| `out/`                                     | Git-ignored bake artifacts                                                     |
| `../visual-regression/stbn-asset.spec.mjs` | The gate (`node --test`)                                                       |
