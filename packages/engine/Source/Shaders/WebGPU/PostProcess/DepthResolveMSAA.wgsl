// DepthResolveMSAA.wgsl — Slice 5c-B Batch 128
//
// Resolves an MSAA depth texture (texture_depth_multisampled_2d) to a
// single-sample depth attachment via a fullscreen render pass that
// writes @builtin(frag_depth). Per-fragment we read sample 0 of the
// MSAA depth (same convention as GBufferNormalsFromDepthMSAA.wgsl)
// and emit it as the fragment's depth.
//
// Why this exists (Batch 128):
//   - WebGPU 1.0 has no `depthResolveTarget` analog for color resolves.
//   - Env effects (NPR / SSR / Procedural Clouds), AO, DoF, and the
//     gBuffer compute producer's single-sample variant all want to
//     bind a `texture_depth_2d` sampleable depth view, but
//     SceneFramebuffer.depthSampleableView returns a depth-only-aspect
//     view of the MSAA depth texture — that view is still
//     multisampled, which trips "Sample count doesn't match
//     expectation" at bind time.
//   - This shader fills a SEPARATE single-sample depth attachment
//     each frame. SceneFramebuffer.depthSampleableView then routes to
//     the resolved view in MSAA mode (unchanged in single-sample
//     mode — the existing aspect view is already single-sample there).
//
// Why FS + frag_depth (vs compute):
//   - Depth-format textures (depth32float) aren't storage-bindable.
//     Compute resolve would need an r32float intermediate + per-shader
//     binding changes across every depth consumer (AO, NPR, SSR, etc.)
//   - FS + frag_depth writes directly to a depth attachment, so the
//     consumer side stays at `texture_depth_2d` — no shader changes.
//
// Sample 0 only (vs full MSAA average):
//   - Same trade-off documented in GBufferNormalsFromDepthMSAA.wgsl:
//     sample 0 is a representative geometric depth, averaging is more
//     accurate at edges but ~Nx more bandwidth. Sample 0 has been
//     proven adequate for AO + the depth-as-color debug overlay.

@group(0) @binding(0) var sceneDepthMSAA: texture_depth_multisampled_2d;

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  // Fullscreen oversize-triangle trick covering [-1,1] in NDC.
  var output: VertexOutput;
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  output.clipPos = vec4<f32>(x, y, 0.0, 1.0);
  return output;
}

// Slice 5c-B Batch 128 — write depth as a single-channel color output
// (NOT @builtin(frag_depth)) so the resolve target can be a
// filterable-float color texture (r16float) instead of a depth
// format. Downstream consumers (AO HBAO, NPR, DoF, SSR) bind their
// depth slot as `texture_2d<f32>` and read `.r` — keeping the
// existing filterable-float BGL declarations unchanged. Using a
// depth-format resolve target would force every depth-slot consumer
// to switch to `unfilterable-float` + non-filtering sampler, a
// per-shader change of much larger scope.
@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) f32 {
  let pixel = vec2<i32>(i32(in.clipPos.x), i32(in.clipPos.y));
  // Sample 0 of the multisampled depth. textureLoad on a multisampled
  // texture requires an explicit sample index (no LOD).
  return textureLoad(sceneDepthMSAA, pixel, 0);
}
