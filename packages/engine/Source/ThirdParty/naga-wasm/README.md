# naga-wasm (vendored)

WASM build of [`gfx-rs/naga`](https://github.com/gfx-rs/wgpu/tree/trunk/naga)
for runtime GLSL / SPIR-V → WGSL translation inside the CesiumJS WebGPU
backend.

## Files

| File                | Purpose                                                        |
| ------------------- | -------------------------------------------------------------- |
| `naga_wasm.js`      | wasm-bindgen JS glue. Exports `default` (init) + translators. |
| `naga_wasm_bg.wasm` | Compiled naga WASM blob (~1.26 MB raw / ~415 KB gzipped).     |
| `naga_wasm.d.ts`    | TypeScript declarations for all exported functions.           |
| `LICENSE-MIT`       | MIT half of naga's dual license.                              |
| `LICENSE-APACHE`    | Apache-2.0 half of naga's dual license.                       |

## Source

This WASM is produced from `packages/wasm-naga/` in this repository, which is
a thin `wasm-bindgen` wrapper around the upstream `naga` crate. To rebuild:

```bash
cd packages/wasm-naga
wasm-pack build --target web --release --features runtime
# Runtime artifacts land in pkg/ — copy them into this directory and rename
# cesium_naga_wasm.* → naga_wasm.*
```

## Exports

```typescript
// GLSL → WGSL; stage is "vertex" | "fragment" | "compute"
export function glsl_to_wgsl(source: string, stage: string): string;

// SPIR-V bytes → WGSL; entry point metadata comes from the SPIR-V module
export function spirv_to_wgsl(bytes: Uint8Array): string;

// Validate + parse WGSL; returns a JSON blob describing entry points + bindings
export function validate_wgsl(source: string): string;

// WGSL → WGSL roundtrip; light minifier + validator
export function normalize_wgsl(source: string): string;
```

Errors throw a real `Error` with a human-readable `.message`.

## License

Naga is dual-licensed under MIT OR Apache-2.0 (see `LICENSE-MIT` and
`LICENSE-APACHE`). CesiumJS is Apache-2.0 — the Apache-2.0 half of naga's
license matches ours exactly.

Copyright holder for the upstream naga source is "The gfx-rs developers"
(per LICENSE-MIT).

## Consumer

`Source/Renderer/WebGPU/WebGPUNagaTranspiler.ts` lazy-loads this module
the first time the WebGL compatibility stub sees a `gl.compileShader()`
call against a GLSL string. Browsers that never hit that path never
download this WASM.
