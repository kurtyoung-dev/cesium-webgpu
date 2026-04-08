// csm_primitiveIndex.wgsl — WGF-6 helpers
//
// Wraps the WGSL `@builtin(primitive_index)` fragment input which gives the
// triangle index (0..N-1) of the rasterized primitive within the current
// draw call. Useful for:
//   - Wireframe overlays without a geometry shader
//   - Per-face debug coloring
//   - Per-triangle picking without a separate pick framebuffer
//
// Usage in a fragment shader:
//
//   #import csm_primitiveIndex;
//
//   @fragment
//   fn fragmentMain(@builtin(primitive_index) primIndex: u32, ...)
//       -> @location(0) vec4<f32> {
//     return csm_debugFaceColor(primIndex);
//   }
//
// `@builtin(primitive_index)` is supported on all WebGPU implementations as
// of mid-2025; no `enable` directive is needed.
//
// @chunk functions/csm_primitiveIndex

/**
 * Maps a triangle index to a deterministic distinct color. Useful for
 * "rainbow per face" debug visualizations of terrain tiles, polygon
 * triangulations, or model meshes.
 */
fn csm_debugFaceColor(primIndex: u32) -> vec4<f32> {
  // Hash the index to RGB via prime-multiplication, then normalize.
  let r = f32((primIndex * 73u) & 255u) / 255.0;
  let g = f32((primIndex * 151u + 31u) & 255u) / 255.0;
  let b = f32((primIndex * 211u + 89u) & 255u) / 255.0;
  return vec4<f32>(r, g, b, 1.0);
}

/**
 * Encodes a triangle index into an RGBA8 color suitable for readback as a
 * "primitive pick" buffer. Reverse via the standard 24-bit unpack.
 */
fn csm_encodePrimitiveIndex(primIndex: u32) -> vec4<f32> {
  let r = f32((primIndex >>  0u) & 255u) / 255.0;
  let g = f32((primIndex >>  8u) & 255u) / 255.0;
  let b = f32((primIndex >> 16u) & 255u) / 255.0;
  let a = f32((primIndex >> 24u) & 255u) / 255.0;
  return vec4<f32>(r, g, b, a);
}

/**
 * Returns true at the edges of every triangle when called with a barycentric
 * coordinate. Combined with `@builtin(primitive_index)` and a per-pixel
 * comparison this can produce wireframe overlays without a geometry shader.
 *
 * Pass the screen-space derivative width to control the line thickness in
 * pixels (typical: 1.0).
 */
fn csm_isWireframeEdge(bary: vec3<f32>, lineWidthPixels: f32) -> bool {
  let d = fwidth(bary);
  let edge = smoothstep(vec3<f32>(0.0), d * lineWidthPixels, bary);
  let minEdge = min(edge.x, min(edge.y, edge.z));
  return minEdge < 1.0;
}
