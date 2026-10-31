---
name: engine-code-standards
description: Engine code rules — architecture patterns, RTE precision, file placement, file size, tech stack, ES6, comments and JSDoc. Read before any change under packages/.
---

# Engine Code Standards

Part of the fork's rules: moved here from `CLAUDE.md` (see its "On-demand Skills" section) so it loads only when needed, and it binds exactly as `CLAUDE.md` does.

## Architecture Patterns

### Feature Renderer Pattern (Phase D)

Scene files access WebGPU renderers via `context.getFeatureRenderer('name')` instead of importing from `Renderer/WebGPU/`:

```javascript
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
const fr = context.getFeatureRenderer(FeatureRendererKey.FOO);
if (fr) {
  fr.update(this, frameState);
  return;
}
// WebGL code follows as the default fallback
```

All registrations are centralized in `Renderer/WebGPU/WebGPUFeatureRenderers.ts`, called during `WebGPUContext._initialize()`. Adding a feature renderer takes three steps: add the key to `Renderer/FeatureRendererKey.js`, increment its `COUNT` (54 at HEAD), and register the renderer in `WebGPUFeatureRenderers.ts`.

### Scene Logic Extractor Pattern — CRITICAL for Collections

Shared scene-level logic MUST run BEFORE the `if (context.isWebGPU)` branch point.

What belongs **before** the branch (shared): entity cleanup, the `show` early-out, 2D/Columbus-View mode handling, load-error handling, texture-atlas scheduling via `frameState.afterRender`, and ready-state tracking. What belongs **after** it (backend-specific): GPU buffer creation and update, pipeline/shader-program creation, draw-command emission, and backend capability checks.

### Query Capabilities Through the Context

`GraphicsContext` is the single source of truth for shared context capabilities. Scene code queries them through the context (`uniformState`, `cache`, `stencilBuffer`, `msaa`, `colorBufferFloat`, `defaultTexture`, `instancedArrays`, `createPickId()`) and never through backend-specific APIs. Read the current surface from the class, not from a transcribed list.

### Enumerated Keys Over String Lookups

- **NEVER** use string literals for registry/table lookups when a finite set of keys is known
- **ALWAYS** use `FeatureRendererKey` enum constants for O(1) direct array access — enum values are integers and `GraphicsContext` indexes a pre-allocated array with them, so there is no hash computation
- This applies beyond feature renderers: prefer frozen numeric enums over string-keyed Maps or objects whenever the key set is fixed at compile time

### RenderCommand (Backend-Agnostic commandList)

`RenderCommand.js` provides a backend-agnostic command abstraction. New scene features SHOULD use `RenderCommand` instead of importing backend-specific commands directly (ruling D5). Adoption is **not yet complete** and is a queued epic: `buildRenderCommand` must be implemented on both backends (today the abstract base throws), `RenderCommand` must be added to `WEBGPU_COMPAT_EXEMPTIONS` (it lives under `Renderer/WebGPU/`, so the first real Scene consumer would otherwise break the webgl-only variant), and one migrated feature must ship as proof.

---

## 64-Bit Precision & RTE (Relative-To-Eye) — CRITICAL

ALL rendering paths MUST use RTE emulated 64-bit precision:

- **NEVER** use a single `position: vec3<f32>` in vertex buffers — always use `positionHigh` + `positionLow`
- **NEVER** multiply `mvp * vec4(position, 1.0)` — always use `mvpRelativeToEye * translateRelativeToEye(...)`
- **NEVER** add `posHigh + posLow` directly — always subtract camera first
- Uniform buffers must carry `encodedCameraHigh`, `encodedCameraLow`, and `mvpRelativeToEye`
- `UniformState.js` already computes every RTE value — reuse them, do not recompute
- `EncodedCartesian3.js` is renderer-agnostic — use it on both the WebGL and WebGPU paths
- Every renderer's `CameraUniforms` struct MUST carry `previousViewProjection: mat4x4<f32>` at the tail (DP-H41, Batch 27). JS pack writes `UniformState.previousViewProjection` with column-major identity fallback on the first frame. TAA / CSM / motion-vector passes read it via `camera.previousViewProjection`. Shaders that still declare it mid-struct are brought to the rule by the AR-D12 enforcement lane (ruling D4).

---

## Monorepo Architecture — File Placement Rules

CesiumJS uses npm workspaces monorepo. Root `Source/` is a **build output**, NOT the source of truth.

| Content Type | Canonical Location (edit HERE)           | Build Output (DO NOT edit) |
| ------------ | ---------------------------------------- | -------------------------- |
| Engine code  | `packages/engine/Source/`                | `Source/`                  |
| WGSL shaders | `packages/engine/Source/Shaders/WebGPU/` | `Source/Shaders/WebGPU/`   |
| GLSL shaders | `packages/engine/Source/Shaders/`        | `Source/Shaders/`          |
| Widget code  | `packages/widgets/Source/`               | `Source/Widgets/`          |
| Assets       | `packages/engine/Source/Assets/`         | `Source/Assets/`           |
| ThirdParty   | `packages/engine/Source/ThirdParty/`     | `Source/ThirdParty/`       |

- **ALWAYS** create new files in `packages/engine/Source/`
- **NEVER** create or edit files directly in root `Source/` — they are overwritten or orphaned
- Root `Source/Cesium.js` is a generated barrel shim; the other root `Source/` folders are gitignored build output (`copyEngineAssets()` in `scripts/build.js`)
- A WGSL file in root `Source/Shaders/WebGPU/` but not in `packages/engine/Source/Shaders/WebGPU/` was created in the wrong place — move it to the canonical location

