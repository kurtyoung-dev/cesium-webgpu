> **Canonical doc** (consolidation first draft, 2026 consolidation).
> **Supersedes / folds in:** the `Build & Test Commands`, `Build Variants (Tree-Shaking)`, `Visual Regression Testing`, and `Playwright / Browser Testing` sections of `cesium-webgpu/CLAUDE.md` (those remain authoritative until this doc is promoted); plus the scattered build-variant notes in `migration_doc/WEBGPU_MIGRATION_STATUS.md`, `migration_doc/DEBUGGING_GUIDE.md`, and `Tools/visual-regression/README.md`.
> **Review-in-progress.** Statuses re-verified against live code (`scripts/build.js`, `scripts/bundleVariantPlugin.js`, `gulpfile.js`, `packages/engine/Source/Renderer/RendererType.ts`, `package.json`, `Tools/variant-smoke-test.mjs`) and git log at HEAD = Batch 506 (`62c5bab450`, post-parity-campaign audit 2026-07-03). Items I could not re-measure are flagged **`status: verify`**.

# Build & Variants — Operational Reference

This is the single operational reference for **building the fork** and for the
**tree-shaking build variants** (`dual` / `webgl-only` / `webgpu-only`). It
covers the gulp tasks, how the variant aliasing actually works at the esbuild
layer, the compat-surface exemption rule, the runtime default-renderer hint,
the smoke test, WGSL→JS compilation, and the visual-regression / Playwright
harness.

The CesiumJS repo is an **npm-workspaces monorepo**. Root `Source/` is a
**build output**, not the source of truth — edit `packages/engine/Source/` and
`packages/widgets/Source/`. See `cesium-webgpu/CLAUDE.md` → *Monorepo
Architecture — File Placement Rules*.

---

## 1. Build Commands

| Command | What it does |
| --- | --- |
| `npx gulp build` | Full build. Runs `buildEngine` → `buildWidgets` → `buildCesium` (combines into `Build/CesiumUnminified`). Includes GLSL→JS **and** WGSL→JS shader compilation. Entry point: `build()` in `gulpfile.js` (line ~82). |
| `npx gulp buildRelease` | Production build — `buildEngine` + `buildWidgets` + dual-variant **unminified** (`Build/CesiumUnminified`) and **minified, pragma-stripped** (`Build/Cesium`) bundles. (`gulpfile.js` line ~473.) |
| `npx tsc --noEmit` | TypeScript type-check only (no emit). Enforces the WebGL/WebGPU abstract-API parity at compile time. The gulp wrapper is `npx gulp tsc` / `npm run tsc`. |
| `npm run build-wasm` | WASM **release** build (`node scripts/buildWasm.js`). Companions: `build-wasm-debug`, `build-wasm-check`, `build-wasm-clean`, `build-wasm-naga`, `build-wasm-naga-tooling`, `build-wasm-full`. |
| `npm run restart` | **User-preferred dev loop.** `gulp clean && gulp build && node server.js` — clean rebuild then start the dev server. Prefer this over raw `gulp` for the rebuild-and-serve cycle. |
| `npm test` | Jasmine/Karma suite (`gulp test`). Karma defaults to Chrome, which may not be installed — set `CHROME_BIN` to the Edge binary; use `--includeName` / `--include` to scope subsets (the full ~17k-spec suite is slow). Variants: `test-webgl`, `test-non-webgl`, `test-webgl-validation`, `test-webgl-stub`, `test-release`, `test-all`. |

Other useful scripts (from `package.json`): `npm start` (`node server.js`),
`npm run build-watch` (`gulp buildWatch` — rebuilds GLSL **and** WGSL on
change), `npm run build-ts`, `npm run eslint`, `npm run lint-debug-pragmas`
(`Tools/lint-debug-pragmas.mjs`), `npm run build-sandcastle`,
`npm run build-apps`.

> **Note on shader rebuilds:** `build` and `build-watch` both run the
> GLSL→JS and WGSL→JS converters. The watch task wires a `gulp.watch` on
> `packages/engine/Source/Shaders/WebGPU/**/*.wgsl` that re-runs
> `wgslToJavaScript` on save (`gulpfile.js` line ~163). See §7.

---

## 2. Build Variants

