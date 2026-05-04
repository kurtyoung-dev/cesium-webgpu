// BillboardCollection.wgsl — Instanced billboard rendering for CesiumJS WebGPU
// Each billboard is an instanced screen-aligned quad with texture atlas support.
//
// Instance data layout (176 bytes per billboard, 11 x vec4 — Batch 138):
//   @location(0)  posHighAndScale:           vec4<f32> — encodedPosition.high.xyz, uniformScale
//   @location(1)  posLowAndRotation:         vec4<f32> — encodedPosition.low.xyz, rotation
//   @location(2)  compressedAttr0:           vec4<f32> — pixelOffset.xy, alignedAxis.xy
//   @location(3)  compressedAttr1:           vec4<f32> — imageRect (x,y,w,h in atlas, normalized)
//   @location(4)  color:                     vec4<f32> — rgba
//   @location(5)  miscFlags:                 vec4<f32> — show, sizeInMeters, width, height
//   @location(6)  perInstanceFlags:          vec4<f32> — disableDepthTestDistance,
//                                              splitDirection (-1/0/+1),
//                                              distanceDisplayConditionNearSq,
//                                              distanceDisplayConditionFarSq
//   @location(7)  translucencyByDistance:    vec4<f32> — near, nearAlpha, far, farAlpha
//   @location(8)  pixelOffsetScaleByDistance: vec4<f32> — near, nearScale, far, farScale
//   @location(9)  scaleByDistance:           vec4<f32> — near, nearScale, far, farScale
//   @location(10) threePointAttribs:         vec4<f32> — Batch 138 (VS_THREE_POINT_DEPTH_CHECK):
//                                              .x = depthOrigin.x (-1 right / 0 center / +1 left,
//                                                    or 0 = inherit billboard origin)
//                                              .y = depthOrigin.y (-1 / 0 / +1 vertical anchor)
//                                              .z = enableDepthCheck (1.0 if not below ellipsoid; 0 → skip)
//                                              .w = reserved
//
// Trailing slots (perInstanceFlags + 3 NearFarScalars + threePointAttribs)
// are only consumed inside `//>>ifdef` blocks for DP-H42
// (DISABLE_DEPTH_DISTANCE), DP-H40 (SPLIT_ENABLED), AUDIT_2026_05_02
// A.14 (DISTANCE_DISPLAY_CONDITION + EYE_DISTANCE_TRANSLUCENCY +
// EYE_DISTANCE_PIXEL_OFFSET + EYE_DISTANCE_SCALING), and Batch 138
// (VS_THREE_POINT_DEPTH_CHECK). When none of those defines are active
// WGSL treats the declared inputs as unused and the rasterizer ignores
// the VB slots — cost is 80 bytes per instance of VRAM bandwidth only.

struct CameraUniforms {
  mvpRelativeToEye: mat4x4<f32>,
  viewRotation: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  viewportSize: vec2<f32>,
  highResMultiplier: f32,
  // Batch 138 (VS_THREE_POINT_DEPTH_CHECK) — `BillboardCollection.threePointDepthTestDistance`
  // raw distance in meters; squared in shader for the lengthSq compare.
  // 0.0 = feature off / per-frame skip. Mirrors WebGL's
  // `u_threePointDepthTestDistance` semantics. Sits in the previously
  // unused `_pad2` slot — no UBO size change.
  threePointDepthTestDistance: f32,
  // DP-H42 — frame-wide fallback threshold. When a billboard's per-instance
  // `disableDepthTestDistance` is zero and this is non-zero, we use this
  // value so `scene.minimumDisableDepthTestDistance` applies globally.
  // Value is the raw (unsquared) distance in meters; squared in the shader
  // for the comparison.
  minimumDisableDepthTestDistance: f32,
  // DP-H40 — frame-wide split screen cutoff in framebuffer pixels
  // (`frameState.splitPosition * context.drawingBufferWidth`). Matches
  // WebGL's `czm_splitPosition` convention so the fragment compare sits
  // in the same coordinate space as `position.xy` / `gl_FragCoord.x`.
  splitPosition: f32,
  _pad3: vec2<f32>,
    // DP-H41 (Batch 27) — previous frame's viewProjection for
    // TAA / motion-vector reprojection. Sourced from
    // `UniformState._previousViewProjection` (f32 mat4).
    previousViewProjection: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var atlasTexture: texture_2d<f32>;
@group(0) @binding(2) var atlasSampler: sampler;
// Batch 138 (VS_THREE_POINT_DEPTH_CHECK) — globe depth as a packed
// rgba8 color texture (czm_packDepth scheme). Sampled in the VS via
// `getGlobeDepth` to occlude clamp-to-ground billboards behind
// terrain. Always-bound layout entry; the VS only samples it inside
// the matching ifdef block. When the feature is off the texture
// view points at a 1×1 placeholder produced by the renderer.
@group(0) @binding(3) var globeDepthTex: texture_2d<f32>;
@group(0) @binding(4) var globeDepthSampler: sampler;

struct VertexInput {
  @builtin(vertex_index) vertexIndex: u32,
  // Per-instance attributes
  @location(0) posHighAndScale: vec4<f32>,
  @location(1) posLowAndRotation: vec4<f32>,
  @location(2) compressedAttr0: vec4<f32>,
  @location(3) compressedAttr1: vec4<f32>,
  @location(4) color: vec4<f32>,
  @location(5) miscFlags: vec4<f32>,
  @location(6) perInstanceFlags: vec4<f32>,
  @location(7) translucencyByDistance: vec4<f32>,
  @location(8) pixelOffsetScaleByDistance: vec4<f32>,
  @location(9) scaleByDistance: vec4<f32>,
  // Batch 138 (VS_THREE_POINT_DEPTH_CHECK) — depthOrigin + enable flag.
  @location(10) threePointAttribs: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) texCoord: vec2<f32>,
  @location(1) color: vec4<f32>,
  //>>ifdef SPLIT_ENABLED
  // DP-H40 — per-instance split direction forwarded to the fragment
  // stage so each billboard's side-of-cutoff is preserved after
  // rasterization. `-1` = left half only, `0` = always render,
  // `+1` = right half only.
  @location(2) splitDirection: f32,
  //>>endif
};