---

## File Size & Code Organization

- **Files over ~1000 lines SHOULD be decomposed** into smaller focused modules
- Extract helper functions into `*Helpers.js` or domain-specific companion files
- Each decomposed file should be **under 1000 lines** with a **clear single responsibility**
- The **main class stays in the original file under its original name** — companion files are imported by it
- **Do NOT decompose** performance-critical math classes or pure data/enum definitions
- When touching a file over 1000 lines for functional changes, decompose it too — leave it better than you found it
- Record decompositions in `migration_doc/ES6_MODERNIZATION_STATUS.md` (the live tracker; `ES6_MODERNIZATION_BACKLOG.md` is archived at `migration_doc/archive/ES6_MODERNIZATION_BACKLOG.md`)

---

## Preferred Tech Stack

- **WebGPU**: Prefer WebGPU over WebGL for new rendering features
- **WebAssembly**: Use for performance-critical code paths (terrain, matrix ops, culling)
- **TypeScript**: Prefer TS over JS for new code
- **TypeScript `any` ban**: NEVER use `any` as a variable, parameter, or return type. Use `unknown`, specific interfaces, union types, or generics instead. This applies to `.ts` files AND `.d.ts` ambient declarations. The only exception is third-party library interop where the upstream type is genuinely `any`.
- **Co-located `.d.ts` for JS interop**: for an untyped JS class, write `ClassName.d.ts` next to `ClassName.js`; with `allowJs: true, checkJs: false` a sibling `.d.ts` **overrides** JS inference for imports (templates: `Renderer/{Context,Texture,CubeMap}.d.ts`). For a class matching an ambient interface, use declaration merging: `declare class X {} interface X extends AmbientShape {}`.
- **`@private` JSDoc ≠ TS `private`**: if a JS method is called cross-module, declare it `public` in a co-located `.d.ts` or change the JSDoc tag to `@internal`.
- **Never trim WIP-module interfaces during cast cleanup**: Some `CesiumGraphicsContext`-adjacent interfaces (e.g., `PerformanceManagerContext`) carry forward-looking method slots that aren't yet implemented on the real classes; the construction-site cast bridges the gap intentionally. Don't delete interface methods just because grep shows no callers — verify the owning module is fully implemented first.
- **RxJS**: Prefer for reactive patterns and async operations over async/await, in production code and test pages alike. Reach for async/await only when performance requires it and that has been measured
- **Service Workers**: usable for asset caching / offline capability and background processing of large datasets — only where the benefit is significant and measured
- **Slang (optional)**: new WebGPU shaders may be authored in `.slang` and compiled to WGSL (`scripts/SLANG_GUIDE.md`). Prefer it for shaders that also need a GLSL twin and for prototyping; do NOT use it for performance-critical shaders needing WebGPU-specific tuning, for preprocessor chunk files, or to rewrite existing hand-written WGSL.

---

## ES6+ Modernization — Incremental Upgrade Rule

When making >10 lines of changes to a file, modernize pre-ES6 patterns:

- `var` → `const`/`let`
- Prototype-based inheritance → ES6 `class`
- `Object.defineProperties()` → ES6 `get`/`set`
- String concatenation → template literals
- `require()` / `module.exports` → ES module `import`/`export`
- `arguments` → rest parameters; `apply`/`call` spreading → spread syntax
- `typeof x !== "undefined"` → optional chaining or nullish coalescing
- `.indexOf(x) !== -1` → `.includes(x)`; `obj.hasOwnProperty(k)` → `Object.hasOwn(obj, k)`
- **NEVER** modernize a file you're not otherwise touching
- Prototype-to-class conversions follow upstream [#8359](https://github.com/CesiumGS/cesium/issues/8359) patterns and must preserve every existing test
- Be cautious converting performance-critical math classes (`Cartesian3`, `Matrix4`, `Quaternion`) — they use result parameters and scratch variables where ES6 patterns can add overhead; benchmark before and after
- `.ts` files are already ES2022+; this rule is aimed at `.js`

---

## Comment & JSDoc Rules

- **Preserve ALL existing JSDoc comments** when modernizing files
- **Do NOT add new JSDoc** that didn't exist in the original
- **Do NOT add boilerplate** restating what code obviously does
- **DO add comments** explaining non-obvious WHY — rationale, edge cases, performance notes
- Match the surrounding file's comment density
- Converting a constructor or prototype to a class: drop `@constructor` and `@memberof Foo.prototype` (both implicit in a class body), move `@param` tags from the function-level JSDoc onto `constructor()`, and keep `@alias ClassName` on the class-level JSDoc — the documentation tooling depends on it
- Do not add `@param` annotations to a constructor unless the original function-level JSDoc had them
- **Fork comment standard (seamless with upstream).** Comments under `packages/engine/Source` and `packages/widgets/Source` — code, WGSL, GLSL and shipped assets — describe what the code does and the constraints it obeys, never the work that produced it: no batch numbers, campaign or tracker IDs, row IDs or dates (that history belongs in commit messages and `migration_doc/**`). The test is that someone diffing a fork file against upstream cannot tell which comments are ours by their voice. Comments stay JSDoc-clean for `npm run build-docs`, and derived code is attributed. Full rules, and how `Tools/c16/comment-marker-guard.mjs` and its clean list enforce them: [`Documentation/Contributors/CodingGuide/ForkCommentStandard.md`](../../../Documentation/Contributors/CodingGuide/ForkCommentStandard.md).
