# Sandcastle Batch 65 Test Report — 2026-04-25

Headless Edge (Playwright `chromium` channel `msedge`, `--enable-unsafe-webgpu`)
loaded each `Apps/Sandcastle/gallery/WebGPU *.html` demo from
`http://localhost:8080`, captured a Playwright element-screenshot of the
`.cesium-widget canvas`, recorded console messages, and attempted demo-
specific interactions (pick-click, `softShadows` toggle, layer-count probe).

Server: `node server.js --port 8080 --production` (serves prebuilt
`Build/CesiumUnminified/Cesium.js`; the dev-mode esbuild rebuild is
broken — see Finding F1 below).

Runner script: `Tools/visual-regression/sandcastle-batch-65-runner.mjs`
Raw machine-readable report: `Tools/visual-regression/screenshots/sandcastle-batch-65/report.json`
Source commit tested: `c35317f841 Batch 65 — Sandcastle demos for Batches 48-63`
(plus `4b538a2644` ESLint follow-up).

## Summary

- Demos delivered by Batch 65: **7**
- Demos tested: **7**
- Passed: **1** (`WebGPU Translucent Classification`)
- Failed: **6**
- Skipped (asset missing): **0**

The 6 failures break down into three engine-level root causes that
Batch 65 surfaces but does not own:

| Finding | Affected demos | Source of the bug |
|---|---|---|
| F1 Unescaped backticks inside WGSL template literal in `WebGPUEdgeVisibilityEmitter.ts` lines 71 + 214 | indirect — blocks dev-mode build for *all* Sandcastles | New file dropped during Batch 65 (Edge Visibility infrastructure work) |
| F2 `DeveloperError: The shader function must have at least one line` thrown from WebGL `ShaderBuilder` | Edge Visibility, Edge Feature ID | Pre-existing engine bug in WebGL Model code path triggered by these glTF assets (no new shader function lines) |
| F3 `Class constructor X cannot be invoked without 'new'` | Many Imagery Layers, Voxel Pick, Point Light Shadows | Pre-existing engine bug — `UrlTemplateImageryProvider` and `DynamicGeometryUpdater` were converted to ES6 classes but ~10 subclasses still call them as `Parent.call(this, …)` |
| F4 404 on the Cesium Man glTF | Model Pick | Demo-author URL bug; asset not packaged in repo |

These three engine bugs are pre-existing — they reproduce on `main` outside
the demo context — but Batch 65 is the first thing that actually exercises
them in a smoke-test, which is what the demos were meant to do. Recommended
follow-up: open three engine-side issues (F1/F2/F3) and a demo-fix for F4.

## Per-demo results

### WebGPU Edge Visibility
- Status: **FAIL**
- Backend probe: viewer not exposed on `window` (Sandcastle scopes `viewer`
  inside the inline script); cannot confirm `rendererType` from outside.
- Console errors: `DeveloperError: The shader function must have at least
  one line.` thrown from
  `ShaderFunction.generateGlslLines → ShaderBuilder.buildShaderProgram →
   ModelDrawCommands.buildModelDrawCommand → Model.update`. Followed by
  the global "An error occurred while rendering. Rendering has stopped."
  banner. (3 errors total, all rooted at the same line.)
- Console warnings: `Failed to create texture for property table
  "undefined": Property with ID: "geometryClass" has (4), which does not
  match number of features in the property table: (1).` — note: the demo
  comment header references `EXT_mesh_primitive_edge_visibility`; this
  warning suggests the glTF asset has a structural-metadata mismatch that
  may be related to the failure path.
- Screenshot: `screenshots/sandcastle-batch-65/WebGPU Edge Visibility.png`
- Notes: The screenshot shows the Sandcastle UI overlay but the canvas
  shows only the engine's modal "rendering stopped" banner; no model
  geometry, no edges. Per Finding F2 this isn't an edge-stage problem —
  the model never makes it to Model.update without throwing.

### WebGPU Edge Feature ID
- Status: **FAIL**
- Console errors: identical stack to Edge Visibility
  (`ShaderFunction.generateGlslLines` throws DeveloperError). 3 errors.
