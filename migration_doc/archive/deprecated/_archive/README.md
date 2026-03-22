# Archived PBR Shaders

**Archived:** March 21, 2026

## `ModelPBR.wgsl` (Gen 1 — Superseded)

This was the first PBR model shader, created before the model-space RTE approach was established.

**Why archived:**
- Uses **world-space RTE** (`positionHigh`/`positionLow` — 6 floats per vertex) instead of the correct **model-space RTE** (`positionMC` — 3 floats + camera-in-model-space encoding)
- Uses `ModelUniforms` struct — incompatible with the current `MaterialUniforms` layout
- No `materialFlags` bitfield — always samples all textures unconditionally
- Missing: specular-glossiness, unlit, double-sided, alpha blend modes
- All PBR math functions exist in superior form in `ModelPBRComplete.wgsl` (pre-computed dot products, avoids `pow()`)

**Zero unique functionality** — everything in this file exists in `ModelPBRComplete.wgsl` and `ModelPBRFragment.wgsl` with better implementations.

## Active Shaders (NOT archived)

- `ModelPBRComplete.wgsl` — Combined vertex+fragment, used by `WebGPUModelPipelineCache.js`
- `ModelPBRVertex.wgsl` + `ModelPBRFragment.wgsl` — Split vertex/fragment approach, preserved for future skinning work (separate vertex shader variants, shared fragment shader)
