# ES6 / TypeScript Modernization Status

**Scope:** Canonical source only — `packages/engine/Source/` and `packages/widgets/Source/`.
**Excluded:** root `Source/` (build output), `Build/`, `node_modules/`, `**/ThirdParty/**`, `**/Workers/**` (generated), and `*.d.ts`.

**Nature of this document:** This is an **inventory of remaining pre-ES6 surface**, not a mandate to mass-rewrite. Per CLAUDE.md: *"When making >10 lines of changes to a file, modernize pre-ES6 patterns (var→const/let, prototype→class, Object.defineProperties→get/set, string concat→template literals); NEVER modernize a file you are not otherwise touching."* Conversions are **opportunistic on-touch**, not a campaign.

> Note: raw grep counts differ between scan passes depending on whether shader-string files and generated chunks were filtered. Where scans disagree, the lower (canonical-JS-only) figure is the load-bearing one and the discrepancy is called out. Treat all counts as approximate.

---

## 1. Executive Summary

The fork is **substantially modernized**. The prototype-based-class era is essentially over in canonical source: there are **zero `*.prototype = ` constructor-function class definitions** (the only `Object.create(...prototype)` chains are 4 legitimate abstract-base subclasses in `Scene/TilePathResolver.js`). ES6 `class` syntax is the norm — ~545 files use `class`, and every one of the ~171 WebGPU `.ts` files is full modern ES2022 (arrow fns, `const`/`let`, template literals, `?.`, `??`, async/await, class getters — no `var`, no `Object.defineProperties`).

What **remains** is concentrated in two idioms inside the legacy `.js` half of the codebase:

1. **`Object.defineProperties` getter/setter blocks** (~99–107 occurrences across ~81–87 files) — the dominant remaining pre-ES6 pattern. Heaviest in `DataSources/*Graphics.js` (BillboardGraphics, ModelGraphics, PolygonGraphics — 40–60+ properties each) and `DataSources/Entity.js`.
2. **`this._private` convention + convention-based privacy** (~4,530 assignments) instead of ES2022 `#private` fields (only **1** `#field` exists in the whole canonical tree).

Plus a long tail: scattered `.apply()`/`.bind()` + `arguments` (~29 files), `=== undefined` coexisting with the `defined()` helper (~193 raw checks), `hasOwnProperty` (~101 uses, zero `Object.hasOwn`), and minor string-concat in data-source parsers. There is **no remaining `var` in actual JavaScript** — the 100+ `var` grep hits are all WGSL shader strings (`var<uniform>`, `var material:`) embedded in JS template literals, which are syntactically required and not modernizable.

The TypeScript story is bifurcated: the **WebGPU renderer is ~87% TS**, while **Core / Scene / DataSources are ~0% TS** (still ES6-class JavaScript). That JS remainder is where all the legacy idioms above live.

---

## 2. Remaining Pre-ES6 Patterns

