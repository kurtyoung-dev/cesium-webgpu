# cesium-wasm-culling

WASM SIMD spatial acceleration for CesiumJS rendering pipeline.

## What This Does

Provides high-performance implementations of two rendering hot paths:

1. **Batch Frustum Culling** — Tests thousands of bounding spheres against 6 frustum planes using WASM SIMD (`f32x4`). ~10x faster than equivalent JavaScript.

2. **Radix Sort** — O(N) sort on packed 64-bit sort keys (layer + priority + material + distance). ~7x faster than JavaScript's Timsort for >5K commands.

## Architecture

```text
JS (SOABoundingSphereLayout.js)          WASM (this crate)
┌─────────────────────────┐              ┌──────────────────────┐
│ Float32Array centerX[]  │──pointer──→  │ frustum_cull_batch() │
│ Float32Array centerY[]  │              │   f32x4 SIMD         │
│ Float32Array centerZ[]  │              │   4 spheres/cycle    │
│ Float32Array radius[]   │              │   6 plane tests      │
│ Float32Array planes[24] │              │                      │
│ Uint8Array visibility[] │←─result───   │ → visibility[i]=0|1  │
└─────────────────────────┘              └──────────────────────┘
```

## Building

### Prerequisites

- [Rust](https://rustup.rs/) (stable channel)
- [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/)

### Build Commands

```bash
# Build optimized WASM (output in pkg/)
cd packages/wasm-culling
wasm-pack build --target web --release

# The output files:
# pkg/cesium_wasm_culling_bg.wasm  — The WASM binary (~15-25KB)
# pkg/cesium_wasm_culling.js       — JS bindings (auto-generated)
# pkg/cesium_wasm_culling.d.ts     — TypeScript declarations
```

### Copy to CesiumJS

```bash
# Copy pre-compiled WASM to the engine's ThirdParty directory
cp pkg/cesium_wasm_culling_bg.wasm ../../packages/engine/Source/ThirdParty/Workers/
```

## API

### `frustum_cull_batch(cx, cy, cz, radii, planes, visibility, count) → visible_count`

Tests `count` bounding spheres against 6 frustum planes.

- Input: SOA float32 arrays (center x/y/z, radii), 24-float plane array
- Output: u8 visibility array (0=culled, 1=visible)
- Returns: number of visible spheres

### `radix_sort_keys(indices, keys_high, keys_low, count, temp)`

O(N) radix sort on packed 64-bit keys.

- Input: u32 index array, two u32 key arrays (high/low words)
- Output: indices sorted in-place by key value
- Requires: temp u32 scratch array of `count` elements

### `pack_sort_key(layer, priority, material, distance, back_to_front, out_high, out_low)`

Packs sort key components into two 32-bit words.

### `alloc_buffer(size_bytes) → pointer`

Allocates shared memory in WASM linear memory.

### `version() → u32`

Returns module version for compatibility checks.

### `has_simd() → bool`

Returns whether SIMD is enabled in this build.

## Performance

| Operation                | JS (baseline) | WASM SIMD | Speedup |
| ------------------------ | ------------- | --------- | ------- |
| Frustum cull 10K spheres | ~3ms          | ~0.3ms    | ~10x    |
| Radix sort 10K keys      | ~2ms          | ~0.3ms    | ~7x     |
| Frustum cull 1K spheres  | ~0.3ms        | ~0.03ms   | ~10x    |

## Integration with CesiumJS

The WASM module is loaded by `WasmCullBridge.js` and `WasmSortBridge.js`:

```javascript
// WasmCullBridge detects and loads the WASM module
const bridge = scene.renderScheduler.wasmCullBridge;
if (bridge.isAvailable) {
  // WASM path: ~10x faster
  const visibleIndices = bridge.cullCommands(cullingVolume, commands);
} else {
  // JS fallback: works everywhere
  const visibleIndices = bridge.cullCommands(cullingVolume, commands);
}
```

## License

Apache-2.0 (same as CesiumJS)
