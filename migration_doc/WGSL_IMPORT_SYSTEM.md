# WGSL Shader Import System

**Date:** February 7, 2026  
**Status:** Implemented  
**Related:** ShaderSource.js (GLSL), WebGPUShaderCache.ts, WGSLShaderPreprocessor.ts

---

## Overview

WebGPU's WGSL shading language **does not natively support `#import` or `#include` statements** — this is a deliberate design choice in the specification. This creates a significant challenge for modular shader development, as all shader code must be contained in a single string passed to `device.createShaderModule()`.

This document describes CesiumJS's solution: a **compile-time WGSL preprocessor and module system** that provides import functionality similar to Three.js's TSL (Three Shader Language) node system, but tailored to CesiumJS's existing architecture.

## Design Decisions

### Why Not Use Existing Solutions?

| Solution | Why Not |
|---|---|
| **naga_oil** | Rust-based, requires build tooling, not suitable for runtime use |
| **Vite/Webpack plugins** | Build-time only, doesn't support runtime shader composition |
| **Three.js TSL** | Node-based system tightly coupled to Three.js, not portable |
| **Raw string concatenation** | No dependency management, no deduplication, error-prone |

### Our Approach: Hybrid Preprocessor

We chose a **hybrid approach** that combines:

1. **Explicit `#import` directives** — for intentional, clear dependencies
2. **Automatic `csm_*` prefix resolution** — mirrors CesiumJS's existing `czm_*` pattern for GLSL
3. **Topological dependency sorting** — same algorithm as `ShaderSource.js`
4. **`#ifdef`/`#ifndef` conditional compilation** — for shader variants

This provides the best of both worlds: explicit control when you want it, automatic resolution when you don't.

## Architecture

```
┌─────────────────────────────────┐
│     Your Shader Code (.wgsl)     │
│  // #import "structs/Camera"     │
│  // #import "functions/csm_phong"│
│  ... uses csm_reinhardTonemap ...│
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│    WGSLShaderPreprocessor        │
│  1. Parse #import directives     │
│  2. Auto-detect csm_* refs      │
│  3. Resolve from library         │
│  4. Build dependency graph       │
│  5. Topological sort             │
│  6. Process #ifdef conditionals  │
│  7. Deduplicate & concatenate    │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│    Final WGSL Code               │
│  (All imports resolved,          │
│   ready for createShaderModule)  │
└─────────────────────────────────┘
```

## File Structure

```
packages/engine/Source/Renderer/WebGPU/
├── WGSLShaderPreprocessor.ts   # Core preprocessor + WGSLShaderLibrary class
├── WGSLBuiltins.ts             # Default chunk registry (like CzmBuiltins.js)
├── WebGPUShaderCache.ts         # Updated with getPreprocessedShader()
└── WebGPUShaderModule.ts        # Existing shader module wrapper

Source/Shaders/WebGPU/
├── chunks/                      # Reusable WGSL shader chunks
│   ├── structs/
│   │   ├── CameraUniforms.wgsl
│   │   ├── ModelUniforms.wgsl
│   │   ├── LightUniforms.wgsl
│   │   ├── LightingUniforms.wgsl
│   │   └── PBRMaterial.wgsl
│   └── functions/
│       ├── csm_constants.wgsl
│       ├── csm_distributionGGX.wgsl
│       ├── csm_geometrySmith.wgsl
│       ├── csm_fresnelSchlick.wgsl
│       ├── csm_phong.wgsl
│       ├── csm_tonemapping.wgsl
│       ├── csm_gammaCorrection.wgsl
│       └── csm_getNormalFromMap.wgsl
├── BasicColor.wgsl              # Existing standalone shaders
├── PhongLighting.wgsl
├── PBRMetallicRoughness.wgsl
└── ...
```

## Usage

### 1. Explicit Imports

Use `// #import "path"` syntax. The `//` prefix keeps it as a valid WGSL comment, so IDE extensions and raw parsers won't break:

```wgsl
// #import "structs/CameraUniforms"
// #import "structs/ModelUniforms"
// #import "functions/csm_phong"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var<uniform> model: ModelUniforms;

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let N = normalize(input.normal);
    let V = normalize(camera.cameraPosition - input.worldPosition);
    let L = normalize(vec3<f32>(0.5, 1.0, 0.5));
    let color = csm_phongSimple(N, V, L, vec3<f32>(0.6, 0.8, 1.0), 32.0);
    return vec4<f32>(color, 1.0);
}
```

### 2. Automatic Resolution (csm_* prefix)

Just reference a `csm_` prefixed function, constant, or struct — the preprocessor will automatically find and include the correct chunk:

```wgsl
// No explicit imports needed! csm_* references are auto-resolved.
@fragment
fn fragmentMain() -> @location(0) vec4<f32> {
    let hdrColor = vec3<f32>(2.0, 1.5, 0.8);
    let toneMapped = csm_reinhardTonemap(hdrColor);
    let srgb = csm_linearToSrgb(toneMapped);
    return vec4<f32>(srgb, 1.0);
}
```

### 3. Conditional Compilation

```wgsl
// #ifdef USE_NORMAL_MAP
    let N = csm_getNormalFromMap(normalSample, material.normalScale, input.normal, input.tangent, input.bitangent);
// #else
    let N = normalize(input.normal);
// #endif
```

### 4. TypeScript API

