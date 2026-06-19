# WebGPU Parity Backlog — 14-Batch Parallel Run (2026-06)

Synthesis of a 14-batch parallel implementation run addressing the
`WEBGPU_PARITY_AUDIT_2026-06` §5 post-upstream-merge (v1.141–1.143) parity
backlog. Each batch was implemented in an **isolated git worktree on its own
branch**, **without** `tsc`/`gulp build` verification (no `node_modules` in the
worktrees). Every batch is a standalone branch named by its id; **landing =
review the diff + verify (tsc/build/probe) + cherry-pick/merge onto `main` +
delete the branch.**

> All 14 batches committed successfully. **0 blocked, 0 partial.** None ran
> tsc/build/probe in-worktree, so every committed batch carries a mandatory
> human verification step before it can land. Many committed with `--no-verify`
> purely because the husky/lint-staged binary is physically absent in the
> isolated worktrees — re-run lint on land.

---

## 1. Summary

### By status

| Status | Count | Batch ids |
| --- | --- | --- |
| committed | 14 | all |
| blocked (scope wrong) | 0 | — |
| partial | 0 | — |

### By confidence

| Confidence | Count | Batch ids |
| --- | --- | --- |
| high | 8 | batch-geojson-primitive-probe, batch-clustered-lighting-leak-fix, batch-enum-renumber-guard, batch-edge-data-paths-slice, batch-bufferpolygon-2dcv-probe, batch-bufferpoint-positionnormalized-probe, batch-inventory-reconcile, batch-debugging-guide-buffer-edge |
| medium | 6 | batch-bufferprimitive-parity, batch-edge-display-mode-tri, batch-panorama-cull-override, batch-changelog-merge-sync, batch-bufferprimitive-pack-stride-test, *(see note)* |
| low | 0 | — |

> Note: there are 6 medium-confidence batches —
> `batch-bufferprimitive-parity`, `batch-edge-display-mode-tri`,
> `batch-panorama-cull-override`, `batch-changelog-merge-sync`,
> `batch-bufferprimitive-pack-stride-test`, plus `batch-clustered-lighting-leak-fix`
> is high. The medium set clusters around the WGSL-lockstep buffer work and the
> two engine-renderer behavior changes (edge tri-mode, panorama cull) — those
> carry the runtime risk a type-check cannot catch and need probe verification.

### By priority (audit §5 P-tier)

| Priority | Count | Batch ids |
| --- | --- | --- |
| P1 — core parity | 3 | batch-bufferprimitive-parity, batch-geojson-primitive-probe, *(probe+demo for P1)* |
| P2 — behavior parity | 4 | batch-edge-display-mode-tri, batch-edge-data-paths-slice, batch-bufferpolygon-2dcv-probe, batch-bufferpoint-positionnormalized-probe |
| P3 / untracked | 1 | batch-panorama-cull-override |
| infra / correctness | 2 | batch-clustered-lighting-leak-fix, batch-enum-renumber-guard |
| test-only sentinel | 1 | batch-bufferprimitive-pack-stride-test |
| doc reconciliation | 3 | batch-inventory-reconcile, batch-debugging-guide-buffer-edge, batch-changelog-merge-sync |

---

## 2. Status Table

