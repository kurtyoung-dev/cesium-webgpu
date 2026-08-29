# Q-94 scoping memo — "the Sandcastle gallery cannot run on WebGPU"

Read-only scoping pass at tip `da4f2e6821`. No edits, no builds, no browser.

---

## (a) The verified behaviour today, in three sentences

A synchronous `new Cesium.Viewer(container, options)` never reaches WebGPU: all three sync constructors call `getSynchronousRendererType()` (`packages/widgets/Source/Viewer/Viewer.js:615`, `packages/engine/Source/Widget/CesiumWidget.js:415`, `packages/engine/Source/Scene/Scene.js:285`), which defaults a missing `contextOptions.renderer` to `"webgl"` and **throws `DeveloperError` for every other value** — `"webgpu"`, `"webgpu-compat"` and even `"auto"` (`packages/engine/Source/Renderer/RendererType.ts:227-243`; the throw at `:238` is not pragma-wrapped, so it is live in release builds). So the outcome is binary and never silently-wrong-backend at the engine boundary: **no `contextOptions.renderer` → a real WebGL context is built with no warning and frozen all-WebGL diagnostics (`Scene.js:292-317`); any WebGPU/auto request → a hard synchronous throw** that aborts construction before the DOM is touched. There is no fallback, no deferred context, and no "becomes ready later" state.

**But the finding's conclusion does not follow, because the Sandcastle2 runner already performs the runner-transparent transform Q-94 proposes.** `transformCodeForRenderer()` rewrites `new Cesium.Viewer(` → `await Cesium.Viewer.createAsync(` whenever the active renderer is `webgpu` (`packages/sandcastle/src/Helpers.ts:92-102`), and `buildRendererPreamble()` patches the static `Viewer.createAsync` to inject `contextOptions.renderer = "webgpu"` (`Helpers.ts:30-52`); the demo body is injected as an inline `<script type="module">` (`packages/sandcastle/src/util/bucket-client.ts:45-46`), so top-level `await` is legal. I mechanically applied that exact transform to all 303 sync demos and ran `node --check` on each: **303/303 parse clean, zero SyntaxErrors.** The shipped `Apps/Sandcastle2` bundle contains the preamble (`Apps/Sandcastle2/assets/useCodeState-rVBxMvcu.js:12`), so this is deployed, not merely present in source.

**The real defect is four settings-layer gaps, not 303 broken demos.**

| # | Defect | Evidence |
|---|---|---|
| D1 | Sandcastle2's default renderer is **`"webgl"`** — the gallery's out-of-the-box experience is WebGL while `Apps/CesiumViewer` starts on WebGPU (`README.md:266-268`). | `packages/sandcastle/src/SettingsContext.ts:54` |
| D2 | There is **no `?renderer=` URL parameter** for Sandcastle2; the mode lives only in localStorage-backed settings. A headless probe cannot select WebGPU by URL. | `packages/sandcastle/src/App.tsx:303-317` reads only `id` |
| D3 | The **standalone / share page hardcodes `rendererMode="webgl"`** — WebGPU is unreachable there for every demo. | `packages/sandcastle/src/Standalone/AppStandalone.tsx:150` |
| D4 | The transform covers only `new Cesium.Viewer(` / `new Viewer(`. **`new Cesium.CesiumWidget(` is not rewritten**, so that demo silently runs WebGL while the toggle reads "WebGPU". | `Helpers.ts:92-102`; `gallery/cesium-widget/main.js` |

A fifth, lower-severity item: in **split** mode the WebGL pane emits no preamble (`Helpers.ts:30` gates on `renderer === "webgpu" || showFps`), so the 29 demos that pin `renderer: "webgpu"` in their own source render WebGPU in *both* panes — the split diff is vacuous for them.

---

## (b) Options table