| Pattern | Approx count (canonical JS) | Files | Worst offenders | Notes |
|---|---|---|---|---|
| **`var` (real JS)** | **0** | 0 | — | All ~100–1,200 grep hits are WGSL shader strings in template literals (`WebGPUGroundPolylineRenderer.js` 46, `Scene/Material.js` 16, `WebGPUVector3DTileClampedPolylinesRenderer.js` 16, `WebGPUShadowMapRenderer.js` 10). Not modernizable; ESLint `no-var` ignores string contents. |
| **Prototype-as-class (`X.prototype = `)** | **0** | 0 | — | Constructor-function classes fully eliminated. |
| **`Object.create(Base.prototype)` chains** | 4 | 1 | `Scene/TilePathResolver.js` (4 subclasses of abstract base) | Legitimate abstract-base inheritance; **leave as-is**. |
| **`.prototype.method = function`** | ~319 *(broad scan)* | ~54 | `Scene/Expression.js` (42 — AST `Node` eval), `Renderer/WebGPU/WGSLShaderBuilder.js` (24), `Renderer/createUniform.js` (13), `Renderer/createUniformArray.js` (13), `DataSources/Static*Batch.js` (7–9 each), `Scene/PolylineCollection.js` (9) | Broad scan counts internal helper structs + builder structs that haven't been promoted to `class`. The conflicting "0 prototype" scan was counting only `X.prototype = ` reassignment; method-attachment on a constructor's prototype still exists. **Genuine class candidates when touched.** |
| **`Object.defineProperties`** | **~99–107** | **~81–87** | `Scene/AtmosphericConditions.js` (9 facade-leaf blocks), `DataSources/ModelGraphics.js` (~60 props, single largest block), `DataSources/BillboardGraphics.js` (~40+), `DataSources/PolygonGraphics.js`, `DataSources/Entity.js` (2 blocks, ~40 props), `Scene/PostProcessStageLibrary.js` (4), `Scene/TilePathResolver.js` (5), `DataSources/GeoJsonDataSource.js` (2) | **Dominant remaining pre-ES6 pattern.** Many use `createPropertyDescriptor(...)` factories (Graphics classes) — these are *not* trivial 1:1 `get`/`set` conversions. |
| **`Object.defineProperty` (singular)** | ~9 | small utils | `Core/Resource.js`, `Core/Check.js` | Minor. |
| **CommonJS `require` / `module.exports`** | **~0** | 0 | (3 `require` hits are in `Workers/` / `ThirdParty/` — excluded) | Canonical source is ES-modules-only. Clean. |
| **`.apply()` / `.bind()`** | ~29 files | 29 | `Core/wrapFunction.js` (2, with `arguments`), `Scene/MetadataComponentType.js` (4), `Renderer/Context.js` (2), `Scene/GaussianSplatPrimitive.js` (2), `Core/Event.js` (1) | Could become spread/arrow; low value, some intentional. |
| **`arguments` object** | 1 | 1 | `Core/wrapFunction.js` | Convert to rest params on-touch. |
| **`=== undefined` / `typeof === "undefined"`** | ~193 (excl. 98 in excluded `google-earth-dbroot-parser.js`) | ~47 | `Core/Cesium3DTilesTerrain*.js` (4–7 each) | Coexists with `defined()` helper; stylistic inconsistency, not a bug. |
| **`hasOwnProperty` (vs `Object.hasOwn`)** | ~101 | ~82 | scattered | Zero `Object.hasOwn` adoption. |
| **String concat (`" + "`)** | ~10–15% of string-building | tail | KML/GeoJSON/GPX parsers, `Scene/AtmosphericConditions.js` (1) | ~85–90% already template literals. Bulk of remaining concat is in excluded ThirdParty parsers. |
| **`for (var ... in/of)`** | 0 | 0 | — | Clean (1 hit was excluded ThirdParty). |
| **IIFE module wrappers** | 0 | 0 | — | 116 IIFE hits are legitimate closures/init, not module wrappers. |

---

## 3. TypeScript vs JavaScript Balance

**Overall (engine + widgets, excluding `.d.ts`):** ~178 `.ts` vs ~1,673 `.js` → **~9–10% TypeScript**.

**Per-subsystem (`packages/engine/Source/`):**

| Subsystem | .ts | .js | % TS |
|---|---|---|---|
| **Renderer (incl. WebGPU)** | 177 | 74 | **~70%** |
| ↳ Renderer/WebGPU only | ~171 | ~25 | **~87%** |
| Scene | 1 | ~552 | ~0.2% |
| Core | 0 | ~290 | 0% |
| DataSources | 0 | ~108 | 0% |
| Shaders (JS string modules) | 0 | ~590 | 0% |
| Services | 0 | 6 | 0% |

**Where the big JS remainder lives:** Core, Scene, and DataSources (~950 files combined, ~0% TS). These hold nearly all the legacy idioms in §2. The WebGPU renderer is the modern island — all-`.ts`, all-ES2022, ESLint + tsconfig enforced.

**Largest legacy files** (ES6 classes, but `Object.defineProperties` + string-concat heavy): `Scene/Scene.js` (~5,326 LOC), `DataSources/CzmlDataSource.js` (~5,158), `DataSources/KmlDataSource.js` (~4,255), `Scene/Cesium3DTileset.js` (~4,166).

**Interop bridge:** 18 co-located `.d.ts` shims (9 Core math types, 8 Renderer, 1 Scene) let the TS WebGPU code consume untyped JS. `Renderer/WebGPU/cesium-js-types.d.ts` (~1,328 LOC) is the central ambient surface (FrameState, UniformState, DrawCommand, Scene), using opaque branded types for pass-through objects. This layer is well-targeted and minimal — **no drift risk flagged**.

---

## 4. ES2022 Opportunities

**Build target is ES2022-safe to emit:** `packages/engine/tsconfig.json` and root tsconfig both set `"target": "ES2022"` / `"module": "ES2022"`. No polyfill strategy needed. (`allowJs: true`, `checkJs: false`, `strict: false` with `noImplicitAny: true` — incremental adoption posture.)