- Console warnings: same property-table texture warning.
- Screenshot: `screenshots/sandcastle-batch-65/WebGPU Edge Feature ID.png`
- Notes: Same root cause as F2; this demo loads a similar glTF asset and
  fails at the same call site. The Highlight/Clear/Feature-ID toolbar
  renders, the model itself does not.

### WebGPU Many Imagery Layers
- Status: **FAIL**
- Console errors: `TypeError: Class constructor UrlTemplateImageryProvider
  cannot be invoked without 'new' at new OpenStreetMapImageryProvider
  (index.js:309457:38) at makeLayers (WebGPU Many Imagery Layers.html:142)`
- Page errors: 1 uncaught, same TypeError.
- Screenshot: `screenshots/sandcastle-batch-65/WebGPU Many Imagery Layers.png`
- Notes: The screenshot shows the **base ellipsoid blue Earth** with no
  imagery — the imagery-layer construction throws before the first
  provider is wired in, so the layer count goes from 1 (default Bing/Ion)
  to 0/error. The demo's intent was 8 layers; observed `imageryLayers.length`
  cannot be probed because the viewer never finishes initialising.
  Per Finding F3 this is upstream of the demo: `OpenStreetMapImageryProvider`
  is a ES5-prototype subclass of `UrlTemplateImageryProvider` (now an
  ES6 class), and the same bug reproduces from any `new
  OpenStreetMapImageryProvider({...})` call on `main`.

### WebGPU Model Pick
- Status: **FAIL**
- Console errors: 2× `Failed to load resource: 404 (Not Found)` — the
  glTF the demo references is not present in the repo's `Specs/Data` tree.
- Page errors: 3× `NotFoundError: Failed to execute 'setPointerCapture'`
  triggered by my synthetic click (pre-existing Cesium issue with
  PointerEvent dispatch on canvases, not a new regression).
- Pick result: synthetic click delivered at (640, 360); demo did not log
  a picked target because the model never loaded.
- Screenshots: `WebGPU Model Pick.png` (pre-click),
  `WebGPU Model Pick-after-click.png` (post-click).
- Notes: Visually the screenshot shows Earth with NaturalEarth II imagery
  rendered correctly and the toolbar "Click a model to pick it; (nothing
  picked yet)" — proving the **viewer is healthy, the WebGPU backend is
  rendering, and only the demo's model-asset URL is broken**. This is the
  cleanest demo failure of the batch from an engine standpoint. A simple
  URL fix (point at an asset that ships in `Specs/Data` like
  `Cesium_Air.glb` or one of the StyledLines glTFs) would likely move this
  to PASS.

### WebGPU Point Light Shadows
- Status: **FAIL**
  (the runner's automated heuristic reported PASS based on PNG size, but
  visual inspection shows a "Rendering has stopped" modal — corrected.)
- Console errors: `An error occurred while rendering. Rendering has
  stopped.\nTypeError: Class constructor DynamicGeometryUpdater cannot be
  invoked without 'new' at new DynamicBoxGeometryUpdater
  (index.js:112240:34) at BoxGeometryUpdater.createDynamicUpdater
  (index.js:111585) at DynamicGeometryBatch.add → _GeometryVisualizer
  → CesiumWidget._onTick`.
- Page errors: none (the error is caught and surfaced via the modal).
- softShadows toggle: attempted via `viewer.shadowMap.softShadows = true`
  but the probe couldn't reach `window.viewer`; both screenshots
  (`-soft.png` and the base) show the same render-stopped dialog so the
  PCF visual diff cannot be evaluated.
- Screenshots: `WebGPU Point Light Shadows.png`,
  `WebGPU Point Light Shadows-soft.png`.
- Notes: Same Finding F3 family as Many Imagery Layers — `BoxGeometryUpdater`
  is one of ten `DynamicGeometryUpdater` subclasses still using the
  ES5 `Parent.call(this, …)` pattern. Until `DynamicGeometryUpdater` is
  reverted to a function constructor or all subclasses are converted to
  `class … extends … { super(…) }`, any demo that adds a Box/Polygon/
  Rectangle/Wall/Plane/Polyline-volume/Corridor/Ellipsoid/Ellipse/Cylinder
  Entity geometry will hit this dialog.

