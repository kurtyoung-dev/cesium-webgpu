# Gaussian-Splat Reference Vetting — `C18-S0` (2026-08-09)

**What this is.** The dedicated licence-verification pass over the Gaussian-splat
implementation ecosystem that
[`REFERENCE_VISUALS_CATALOG_2026-08-09.md`](REFERENCE_VISUALS_CATALOG_2026-08-09.md)
§3 recorded as its own honest gap — *"Gaussian splats (C15-G1..G8): zero
candidates in this sweep… needs its own dedicated license-verification pass"*.
It closes the gap the catalog named and it is the input to the reference
pre-registration tables in
[`QUEUE_2026-08-09_CAMPAIGN18.md`](QUEUE_2026-08-09_CAMPAIGN18.md) §6 and
[`QUEUE_2026-08-02_CAMPAIGN15.md`](QUEUE_2026-08-02_CAMPAIGN15.md) §2b.

**What this is NOT.** This document files **pre-registrations, not
determinations.** A determination is a numbered `L-xx` entry in
[`LICENSE_DETERMINATIONS_2026-08-10.md`](LICENSE_DETERMINATIONS_2026-08-10.md)
that records an obligation the fork has actually incurred, together with the
`LICENSE.md` entries that discharge it. Nothing here incurs an obligation,
because **no code has been taken from any project below.** A row becomes an
`L-25`-or-later determination on the day a Wave-S batch derives from it, and the
batch that files it claims its own number — this pass does not reserve one.

**Scope note, in the shape §1 of the determinations file uses.** This records
what was read, from where, and on what date. It is not legal advice and not a
clearance. Where the licence text itself could not be retrieved, the row says so
and the row is not usable for file-level reuse, full stop.

## 1. Method and verification markers

Every row below was reached by fetching a licence artifact over the network —
evidence class 1 in `LICENSE_DETERMINATIONS_2026-08-10.md` §1 — and never by
recollection of what a project's licence "usually is". That is the **L-24
lesson** applied prospectively: the Takram entry only became correct once
`LICENSE` was read at the source rather than paraphrased.