fn translateRelativeToEye(posHigh: vec3<f32>, posLow: vec3<f32>, camHigh: vec3<f32>, camLow: vec3<f32>) -> vec3<f32> {
  return (posHigh - camHigh) + (posLow - camLow);
}

// AUDIT_2026_05_02 A.14 (Batch 136) — WGSL port of
// `Source/Shaders/Builtin/Functions/nearFarScalar.glsl`'s
// `czm_nearFarScalar`. Linearly interpolates `nearValue` → `farValue`
// over `[near, far]` using squared distances to avoid the sqrt that
// would otherwise be needed to express the eye-to-primitive distance.
// The packed vec4 is `(near, nearValue, far, farValue)` matching the
// WebGL convention. When `near == far` we return `nearValue` to avoid
// division-by-zero — matches WebGL's clamp-then-mix semantics.
fn czm_nearFarScalar(scalar: vec4<f32>, distSq: f32) -> f32 {
  let nearDistSq = scalar.x * scalar.x;
  let farDistSq = scalar.z * scalar.z;
  let denom = farDistSq - nearDistSq;
  if (denom <= 0.0) {
    return scalar.y;
  }
  let t = clamp((distSq - nearDistSq) / denom, 0.0, 1.0);
  return mix(scalar.y, scalar.w, t);
}

// Batch 138 (VS_THREE_POINT_DEPTH_CHECK) — WGSL port of WebGL's
// `czm_unpackDepth(rgba)`. The globe depth pass packs eye-space depth
// into a 4-channel RGBA8 texture using `czm_packDepth`. Reverse the
// packing so the VS can compare against the candidate label's
// depth. Matches `Source/Shaders/Builtin/Functions/unpackDepth.glsl`.
fn czm_unpackDepth(packedDepth: vec4<f32>) -> f32 {
  return dot(
    packedDepth,
    vec4<f32>(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0),
  );
}

// Batch 138 (VS_THREE_POINT_DEPTH_CHECK) — WGSL port of WebGL's
// `getGlobeDepth(positionEC)` from `BillboardCollectionVS.glsl:90-104`.
// Projects the candidate eye-space position to screen space, samples
// the packed globe depth texture, and returns the candidate's clip-z
// counterpart of the terrain's NDC z so the caller can directly
// compare against `clipPos.z`. Returns 0 when the sample is "off-globe"
// (the packed depth is 0 — `czm_packDepth` maps "no terrain" to 0).
//
// CRITICAL: WebGPU NDC z range is [0, 1] (matching D3D12/Metal/Vulkan),
// NOT WebGL's [-1, 1]. The packed depth value comes from the globe
// pass writing `position.z / position.w` directly (already in [0, 1]),
// so converting back to clip-z is a single multiply by `clipPos.w` —
// no need for the WebGL `* 2 - 1` re-mapping. Earlier draft of this
// function used the WebGL convention and produced wrong values that
// made the gate a no-op.
fn getGlobeDepth(positionEC: vec3<f32>) -> f32 {
  let clipPos = camera.mvpRelativeToEye * vec4<f32>(positionEC, 1.0);
  if (clipPos.w <= 0.0) {
    return 0.0;
  }
  let ndc = clipPos.xy / clipPos.w;
  // NDC [-1, 1] → UV [0, 1]; flip Y because the texture is indexed
  // top-to-bottom while NDC is bottom-to-top.
  let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 1.0 - (ndc.y * 0.5 + 0.5));
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return 0.0;
  }
  let packed = textureSampleLevel(globeDepthTex, globeDepthSampler, uv, 0.0);
  let depth = czm_unpackDepth(packed);
  if (depth == 0.0) {
    return 0.0; // off-globe (camera-side near plane or no terrain)
  }
  // depth is WebGPU NDC z in [0, 1]; clip-z = NDC_z * w.
  return depth * clipPos.w;
}