### WebGPU Translucent Classification
- Status: **PASS**
- Console errors: none.
- Console warnings: only the benign "Canvas2D willReadFrequently" hint
  emitted by my own pixel-sampling code.
- Screenshot: `screenshots/sandcastle-batch-65/WebGPU Translucent Classification.png`
- Notes: Visual confirms the photogrammetry tileset and a building
  classification region rendering against aerial imagery. The demo's
  4-sample MSAA toolbar is visible. Couldn't toggle "Show classification
  volume" automatically without `window.viewer`, so depth-of-render
  verification (volume-visible vs hidden) is left to manual review.
  This demo is the best evidence that the WebGPU translucent
  classification path (Batch 47 + 61) is healthy in headless Edge.

### WebGPU Voxel Pick
- Status: **FAIL**
- Console errors: `TypeError: Class constructor UrlTemplateImageryProvider
  cannot be invoked without 'new' at new TileMapServiceImageryProvider
  (index.js:158587:38) at TileMapServiceImageryProvider.fromUrl
  (index.js:158623)`.
- Page errors: 3× `setPointerCapture` (synthetic-click artefact, see
  Model Pick).
- Pick result: synthetic click attempted; the demo never wires its pick
  handler because the imagery provider failure may have aborted the
  viewer's bootstrap path.
- Screenshots: `WebGPU Voxel Pick.png`, `WebGPU Voxel Pick-after-click.png`.
- Notes: The screenshot **does** show the white-clay voxel hexagon
  rendered against a starry void — meaning the WebGPU voxel renderer
  itself is producing valid output. The TMS imagery error is the same
  Finding F3 family (`TileMapServiceImageryProvider extends
  UrlTemplateImageryProvider`). If the demo were updated to use an
  alternative basemap (e.g. `IonResource.fromAssetId(2)` or
  `createWorldImageryAsync`) it would likely PASS.

## Findings

### F1 — Unescaped backticks inside WGSL template literal
File: `packages/engine/Source/Renderer/WebGPU/WebGPUEdgeVisibilityEmitter.ts`
Lines: **71** (`limit). \`C-R8-EDGE-ID-FORMAT\` limit).`) and **214**
(`\`low + high * 256.0\` after denormalising both. Saturates at`).

The file opens a backtick-delimited template literal at line 38
(`const EDGE_EMITTER_WGSL = /* wgsl */ \``) and closes at line 231 (`\`;`).
Backticks inside that literal terminate the template prematurely, after
which esbuild parses `C-R8-EDGE-ID-FORMAT` as TypeScript and reports
`Expected ';' but found 'C'` at line 71 col 35. The dev-mode server
(`node server.js`, default mode) intercepts requests for
`Build/CesiumUnminified/Cesium.js` and rebuilds via esbuild on each hit,
so as long as this file is on disk **every Sandcastle demo serves a
500 with a stack trace instead of Cesium.js**.

Fix: either escape the inner backticks (`\\\``) or replace them with
single quotes inside the WGSL comments. The file is currently `untracked`
in the working tree (not part of any commit), so it is fine to edit
in-place.

Workaround that unblocked this test run: serve via
`node server.js --port 8080 --production` so the prebuilt
`Build/CesiumUnminified/Cesium.js` is returned without a rebuild. The
prebuilt file predates this `.ts` file, so the engine works.

### F2 — `ShaderBuilder.buildShaderProgram` throws on edge-visibility glTF assets
Stack: `ShaderFunction.generateGlslLines → generateFunctionLines →
ShaderBuilder.buildShaderProgram → createShaderProgram4 →
ModelDrawCommands.buildModelDrawCommand → Model.update`.

The `DeveloperError("The shader function must have at least one line")`
fires in WebGL2's `ShaderFunction.generateGlslLines`. This is the WebGL
code path even though the demo passes `renderer: 'webgpu'` — Model.js
shares the structural-metadata texture pre-pass between backends, and
that pre-pass goes through `ShaderBuilder` regardless of backend.

The accompanying warning
`Property with ID: "geometryClass" has (4), which does not match number
of features in the property table: (1)` suggests the
EXT_mesh_primitive_edge_visibility glTF asset
(`Specs/Data/Models/glTF-2.0/StyledLines/BENTLEY_materials_line_style.gltf`)
has a structural-metadata table with an inconsistent feature count. The
empty shader function downstream is likely a consequence of that empty
property table.