The pass hardened that lesson once more. Six of the first fetches came back as a
*summary* of the licence rather than its text; each was re-fetched with an
explicit literal-transcription instruction before anything was recorded. **A
summary of a licence is not a reading of a licence** — and two of the most
important findings in this document (Mip-Splatting and StopThePop both carrying
Inria's licence verbatim) were invisible in the summary form.

| Marker | Meaning |
| --- | --- |
| **✔ VERBATIM-READ** | The licence text was retrieved and transcribed literally this pass. Named copyright line confirmed character-for-character. |
| **◐ VERBATIM-PARTIAL** | The licence *body* was transcribed literally, but the copyright line was not confirmed verbatim (absent from the file, or outside the transcribed span). The same shape as the standing `PARTIAL` rows in `LICENSE_DETERMINATIONS_2026-08-10.md` §3. |
| **△ DECLARED-ONLY** | The hosting platform's reported licence and filename were obtained, but the file text was not retrieved. **Blocks file-level reuse** — this is the catalog's own △ convention. |
| **✗ UNVERIFIABLE** | Neither text nor declaration could be obtained. No row in this pass ended here. |

**Class values** follow the catalog: **USABLE** (permissive), **FILE-COPYLEFT**
(MPL/LGPL — file-level obligations), **STUDY-ONLY** (research-only, AGPL/GPL or
CC-NC — techniques only, never copy code), **UNKNOWN** (no reuse until cleared).

## 2. Pre-registration table

| Name | URL | Licence as declared (verbatim where marked ✔) | Class | Principal author(s) | What it offers which fork row | Marker |
| --- | --- | --- | --- | --- | --- | --- |
| **antimatter15/splat** | <https://github.com/antimatter15/splat> | `MIT License` / `Copyright (c) 2023 Kevin Kwok` | **USABLE** | Kevin Kwok | Baseline browser 3DGS renderer. Its README is a *negative* reference for `C18-S3`: "splat sorting is done asynchronously on the cpu in a webworker… ~1M splats… takes about 150ms", and it names the target — "the reference implementation uses a radix sort based on onesweep, which can happen in O(n) time". | ✔ |
| **mkkellogg/GaussianSplats3D** | <https://github.com/mkkellogg/GaussianSplats3D> | `The MIT License (MIT)` / `Copyright (c) 2023 Mark Kellogg` | **USABLE** | Mark Kellogg | `C18-S3` CPU-side comparison: "WASM splat sort: Implemented in C++ using WASM SIMD instructions" plus transform-feedback distance pre-calculation. **Freshness caveat: the author states "this repo is no longer in active development"** and points at Spark. | ✔ |
| **huggingface/gsplat.js** | <https://github.com/huggingface/gsplat.js> | `MIT License` / `Copyright (c) 2023 Dylan Ebert` | **USABLE** | Dylan Ebert (Hugging Face) | Minimal TypeScript renderer. Thin value for the Wave-S rows — no spherical-harmonic evaluation and no GPU sort — recorded so the ecosystem survey is complete rather than because a row needs it. | ✔ |
| **playcanvas/engine** (gsplat) | <https://github.com/playcanvas/engine> | `Copyright (c) 2011-2026 PlayCanvas Ltd.` + MIT permission body | **USABLE** | PlayCanvas Ltd | The one *production* engine-integrated splat implementation with a permissive licence — the closest structural peer to this fork's own renderer. Relevant to `C18-S1` (SH band selection) and `C18-S3` (sorter architecture). | ✔ |
| **playcanvas/supersplat** | <https://github.com/playcanvas/supersplat> | `Copyright (c) 2011-2026 PlayCanvas Ltd.` + MIT permission body (file `LICENSE` at repo root) | **USABLE** | PlayCanvas Ltd | Editor/viewer and compression tooling. Asset-pipeline reference for the §7 watch item "SPZ-4 loader compatibility check"; no Wave-S row depends on it. | ✔ |
| **aras-p/UnityGaussianSplatting** | <https://github.com/aras-p/UnityGaussianSplatting> | `MIT License` / `Copyright (c) 2023 Aras Pranckevičius` | **USABLE** (own code) | Aras Pranckevičius | **The single most useful permissive reference in this pass.** Compression/quantization ladders for positions, scales, colour and SH coefficients — directly informative for `C18-S1`'s bit-budget question — and it is where the DeviceRadixSort integration for `C18-S3` is demonstrated end-to-end. Its README states the boundary the fork must respect: the MIT grant covers *his* code, while "the license of the original paper implementation says that the official training software for the Gaussian Splats is for educational / academic / non-commercial purpose". | ✔ |
| **b0nes164/GPUSorting** | <https://github.com/b0nes164/GPUSorting> | `GPUSorting's source code is released under the MIT license:` / `Copyright (c) 2024 Thomas Smith` — **but the same file additionally carries FidelityFX (MIT, `Copyright © 2024 Advanced Micro Devices, Inc.`), CUB (BSD-3, `Copyright (c) 2010-2011, Duane Merrill` / `2011-2024, NVIDIA CORPORATION`), DirectStorage (MIT, `Copyright (c) Microsoft Corporation.`) and bb_segsort under `GNU LESSER GENERAL PUBLIC LICENSE Version 2.1`** | **USABLE (MIT core) / FILE-COPYLEFT (one bundled component)** | Thomas Smith | The `C18-S3` algorithm reference: OneSweep, DeviceRadixSort and reduce-then-scan, citing "Andy Adinets and Duane Merrill. Onesweep: A Faster Least Significant Digit Radix Sort for GPUs. 2022." **Two hard caveats: (a) the repo's LICENSE is multi-part and the bb_segsort component is LGPL-2.1 — never copy from that path; (b) it contains NO WebGPU/WGSL implementation** (HLSL/CUDA only), so it cannot be a porting source, only a structural one. | ✔ |
| **graphdeco-inria/gaussian-splatting** | <https://github.com/graphdeco-inria/gaussian-splatting> | `Gaussian-Splatting License` — "**Inria** and **the Max Planck Institut for Informatik (MPII)** hold all the ownership rights"; §3: "The *Software* may be used \"non-commercially\", i.e., for research and/or evaluation purposes only."; and "THE USER CANNOT USE, EXPLOIT OR DISTRIBUTE THE *SOFTWARE* FOR COMMERCIAL PURPOSES WITHOUT PRIOR AND EXPLICIT CONSENT OF LICENSORS." | **STUDY-ONLY** | Kerbl, Kopanas, Leimkühler, Drettakis (Inria / MPII) | The origin implementation of the SIGGRAPH 2023 paper. **Never copy, never transliterate, never port.** Present in this table so its licence text is on the record and so the lineage section below can be reasoned about. | ✔ |
| **graphdeco-inria/diff-gaussian-rasterization** | <https://github.com/graphdeco-inria/diff-gaussian-rasterization> | `Gaussian-Splatting License` — same Inria/MPII text, confirmed independently | **STUDY-ONLY** | Same | The CUDA rasterizer submodule that essentially every research fork inherits. It is the *carrier* of the research-only restriction through the ecosystem. | ✔ |
| **autonomousvision/mip-splatting** | <https://github.com/autonomousvision/mip-splatting> | `Gaussian-Splatting License` — **byte-for-byte the Inria/MPII text**, confirmed by literal transcription | **STUDY-ONLY** | Zehao Yu, Anpei Chen, Binbin Huang, Torsten Sattler, Andreas Geiger | `C18-S2`. Its README is explicit: "This project is built upon [3DGS](https://github.com/graphdeco-inria/gaussian-splatting). Please follow the license of 3DGS." **The reference implementation of the fork's own headline splat-quality row is research-only.** The technique must come from the paper. | ✔ |
| **r4dl/StopThePop** | <https://github.com/r4dl/StopThePop> | `Gaussian-Splatting License` at repo root, with named carve-outs the README states verbatim: "The majority of the projects is licensed under the [\"Gaussian-Splatting License\"](LICENSE.md), with the exception of: PoppingDetection: MIT License; StopThePop header files (submodules/diff-gaussian-rasterization/cuda_rasterizer/stopthepop): MIT License; FLIP: BSD-3 license" | **STUDY-ONLY** (repo); carve-out **UNKNOWN** | Lukas Radl, Michael Steiner, Mathias Parger, Alexander Weinrauch, Bernhard Kerbl, Markus Steinberger (TU Graz et al.) | The other end of `C18-S3`'s popping problem — hierarchical approximate per-pixel resort instead of a faster global sort. README: "Our repository is built on 3D Gaussian Splatting". The MIT carve-out is real but sits *inside* a fork of the Inria-licensed rasterizer; this pass does not clear it. | ✔ |
| **nerfstudio-project/gsplat** | <https://github.com/nerfstudio-project/gsplat> | `Apache License` / `Version 2.0, January 2004` (body transcribed literally). Copyright attributed to the Nerfstudio Team — **not confirmed verbatim**, see marker | **USABLE** | Nerfstudio Team | The one research-grade 3DGS rasterizer that is **not** under the Inria licence — the existence proof that a re-implementation from the paper is achievable and shippable under a permissive grant. Same licence family as this fork. | ◐ |
| **nianticlabs/spz** | <https://github.com/nianticlabs/spz> | `MIT License` / `Copyright (c) 2024 Niantic Labs` | **USABLE** | Niantic Labs | The SPZ container format. Already reaches the fork transitively through `@spz-loader/core`; see `L-22a`. Relevant to the §7 watch item "SPZ-4 loader compatibility check". | ✔ |
| **drumath2237/spz-loader** (`@spz-loader/core`) | <https://github.com/drumath2237/spz-loader> | Apache-2.0 as reported by the host; licence file is `LICENSE.txt` | **USABLE** | Ryosuke Nomura (@drumath2237) | **Already a shipped dependency of `packages/engine`** — determined as `L-22a` (RESOLVED via npm metadata). "a pure decoding facility using `nianticlabs/spz` converted to wasm by Emscripten". | △ |
| **CesiumGS/cesium-wasm-utils** (`@cesium/wasm-splats`) | <https://github.com/CesiumGS/cesium-wasm-utils> | Apache-2.0 as reported by the host; licence file is `LICENSE.md` | **USABLE** | Cesium GS | **Already a shipped dependency** — determined as `L-22b`, and `wasm_splats_bg.wasm` is copied into `Source/ThirdParty/` by the `prepare` task. It is the multithreaded WASM radix sort and SH texture generator that `C15-G4`/`C15-G5` consume. Directly bounds `C18-S3`: the fork's *existing* sort is already permissively licensed. | △ |
| **ubc-vision/stochasticsplats** | <https://github.com/ubc-vision/stochasticsplats> | `MIT License` / `Copyright 2024 Anthony J. Thibault` (inherited from the Splatapult viewer it extends) | **USABLE** | Ashkan Kheradmand et al. (UBC), on Splatapult by Anthony J. Thibault | The §7 watch item "StochasticSplats sort-free spike". **Notable: MIT lineage, not Inria lineage** — a research splat technique whose implementation is actually permissive. The one pleasant surprise of this pass. | ✔ |
| **cvlab-epfl/gaussian-splatting-web** | <https://github.com/cvlab-epfl/gaussian-splatting-web> | Apache-2.0 as reported by the host; licence file is `LICENSE` | **USABLE** | EPFL CVLab | The earliest WebGPU 3DGS viewer, and mkkellogg's stated starting point. README: "Interactive web viewer of NeRFs created with the code available from [INRIA]" and "Unlike the original paper, this code doesn't use computer shaders to compute each pixel value independently but instead maps the problem to a standard rasterization technique". See §3 for why that second sentence matters. | △ |
| **nvpro-samples/vk_gaussian_splatting** | <https://github.com/nvpro-samples/vk_gaussian_splatting> | `Apache License` / `Version 2.0, January 2004` — **no copyright line present in the file** | **USABLE** | NVIDIA | The most modern multi-method splat viewer with a permissive licence (Vulkan, several rasterization strategies). Same licence as this fork. Useful structural context for `C18-S3`; no Wave-S row depends on it. | ◐ |
| **sparkjsdev/spark** | <https://github.com/sparkjsdev/spark> | `The MIT License` / `Copyright © 2025 WORLD LABS TECHNOLOGIES, INC.` | **USABLE** | World Labs Technologies, Inc. | The maintained successor mkkellogg redirects to. Recorded so the "the obvious web reference is stale" trap is not walked into later; no Wave-S row depends on it. | ✔ |
| **KHR_gaussian_splatting** (glTF extension) | <https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_gaussian_splatting> | `Copyright 2026 The Khronos Group Inc. SPDX-License-Identifier: CC-BY-4.0`; status **"Release Candidate"** | **SPEC** (documentation licence, not a code licence) | Khronos, with contributors incl. Jason Sobotka, Renaud Keriven, Adam Morris, **Sean Lilley (Cesium)**, Projit Bandyopadhyay, Daniel Knoblauch (Niantic Spatial), Ronald Poirrier, Jean-Philippe Pons (Esri), Alexey Knyazev (Khronos), Marco Hutter, Arseny Kapoulkine, Nathan Morrical (Nvidia), Norbert Nopper, Zehui Lin, Chenxi Tu (Huawei), Michael Nikelsky (Autodesk) | The **format** authority behind `C15-G3`'s record layout. CC-BY-4.0 governs the *specification text*; implementing a specification from its normative prose is the ordinary and intended use and creates no code-licence question. Its SPZ compression companion split into a separately-ratifying extension (`KHR_gaussian_splatting_compression_spz`) and is likewise a release candidate. | ✔ |

## 3. Provenance chain — the Inria question

The task the row was given names this as the point of the exercise, and the
answer is sharper than expected: **the two references that map most directly
onto Wave S are both Inria-licensed, and neither can be read as an exception.**

### 3.1 What the Inria licence actually says

Transcribed from `LICENSE.md` at `graphdeco-inria/gaussian-splatting` and
confirmed identically at `graphdeco-inria/diff-gaussian-rasterization`:

- The licensors are **Inria and the Max Planck Institut für Informatik (MPII)**,
  and they "hold all the ownership rights on the *Software*".
- §3 grants rights "to use the *Software* for research purposes to research users
  (both academic and industrial), free of charge, **without right to
  sublicense**", and states that it "may be used \"non-commercially\", i.e., for
  research and/or evaluation purposes only."
- §4.2 propagates the restriction into derivative works: Your Terms may differ
  "only if (a) Your Terms provide that the use limitation … applies to your
  derivative works".
- The ALL-CAPS clause: "THE USER CANNOT USE, EXPLOIT OR DISTRIBUTE THE
  *SOFTWARE* FOR COMMERCIAL PURPOSES WITHOUT PRIOR AND EXPLICIT CONSENT OF
  LICENSORS."

This fork is Apache-2.0. A copyleft-style research restriction that forbids
sublicensing and propagates to derivatives **cannot be reconciled with shipping
inside an Apache-2.0 engine**. There is no clever framing that makes copied
Inria-lineage code safe here.

### 3.2 The distinction that governs every row: PAPER vs CODE

Copyright attaches to the expression, not to the method. The 3DGS *paper*,
the Mip-Splatting *paper* and the StopThePop *paper* are published descriptions
of techniques; re-deriving a technique from its published description is the
house norm this fork already runs on, and it is what `L-24` classified as
`DERIVED-TECHNIQUE` for every Takram site. The *repositories* are expression,
and the Inria licence governs them.

So the operative test per candidate is not "does it implement 3DGS" — everything
here does — but **"does its code descend from the Inria tree?"**

### 3.3 Verdict per candidate

| Candidate | Inria-lineage verdict | Basis |
| --- | --- | --- |
| graphdeco-inria/gaussian-splatting | **IS the Inria tree** | Licence read verbatim |
| graphdeco-inria/diff-gaussian-rasterization | **IS the Inria tree** | Licence read verbatim |
| **autonomousvision/mip-splatting** | **INRIA-DERIVED — research-only, transitively** | Carries the Inria licence byte-for-byte *and* its README says "This project is built upon 3DGS. Please follow the license of 3DGS." Both halves point the same way. |
| **r4dl/StopThePop** | **INRIA-DERIVED — research-only, transitively; the MIT carve-out does not rescue it** | Root `LICENSE.md` is the Inria text; README: "Our repository is built on 3D Gaussian Splatting". The MIT-declared StopThePop header files live at `submodules/diff-gaussian-rasterization/cuda_rasterizer/stopthepop` — i.e. *inside a fork of the Inria-licensed rasterizer*. A permissive declaration on files embedded in a research-only tree is exactly the question this pass is not competent to resolve, so it stays **UNKNOWN** and therefore unusable. |
| antimatter15/splat | **PAPER-DERIVED — clean** | Independent JS implementation: "written in javascript with webgl 1.0 with no external dependencies". Its acknowledgements credit people and discussions, not code. It describes the Inria rasterizer as "the reference implementation" — i.e. as something it read about, not something it contains. |
| mkkellogg/GaussianSplats3D | **PAPER-DERIVED — clean, with one recorded upstream** | "I used those versions as a starting point for my initial implementation, but as of now this project contains all my own code." The two named starting points were antimatter15 (MIT) and cvlab-epfl (Apache-2.0) — both permissive, neither Inria-licensed. |
| huggingface/gsplat.js | **PAPER-DERIVED — clean** | Independent MIT TypeScript implementation; no Inria submodule or vendored kernel. |
| playcanvas/engine · playcanvas/supersplat | **PAPER-DERIVED — clean** | Commercial engine shipping under MIT since 2011; an Inria-derived rasterizer could not sit under that grant, and none is declared. |
| aras-p/UnityGaussianSplatting | **PAPER-DERIVED — clean, and the author says so explicitly** | MIT on his own code, with the README separating it from the original: "even if this viewer / integration into Unity is just 'MIT license', you need to separately consider how did you get your Gaussian Splat PLY files." Third-party code is named and permissive (zanders3/json MIT; DeviceRadixSort by Thomas Smith). |
| nerfstudio-project/gsplat | **PAPER-DERIVED — asserted by its own authors** | Apache-2.0 declared over a from-scratch CUDA rasterizer. Recorded as an assertion, not as an audit: this pass read the licence, it did not diff kernels against `diff-gaussian-rasterization`. That is acceptable because the fork borrows nothing from it. |
| ubc-vision/stochasticsplats | **NOT Inria-lineage** | It extends **Splatapult** (MIT, Anthony J. Thibault), and its `LICENSE` retains that MIT notice rather than the Inria text — the visible signature of a non-Inria codebase. |
| cvlab-epfl/gaussian-splatting-web | **DECLARED CLEAN — one residual question, non-blocking** | Apache-2.0 declared, and the README distances the implementation from the paper's approach: "this code doesn't use computer shaders to compute each pixel value independently but instead maps the problem to a standard rasterization technique". Its Inria reference is to where the *trained scenes* came from. The question is residual only because **nothing in this fork borrows from it** — it appears here solely as mkkellogg's stated ancestor. |
| nvpro-samples/vk_gaussian_splatting · sparkjsdev/spark | **PAPER-DERIVED — clean** | Apache-2.0 and MIT respectively, declared over independent renderers by organisations that would not ship research-only code under those grants. |
| b0nes164/GPUSorting | **NOT APPLICABLE** | A general GPU sorting library. It predates nothing and derives from nothing in the splat ecosystem; its lineage question is CUB/Onesweep, not Inria. |
| nianticlabs/spz · spz-loader · cesium-wasm-utils | **NOT APPLICABLE** | Container format and format/sort utilities. No rasterizer lineage. |

### 3.4 The asset side is separately clean — and already answered in-tree

aras-p's warning about PLY provenance is the one part of the Inria question that
is about *data* rather than code, and it is worth recording that the fork does
not have this exposure. `QUEUE_2026-08-02_CAMPAIGN15.md` §6b established that the
gate assets are **two licence-clean CesiumGS-shipped tilesets** in
`Specs/Data/Cesium3DTiles/GaussianSplats/` (`sh_unit_cube`, 27 splats;
`tower`, 286,868 splats), inherited under the fork's own Apache-2.0 upstream
relationship and reachable with no network and no Ion token. **No externally
trained scene enters the gate.** Wave S must not change that: pulling a
demo scene from a research repository would re-open on the data side precisely
the question §3.1 closes on the code side.

## 4. Honest gaps — what this pass did not establish

1. **Three rows are △ DECLARED-ONLY and cannot be derived from at file level.**
   `drumath2237/spz-loader`, `CesiumGS/cesium-wasm-utils` and
   `cvlab-epfl/gaussian-splatting-web` returned their licence *declaration* and
   filename but not their text (the raw file paths 404'd). The first two are
   already shipped dependencies resolved as `L-22a`/`L-22b` through npm
   metadata, so the gap is a transcription gap and not a permission gap — but it
   is a gap, and the △ rule applies to them exactly as it applies to everything
   else: **read the file before copying a line from it.**
2. **Two rows are ◐ VERBATIM-PARTIAL on the copyright line.**
   `nerfstudio-project/gsplat`'s Apache body was transcribed literally but the
   copyright attribution was not confirmed in the transcribed span; the
   `nvpro-samples/vk_gaussian_splatting` licence file carries **no copyright
   line at all**. Same shape as the `L-11`/`L-12`/`L-13c` rows that stood open
   in §3 of the determinations file until the Batch-965 network pass closed
   them. Neither blocks anything today because neither is a derivation source.
3. **No WGSL/WebGPU GPU radix sort with a read licence exists.** GPUSorting is
   the algorithm authority and is HLSL/CUDA. This is the single most
   consequential gap for `C18-S3` and it is a *good* one to know before starting:
   there is no port to make, only an implementation to write.
4. **No reference implements distance-graded SH truncation.** aras-p does SH
   *bit-budget* compression and PlayCanvas does SH *band count* selection.
   Neither is `C18-S1`'s distance-banded LOD. That row is effectively
   first-of-kind, in the same sense `QUEUE_2026-08-02_CAMPAIGN15.md` §2b records
   `C15-03`/`C15-04` as first-of-kind for aurora — with the same consequence:
   the gate cannot lean on "matches the reference", because there is no
   reference.
5. **No geospatial splat renderer exists anywhere in the surveyed ecosystem.**
   Every reference above renders a splat scene in a bounded local frame. None
   handles a globe camera, RTE-encoded positions, log-depth, multi-frustum
   composition or the far-camera regime that makes `C18-S2` globe-critical in
   the first place. The fork's hardest splat problems have no external peer.
6. **Kernel-level independence was not audited for any candidate.** Where a
   project declares a permissive licence over a 3DGS implementation, this pass
   recorded the declaration and the project's own lineage statement. It did not
   diff source against `diff-gaussian-rasterization`. That is proportionate —
   an audit of that depth is only owed if the fork intends to copy, and the
   recommendations in §5 are all clean-room or in-tree.
7. **Not surveyed:** training-side tooling (COLMAP pipelines, splat optimizers),
   4DGS/animated splat repositories, and SOG loaders — all three are recorded
   non-goals in `QUEUE_2026-08-09_CAMPAIGN18.md` §7 and
   `QUEUE_2026-08-02_CAMPAIGN15.md` §6d, so surveying them would have expanded
   scope past the rows this pass exists to bound.

## 5. Recommendation per Wave-S row

### `C18-S1` — SH distance-band truncation → **NO EXTERNAL NEEDED**

The seam the row names already exists in-tree:
`applySphericalHarmonicsBudget` at `packages/engine/Source/Scene/GaussianSplatPrimitive.js:695`,
called above the backend branch and referenced from
`packages/engine/Source/Renderer/WebGPU/WebGPUGaussianSplatRenderer.ts:1842`.
The work is to make an existing backend-neutral budget distance-graded — a
change to the fork's own code, guided by the fork's own `C15-G5` option-(a)
precedent. Per §4.4 no external project does this, so there is nothing to
borrow even if borrowing were wanted.

**Pre-register anyway:** `aras-p/UnityGaussianSplatting` (MIT ✔) as the one
permissive reference for SH *quantization ladders*, should the row grow a
bit-budget dimension. It is a ✔ row, so file-level reuse would be permitted with
a `Reference:` block and an `L-xx` entry — but the recommendation is that none
is needed.

### `C18-S2` — Mip-Splatting opt-in → **CLEAN-ROOM FROM THE PAPER, MANDATORY**

This is the finding that most changes how a row gets built. **Both candidate
implementations are research-only**: `autonomousvision/mip-splatting` carries the
Inria licence byte-for-byte and instructs readers to "follow the license of
3DGS", and the 3DGS tree it builds on is the same licence. There is no permissive
implementation of Mip-Splatting.

Derive **only** from the published paper: Zehao Yu, Anpei Chen, Binbin Huang,
Torsten Sattler, Andreas Geiger, *Mip-Splatting: Alias-free 3D Gaussian
Splatting*, CVPR 2024, arXiv:2311.16493. The paper states the mechanism the row
needs in full — a 3D smoothing filter constraining primitive size by the maximal
sampling frequency of the input views, and a 2D Mip filter replacing the 2D
dilation.

The in-tree sites the row replaces are both confirmed at HEAD and both carry
vanilla dilation on both diagonals, as the row claims:

- `packages/engine/Source/Shaders/PrimitiveGaussianSplatVS.glsl:124,126` —
  `float diagonal1 = cov[0][0] + .3;` / `float diagonal2 = cov[1][1] + .3;`
- `packages/engine/Source/Renderer/WebGPU/WebGPUGaussianSplatRenderer.ts:646` —
  `let diagonal1 = J1.x*J1.x*a + 2.0*J1.x*J2.x*c + J2.x*J2.x*f + 0.3;`

**Carry the `L-03(b)` lesson forward as an acceptance condition.** That
determination convicted a shader of being copied-shape because it used the
Khronos reference's working-variable names *in order* — "two independent
implementations of Belcour & Barla 2017 do not converge on that naming." The same
test will be applied here, and it must pass: if the landed shader carries
Mip-Splatting's identifier set, that is evidence of copying from an
Inria-licensed source, and the diff does not land. Name the variables for what
they hold in this codebase.

The `Reference:` block and the eventual `L-xx` determination must name the
**paper and its authors**, not the repository — citing the repository would
imply a derivation the row is forbidden to make.

### `C18-S3` — GPU radix sort → **BUILD IN-TREE FROM THE PUBLISHED ALGORITHM; ONE ✔ CROSS-CHECK REFERENCE**

Three things bound this row, and together they say *write it here*:

1. **The algorithm is published.** Adinets & Merrill, *Onesweep: A Faster Least
   Significant Digit Radix Sort for GPUs* (2022), cited by GPUSorting itself.
2. **The decoupled-lookback primitive Onesweep depends on already exists in
   this repository**, with its licence question already resolved:
   `packages/engine/Source/Shaders/WebGPU/Compute/DecoupledLookbackScan.wgsl`
   is `L-18` (Merrill & Garland 2016 cited in-file; Vello port credited; Vello
   entry present in both `LICENSE.md` files). Alongside it sit
   `GPUSortKeys.wgsl`, `PointCloudSort.wgsl` and `BitonicSortU64.wgsl`. The
   scaffolding for a WGSL radix sort is largely in the tree already.
3. **The fork's current splat sort is already permissively licensed** —
   `@cesium/wasm-splats` (Apache-2.0, `L-22b`), whose multithreaded WASM radix
   sort `C15-G4` consumes. So this row replaces permissive code with fork code;
   no external permission is implicated at any point.

**Pre-register `b0nes164/GPUSorting` (MIT ✔, Thomas Smith)** as a structural
cross-check for digit-pass decomposition and histogram layout, with **two
binding caveats recorded at the derivation site**: (a) it contains no WGSL, so
it cannot be a porting source; (b) its `LICENSE` is multi-part and one bundled
component (**bb_segsort**) is **LGPL-2.1** — nothing from that component may be
read into fork code, and any future `LICENSE.md` entry must scope itself to the
MIT core.

**Do not pre-register StopThePop for this row.** It is the other answer to the
same popping symptom and it is research-only; if hierarchical per-pixel resort
is ever wanted, it is a clean-room from arXiv:2402.00525 / ACM TOG 43(4), 2024
(Radl, Steiner, Parger, Weinrauch, Kerbl, Steinberger), and it is a different row
from this one.

### `C18-S4` — Splat `splitDirection` → **NO EXTERNAL NEEDED, AND NONE EXISTS**

The reference is the fork's own GLSL. `packages/engine/Source/Shaders/PrimitiveGaussianSplatFS.glsl:8-9`
already carries the discard the WGSL twin lacks:

```glsl
if (v_splitDirection < 0.0 && gl_FragCoord.x > czm_splitPosition) discard;
if (v_splitDirection > 0.0 && gl_FragCoord.x < czm_splitPosition) discard;
```

with the varying set at `PrimitiveGaussianSplatVS.glsl:195` and the property
plumbed through `Scene/GaussianSplatPrimitive.js` (`_splitDirection`, and the
tileset propagation at line 1542). `splitDirection` is a CesiumJS API concept;
no external splat renderer has one. This row is a WGSL port of in-tree GLSL and
touches no external work at all.

### `C15-G` lane (`QUEUE_2026-08-02_CAMPAIGN15.md` §6) — **RETROSPECTIVELY ANSWERED**

The §2b placeholder was written against `C15-G3` (record format) and `C15-G5`
(spherical harmonics), both of which have since landed. Their external surface
turns out to be **two projects that were already licence-determined before this
pass ran**: `@cesium/wasm-splats` (Apache-2.0, `L-22b`) for the sort and SH
texture generation, and `@spz-loader/core` (Apache-2.0, `L-22a`) for SPZ
decoding. Neither row derived from an unvetted project. The format authority is
`KHR_gaussian_splatting` (CC-BY-4.0 spec text, Release Candidate) — a
specification implemented from its normative prose, which raises no code-licence
question.

`C15-G8`'s terminal gate needs no external reference: it is a cross-backend
self-comparison.

### Watch items in `QUEUE_2026-08-09_CAMPAIGN18.md` §7 — bounded early

- **StochasticSplats sort-free spike** → `ubc-vision/stochasticsplats` is **MIT
  ✔** via its Splatapult ancestry, not Inria-licensed. If that spike is ever
  approved it has a usable reference — the only research-grade splat technique in
  this survey for which that is true.
- **SPZ-4 loader compatibility check** → `nianticlabs/spz` MIT ✔, reaching the
  fork through `@spz-loader/core` (Apache-2.0, `L-22a`). The Khronos SPZ
  compression companion is a separately-ratifying release candidate; treat its
  naming as unsettled (`KHR_spz_gaussian_splats_compression` →
  `KHR_gaussian_splatting_compression_spz`) and read the extension directory
  rather than a news article before depending on a name.

### The one-line rule this pass leaves behind

**Every splat repository whose `LICENSE` opens with `Gaussian-Splatting License`
is research-only, no matter whose name is on the paper.** Two of this pass's
twenty rows matched that string, and both were candidates a Wave-S row was
expecting to lean on. Checking that first line is a five-second test that
disposes of the hardest licensing question in this ecosystem.

## 6. What this feeds

A future determinations batch — the `L-25`-and-later slots in
`LICENSE_DETERMINATIONS_2026-08-10.md` — files numbered entries **only for
projects a landed batch actually derived from.** On the recommendations above
that set is expected to be small, and possibly empty:

| Row | Expected determination at landing |
| --- | --- |
| `C18-S1` | None expected — in-tree seam. |
| `C18-S2` | A **paper** citation, not a project entry. A `Reference:` block naming Yu et al., CVPR 2024. A `LICENSE.md` entry is owed only if code or shader shape is taken, which the recommendation forbids. |
| `C18-S3` | Possibly one entry for **GPUSorting** (MIT, Thomas Smith) if structural shape is adopted, scoped explicitly to the MIT core and excluding the LGPL-2.1 bundled component. Onesweep itself is a paper citation. |
| `C18-S4` | None — in-tree port. |
| `C15-G3`/`G5` | Already covered by `L-22a`/`L-22b`. |

The numbering is claimed by the batch that files, per the §5 manifest contract:
`Tools/c16/verify-packaged-notices.mjs` reads that manifest, so an entry that
exists here but not there would be invisible to the packaging check. **This
document is not read by any tool** — that is deliberate, and it is why nothing
here is written in the manifest's shape.
