---
name: wasm-strategy
description: WASM rules — JS fallback bridges, feature detection, async loading, arena allocation, toolchain choice, WASM versus GPU compute, threading. Read before any WASM work.
---

# WASM Strategy

Part of the fork's rules: moved here from `CLAUDE.md` (see its "On-demand Skills" section) so it loads only when needed, and it binds exactly as `CLAUDE.md` does.

- Every WASM function MUST have a JS fallback (bridge pattern)
- Feature detection before activation
- Async loading only — never block main thread
- Threshold-gated activation (avoid overhead for small workloads)
- All bridges must have `destroy()`, `free_buffer()`, version check, SIMD detection, and a `getDiagnostics()` reporting readiness, last-operation stats, and whether WASM or the JS fallback ran
- Never load WASM on a hot constructor path — loading is async; load opportunistically and use it when ready
- Use the arena allocator (`alloc_buffer`/`free_buffer`) for shared JS↔WASM memory; never let WASM allocate unbounded
- **Toolchain choice**: Rust (wasm-pack) for new performance-critical code we author, for memory-safety-sensitive index/SIMD work, and for modules that want generated `.d.ts`. Emscripten for wrapping existing C/C++ libraries (Draco, KTX2) or porting established C++ implementations
- **WASM or GPU compute**: WASM SIMD wins at low latency and small-to-mid batch sizes (frustum culling under ~50K, radix sort in the ~5K-50K range); GPU compute wins above that; plain JS wins below the threshold where dispatch overhead dominates. Profile before and after, and report the change with numbers
- **Threading is allowed** but needs `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`. Always ship a single-threaded fallback, detect `SharedArrayBuffer`/`Atomics` at runtime, use `std::sync::Mutex` (never `static mut`) for shared state, and keep the thread count configurable
