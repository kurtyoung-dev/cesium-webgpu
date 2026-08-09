// DepthResolveMSAA.wgsl
//
// Resolves an MSAA depth texture (texture_depth_multisampled_2d) to a
// single-sample target through a fullscreen render pass. Per fragment it
// reads sample 0 of the MSAA depth, the same convention
// GBufferNormalsFromDepthMSAA.wgsl uses.
//
// Why this exists:
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

// Depth is written as a single-channel colour output rather than through
// `@builtin(frag_depth)`, so the resolve target can be a filterable-float
// colour texture, r16float, instead of a depth format. Downstream consumers —
// AO, NPR, DoF, SSR — bind their depth slot as `texture_2d<f32>` and read
// `.r`, which keeps their existing filterable-float bind-group declarations.
// A depth-format resolve target would force every one of them onto
// `unfilterable-float` with a non-filtering sampler.
@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) f32 {
  let pixel = vec2<i32>(i32(in.clipPos.x), i32(in.clipPos.y));
  // Sample 0 of the multisampled depth. textureLoad on a multisampled
  // texture requires an explicit sample index (no LOD).
  return textureLoad(sceneDepthMSAA, pixel, 0);
}
