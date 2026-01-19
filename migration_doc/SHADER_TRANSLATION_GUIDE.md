# GLSL to WGSL Shader Translation Guide

**Created:** 2025-12-12  
**Phase:** 4.2 - Shader Translation & Management  
**Purpose:** Document patterns for translating Cesium GLSL shaders to WGSL

---

## 🎯 Overview

This guide provides practical patterns for converting GLSL ES 3.0 shaders (used in CesiumJS) to WGSL (WebGPU Shading Language).

---

## 📋 Quick Reference Table

| GLSL ES 3.0 | WGSL | Notes |
|-------------|------|-------|
| `attribute` | `@location(N)` in struct | Vertex inputs |
| `varying` | `@location(N)` in struct | Vertex outputs / Fragment inputs |
| `uniform` | `@group(G) @binding(B)` | Uniforms, textures, samplers |
| `gl_Position` | `@builtin(position)` | Clip-space position |
| `gl_FragColor` | `@location(0)` return | Fragment output |
| `vec2`, `vec3`, `vec4` | `vec2<f32>`, `vec3<f32>`, `vec4<f32>` | Explicit type |
| `mat4` | `mat4x4<f32>` | Matrix types |
| `texture2D(tex, uv)` | `textureSample(tex, sampler, uv)` | Texture sampling |
| `void main()` | `fn vertexMain()` / `fn fragmentMain()` | Entry points |
| `#version 300 es` | *(not needed)* | WGSL doesn't use version |
| `precision mediump float` | *(not needed)* | WGSL has implicit precision |

---

## 🔄 Translation Patterns

### Pattern 1: Simple Vertex Shader

**GLSL ES 3.0:**
```glsl
#version 300 es
precision mediump float;

in vec3 a_position;
in vec4 a_color;

uniform mat4 u_modelViewProjection;

out vec4 v_color;

void main() {
    gl_Position = u_modelViewProjection * vec4(a_position, 1.0);
    v_color = a_color;
}
```

**WGSL:**
```wgsl
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) color: vec4<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
}

struct Uniforms {
    modelViewProjection: mat4x4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = uniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
    output.color = input.color;
    return output;
}
```

### Pattern 2: Simple Fragment Shader

**GLSL ES 3.0:**
```glsl
#version 300 es
precision mediump float;

in vec4 v_color;
out vec4 fragColor;

void main() {
    fragColor = v_color;
}
```

**WGSL:**
```wgsl
struct FragmentInput {
    @location(0) color: vec4<f32>,
}

@fragment
fn fragmentMain(input: FragmentInput) -> @location(0) vec4<f32> {
    return input.color;
}
```

### Pattern 3: Textured Shader

**GLSL ES 3.0:**
```glsl
// Vertex
#version 300 es
in vec3 a_position;
in vec2 a_texCoord;
uniform mat4 u_modelViewProjection;
out vec2 v_texCoord;

void main() {
    gl_Position = u_modelViewProjection * vec4(a_position, 1.0);
    v_texCoord = a_texCoord;
}

// Fragment
#version 300 es
precision mediump float;
in vec2 v_texCoord;
uniform sampler2D u_texture;
out vec4 fragColor;

void main() {
    fragColor = texture(u_texture, v_texCoord);
}
```

**WGSL:**
```wgsl
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) texCoord: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>,
}

struct Uniforms {
    modelViewProjection: mat4x4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var textureSampler: sampler;
@group(0) @binding(2) var colorTexture: texture_2d<f32>;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = uniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
    output.texCoord = input.texCoord;
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    return textureSample(colorTexture, textureSampler, input.texCoord);
}
```

---

## 🔧 Key Differences

### 1. Struct-Based I/O
WGSL uses explicit structs for vertex inputs/outputs instead of individual `in`/`out` variables.

### 2. Binding Model
- GLSL uses `uniform` keyword
- WGSL uses `@group(G) @binding(B)` with explicit binding points

### 3. Texture Sampling
- GLSL: `texture(sampler2D, uv)` - combined sampler/texture
- WGSL: `textureSample(texture, sampler, uv)` - separate sampler and texture

### 4. Type Annotations
- GLSL: Implicit precision (`float`, `vec3`)
- WGSL: Explicit types (`f32`, `vec3<f32>`)

### 5. Entry Points
- GLSL: Always `void main()`
- WGSL: Named functions with `@vertex` or `@fragment` attributes