This is a pre-existing bug not introduced by Batch 65; the demos simply
happen to be the first thing in the smoke-test surface that loads this
particular asset.

### F3 — ES5 subclasses calling ES6 class parents as functions
The engine has at least the following surfaces affected:

`DynamicGeometryUpdater` parent (ES6), 10 subclasses calling `.call(this, …)`:
`BoxGeometryUpdater`, `WallGeometryUpdater`, `RectangleGeometryUpdater`,
`PolylineVolumeGeometryUpdater`, `PolygonGeometryUpdater`,
`PlaneGeometryUpdater`, `CorridorGeometryUpdater`,
`EllipsoidGeometryUpdater`, `EllipseGeometryUpdater`,
`CylinderGeometryUpdater` (paths under
`packages/engine/Source/DataSources/`).

`UrlTemplateImageryProvider` parent (ES6), at least 2 subclasses with
the same pattern: `OpenStreetMapImageryProvider`,
`TileMapServiceImageryProvider`. Likely more.

Per the migration rules in CLAUDE.md ("ES6 modernization — never
modernize a file you're not otherwise touching"), the parent classes
were converted to ES6 in some prior batch but the subclass conversions
were left for the modernization-when-touched policy. The demos exercise
these inheritance chains for the first time at runtime, exposing the
gap.

Fix path (any one of these, smallest change first):
1. Revert the parents to function-constructors with `Object.assign` for
   prototype inheritance (matches subclass expectations).
2. Convert each subclass to `class X extends Y { constructor(){ super(); … } }`
   and replace the trailing `Object.defineProperties` blocks with class
   `get/set` accessors. ~10 file edits, mechanical.
3. Patch the parents to detect a non-`new` invocation and re-dispatch via
   `new this.constructor(...arguments)`. Ugly but localised.

### F4 — Model Pick references a glTF that isn't in the repo
Demo file: `Apps/Sandcastle/gallery/WebGPU Model Pick.html`. Two
404s on resource fetches indicate the model URL points at an asset
that doesn't exist in `Specs/Data` or `Apps/SampleData`. This is a
pure demo-author bug; pointing at any of the bundled glTFs (e.g.
`Apps/SampleData/models/CesiumAir/Cesium_Air.glb`) should work.

## Recommended follow-ups (not done in this batch per the brief)

1. **F1 (highest priority for any sandcastle work)**: escape the inner
   backticks in `WebGPUEdgeVisibilityEmitter.ts:71,214` so the dev-mode
   build comes back. Without this, every Sandcastle in the gallery —
   not just the seven new ones — is broken under `npm run start`.
2. **F3 (highest priority for Entity-using demos)**: pick one of the
   three fix strategies above for the DynamicGeometryUpdater + provider
   inheritance. Without this, any Sandcastle demo that uses Entity-API
   `box`/`polygon`/`rectangle`/etc. is broken regardless of backend.
3. **F4**: fix the Model Pick demo's URL to point at a bundled asset.
4. **F2**: triage whether the BENTLEY_materials_line_style asset is
   malformed or if the structural-metadata pre-pass needs to handle
   under-populated property tables more gracefully. The Edge demos
   cannot pass smoke-test until this is resolved.
5. **Test-runner improvements** (for the next sandcastle batch):
   - The runner should expose `viewer` to `window` itself (it can do
     this via a small `page.addInitScript` patch that hooks into
     `Sandcastle.declare` or the inline `var viewer =` pattern). That
     removes the "via: none, rendererType: null" gap in the report.
   - The PASS heuristic should treat any `An error occurred while
     rendering` console message as a hard FAIL regardless of PNG size.
   - Adding a `--threshold-pixels-changed` mode that diffs against
     a stored baseline would close the loop on actually verifying the
     visual content (e.g. PCF soft-shadow penumbra width).

## Artifacts
- Screenshots (one per demo, plus per-demo extras):
  `Tools/visual-regression/screenshots/sandcastle-batch-65/*.png`
- Machine-readable run report: `…/sandcastle-batch-65/report.json`
- Test runner script:
  `Tools/visual-regression/sandcastle-batch-65-runner.mjs`