| Option | Effort (files / LOC) | Risk | What breaks | Verification cost | Verdict |
|---|---|---|---|---|---|
| **A. Runner-transparent** — already built; finish it. Flip `initialSettings.rendererMode`, add a `?renderer=` URL param, unhardcode the standalone page, extend the regex to `CesiumWidget`. | 4-5 files, ~60 LOC: `SettingsContext.ts`, `App.tsx` (+`SettingsProvider.tsx`), `Standalone/AppStandalone.tsx`, `Helpers.ts` | **Low.** No engine change, no demo change, no public API change. The transform mechanism is already load-bearing and shipped. | Nothing structural. Flipping the default surfaces every unfixed WebGPU parity bug to gallery visitors at once — that is exposure, not breakage, but it is a product decision. | One headless sweep (§e). `?renderer=` is itself the enabler that makes the sweep cheap. | **RECOMMENDED** |
| **B. Per-demo transform** — edit 303 `main.js` to `const viewer = await Cesium.Viewer.createAsync(...)`. | 303 files, ~305 edited lines | **Medium-high.** 303-file diff to review; permanently diverges every demo from upstream CesiumJS, a live cost under Campaign 16's "seamless with upstream" mandate. | Demos become non-portable back to upstream Sandcastle. The 29 webgpu-pinned demos need their pins reconciled with the preamble. Does not fix D1/D2/D3 — the default would still be WebGL. | Same sweep as A, plus a 303-file review. | **Reject.** Solves nothing A does not, at ~75x the diff plus a permanent upstream-divergence tax. Reachable only if A is rejected on product grounds. |
| **C. Engine deferred-context** — make `new Cesium.Viewer` itself WebGPU-capable via a deferred context the render loop awaits. | `Scene.js`, `CesiumWidget.js`, `Viewer.js`, `ContextFactory.ts`, `RendererType.ts` + every synchronous `scene.context` reader; realistically 15-40 files, 500+ LOC | **High.** `Scene`'s constructor reads the live context immediately — `context.fragmentDepth` decides `_logDepthBuffer` (`Scene.js:413`) and `context.getFeatureRenderer(...)` runs at `:461`, both before any deferral point could resolve. Deferral means either a null-context window every reader must tolerate, or a stalling proxy. | Any app code doing `const v = new Viewer(...); v.scene.context.…` on the next line. It also reopens the transactional boundary that `_preInitializedContext` exists to provide (`Scene.createAsync`, `CesiumWidget._createAsyncContext:820`, `Viewer.createAsync:2295` each own context cleanup on failure). | Full engine suite + variant smoke + a parity sweep. | **Reject for this lane.** A legitimate engine epic, but not the cheapest fix for a gallery-default problem. |
| **D. Hybrid** — A now; file C as a separate engine epic behind its own gate. | A's 4-5 files now | Low now | — | A's sweep now | **Recommended framing.** |

### Recommendation

**Option A, filed under the D framing.** Reasons:

1. **The premise Q-94 rests on is already solved in the runner.** The expensive options are priced against a problem that does not exist. All 303 demos survive the existing transform at parse level, and the single demo whose construction is not at column 0 (`khr-mesh-primitive-restart-dev/main.js:25`) constructs inside an `async function`, so `await` is legal there too.
2. **The residual defect is four settings-layer lines plus one regex alternation.** D1–D4 each touch only `packages/sandcastle/`, no engine code and no demo file.
3. **`?renderer=` (D2) is the highest-value single item** even independent of the default flip: without it, certifying the gallery on WebGPU requires driving localStorage or the UI toggle per demo — which is the entire reason this looks expensive today.
4. **Flipping the default (D1) is a product call, not an engineering one.** It should be made knowingly, because it exposes every unfixed WebGPU parity bug to the default gallery visitor. It is cleanly separable from D2/D3/D4, which are strict improvements under any decision.

On upstream precedent for Option C: the fork's `Viewer.createAsync` / `Scene.createAsync` / `CesiumWidget.createAsync` are **fork additions**; upstream CesiumJS's `Viewer` is synchronous-only, and upstream's async precedent sits at the *resource* layer (`Cesium3DTileset.fromUrl`, `createWorldTerrainAsync`), not the viewer layer. **I do not know of an upstream issue proposing async Viewer construction and am not asserting one.**

---

## (c) Inventory (mechanical, `packages/sandcastle/gallery/*/main.js`)

| Shape | Count |
|---|---|
| Total demos (one `main.js` each) | **338** |
| Sync `new Cesium.Viewer(` | **303** |
| Bare `new Viewer(` (destructured import) | **0** |
| `Viewer.createAsync` | **33** (29 of which pin `renderer: "webgpu"`) |
| `new Cesium.CesiumWidget(` only | **1** |
| No viewer construction at all | **1** |
| Demos pinning `renderer: "webgl"` | **0** |

Transform-safety check — I applied the exact `Helpers.ts:92-102` regex pair to each of the 303 sync demos, wrote each result as `.mjs`, and ran `node --check`:

