# Slang Shader Cross-Compilation Guide

## Overview

CesiumJS WebGPU supports [Slang](https://github.com/shader-slang/slang) as an optional shader cross-compilation pipeline. Slang shaders (`.slang` files) can be compiled to WGSL for the WebGPU renderer.

**Slang is optional.** The project works without it — pre-compiled `.wgsl` files are provided in `packages/engine/Source/Shaders/WebGPU/Generated/`. You only need Slang installed if you're editing `.slang` source files.

## Why Slang?

| Benefit            | Description                                                         |
| ------------------ | ------------------------------------------------------------------- |
| **Single source**  | Write shader once in Slang, compile to WGSL (and optionally GLSL)   |
| **Quality output** | Slang produces clean, optimized WGSL — not transpiled spaghetti     |
| **C-like syntax**  | Familiar HLSL-like syntax, easier to read than raw WGSL             |
| **Type safety**    | Slang has stronger typing than WGSL, catches errors at compile time |
| **Future-proof**   | Can target Metal, SPIRV, HLSL if needed                             |

## Installation

### 1. Download Slang Compiler

Download `slangc` from: https://github.com/shader-slang/slang/releases

- **Windows:** Download `slang-X.Y.Z-windows-x86_64.zip`, extract, add to PATH
- **macOS:** Download `slang-X.Y.Z-macos-aarch64.zip` (or x86_64)
- **Linux:** Download `slang-X.Y.Z-linux-x86_64.tar.gz`

### 2. Verify Installation

```bash
slangc --version
# Expected: slang 2024.x.y (or newer)
```

### 3. Set Path (Alternative)

If `slangc` isn't in your PATH, set the `SLANG_PATH` environment variable:

```bash
# Windows
set SLANG_PATH=C:\path\to\slangc.exe

# macOS/Linux
export SLANG_PATH=/path/to/slangc
```

## Project Structure

```text
packages/engine/Source/Shaders/
├── Slang/                          ← Slang source files (write here)
│   └── EllipsoidPrimitive.slang    ← Example: ray-marched ellipsoid
├── WebGPU/
│   ├── Generated/                  ← Auto-generated .wgsl from Slang
│   │   └── EllipsoidPrimitive.wgsl ← Compiled output (or hand-written reference)
│   ├── Primitive/                  ← Hand-written WGSL (not from Slang)
│   ├── Collections/                ← Hand-written WGSL
│   └── chunks/                     ← WGSL utility chunks
└── (GLSL files)                    ← Existing WebGL shaders
```

## Usage

### Compile All Slang Shaders (WGSL + GLSL)

```bash
node scripts/compileSlang.js
```

### WGSL Only

```bash
node scripts/compileSlang.js --targets wgsl
```

### GLSL Only

```bash
node scripts/compileSlang.js --targets glsl
```

### Watch Mode (Auto-Recompile on Save)

```bash
node scripts/compileSlang.js --watch
```

### Verbose Output

```bash
node scripts/compileSlang.js --verbose
```

### Dry Run (Show What Would Compile)

```bash
node scripts/compileSlang.js --dry-run
```

### Custom Paths

```bash
node scripts/compileSlang.js --input my/shaders --wgsl-out my/wgsl --glsl-out my/glsl --slangc /path/to/slangc
```

## Writing CesiumJS Slang Shaders

### CesiumJS Conventions

1. **RTE Precision:** Always use `positionHigh` + `positionLow` for world-space geometry
2. **Uniforms:** Use `csm_` prefix for CesiumJS-specific functions
3. **Bind Groups:**
   - Group 0: Per-frame uniforms (camera, projection)
   - Group 1: Per-material uniforms (color, texture params)
   - Group 2: Per-object uniforms (model matrix, pick ID)
4. **Entry Points:** Use `vertexMain` and `fragmentMain` as entry point names

### Slang → WGSL Mapping

| Slang (HLSL-like)       | WGSL Equivalent         |
| ----------------------- | ----------------------- |
| `float3`                | `vec3<f32>`             |
| `float4x4`              | `mat4x4<f32>`           |
| `ConstantBuffer<T>`     | `var<uniform>`          |
| `[[vk::binding(B, G)]]` | `@group(G) @binding(B)` |
| `SV_Position`           | `@builtin(position)`    |
| `SV_Target0`            | `@location(0)`          |
| `[shader("vertex")]`    | `@vertex`               |
| `[shader("fragment")]`  | `@fragment`             |
| `mul(m, v)`             | `m * v`                 |
| `discard`               | `discard`               |

### Example: Minimal Slang Shader

```slang
struct Uniforms {
    float4x4 mvpRTE;
    float3 cameraHigh;
    float _pad0;
    float3 cameraLow;
    float _pad1;
};

[[vk::binding(0, 0)]] ConstantBuffer<Uniforms> u;

struct VertexInput {
    [[vk::location(0)]] float3 positionHigh : POSITION0;
    [[vk::location(1)]] float3 positionLow  : POSITION1;
};

struct VertexOutput {
    float4 position : SV_Position;
};

float3 csm_translateRelativeToEye(float3 pH, float3 pL, float3 cH, float3 cL) {
    return (pH - cH) + (pL - cL);
}

[shader("vertex")]
VertexOutput vertexMain(VertexInput input) {
    VertexOutput output;
    float3 posRTE = csm_translateRelativeToEye(
        input.positionHigh, input.positionLow,
        u.cameraHigh, u.cameraLow
    );
    output.position = mul(u.mvpRTE, float4(posRTE, 1.0));
    return output;
}

[shader("fragment")]
float4 fragmentMain() : SV_Target0 {
    return float4(1.0, 0.0, 0.0, 1.0); // Red
}
```

## When to Use Slang vs Hand-Written WGSL

| Use Case                                                       | Recommendation                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------ |
| New feature shader that might also need GLSL                   | ✅ **Slang** — write once, compile to both                   |
| Performance-critical shader with WebGPU-specific optimizations | ❌ **Hand-written WGSL** — full control                      |
| Utility function / chunk                                       | ❌ **Hand-written WGSL** — chunks use `#import` preprocessor |
| Quick prototype                                                | ✅ **Slang** — C-like syntax is faster to write              |
| Existing WGSL shader                                           | ❌ Don't rewrite — leave as-is                               |

## Output Quality

Slang produces **clean, performant WGSL** output. Key characteristics:

- **No unnecessary temporaries** — Slang optimizes intermediate values
- **Correct padding** — Struct layouts match WebGPU alignment requirements
- **Native WGSL features** — Uses `@group`, `@binding`, `@builtin` correctly
- **Readable output** — Variable names preserved, comments stripped

The generated WGSL is comparable in quality to hand-written WGSL. There is no
measurable performance difference between Slang-compiled and hand-written shaders.

## Troubleshooting

### "slangc not found"

Install Slang or set `SLANG_PATH`. The build gracefully skips Slang compilation
when the compiler isn't available — pre-compiled `.wgsl` files are used instead.

### Compilation Errors

Slang error messages reference the `.slang` source with line numbers:

```text
EllipsoidPrimitive.slang(42): error 30019: expected ';' after variable declaration
```

### Struct Alignment

WebGPU requires 16-byte alignment for uniform struct members. Add `_pad` fields:

```slang
struct Bad {
    float3 position;  // ✗ Next field won't align
    float4 color;     // ✗ Starts at byte 12, needs byte 16
};

struct Good {
    float3 position;
    float _pad0;      // ✓ Explicit padding
    float4 color;     // ✓ Starts at byte 16
};
```