Three bundle variants reduce download size when only one backend is needed.
Each variant decides **what code is in the bundle**, not what runs at boot —
the dual build's runtime backend can still be flipped per-`Viewer` via
`contextOptions.renderer`.

### Tasks

| Gulp task | Variant | Output dirs |
| --- | --- | --- |
| `npx gulp buildCesiumDual` | both backends, WebGPU-first default | `Build/Cesium` + `Build/CesiumUnminified` (historical paths) |
| `npx gulp buildCesiumWebGLOnly` | WebGL only — WebGPU renderer + WGSL aliased to empty stubs | `Build/CesiumWebGL` + `Build/CesiumWebGLUnminified` |
| `npx gulp buildCesiumWebGPUOnly` | WebGPU only — GLSL shader strings aliased to empty stubs | `Build/CesiumWebGPU` + `Build/CesiumWebGPUUnminified` |
| `npx gulp buildAllVariants` | all three side-by-side | all of the above |

The standalone tasks (`buildCesiumDual/WebGLOnly/WebGPUOnly`) rebuild
`buildEngine` + `buildWidgets` each time — suitable for "I just want one
variant" workflows. `buildAllVariants` **hoists** `buildEngine` + `buildWidgets`
so they run exactly **once**, then builds the dual variant (which produces the
shared assets — workers, CSS, ThirdParty, Widgets, Assets), and finally runs
`webgl-only` and `webgpu-only` on a **fast path** that copies those shared
assets instead of rebuilding them (`buildCesiumVariantFast` →
`copyVariantSharedAssets`, `gulpfile.js` lines ~568–609). The variant→dir-suffix
mapping is `variantDirSuffix()` in `scripts/build.js` (line ~1201): `webgl-only`
→ `WebGL`, `webgpu-only` → `WebGPU`, `dual` → `""`.

### Measured sizes

The following are the sizes recorded in `CLAUDE.md`'s *Build Variants*
section (minified IIFE `Cesium.js`). **`status: verify` — STALE** — these were
measured at an earlier batch (the doc was last refreshed around Batches 56–185;
HEAD is 506, and the WebGPU surface has grown substantially since, e.g. the
cloud / atmosphere / env campaigns in Batches 400–453, DP-H46 metadata in
454–463, and the WebGL→WebGPU parity campaign in 482–506, which alone added
~16.9K lines). Treat them as the **shape** of the savings, not exact current numbers
— this is a snapshot-in-time metric, not a stable invariant; do not treat the
absolute MB figures as canonical.

| Variant | Size (as recorded) | vs dual |
| --- | --- | --- |
| dual (webgpu-first, default) | ~7.1 MB | baseline |
| webgl-only | ~5.6 MB | ≈ −1.5 MB (−21%) |
| webgpu-only | ~6.4 MB | ≈ −0.7 MB (−10%) |

**Re-measure** before quoting these anywhere user-facing:

```bash
npx gulp buildAllVariants
ls -lh Build/Cesium/Cesium.js Build/CesiumWebGL/Cesium.js Build/CesiumWebGPU/Cesium.js
```

(Those three bundle paths are the same ones the §6 smoke test loads, so a
re-measure and a smoke run share one build.)

**Why the asymmetry** (this reasoning is structural and **still holds**
regardless of the absolute sizes): the webgl-only build strips the entire
`Source/Renderer/WebGPU/` directory **plus** all WGSL string modules, so it
drops more. The webgpu-only build only strips the GLSL shader-string leaves —
the WebGL backend **classes** (`Context`, `ShaderProgram`, `Texture`, etc. under
`Source/Renderer/`) are still pulled in by Scene files' static imports, so it
drops less. Closing that gap is a separate refactor. The exact file/LOC counts
quoted in `CLAUDE.md` — "103 files, ~45K LOC", "67 WGSL modules", "191 GLSL
leaves" — are also **`status: verify` (STALE)**; re-count with:

```bash
find packages/engine/Source/Renderer/WebGPU -type f \( -name '*.ts' -o -name '*.js' \) | wc -l   # WebGPU renderer files
find packages/engine/Source/Shaders/WebGPU -name '*.wgsl' | wc -l                                  # WGSL modules
find packages/engine/Source/Shaders -name '*.glsl' -not -path '*/WebGPU/*' | wc -l                 # GLSL leaves
```

---

## 3. How the Variant Wiring Works