| batch id | priority | status | confidence | branch | files | one-line summary |
| --- | --- | --- | --- | --- | --- | --- |
| batch-clustered-lighting-leak-fix | infra/correctness | committed | high | batch-clustered-lighting-leak-fix | 1 | Resume the default canvas render pass on the missing-frame-state early-return so empty/pick passes don't leak an ended pass ("no active render pass" error). |
| batch-enum-renumber-guard | infra/correctness | committed | high | batch-enum-renumber-guard | 3 (specs) | Test-only enum-pin specs (Pass 0–14, TerrainQuantization, ShaderDefine/ShaderSourceId) that fail if an enum is renumbered/extended without a deliberate update. |
| batch-inventory-reconcile | doc | committed | high | batch-inventory-reconcile | 2 (docs) | Reconcile FEATURE_INVENTORY + DEFERRED_WORK: mark WebGPU edge as partial, add 4 untracked-gap WIP entries, add GeoJsonPrimitive. |
| batch-debugging-guide-buffer-edge | doc | committed | high | batch-debugging-guide-buffer-edge | 1 (doc) | Add 4 new probe rows + 2 decision-tree branches/playbooks (buffer translucency/2D-CV, glTF edge tri-mode) to DEBUGGING_GUIDE. |
| batch-changelog-merge-sync | doc | committed | medium | batch-changelog-merge-sync | 1 (doc) | Append a "post-merge WebGPU parity work" table to the v1.141–1.143 upstream-merge changelog. |
| batch-geojson-primitive-probe | P1 | committed | high | batch-geojson-primitive-probe | 3 | New probe + Sandcastle demo for GeoJsonPrimitive.fromGeoJson (count-parity + ERR_CAPACITY guard + WebGL/WebGPU diff); 1 gallery-index row edited. |
| batch-bufferpoint-positionnormalized-probe | P2 | committed | high | batch-bufferpoint-positionnormalized-probe | 2 | Uncalled static guard `detectUnsupportedPositionEncoding` + probe surfacing the non-DOUBLE/positionNormalized mis-encode gap (no encoding change). |
| batch-bufferpolygon-2dcv-probe | P2 | committed | high | batch-bufferpolygon-2dcv-probe | 2 | Producer-half CPU reprojected SCENE2D/CV scaffold `computeReprojected2DPositions` (uncalled) + probe; renderer-bind is a named follow-up. |
| batch-edge-data-paths-slice | P2 | committed | high | batch-edge-data-paths-slice | 2 | WebGPU edge emitter now handles lineStrings-only assets (was zero edges); + degenerate-tri (PR#13421) numeric probe. WebGPU-only file. |
| batch-edge-display-mode-tri | P2 | committed | medium | batch-edge-display-mode-tri | 4 | EdgeDisplayMode tri-mode on WebGPU: SURFACES_ONLY suppression, EDGES_ONLY direct pass (slot 12), frustum-loop dispatch. Deliberate deviation from literal instruction (see notes). |
| batch-panorama-cull-override | P3/untracked | committed | medium | batch-panorama-cull-override | 2 | Force cullMode 'none' when `renderState.cull.enabled===false` (panorama interior). Fixed BOTH cull-derivation sites (material path, not the cited line 1358). |
| batch-bufferprimitive-parity | P1 | committed | medium | batch-bufferprimitive-parity | 7 | **WGSL-lockstep XL.** color.alpha translucency + blendOption OPAQUE pass + world-space boundingVolume/debugShowBoundingVolume across 3 renderers + 3 WGSL. |
| batch-bufferprimitive-pack-stride-test | test sentinel | committed | medium | batch-bufferprimitive-pack-stride-test | 1 (spec) | Self-calibrating Jasmine spec asserting CPU-pack-width === GPU-arrayStride for the 3 buffer renderers; guards the parity batch's lockstep. |

> File counts are the per-batch assigned-file sets from the run report.
> `batch-bufferprimitive-pack-stride-test`'s file was committed via a
> worktree-absolute path in its branch — when cherry-picking, the file lands at
> `packages/engine/Specs/Renderer/WebGPU/WebGPUBufferPrimitivePackStrideSpec.js`.

---

## 3. Verify-and-Land Plan

General rule for **every** committed batch:

```bash
git diff main..<branch>                                   # review the diff first
npx tsc --project packages/engine/tsconfig.json --noEmit   # type-check (none ran in-worktree)
# if the batch touches WGSL or rendering:
npx gulp build                                             # regenerate WGSL .js + index.js
node Tools/visual-regression/<probe>.mjs                   # with scene.requestRenderMode=false
# READ the output PNGs (CLAUDE.md Principle 8 — don't trust the diff number alone)
```

> **`--no-verify` caveat (applies to nearly all batches):** most batches
> committed with `--no-verify` because `node_modules/.bin/lint-staged` does not
> exist in the isolated worktrees (exit 127) — the hook was structurally
> unrunnable, not bypassing a real lint failure. Re-run lint/prettier on each
> file set when landing on a checkout that has `node_modules`. (Exception:
> `batch-inventory-reconcile` ran the real hook by junction-linking the main
> repo's `node_modules`, then removed the junction — clean.)

### File-set overlap & out-of-set audit (read before merging)

- **No two batches share a literal file path.** Safe to land independently.
- **Logical (not literal) coupling — same subsystem, different files:**
  - `batch-bufferprimitive-parity` (WGSL + `WebGPUBuffer*Renderer.ts`) and
    `batch-bufferprimitive-pack-stride-test` (a spec that *drives* those
    renderers). The spec is self-calibrating and passes against either the
    pre- or post-widening layout, so order is free — but it only meaningfully
    guards the parity batch once both are on the same tip. **Land the spec with
    or right after the parity batch.**
  - `batch-bufferpolygon-2dcv-probe` and `batch-bufferpoint-positionnormalized-probe`
    each add an **uncalled** producer-half/guard in `Scene/BufferPolygonMaterial.js`
    / `Scene/BufferPointMaterial.js`. Their named renderer-side follow-up is
    `batch-bufferprimitive-parity` — but that follow-up is **not** in the parity
    batch's actual 7-file diff (parity did alpha/blend/BV, **not** 2D-CV
    reprojection or positionDatatype branching). **These two are scaffolding
    only; the renderer-bind work they reference is still unimplemented** — track
    as next work, don't expect them to "light up" after parity lands.
  - `batch-edge-display-mode-tri` (`WebGPUModelRenderer.js` + frustum-loop +
    3DTilePasses) and `batch-edge-data-paths-slice`
    (`WebGPUEdgeVisibilityEmitter.ts`). Different files; the data-paths batch
    explicitly notes the model-renderer call site needs **no** change. Land in
    either order.
- **Out-of-assigned-set edits flagged by the batches (potential surprise, NOT a literal conflict):**
  - `batch-geojson-primitive-probe` edited `Apps/Sandcastle/gallery/gallery-index.js`
    (one row) — the one existing source file it touched; it was in-scope per its
    plan. No conflict expected, but it is a shared index file — rebase if
    another batch ever touches it.
  - `batch-enum-renumber-guard` **edited an existing spec**
    (`WebGPUShaderDefinesSpec.js`) in addition to adding two new specs; the
    brief said "new spec files only." Justified (the existing spec was stale)
    but worth a glance.
  - `batch-bufferprimitive-pack-stride-test` initially wrote its file into the
    **main repo** by absolute path, then moved it into the worktree and
    confirmed the main repo is clean. **Verify `git status` on main shows no
    stray `WebGPUBufferPrimitivePackStrideSpec.js`** before/after cherry-pick.
- **Cross-batch reference-key drift (doc batches):**
  `batch-changelog-merge-sync` and `batch-debugging-guide-buffer-edge` coined
  `NEW-*` keys and sibling batch ids (e.g. `batch-buffer-primitive-parity` with
  a hyphen vs the actual `batch-bufferprimitive-parity`) that must be reconciled
  against the keys `batch-inventory-reconcile` actually registered. **Land the
  three doc batches together and grep-reconcile the keys** so cross-links
  resolve.

---

### LAND FIRST — high-confidence, low-risk, isolated

These touch one WebGPU-only file, or are test/doc-only, with no WGSL lockstep
and minimal runtime risk.

1. **batch-clustered-lighting-leak-fix** (high, 1 file, WebGPU-only control flow)
   ```bash
   git diff main..batch-clustered-lighting-leak-fix
   npx tsc --project packages/engine/tsconfig.json --noEmit
   npx gulp build
   ```
   Probe: load a clustered-lighting Sandcastle (`scene.clusteredLightingEnabled = true`)
   with a pick/empty-pass frame; confirm no "no active render pass" validation
   error and a normal frame renders identically. One-line, byte-identical happy
   path. **Lowest risk in the run.**

2. **batch-enum-renumber-guard** (high, 3 spec files, test-only)
   ```bash
   git diff main..batch-enum-renumber-guard
   npm test     # Jasmine — confirm Pass / TerrainQuantization / ShaderDefines specs pass
   ```
   No tsc/build/probe needed for behavior (plain `.js` specs), but `npm test`
   requires `npx gulp build` first to regenerate `index.js` + `SpecList.js`.
   Pure safety net — landing it early protects every later enum touch.

3. **batch-edge-data-paths-slice** (high, 1 engine `.ts` + 1 probe, WebGPU-only)
   ```bash
   git diff main..batch-edge-data-paths-slice
   npx tsc --project packages/engine/tsconfig.json --noEmit   # casts guarded by hasVisibilityData
   npx gulp build
   node Tools/visual-regression/probe-edge-degenerate.mjs     # exits 0 pass / 2 if .js missing
   node Tools/visual-regression/probe-edge-emitter.mjs        # must stay green (dev server :8080)
   ```
   Vertex layout byte-identical (15 floats/60 bytes); lineStrings edges flow
   through the existing `emitEdgeQuad`. Ideally also confirm a real
   lineStrings-authored glTF (BENTLEY_materials_line_style) now shows non-zero
   WebGPU edges.

Then continue with the remaining high-confidence batches (any order):

4. **batch-geojson-primitive-probe** (high, probe + demo + 1 gallery-index row)
   ```bash
   git diff main..batch-geojson-primitive-probe
   npx gulp build && # serve :8080
   node Tools/visual-regression/probe-geojson-primitive.mjs   # expect PASS, 6 features, 0 ERR_CAPACITY
   ```
   READ `output/_geojson-{webgl,webgpu}.png` — confirm the polygon hole shows
   the globe through it and both MultiPolygon parts render. **Run AFTER
   `batch-bufferprimitive-parity`** so the diff exercises the alpha/blend/BV
   fixes end-to-end (still under the 15% ceiling before parity, but cleaner
   after). No tsc needed (no `.ts`).

5. **batch-bufferpoint-positionnormalized-probe** (high, uncalled guard + probe)
   ```bash
   git diff main..batch-bufferpoint-positionnormalized-probe
   npx tsc --project packages/engine/tsconfig.json --noEmit
   npx gulp build
   node Tools/visual-regression/probe-bufferpoint-positiondatatype.mjs   # PROBE_BASE may be :8134
   node Tools/visual-regression/probe-collections-regression.mjs         # must stay green
   ```
   Additive uncalled static method — DOUBLE collections render byte-identically.

6. **batch-bufferpolygon-2dcv-probe** (high, uncalled producer-half + probe)
   ```bash
   git diff main..batch-bufferpolygon-2dcv-probe
   npx tsc --project packages/engine/tsconfig.json --noEmit
   npx gulp build
   node Tools/visual-regression/probe-bufferpolygon-2dcv.mjs             # reads output/_bp2dcv-*.png
   node Tools/visual-regression/probe-bufferpolygon-vector-tile.mjs      # must stay green
   ```
   Purely additive uncalled helper. The probe documents the expected *large*
   SCENE2D/CV diff (the unfixed "wandering points" artifact) as a baseline —
   that's intended, not a regression.

7–9. **Doc batches — land together** (high/medium, Markdown-only, no tsc/build):
   - **batch-inventory-reconcile** (high) — `FEATURE_INVENTORY.md`, `DEFERRED_WORK.md`
   - **batch-debugging-guide-buffer-edge** (high) — `DEBUGGING_GUIDE.md`
   - **batch-changelog-merge-sync** (medium) — `UPSTREAM_MERGE_2026-06_CHANGELOG.md`
   ```bash
   git diff main..batch-inventory-reconcile
   git diff main..batch-debugging-guide-buffer-edge
   git diff main..batch-changelog-merge-sync
   # let the real lint-staged (markdownlint + prettier) run on land
   ```
   **Grep-reconcile the `NEW-*` keys and sibling batch ids across all three**
   (and against what `batch-inventory-reconcile` actually registered) before
   landing — e.g. `batch-buffer-primitive-parity` vs `batch-bufferprimitive-parity`.

---

### REVIEW CAREFULLY — medium confidence, runtime/WGSL risk, deliberate deviations

10. **batch-bufferprimitive-parity** (medium, **7 files incl. 3 WGSL — the WGSL-lockstep XL**)
    ```bash
    git diff main..batch-bufferprimitive-parity
    npx tsc --project packages/engine/tsconfig.json --noEmit   # BlendOption import + new cache fields
    npx gulp build                                             # MUST rebuild — WGSL .js modules are gitignored
    node Tools/visual-regression/probe-bufferpolygon-vector-tile.mjs   # must stay green
    node Tools/visual-regression/probe-collections-regression.mjs      # must stay green
    # + probe a translucent (alpha<1) point/polyline/polygon WebGL-vs-WebGPU
    # + probe a collection with debugShowBoundingVolume=true (overlay sphere)
    ```
    **Highest-risk batch.** Three lockstep triples widened (CPU Float32Array
    width ↔ GPU arrayStride/format ↔ WGSL struct field) — Polygon vec2→vec3
    (loc3, stride 8→12), Point vec3→vec4 + vec2→vec3 (loc3/loc4), Polyline new
    f32 alpha lane (loc8). `tsc` **cannot** catch a lockstep desync — that's
    exactly what `batch-bufferprimitive-pack-stride-test` guards, so land them
    together. Verify the debug-overlay sphere draw path (the batch could not
    trace the generic Scene overlay draw for buffer commands — flagged risk).
    The one judgment call: it deliberately does **not** pass `modelMatrix` to the
    command because the WebGPU culler ignores it and `collection.boundingVolume`
    is already world-space — confirm against the culler.

11. **batch-bufferprimitive-pack-stride-test** (medium, 1 spec — land with #10)
    ```bash
    git diff main..batch-bufferprimitive-pack-stride-test
    npx gulp build      # regenerates gitignored Buffer*Material.js + SpecList.js
    npm test            # 3 positive cases + 1 negative-control must pass
    ```
    Self-calibrating (anchors on the 12-byte positionHigh lane), so it passes on
    a consistent layout regardless of which alpha-lane strategy parity picked.
    **Check `git status` for a stray copy of this spec in the main repo root**
    (the batch noted it initially wrote to the wrong path then moved it).

12. **batch-edge-display-mode-tri** (medium, 4 files, engine behavior change + **deliberate deviation**)
    ```bash
    git diff main..batch-edge-display-mode-tri
    npx tsc --project packages/engine/tsconfig.json --noEmit
    npx gulp build
    PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-edge-display-mode-tri.mjs
    node Tools/visual-regression/probe-edge-emitter.mjs       # SURFACES_AND_EDGES must not regress
    node Tools/visual-regression/probe-b3dm-render-edge.mjs   # ditto
    ```
    READ the 6 output PNGs (`edge-mode-{webgl,webgpu}-{surfaces-only,surfaces-and-edges,edges-only}.png`)
    and confirm the three modes are visually distinct and WebGPU matches WebGL.
    **DELIBERATE DEVIATION from the literal instruction:** the batch did *not*
    add an executing `runPass(slot 12)` inside `WebGPUSceneRenderer3DTilePasses.ts`
    (that module runs before OPAQUE; executing there would mis-order vs WebGL and
    double-render). Authoritative slot-12 dispatch is in
    `WebGPUSceneRendererFrustumLoop.ts` after OPAQUE; the 3DTilePasses edit is a
    comment-only guard. If a reviewer insists on the literal placement it would
    break WebGL ordering parity — confirm the deviation is acceptable.
    Doc nit: `EdgeDisplayMode` is at `Scene/EdgeDisplayMode.js`, not `Scene/Model/`
    as CLAUDE.md implies (import path used is correct).

13. **batch-panorama-cull-override** (medium, 2 files, engine behavior change + **scope correction**)
    ```bash
    git diff main..batch-panorama-cull-override
    npx tsc --project packages/engine/tsconfig.json --noEmit
    npx gulp build
    node Tools/visual-regression/probe-panorama-cull-override.mjs   # interior coverage ≈ WebGL, not ~0
    node Tools/visual-regression/probe-all-materials.mjs            # closed-sphere/ellipsoid still back-face cull
    ```
    READ the two output PNGs — WebGPU panorama-interior coverage should match
    WebGL (interior visible). **SCOPE CORRECTION:** the cited line 1358 is NOT
    the panorama's path (it uses an Image Material → the *material* cull
    derivation at ~2277). The batch fixed **both** cull-derivation sites; both
    are inside the single in-scope file. Confirm Box/Sphere/Ellipsoid/Cylinder
    defaults still back-face cull (no see-through gridlines). **Known
    non-target edge left as-is:** a closed+TRANSLUCENT appearance with
    `cull.enabled:false` still hits the DP-H17 twoPasses culling — the panorama
    is opaque so unaffected, and DP-H17 is preserved per instruction.

---

## 4. Landing Mechanics

Each batch is a **standalone local branch named by its id** (e.g.
`batch-clustered-lighting-leak-fix`). They are **local only** — no pushes were
performed. To land a batch:

1. `git diff main..<branch>` — review the full diff against the batch's
   reported scope and self-review.
2. Run the verification steps for that batch above (tsc, and build + probe if it
   touches WGSL/rendering, with `scene.requestRenderMode = false` so the probe
   captures stable frames).
3. Re-run lint/prettier on the touched files (the worktree `--no-verify` commits
   skipped the hook only because the binary was absent).
4. Cherry-pick or merge the branch onto `main`.
5. **Delete the branch** once landed and verified green.

After all parity batches land, move the resolved rows in
`FEATURE_INVENTORY.md` from §C (WIP) to §B (SHIPPED) and confirm the
`batch-inventory-reconcile` / `batch-changelog-merge-sync` /
`batch-debugging-guide-buffer-edge` cross-reference keys all resolve.

**Branch transparency:** besides the 13 `batch-*` branches and `main`, the repo
also has 12 `worktree-wf_383c19e3-4bc-*` branches from the orchestration
worktrees and `pre-upstream-merge`-style refs may exist — these are the parallel
agents' / orchestrator's worktree branches. Audit and clean them
(`git worktree prune` + branch delete) once all 14 batches are landed or
discarded.