- **SyntaxErrors: 0 / 303.** Top-level `await` is legal in every case.
- Multi-viewer demos: **2** — `multiple-synced-views` (2 viewers, `main.js:24-25`) and `arcgis-mapserver` (its second hit, `main.js:12`, is inside a `//` comment, so the rewrite is inert).
- Construction not at column 0: **1** — `khr-mesh-primitive-restart-dev/main.js:25`, inside `async function createViewer(requestWebgl1)` (`:21`). Legal.

Named outliers: `cesium-widget` (D4 — `CesiumWidget`, untransformed, silently WebGL), `timeline` (no viewer construction), `multiple-synced-views` (two concurrent WebGPU devices once D1 lands — worth one explicit check), `arcgis-mapserver` (commented-out construction, benign), `khr-mesh-primitive-restart-dev` (async-function construction, benign).

ESM confirmation: every `main.js` opens with `import * as Cesium from "cesium";` and is injected as `<script type="module">` (`bucket-client.ts:45-46`) — top-level `await` is supported by construction, not by assumption.

---

## (d) What the maintainer must decide

1. **Flip Sandcastle2's default to WebGPU?** (`SettingsContext.ts:54`) The only genuinely contested item. It makes the gallery match the README's CesiumViewer claim, at the cost of exposing every open WebGPU parity bug by default. Options: flip; flip to AUTO-with-fallback semantics; or leave WebGL and treat D2/D3/D4 as the whole lane.
2. **Ship `?renderer=` for Sandcastle2?** Recommend yes regardless of (1) — it is the verification enabler.
3. **Unhardcode the standalone/share page** (`AppStandalone.tsx:150`)? Recommend yes; shared links currently cannot demonstrate WebGPU at all.
4. **Extend the transform to `CesiumWidget`**? Recommend yes — this is the only place a user is shown the wrong backend with no signal at all.
5. **Split-mode WebGL pane vs the 29 self-pinned demos** — force `renderer: "webgl"` into that pane (honest split, overrides demo intent), or surface a "renderer pinned" marker as `Tools/visual-regression/cross-backend-sandcastle-runner.mjs:10-17` already does?
6. **Is engine deferred-context (Option C) worth a separate epic seed at all?** My read is no for parity purposes, but it is the only thing that would let unmodified upstream demo code run on WebGPU *outside* a runner.

---

## (e) What I could not verify without a browser

- **Runtime, as opposed to parse-time, success of the 303 transformed demos.** `node --check` proves no SyntaxError; it cannot prove the demos render. Specifically unverified: demos whose later code assumes the viewer exists across an intervening `await`, and ordering interactions with `Sandcastle.finishedLoading()` (`Helpers.ts:151`).
- **Whether the WebGPU toggle currently produces a correct first frame per demo.** Q-94 was raised from a probe that bypassed the app's own transform entirely — `Tools/visual-regression/output/edge-tranche3e-a-2026-08-29/j3-eclipse-explorer.mjs` rewrites `main.js` over the wire to inject `contextOptions` — so it never exercised the `Helpers.ts` path and cannot speak to whether that path works.
- **Two-concurrent-WebGPU-device behaviour** in `multiple-synced-views` (device-pool lease pressure).
- **Whether `Apps/Sandcastle2/gallery` (342 entries) is byte-current** with `packages/sandcastle/gallery` (338 demos). The counts differ by 4 and I did not diff them; some entries are likely index/manifest files rather than demos.

### Cheap certification design (for whoever takes the lane)

Land `?renderer=webgpu` (D2) **first**, then run a headless page-load sweep: for each of the 338 gallery ids, open `Apps/Sandcastle2/index.html?id=<id>&renderer=webgpu`, wait for the bucket frame, and assert (i) zero `pageerror` / `console.error`, (ii) `viewer.scene.context.rendererType === "webgpu"`, (iii) `frameNumber` advances past 1, (iv) an element screenshot of the canvas is non-black and non-uniform. Gates (i)/(iii)/(iv) already exist in `Tools/visual-regression/sandcastle-smoke.mjs`; **gate (ii) is the new assertion Q-94 actually needs, and is what would have caught D4.** Reuse the standing instrument rule — WebGPU canvases must be captured via Playwright element screenshots, never in-page `drawImage`. Without D2 the same sweep needs per-demo localStorage seeding or UI toggling, which is what makes this look expensive today.