### 6. Built-ins
- GLSL: `gl_Position`, `gl_FragCoord`, etc.
- WGSL: `@builtin(position)`, `@builtin(frag_coord)`, etc.

---

## 📝 Translation Checklist

When translating a Cesium shader:

- [ ] Remove `#version` and `precision` directives
- [ ] Convert `attribute` → struct with `@location(N)`
- [ ] Convert `varying` → struct with `@location(N)`
- [ ] Convert `uniform` → `@group(G) @binding(B) var<uniform>`
- [ ] Convert `sampler2D` → separate `sampler` and `texture_2d<f32>`
- [ ] Update `texture()` calls → `textureSample()`
- [ ] Change `main()` → `vertexMain()` or `fragmentMain()`
- [ ] Add `@vertex` or `@fragment` attribute
- [ ] Update `gl_Position` → `@builtin(position)`
- [ ] Convert types (`vec3` → `vec3<f32>`, etc.)
- [ ] Test compilation in WebGPU

---

## 🎓 Common Patterns

### Matrix Multiplication
```glsl
// GLSL
gl_Position = u_mvp * vec4(a_position, 1.0);
```
```wgsl
// WGSL
output.position = uniforms.mvp * vec4<f32>(input.position, 1.0);
```

### Texture Lookup
```glsl
// GLSL
vec4 color = texture(u_diffuse, v_texCoord);
```
```wgsl
// WGSL
let color = textureSample(diffuseTexture, diffuseSampler, input.texCoord);
```

### Color Output
```glsl
// GLSL
out vec4 fragColor;
void main() {
    fragColor = vec4(1.0, 0.0, 0.0, 1.0);
}
```
```wgsl
// WGSL
@fragment
fn fragmentMain() -> @location(0) vec4<f32> {
    return vec4<f32>(1.0, 0.0, 0.0, 1.0);
}
```

---

## 🚧 Advanced Patterns (Future)

### Lighting Calculations
Will be documented as we translate more complex shaders.

### Multiple Render Targets
```wgsl
struct FragmentOutput {
    @location(0) color: vec4<f32>,
    @location(1) normal: vec4<f32>,
}
```

### Compute Shaders
```wgsl
@compute @workgroup_size(16, 16, 1)
fn computeMain(@builtin(global_invocation_id) id: vec3<u32>) {
    // Compute shader code
}
```

---

## 📚 Resources

### Official Documentation
- [WGSL Specification](https://www.w3.org/TR/WGSL/)
- [GLSL to WGSL Migration Guide](https://github.com/gpuweb/gpuweb/wiki/GLSL-to-WGSL-Porting-Guide)
- [WebGPU Shading Language](https://google.github.io/tour-of-wgsl/)

### Tools
- [Naga](https://github.com/gfx-rs/naga) - Shader translation tool (Rust)
- [Tint](https://dawn.googlesource.com/dawn/+/refs/heads/main/docs/tint/) - Google's shader compiler
- [WGSL Playground](https://google.github.io/tour-of-wgsl/)

---

## ✅ Shaders Translated (CesiumJS WebGPU)

### Basic Shaders
1. ✅ `BasicColor.wgsl` - Simple colored geometry
2. ✅ `BasicTextured.wgsl` - Textured geometry

### To Be Translated
- [ ] Atmosphere shading
- [ ] Globe rendering
- [ ] 3D Tiles
- [ ] Post-processing effects
- [ ] Shadow mapping
- [ ] Lighting models

---

## 🎯 Best Practices

### 1. Use Structs for Clarity
Group related inputs/outputs into structs instead of individual variables.

### 2. Explicit Types
Always specify types (`f32`, `i32`, `u32`) for clarity and portability.

### 3. Consistent Naming
- `vertexMain` / `fragmentMain` / `computeMain` for entry points
- `input` / `output` for shader I/O structs
- `uniforms` for uniform buffers

### 4. Separate Samplers and Textures
WebGPU separates samplers from textures - this enables sampler reuse.

### 5. Document Binding Points
Always document which binding points are used:
```wgsl
// @group(0) @binding(0) - Uniforms (MVP matrix)
// @group(0) @binding(1) - Sampler
// @group(0) @binding(2) - Texture
```

---

**Last Updated:** 2025-12-12  
**Status:** Initial translation patterns documented  
**Next:** Translate more complex Cesium shaders as needed