```typescript
import { WGSLShaderPreprocessor, WGSLShaderLibrary } from './WGSLShaderPreprocessor';
import { createDefaultWGSLLibrary } from './WGSLBuiltins';

// Create library with all built-in chunks
const library = createDefaultWGSLLibrary();

// Optionally register custom chunks
library.registerCode('myApp/fog', `
fn csm_applyFog(color: vec3<f32>, distance: f32, fogColor: vec3<f32>) -> vec3<f32> {
    let fogFactor = exp(-distance * 0.01);
    return mix(fogColor, color, fogFactor);
}
`);

// Create preprocessor
const preprocessor = new WGSLShaderPreprocessor(library);

// Process a shader
const result = preprocessor.process(myShaderCode, {
    defines: ['USE_NORMAL_MAP', 'MAX_LIGHTS 4'],
    label: 'MyCustomShader',
});

// result.code - final WGSL ready for createShaderModule()
// result.includedChunks - list of chunks that were included
// result.dependencyOrder - topological order of dependencies

const module = device.createShaderModule({ code: result.code });
```

### 5. Via WebGPUShaderCache (Recommended)

```typescript
const cache = new WebGPUShaderCache(device);

// Preprocessed + compiled + cached in one call
const module = await cache.getPreprocessedShader('MyShader', shaderCode, {
    defines: ['USE_PHONG'],
});

// Or just preprocess without compiling
const resolvedWGSL = cache.preprocessOnly(shaderCode, { defines: ['USE_PBR'] });
```

## Naming Conventions

### Functions: `csm_` prefix (Cesium Shader Module)

| Name | Description |
|---|---|
| `csm_phong()` | Full Blinn-Phong lighting |
| `csm_phongSimple()` | Simplified Phong with defaults |
| `csm_distributionGGX()` | GGX normal distribution (PBR) |
| `csm_geometrySmith()` | Smith geometry occlusion (PBR) |
| `csm_fresnelSchlick()` | Schlick Fresnel approximation (PBR) |
| `csm_reinhardTonemap()` | Reinhard tone mapping |
| `csm_acesTonemap()` | ACES filmic tone mapping |
| `csm_linearToSrgb()` | Linear to sRGB conversion |
| `csm_srgbToLinear()` | sRGB to linear conversion |
| `csm_getNormalFromMap()` | Normal map sampling with TBN |

### Constants: `CSM_` prefix

| Name | Value |
|---|---|
| `CSM_PI` | 3.14159265359 |
| `CSM_TWO_PI` | 6.28318530718 |
| `CSM_HALF_PI` | 1.57079632679 |
| `CSM_EPSILON1` through `CSM_EPSILON7` | 0.1 through 0.0000001 |

### Structs: PascalCase

| Name | Description |
|---|---|
| `CameraUniforms` | View/projection matrices + camera position |
| `ModelUniforms` | Model + normal matrices |
| `LightUniforms` | Directional light + Phong material properties |
| `LightingUniforms` | Light properties for PBR |
| `PBRMaterial` | glTF 2.0 metallic-roughness parameters |
| `CsmPhongResult` | Phong lighting output (ambient/diffuse/specular/combined) |

## How It Works (Technical Details)

### Dependency Resolution Algorithm

The preprocessor uses the same topological sort algorithm as CesiumJS's GLSL `ShaderSource.js`:

1. **Parse** explicit `#import` directives from the source
2. **Scan** for `csm_*` identifiers in the source code (after stripping comments)
3. **Look up** each identifier in the library's auto-resolve index
4. **Build** a dependency graph: each chunk may have its own imports and `csm_*` references
5. **Recursively resolve** all transitive dependencies
6. **Topological sort** using Kahn's algorithm (nodes with no dependencies come first)
7. **Detect** circular dependencies (throws clear error message)
8. **Concatenate** resolved chunks in dependency order, then append the main source

### Deduplication

Each chunk is included exactly once, even if referenced by multiple imports. The topological sort ensures correct declaration order.

### Conditional Compilation

Supports `#ifdef`, `#ifndef`, `#else`, `#endif` with both bare and comment-prefixed syntax:

```wgsl
#ifdef FEATURE        // bare syntax
// #ifdef FEATURE     // comment-prefixed syntax (valid WGSL)
```

Both forms are processed identically by the preprocessor.

## Comparison with Cesium's GLSL System

| Feature | GLSL (ShaderSource.js) | WGSL (WGSLShaderPreprocessor) |
|---|---|---|
| Auto-resolve prefix | `czm_` | `csm_` |
| Import syntax | Auto-only (no explicit import) | Both explicit `#import` and auto |
| Conditional compilation | Via `#define` in ShaderSource | Via `#ifdef`/`#ifndef` |
| Dependency algorithm | Topological sort | Topological sort (same) |
| Registry | `CzmBuiltins.js` | `WGSLBuiltins.ts` |
| Struct auto-resolve | No | Yes (PascalCase struct names) |
| Chunk location | `Shaders/Builtin/` | `Shaders/WebGPU/chunks/` |

## Test Page

Open `Apps/WebGPUTest/wgsl-import-test.html` to run the full test suite:
- Library registration and identifier indexing
- Explicit import parsing and resolution
- Automatic `csm_*` dependency resolution
- Transitive dependency resolution
- Conditional compilation (`#ifdef`/`#else`)
- Deduplication
- WebGPU shader compilation with imports
- Comment stripping

---

**Next Steps:**
- Refactor existing WGSL shaders (PhongLighting.wgsl, PBR.wgsl) to use `#import`
- Add more built-in chunks as needed (fog, shadow, atmosphere)
- Consider build-time optimization to pre-resolve imports for production builds