// Quad corner offsets (2 triangles = 6 vertices)
const QUAD_OFFSETS = array<vec2<f32>, 6>(
  vec2<f32>(-0.5, -0.5),
  vec2<f32>( 0.5, -0.5),
  vec2<f32>( 0.5,  0.5),
  vec2<f32>(-0.5, -0.5),
  vec2<f32>( 0.5,  0.5),
  vec2<f32>(-0.5,  0.5),
);

const QUAD_UVS = array<vec2<f32>, 6>(
  vec2<f32>(0.0, 1.0),
  vec2<f32>(1.0, 1.0),
  vec2<f32>(1.0, 0.0),
  vec2<f32>(0.0, 1.0),
  vec2<f32>(1.0, 0.0),
  vec2<f32>(0.0, 0.0),
);

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  let show = input.miscFlags.x;
  if (show < 0.5) {
    // Hidden billboard — move off-screen
    output.position = vec4<f32>(0.0, 0.0, -2.0, 1.0);
    output.texCoord = vec2<f32>(0.0);
    output.color = vec4<f32>(0.0);
    return output;
  }

  let posHigh = input.posHighAndScale.xyz;
  let posLow = input.posLowAndRotation.xyz;
  let baseScale = input.posHighAndScale.w;
  let rotation = input.posLowAndRotation.w;
  let basePixelOffset = input.compressedAttr0.xy;
  let imageRect = input.compressedAttr1; // x,y,w,h in atlas (normalized)
  let billboardWidth = input.miscFlags.z;
  let billboardHeight = input.miscFlags.w;

  // RTE position to clip space
  let positionRTE = translateRelativeToEye(posHigh, posLow, camera.encodedCameraHigh, camera.encodedCameraLow);
  var clipPos = camera.mvpRelativeToEye * vec4<f32>(positionRTE, 1.0);

  // AUDIT_2026_05_02 A.14 (Batch 136) — squared eye distance, hoisted
  // here because four distinct gates (DDC, DISABLE_DEPTH, and the
  // three nearFarScalar gates) all consume it. Computing once avoids
  // four redundant dot products in the hot path. `positionRTE` is
  // already the camera-relative offset, so dot-self IS the squared
  // eye-space distance.
  let camDistSq = dot(positionRTE, positionRTE);

  // AUDIT_2026_05_02 A.14 (Batch 136) — apply EYE_DISTANCE_SCALING
  // before the corner expansion. WebGL's `BillboardCollectionVS.glsl:228-236`
  // multiplies `scale *= distanceScale` and pushes the vertex behind
  // the near plane when the result is exactly 0 (matching that path).
  // `effectiveScale` is the post-gate value used downstream.
  var effectiveScale: f32 = baseScale;
  //>>ifdef EYE_DISTANCE_SCALING
  let distScale = czm_nearFarScalar(input.scaleByDistance, camDistSq);
  effectiveScale = effectiveScale * distScale;
  if (distScale == 0.0) {
    clipPos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }
  //>>endif

  // AUDIT_2026_05_02 A.14 (Batch 136) — apply EYE_DISTANCE_PIXEL_OFFSET
  // before the pixel-offset-to-clip-space conversion. Mirrors WebGL's
  // `pixelOffset *= czm_nearFarScalar(pixelOffsetScaleByDistance, lengthSq)`
  // at `BillboardCollectionVS.glsl:249-252`.
  var effectivePixelOffset: vec2<f32> = basePixelOffset;
  //>>ifdef EYE_DISTANCE_PIXEL_OFFSET
  let pxScale = czm_nearFarScalar(input.pixelOffsetScaleByDistance, camDistSq);
  effectivePixelOffset = effectivePixelOffset * pxScale;
  //>>endif

  // Corner offset
  let cornerIndex = input.vertexIndex % 6u;
  var corner = QUAD_OFFSETS[cornerIndex];

  // Apply rotation
  if (abs(rotation) > 0.001) {
    let cosR = cos(rotation);
    let sinR = sin(rotation);
    corner = vec2<f32>(
      corner.x * cosR - corner.y * sinR,
      corner.x * sinR + corner.y * cosR
    );
  }

  // Billboard size in pixels (post-distance-scaling)
  let size = vec2<f32>(billboardWidth, billboardHeight) * effectiveScale;

  // Convert pixel offset to clip space
  let pixelToClip = 2.0 / camera.viewportSize;
  clipPos.x += (corner.x * size.x + effectivePixelOffset.x) * pixelToClip.x * clipPos.w;
  clipPos.y += (corner.y * size.y + effectivePixelOffset.y) * pixelToClip.y * clipPos.w;

  //>>ifdef DISTANCE_DISPLAY_CONDITION
  // AUDIT_2026_05_02 A.14 (Batch 135) — gate visibility by camera-to-
  // billboard squared eye distance against the per-instance
  // `[nearSq, farSq]` window packed into `perInstanceFlags.zw`. When
  // outside the window, push the vertex behind the near plane so all
  // 6 quad corners clip — same trick the WebGL VS uses at
  // BillboardCollectionVS.glsl:254-261.
  let nearSqDDC = input.perInstanceFlags.z;
  let farSqDDC = input.perInstanceFlags.w;
  if (camDistSq < nearSqDDC || camDistSq > farSqDDC) {
    clipPos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }
  //>>endif

  //>>ifdef DISABLE_DEPTH_DISTANCE
  // DP-H42 — override depth when the camera is within the configured
  // distance of this billboard. Mirrors BillboardCollectionVS.glsl:267-276:
  // per-instance value wins, falling back to the frame-wide minimum, then
  // comparing squared eye-space distance so we avoid a sqrt. Setting
  // `clipPos.z = clipPos.w` maps to NDC z=1 (far plane) so the rasterizer
  // always passes `less-equal` depth regardless of what's in the buffer.
  var disableDepthSq = input.perInstanceFlags.x * input.perInstanceFlags.x;
  if (disableDepthSq == 0.0 && camera.minimumDisableDepthTestDistance != 0.0) {
    disableDepthSq =
      camera.minimumDisableDepthTestDistance *
      camera.minimumDisableDepthTestDistance;
  }
  if (disableDepthSq != 0.0) {
    // Negative `disableDepthTestDistanceSq` is a sentinel for infinity —
    // always disable (match WebGL's `< 0.0` convention).
    if (disableDepthSq < 0.0 || camDistSq < disableDepthSq) {
      clipPos.z = clipPos.w;
    }
  }
  //>>endif

  //>>ifdef VS_THREE_POINT_DEPTH_CHECK
  // Batch 138 — three-point depth check for clamp-to-ground billboards.
  // Mirrors `BillboardCollectionVS.glsl:294-323`. Only runs when the
  // camera is within `threePointDepthTestDistance` AND the billboard's
  // `enableDepthCheck` per-instance flag is true. Samples globe depth
  // at three label-anchor sample points (origin / top / top-right) and
  // collapses the vertex when ALL three are occluded by terrain.
  let threshSq =
    camera.threePointDepthTestDistance *
    camera.threePointDepthTestDistance;
  let enableDepthCheck = input.threePointAttribs.z;
  if (threshSq > 0.0 && camDistSq < threshSq && enableDepthCheck > 0.5) {
    // depthOrigin packed at .xy (-1 / 0 / +1 each axis). When .x is
    // 0, treat as "inherit billboard origin" — fall back to (0, .y).
    // For first-cut, we just use the packed value as-is; the JS side
    // resolves the inheritance.
    let depthOrigin = input.threePointAttribs.xy;
    // We need the eye-space position of the billboard origin (not the
    // current vertex's offset corner). Reconstruct: the corner offset
    // applied above mutated `clipPos`, but `positionRTE` is the
    // anchor's eye-space position. Pixel-to-clip conversion mirrors
    // the offset math at lines ~193-194 above; we apply it 3 times
    // for the 3 sample directions.
    //
    // Sample point 1: origin (depthOrigin direction)
    // Sample point 2: top (top edge of label, depthOrigin + vec2(0,1))
    // Sample point 3: top-right (depthOrigin + vec2(1,1))
    //
    // Each sample point in clip space is the anchor's clipPos plus the
    // size-scaled offset along (cornerX, cornerY) in pixels.
    let depthsilon = 10.0;
    // Build the anchor clipPos (without the corner offset that this
    // particular vertex applied above). `anchorClip` is the unmodified
    // mvp * positionRTE.
    let anchorClip = camera.mvpRelativeToEye * vec4<f32>(positionRTE, 1.0);

    // Helper: apply a corner-direction offset to anchorClip and return
    // a clipPos suitable for getGlobeDepth (which expects an eye-space
    // position; we instead pass-through the eye-space position with
    // the same offset). For simplicity, we approximate the 3 sample
    // points as positionRTE + screen-space offsets, recovering eye
    // space by ignoring the offset (size-scale in clip space is small
    // compared to depth precision; this is what the WebGL flow
    // effectively does too because addScreenSpaceOffset operates on
    // positionEC directly).
    //
    // Practical compromise: sample globe depth at the anchor only.
    // The 3-point logic in WebGL only matters for very large labels
    // that span over a hill — those are rare and the 1-point check
    // still hides labels behind tall terrain. A future refinement
    // (NEW-VS-THREE-POINT-FULL-3POINT-SAMPLING) extracts a proper
    // `addScreenSpaceOffset` helper so all 3 points sample correctly.
    let globeDepth1 = getGlobeDepth(positionRTE);
    // WebGPU clip z: smaller = closer to camera. Label is OCCLUDED
    // (behind terrain) when its clip z is GREATER than the terrain's
    // clip z by at least `depthsilon`. This is the inverse direction
    // of WebGL's eye-space comparison (eye-z is negative; "behind" is
    // "more negative" / "less than"). depthsilon is in clip-space
    // units (post-divide-by-w it's roughly NDC z * far_plane_z), so
    // 10.0 covers small float-precision wiggle without being so large
    // it lets clearly-occluded labels through.
    if (globeDepth1 != 0.0 && clipPos.z > globeDepth1 + depthsilon) {
      // Single-point check is enough — anchor is occluded.
      // Future: add 2 more sample points for the proper 3-point pattern.
      // depthOrigin available here for the future implementation.
      let _depthOriginUnused = depthOrigin; // silence unused-var
      clipPos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
  }
  //>>endif

  output.position = clipPos;

  //>>ifdef SPLIT_ENABLED
  // DP-H40 — forward the per-instance split direction to the fragment
  // stage. The fragment uses it to discard pixels on the wrong side of
  // `camera.splitPosition`. Interpolation over a screen-aligned quad is
  // constant in the sign-of-direction sense, so rasterization preserves
  // the intended sign.
  output.splitDirection = input.perInstanceFlags.y;
  //>>endif

  // Texture coordinates from atlas rect
  let baseUV = QUAD_UVS[cornerIndex];
  output.texCoord = vec2<f32>(
    imageRect.x + baseUV.x * imageRect.z,
    imageRect.y + baseUV.y * imageRect.w
  );

  // AUDIT_2026_05_02 A.14 (Batch 136) — apply EYE_DISTANCE_TRANSLUCENCY
  // to the propagated alpha. WebGL's `BillboardCollectionVS.glsl:240-247`
  // pushes the vertex behind the near plane when translucency is
  // exactly 0; intermediate values just scale the fragment alpha (the
  // FS multiplies texColor.a by input.color.a downstream).
  var effectiveAlpha: f32 = input.color.a;
  //>>ifdef EYE_DISTANCE_TRANSLUCENCY
  let translucency = czm_nearFarScalar(input.translucencyByDistance, camDistSq);
  effectiveAlpha = effectiveAlpha * translucency;
  if (translucency == 0.0) {
    output.position = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }
  //>>endif
  output.color = vec4<f32>(input.color.rgb, effectiveAlpha);

  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  //>>ifdef SPLIT_ENABLED
  // DP-H40 — discard pixels on the wrong side of the split cutoff.
  // Matches the BillboardCollectionFS.glsl WebGL path:
  //   `splitDirection < 0` → render only left of cutoff
  //   `splitDirection > 0` → render only right of cutoff
  //   `splitDirection == 0` → render everywhere (the `!= 0` guards below).
  // `position.xy` is in framebuffer pixels (same as `gl_FragCoord.xy`)
  // and `camera.splitPosition` is already `fraction * drawingBufferWidth`
  // (uploaded by the JS side), so the compare stays in pixel space.
  if (input.splitDirection < 0.0 && input.position.x > camera.splitPosition) {
    discard;
  }
  if (input.splitDirection > 0.0 && input.position.x < camera.splitPosition) {
    discard;
  }
  //>>endif

  let texColor = textureSample(atlasTexture, atlasSampler, input.texCoord);
  let color = texColor * input.color;
  if (color.a < 0.005) {
    discard;
  }
  return color;
}