The mechanism is `scripts/bundleVariantPlugin.js` — an esbuild plugin that
**aliases backend-specific module imports to empty stubs** during bundling. It
is transparent to source files: they keep their normal static imports (e.g. a
Scene file's WebGL fallback does `import GlobeFS from "../Shaders/GlobeFS.js"`),
and the plugin redirects that import to an empty string in a webgpu-only build.
The WebGPU feature-renderer pattern guarantees the WebGL fallback path that
would have consumed `GlobeFS` is never reached when WebGPU is active.

### esbuild `onResolve` redirects

`bundleVariantPlugin(variant)` returns `null` for `dual` (no aliasing) so
callers can do `[bundleVariantPlugin(variant)].filter(Boolean)`. For the two
single-backend variants it registers an `onResolve({ filter: /.*/ })` hook that:

1. **Re-entry guard / virtual-module skip** — bails on esbuild-internal
   ``-prefixed paths and on its own `pluginData._variantSkip`.
2. **Cheap pre-filter** — only relative/absolute paths can be backend-specific;
   bare specifiers (`@cesium/engine`, `lodash`) are skipped immediately.
3. **Synthetic path resolution** — computes what esbuild *would* resolve to via
   `path.resolve(args.resolveDir, args.path)` **without** calling
   `build.resolve()` (which would walk the whole plugin chain and need a
   recursion guard). This relies on Cesium consistently using explicit `.js`
   extensions on relative imports.
4. **Decision cache** — a `Map` from candidate path → redirect target (or
   `false`). Makes repeat lookups O(1), which matters across Cesium's ~3000
   modules.
5. **Pattern match** →
   - `webgpu-only` + `isGLSLShaderFile(candidate)` → redirect to the GLSL stub.
   - `webgl-only` + `isWebGPUFile(candidate)` → redirect to the **shader** stub
     if it's under `/Source/Shaders/WebGPU/`, else the **module** stub.
   - otherwise return `null` (let esbuild's default resolver, and any later
     plugins, handle it).

`isGLSLShaderFile` matches `…/Source/Shaders/…` `.js`/`.glsl` **excluding**
`…/Source/Shaders/WebGPU/…`. `isWebGPUFile` matches `…/Source/Renderer/WebGPU/`
or `…/Source/Shaders/WebGPU/` **minus** the compat-surface exemptions (§4).

### The two stubs

- `scripts/stubs/emptyShader.js` — `export default ""`. Used for GLSL shader
  strings (webgpu-only) and WGSL shader strings (webgl-only). A no-op string.
- `scripts/stubs/emptyModule.js` — a `Proxy` that throws on any non-introspection
  access. Used for WebGPU **TS modules** in webgl-only builds, so if a code path
  *does* reach into a stubbed WebGPU module it fails loudly rather than silently
  misbehaving. (It also carries a `default` export so esbuild's named-re-export
  check in the entry barrel is satisfied — see `gulpfile.js` ~1383–1429.)

### ESM code-splitting (dual) vs IIFE/CJS inlining

- The **dual** build enables ESM code splitting, so the
  `await import("./WebGPU/WebGPUContext.js")` in `ContextFactory` stays dynamic:
  WebGPU code lands in a separate `chunks/WebGPUContext-*.js` chunk that only
  downloads when `renderer: 'webgpu'` (or `AUTO` resolving to WebGPU) is chosen.
- The **IIFE** (`Cesium.js`) and **CJS** (`index.cjs`) formats do **not**
  support code splitting, so their WebGPU code is inlined regardless of variant.
  For those formats, the alias plugin is what actually shrinks the bundle. This
  is the documented IIFE trade-off in `bundleVariantPlugin.js` (lines ~96–112):
  IIFE consumers pay for bundled-but-unexecuted code paths (naga-wasm glue,
  shader-translator scaffolding) in exchange for single-`<script>` simplicity;
  prefer the ESM bundle if minimum size matters.

---

## 4. Compat-Surface Exemptions

Some files under `Source/Renderer/WebGPU/` are **backend-neutral** — they're
consumable from a webgl-only build even though they live in the WebGPU
directory, because the engine barrel re-exports named symbols from them. These
must **not** be aliased to empty stubs. They are listed in
`WEBGPU_COMPAT_EXEMPTIONS` in `scripts/bundleVariantPlugin.js` (line ~114).

**Current entries (verified at HEAD):**

```
/Source/Renderer/WebGPU/WebGLCompatibilityStub
/Source/Renderer/WebGPU/WebGPUShaderTranslator
/Source/Renderer/WebGPU/WebGLStubPipelineExtractor
/Source/Renderer/WebGPU/WebGPUNagaTranspiler
```

Matching is by `String.prototype.includes` on the path **without** extension,
so `.ts`, `.js`, and `.d.ts` sibling resolutions all hit the same rule (no
per-extension entries needed).

**Rule for adding a new compat-surface file.** When you add a file under
`Source/Renderer/WebGPU/` that exports a backend-neutral API (an extended
shader translator, a new pluggable registry, a Session-29-style `.d.ts` interop
surface), add its path to `WEBGPU_COMPAT_EXEMPTIONS` **and** satisfy this
checklist (from the plugin's own docstring):

1. The file's **runtime** code paths (not just types) must be safe to execute in
   a webgl-only bundle — lazily import any WebGPU dependency, guarded by
   `isWebGPUSupported()` or similar.
2. The default export must **not throw at module-load time** when the WebGPU
   backend is inactive (module-load side-effects run regardless of whether the
   API is ever called).
3. If the file holds per-module state, confirm that state is harmless when never
   read (e.g. a null-initialised registry).

---

## 5. Runtime Default Renderer

The "which backend wins when the caller doesn't ask" decision lives in
`packages/engine/Source/Renderer/RendererType.ts`.

- `setGlobalDefaultRenderer(rendererType)` sets a **module-level** default.
- `getGlobalDefaultRenderer()` reads it; `getDefaultRendererType(preferWebGPU?)`
  resolves the effective backend (explicit `preferWebGPU` arg wins; otherwise
  the module default; then `isWebGPUSupported()` gates WebGPU).
- The module-level default is **`RendererType.WEBGPU`** (line ~97), so fresh
  installs / CDN consumers get the modern backend by default.
- It has **no effect** on contexts that explicitly pass `renderer` to
  `ContextFactory.createContext()` (or per-`Viewer` `contextOptions.renderer`).

`RendererType` also defines `WEBGPU_COMPAT` (`"webgpu-compat"`, WebGPU API in
`featureLevel: "compatibility"` on WebGL2-class hardware) and `AUTO` —
re-verified at HEAD.

### Per-variant entry barrels

Each variant ships a different entry barrel, generated by
`createCesiumJs(variant)` in `scripts/build.js` (line ~462). The
`entryFileForVariant()` map (line ~439):

| Variant | Generated entry file | Appended default-renderer call |
| --- | --- | --- |
| dual | `Source/Cesium.js` (historical name) | `setGlobalDefaultRenderer(RendererType.WEBGPU)` |
| webgl-only | `Source/CesiumWebGLOnly.js` | `setGlobalDefaultRenderer(RendererType.WEBGL)` |
| webgpu-only | `Source/CesiumWebGPUOnly.js` | `setGlobalDefaultRenderer(RendererType.WEBGPU)` |

`createCesiumJs` excludes the irrelevant backend's modules from the export list
(`shouldExcludeFromVariantBarrel`) and **appends** the
`setGlobalDefaultRenderer(...)` call so the runtime auto-selection matches the
bundled backend (build.js lines ~550–558). The dual entry leaves the default at
WEBGPU but still emits the call explicitly so intent is visible in source.

> WebGPU-source named re-exports (the Slice-5d cluster renderers, the WGSL
> preprocessor, the shader-translator / naga / stub helpers) are imported from
> `@cesium/engine/index-wgsl.js` and are **gated out of the webgl-only barrel**
> (`if (variant !== "webgl-only")`, build.js ~530). Importing them in webgl-only
> would trip esbuild's static named-re-export check because the alias plugin has
> rewritten those paths to the empty-module stub. (This is the
> `NEW-WEBGL-ONLY-CLUSTER-EXPORT-GATING` fix, Batch 224.) **Do not add deep
> `@cesium/engine/Source/...` specifiers** to the generated barrel — the
> Sandcastle dev runner's import map only maps the bare `@cesium/engine`, so a
> deep specifier throws "Failed to resolve module specifier" in the browser.
> The one sanctioned deep specifier is `@cesium/engine/index-wgsl.js`.

### Side-effects declaration (CRITICAL)

The root `package.json` declares `"./Source/Cesium*.js"` in `"sideEffects"`
(verified, line ~48) so bundlers do **not** tree-shake the
`setGlobalDefaultRenderer()` call out of the variant entry barrels. **Never
remove that glob** without replacing it with a different mechanism for the
default-renderer hint — otherwise the variant's default backend silently
reverts to the `RendererType.ts` module default.

---

## 6. Smoke Test

`node Tools/variant-smoke-test.mjs` — loads each variant's **IIFE** bundle in
Playwright, constructs a `Viewer`, renders frames, and asserts **zero
`console.error`** for the run. This catches the silent-regression class where a
variant *builds* cleanly but *crashes at runtime* because a code path hit an
empty-stub shader or the proxy-throwing WebGPU module.

Verified bundle paths and per-variant renderer (the `VARIANTS` array, lines
~50–68):

| Variant | Bundle path | Renderer exercised |
| --- | --- | --- |
| dual | `Build/Cesium/Cesium.js` | `webgpu` (explicit, to exercise both backends across the suite) |
| webgl-only | `Build/CesiumWebGL/Cesium.js` | `webgl` |
| webgpu-only | `Build/CesiumWebGPU/Cesium.js` | `webgpu` |

Pass criteria per variant: page loads without throwing; `window.Cesium` is
defined after the IIFE executes; `Cesium.Viewer(container)` constructs; five
frames complete; zero `console.error`. Exit code `0` = all pass, `1` = any
failure, `2` = bad args.

Usage: `node Tools/variant-smoke-test.mjs` (all three),
`--variant webgl-only` (one), `--headed` (show browser),
`--url http://localhost:8080` (reuse a running dev server; otherwise the tool
starts its own static server on an ephemeral port — CI relies on this,
`NEW-VARIANT-CI` follow-up, Batch 243). Uses Edge by default.

Last verified green: 2026-07-03 post-campaign audit at Batch 506 HEAD — all
three variants (dual / webgl-only / webgpu-only) passed.

**Run the smoke test after any change** that touches the variant plugin, the
exemption list, the entry-barrel generation, or `RendererType.ts`. The variant
build + smoke job is wired into CI (Batches 242, 259); the SwiftShader WebGPU
smokes are `LOCAL-REQUIRED` (real-GPU only).

---

## 7. WGSL Compilation (`.wgsl` → `.js`)

WGSL shaders are authored as `.wgsl` files under
`packages/engine/Source/Shaders/WebGPU/` and **compiled into `.js` string
modules** at build time by `wgslToJavaScript()` in `scripts/build.js`
(line ~996), mirroring upstream's `glslToJavaScript` for GLSL.

- Each `<name>.wgsl` becomes a sibling `<name>.js` exporting the source as a
  string. The generated header is
  `//This file is automatically rebuilt by the Cesium build process.`
- Files under `Shaders/WebGPU/chunks/functions` and `…/chunks/structs` are
  additionally registered as **builtin** function/struct chunks (the
  `CsmBuiltins.js` index is generated from them).
- The converter is incremental: it skips regeneration when the `.js` is newer
  than both its `.wgsl` source and the `minifyShaders.state` file.
- `build` / `buildRelease` run it once; `build-watch` re-runs it on `.wgsl`
  save via the `gulp.watch` on `Shaders/WebGPU/**/*.wgsl` (`gulpfile.js` ~163).

**Never hand-edit the generated `.js`** — your change will be overwritten on the
next build. Edit the `.wgsl` and rebuild. The generated `.js` wrappers are
explicitly treated as build output (e.g. clean globs and the
`Shaders/WebGPU/**/*.js` entries in build.js). This mirrors the *Monorepo File
Placement Rules* in `CLAUDE.md` (canonical = `packages/engine/Source/...`,
build output = root `Source/...`).

---

## 8. Visual Regression + Playwright Testing

### Browser requirement — Edge (Chromium), NOT Firefox

Use **Edge (Chromium)** for any WebGPU browser automation. Playwright bundles
Firefox **Nightly**, which does **not** have WebGPU enabled (release Firefox
does, but Playwright doesn't ship it). The visual-regression and smoke tools
both default to `msedge`. (Memory: *Feedback — Playwright Edge*.)

Useful URLs / globals:

- WebGPU viewer: `http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu` (`window.viewer` exposed)
- Split-screen: `http://localhost:8080/Apps/WebGPUTest/split-screen-comparison.html` (`window.webglViewer` / `window.webgpuViewer` exposed)
- WebGPU **requires** the post-process pipeline to blit the scene framebuffer to
  the canvas — `usePostProcess` must always be true for WebGPU (WebGL can render
  directly to the canvas).
- Diagnostics: `viewer.scene.getDebugSnapshot()` / `logDebugSnapshot()`, plus the
  `CesiumDebug.*` console commands (see `migration_doc/DEBUGGING_GUIDE.md`).

### Capture-and-diff harness

`Tools/visual-regression/capture-and-diff.mjs` captures the WebGL and WebGPU
canvases from the split-screen page, pixel-diffs them, and writes PNG diffs +
`report.json`. Zero external deps (Playwright + canvas-decode diff). See
`Tools/visual-regression/README.md`.

```bash
node Tools/visual-regression/capture-and-diff.mjs                 # all scenes
node Tools/visual-regression/capture-and-diff.mjs --update        # promote outputs to baseline/
node Tools/visual-regression/capture-and-diff.mjs --scene globe-default --headed
```

Flags: `--update`, `--scene NAME`, `--threshold N` (default `0.02`),
`--browser msedge|chromium|firefox|webkit` (default `msedge`), `--headed`.
Exit code `0` all-under-threshold, `1` any failure, `2` bad args, `99` uncaught.
Scenes live in `scenes.json` (each `name` + optional `camera`; synthetic scenes
via `setup` / `setupFile`, Batches 224–225).

### Probe-first workflow (the rule)

Per `CLAUDE.md` Principle 8: **any visually-verifiable WebGPU fix must be
verified by an automated Playwright probe before it's claimed to work** — do not
ask the user to reload and eyeball it. The required loop:

1. Reproduce the symptom in a probe under `Tools/visual-regression/probe-*.mjs`
   that matches the user's exact repro (saved-view query params, terrain/imagery
   picker, scene mode — default-camera probes miss view-specific artifacts).
   `probe-saved-view.mjs` is the recommended template.
2. Capture WebGL vs WebGPU + compute a pixel diff; record the baseline mismatch %.
3. Apply fix → rebuild → re-run the probe; compare the new mismatch % to baseline.
4. **Read the output PNGs yourself** — a dropped diff number is not proof; confirm
   the artifact is gone and no new one appeared.
5. Only then surface the probe name + mismatch delta + screenshots to the user.

There are 441 `probe-*.mjs` scripts in `Tools/visual-regression/` (counted at
Batch 506 HEAD; the Batch 482–506 parity campaign added 23 of them); search
there before writing a new one. The probe inventory + decision tree is
maintained in `migration_doc/DEBUGGING_GUIDE.md`. Note two probe-harness
gotchas surfaced by the 2026-07-03 campaign audit: `probe-collections-regression`
and `probe-pick-basic` default `PROBE_BASE` to `:8134` — set
`PROBE_BASE=http://localhost:8080` when running against the standard dev
server; and `probe-colorgrading-wired`'s stored default-view baseline PNG is
stale after Batch 506's intentional glint/seam pixel change (functional gates
A–E pass; the baseline needs a refresh — tracked as an OPEN doc-wave follow-up).

---

## Maintenance Notes

- **When you add a file under `Source/Renderer/WebGPU/`** that exports a
  backend-neutral API, add it to `WEBGPU_COMPAT_EXEMPTIONS` (§4) and run the
  smoke test (§6).
- **When you add a `.wgsl` shader**, rebuild (don't hand-edit the `.js`); for a
  new define bit, route it through the preprocessor/module cache per
  `CLAUDE.md` → *WGSL Shader Pipeline*.
- **Never remove** `"./Source/Cesium*.js"` from `package.json` `sideEffects`
  without replacing the default-renderer-hint mechanism (§5).
- **Re-measure variant sizes** (§2) before quoting them in user-facing material
  — the recorded figures predate the Batch 400–506 WebGPU growth and are
  `status: verify`.
- Keep this doc in sync with `CLAUDE.md`'s build sections; if they ever
  disagree, `CLAUDE.md` + the live scripts win until this doc is promoted.
