// Post-process resolve of the source-agnostic
// per-fragment feature-ID G-buffer.
//
// The WebGPU pick pass (WebGPUSceneRendererPickPass) rasterizes a 32-bit object
// or feature ID for EVERY source (globe, 3D-tile, model, voxel, Gaussian-splat)
// into one shared rgba8 target. The target is therefore a source-agnostic,
// per-fragment feature-ID texture.
//
// This fullscreen post-process pass `textureLoad`s the ID at each fragment
// (nearest — IDs must never be filtered), decodes the 32-bit key with the SAME
// little-endian byte order the CPU pick
// decode uses (r | g<<8 | b<<16 | a<<24, matching Color.fromRgba /
// bytesToRgba), and
// recolors each distinct feature with a deterministic integer hash. Fragments
// with id 0 (nothing drawn) stay black. A cross-source scene paints each
// source's covered pixels a distinct, ID-derived colour entirely on the GPU.
// Default-OFF: nothing dispatches this unless an app/probe calls
// WebGPUPickFramebuffer.resolveFeatureIdRecolorAsync().

@group(0) @binding(0) var idTexture: texture_2d<f32>;

// Decode the little-endian 32-bit pick key from a logical-RGBA sample. WebGPU
// returns logical channels for BOTH rgba8unorm and bgra8unorm storage, so no
// swizzle is needed here regardless of the pick FBO's memory format.
//
// ALPHA IS PART OF THE KEY, not a coverage flag. Every pick producer writes
// `PickId.color` = `Color.fromRgba(key)` across all four channels, so the high
// byte of the key lands in alpha; `WebGPUPickFramebuffer` has always rebuilt
// the key from all four with `Color.bytesToRgba(r, g, b, a)`. Dropping alpha
// here made two ids differing only above bit 23 recolor identically and made
// every id that is a multiple of 2^24 decode to 0 — i.e. render as background.
// The cleared pick target is (0,0,0,0), so id 0 still means "nothing drawn".
fn decodeFeatureId(c: vec4<f32>) -> u32 {
    let r = u32(round(c.r * 255.0));
    let g = u32(round(c.g * 255.0));
    let b = u32(round(c.b * 255.0));
    let a = u32(round(c.a * 255.0));
    return r | (g << 8u) | (b << 16u) | (a << 24u);
}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
    // Single oversized triangle covering the viewport.
    var pos = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 3.0, -1.0),
        vec2<f32>(-1.0,  3.0),
    );
    return vec4<f32>(pos[vertexIndex], 0.0, 1.0);
}

@fragment
fn fragmentMain(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
    let coord = vec2<i32>(i32(fragCoord.x), i32(fragCoord.y));
    let id = decodeFeatureId(textureLoad(idTexture, coord, 0));

    if (id == 0u) {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }

    // Knuth multiplicative hash — different IDs map to visibly different colours
    // with overwhelming probability. Replicated exactly in the JS probe so the
    // shader's output colour can be tied back to the CPU-resolved pick ID.
    let h = id * 2654435761u;
    let hr = f32(h & 0xFFu) / 255.0;
    let hg = f32((h >> 8u) & 0xFFu) / 255.0;
    let hb = f32((h >> 16u) & 0xFFu) / 255.0;
    return vec4<f32>(hr, hg, hb, 1.0);
}