| ES2022 feature | Current adoption | Opportunity / verdict |
|---|---|---|
| **`#private` fields** | **1** in entire canonical tree; ~4,530 `this._x` convention instead | Highest theoretical value (true encapsulation) but **HIGH RISK** — `scene._context`-style access is part of the de facto public surface of a shipped library; flipping to `#` is a breaking change needing a deprecation plan. **Do NOT mass-convert.** Only adopt in brand-new classes. |
| **Class `get`/`set` (replacing `Object.defineProperties`)** | ~545 classes already use native getters; ~99–107 blocks still on `defineProperties` | **Best opportunistic target.** Convert when the owning file is otherwise edited. Watch out for `createPropertyDescriptor(...)` factory blocks (Graphics classes) — those resist 1:1 conversion. |
| **`Object.hasOwn()`** | 0 (vs ~101 `hasOwnProperty`) | Low-risk on-touch swap. |
| **`String.replaceAll()`** | 0 (vs regex `.replace(/x/g)`) | Cosmetic; a few sites (`demodernizeShader.js`, `ModelUtility.js`). |
| **`Array.prototype.at()`** | 2 (vs many `arr[arr.length-1]`) | Cosmetic. |
| **Logical assignment `??= / \|\|= / &&=`** | ~1 | Cosmetic; nice for fallback init. |
| **`Array.flat()` / `flatMap()`** | 3 | Limited use cases. |
| **`structuredClone()`** | 0 | Custom `clone()` utility in use; not worth changing. |
| **Error `.cause`** | 0 | Error chaining not prevalent. |
| **Top-level await** | 0 | N/A pattern-wise. |

---

## 5. Tooling & Enforcement

**Already enforced (prevents regressions):**

- **ESLint `no-var`: `"error"`** and **`prefer-const`: `"error"`** (via `@cesium/eslint-config/common.js`) — any *new* JS `var` is caught at lint time. (Correctly ignores `var` inside WGSL strings.)
- ESLint bans `@ts-ignore`, requires `@ts-expect-error` descriptions; disallows `new X.fromDegrees()` misuse; disallows `Array.push.apply()` (prefers spread); no use-before-define in classes; TS-ESLint recommended rules on `.ts`.
- `noImplicitAny: true` on `.ts` — catches untyped cross-module boundaries.
- ESLint ignores root `Source/` (build output), `ThirdParty/`, `Workers/`, `Shaders/**` — matches this audit's scope.
- CLAUDE.md project rule: **TypeScript `any` ban** (use `unknown`/unions/generics).

**Gaps (no automated guard):**

- **No rule prevents new `Object.defineProperties` getter/setter blocks** — a new prototype-style accessor pattern would lint clean.
- **No rule prevents attaching methods to `.prototype`** (constructor-function-style class authoring) — only `var` is blocked, not the broader pre-class idiom.
- **No `prefer-object-has-own` / `prefer-string-replace-all`** rules — so `hasOwnProperty` and regex-replace keep accreting.
- **No enforcement nudging `#private`** over `this._` (and given the public-surface risk, that's appropriate — leave it).
- `checkJs: false` — JS type errors are not surfaced unless a file opts in.

---

## 6. Strategy & Priorities

**Reaffirm the incremental rule:** Modernize a file **only when you're already making >10 lines of changes to it.** Never open a file solely to modernize it. This audit is the map of what *would* be modernized on-touch — not a work queue.

### Highest-value OPPORTUNISTIC targets (likely to be edited anyway)

- `Scene/Scene.js`, `Scene/Cesium3DTileset.js` — large, frequently touched; convert their `Object.defineProperties` getters → class `get`/`set` and string-concat → template literals **when next edited**.
- `DataSources/ModelGraphics.js`, `BillboardGraphics.js`, `PolygonGraphics.js`, `Entity.js` — biggest `defineProperties` blocks; convert on-touch, but note the `createPropertyDescriptor` factory blocks are not 1:1.
- `Scene/Expression.js` (42 prototype methods), `Renderer/WebGPU/WGSLShaderBuilder.js` (24), `Renderer/createUniform.js` / `createUniformArray.js` (13 each) — genuine `class` promotion candidates when touched.
- `Core/wrapFunction.js` — `arguments` → rest params, `.apply` → spread (tiny, safe).

### Possibly worth a dedicated, *low-risk* pass (optional)

- A mechanical `hasOwnProperty` → `Object.hasOwn()` sweep (~101 sites, ~82 files) — purely additive, ES2022-safe, easy to review. Only if the user explicitly wants a focused cleanup; otherwise on-touch.

### Do NOT mass-rewrite (risk > value)

- **`this._x` → `#private`** across the codebase — breaking change to the de facto public API of a shipped library; needs deprecation planning. New classes only.
- **WGSL `var` in shader strings** — syntactically required; not JS.
- **`Object.create` chains in `TilePathResolver.js`** — legitimate abstract-base inheritance.
- **Blanket `=== undefined` → `defined()`** — both are accepted in the codebase; not worth churn.
- **Bulk `Object.defineProperties` conversion** outside of files you're already editing — high churn, large review surface, no functional gain.
- **Bulk JS→TS conversion of Core/Scene/DataSources** — strategic, multi-day per subsystem; only undertake `Scene.js`/`FrameState`-class conversion if deeper WebGPU type-narrowing demands it.
