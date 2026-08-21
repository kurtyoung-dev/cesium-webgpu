// BillboardCollection.wgsl — Instanced billboard rendering for CesiumJS WebGPU
// Each billboard is an instanced screen-aligned quad with texture atlas support.
//
// Instance data layout (176 bytes per billboard, 11 x vec4):
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
//   @location(10) threePointAttribs:         vec4<f32> — depth-check controls:
//                                              .x = depthOrigin.x (-1 right / 0 center / +1 left,
//                                                    or 0 = inherit billboard origin)
//                                              .y = depthOrigin.y (-1 / 0 / +1 vertical anchor)
//                                              .z = enableDepthCheck (1.0 if not below ellipsoid; 0 → skip)
//                                              .w = reserved
//
// Trailing slots (perInstanceFlags + 3 NearFarScalars + threePointAttribs)
// are only consumed by the DISABLE_DEPTH_DISTANCE, SPLIT_ENABLED,
// DISTANCE_DISPLAY_CONDITION, EYE_DISTANCE_TRANSLUCENCY,
// EYE_DISTANCE_PIXEL_OFFSET, EYE_DISTANCE_SCALING, and
// VS_THREE_POINT_DEPTH_CHECK variants. When none of those defines are active,
// WGSL treats the declared inputs as unused and the rasterizer ignores
// the VB slots — cost is 80 bytes per instance of VRAM bandwidth only.

struct CameraUniforms {
  mvpRelativeToEye: mat4x4<f32>,
  viewRotation: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  // Former `_pad0` / `_pad1` lanes carry the log-depth frustum near/far, and
  // formerly implicit float 46 carries oneOverLog2FarDepthFromNearPlusOne.
  // `packUniforms` fills them unconditionally without changing the UBO layout;
  // only the `//>>ifdef LOG_DEPTH` blocks read them.
  // See WebGPULogDepth.ts for the encode contract.
  logDepthNear: f32,
  encodedCameraLow: vec3<f32>,
  logDepthFar: f32,
  viewportSize: vec2<f32>,
  highResMultiplier: f32,
  // `BillboardCollection.threePointDepthTestDistance` in meters; squared in
  // the shader for the lengthSq compare.
  // 0.0 = feature off / per-frame skip. Mirrors WebGL's
  // `u_threePointDepthTestDistance` semantics. Stored in a padding slot, so
  // the UBO size does not change.
  threePointDepthTestDistance: f32,
  // Frame-wide fallback threshold. When a billboard's per-instance
  // `disableDepthTestDistance` is zero and this is non-zero, we use this
  // value so `scene.minimumDisableDepthTestDistance` applies globally.
  // Value is the raw (unsquared) distance in meters; squared in the shader
  // for the comparison.
  minimumDisableDepthTestDistance: f32,
  // Frame-wide split-screen cutoff in framebuffer pixels
  // (`frameState.splitPosition * context.drawingBufferWidth`). Matches
  // WebGL's `czm_splitPosition` convention so the fragment compare sits
  // in the same coordinate space as `position.xy` / `gl_FragCoord.x`.
  splitPosition: f32,
  // Log-depth factor (oneOverLog2FarDepthFromNearPlusOne) at float 46 +
  // reserved float 47 — these bytes were implicit padding before
  // `previousViewProjection`'s 16-byte alignment, so the struct size and
  // every existing offset are unchanged.
  logDepthFactor: f32,
  // Holds `czm_gamma` (`scene.gamma`, default 2.2) while
  // `scene.highDynamicRange` is enabled and zero otherwise. It occupies float
  // 47 without changing the uniform-buffer size. The fragment shader applies
  // WebGL's `#ifdef HDR` sRGB-to-linear decode only when this value exceeds
  // 0.5, leaving the default SDR path unchanged.
  hdrGamma: f32,
      previousViewProjection: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var atlasTexture: texture_2d<f32>;
@group(0) @binding(2) var atlasSampler: sampler;
// Packed RGBA8 globe depth (`czm_packDepth`) sampled by
// `getGlobeNdcDepth` to occlude clamp-to-ground billboards behind
// terrain. Always-bound layout entry; the VS only samples it inside
// the matching ifdef block. When the feature is off the texture
// view points at a 1×1 placeholder produced by the renderer.
@group(0) @binding(3) var globeDepthTex: texture_2d<f32>;
@group(0) @binding(4) var globeDepthSampler: sampler;

//>>ifdef LOG_DEPTH
// Collection shaders are fully inline (no #import chunk pipeline), so these
// mirror the canonical definitions in Shaders/WebGPU/chunks/functions/
// csm_{vertexLogDepth,writeLogDepth}.wgsl — keep them byte-compatible.
// near/far/factor come from the camera UB lanes (packUniforms).
fn csm_vertexLogDepth(clipPosition: vec4<f32>, near: f32) -> f32 {
  // Linear "eye distance from near, plus one" — interpolated; FS takes log2.
  return (clipPosition.w - near) + 1.0;
}
fn csm_updatePositionDepth(clipPosition: vec4<f32>) -> vec4<f32> {
  // Clamp clip z (WebGPU NDC [0,1]) so FP rounding at huge far/near ratios
  // can't clip a vertex before the FS writes the correct log depth.
  var coords = clipPosition;
  coords.z = clamp(coords.z / coords.w, 0.0, 1.0) * coords.w;
  return coords;
}
fn csm_writeLogDepth(depthFromNearPlusOne: f32, oneOverLog2FarDepthFromNearPlusOne: f32) -> f32 {
  return log2(depthFromNearPlusOne) * oneOverLog2FarDepthFromNearPlusOne;
}
//>>endif

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
  // Depth origin and enable flag for the three-point depth check.
  @location(10) threePointAttribs: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) texCoord: vec2<f32>,
  @location(1) color: vec4<f32>,
  //>>ifdef SPLIT_ENABLED
  // Per-instance split direction forwarded to the fragment
  // stage so each billboard's side-of-cutoff is preserved after
  // rasterization. `-1` = left half only, `0` = always render,
  // `+1` = right half only.
  @location(2) splitDirection: f32,
  //>>endif
  //>>ifdef LOG_DEPTH
  // Interpolated linear depthFromNearPlusOne; the FS converts it to
  // frag_depth (csm_vertexLogDepth / csm_writeLogDepth contract).
  @location(3) v_logDepth: f32,
  //>>endif
};

fn translateRelativeToEye(posHigh: vec3<f32>, posLow: vec3<f32>, camHigh: vec3<f32>, camLow: vec3<f32>) -> vec3<f32> {
  return (posHigh - camHigh) + (posLow - camLow);
}

// WGSL port of
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

// WGSL port of WebGL's
// `czm_unpackDepth(rgba)`. The globe depth pass packs eye-space depth
// into a 4-channel RGBA8 texture using `czm_packDepth`. Reverse the
// packing so the VS can compare against the candidate primitive's
// depth. Matches `Source/Shaders/Builtin/Functions/unpackDepth.glsl`.
fn czm_unpackDepth(packedDepth: vec4<f32>) -> f32 {
  return dot(
    packedDepth,
    vec4<f32>(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0),
  );
}

// Sample the
// packed globe-depth texture at a clip-space position and return the
// terrain's NDC z directly. Returns 0 when off-globe (the packed
// depth is 0 — `czm_packDepth` maps "no terrain" to 0).
//
// WebGPU NDC z range is [0, 1] (matching D3D12/Metal/Vulkan), unlike
// WebGL's [-1, 1]. The globe pass writes `position.z / position.w`
// already in [0, 1], so the unpacked value is the terrain's NDC z;
// callers compare in NDC space using a uniform NDC bias instead of
// converting back to clip-z, where a fixed bias would be distance-dependent
// and ineffective at long distances.
fn getGlobeNdcDepth(clipPos: vec4<f32>) -> f32 {
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
  return czm_unpackDepth(packed);
}

// Candidate depth for the three-point check. The globe
// depth texture is a copy of the scene depth buffer: hyperbolic NDC z
// normally, logarithmically encoded when LOG_DEPTH is active — so the
// comparison value must live in the same space. The log form derives the
// eye distance from clip.w (csm_vertexLogDepth contract) and applies the
// same encode the globe FS used (camera.logDepthNear / logDepthFactor =
// the shared encode frustum).
fn candidateGlobeCompareDepth(clipPos: vec4<f32>) -> f32 {
  //>>ifdef LOG_DEPTH
  return log2(max((clipPos.w - camera.logDepthNear) + 1.0, 1e-9)) *
    camera.logDepthFactor;
  //>>else
  return clipPos.z / clipPos.w;
  //>>endif
}

// WGSL port of WebGL's `addScreenSpaceOffset` helper. Computes the clip position
// of a corner of a billboard given the anchor's clipPos, a direction
// in {(0,0), (0,1), (1,1)} for the WebGL 3-point sample-point set,
// the label origin in {-1, 0, +1}², the billboard size in pixels,
// the pixelOffset, the rotation, and the pixel→clip scale.
//
// `originScale` follows the WebGL expression without negation:
// `originTranslate = origin * abs(halfSize)`.
//   halfSize = size * 0.5
//   halfSizeOffset = halfSize * (direction * 2 - 1)   // [-half, +half]
//   originScale = origin * abs(halfSize)              // shift along origin
//   total = rotate(halfSizeOffset + originScale) + pixelOffset
// `direction = (0,0)` → BL corner; `(0,1)` → TL; `(1,1)` → TR. These
// are the three sample points the WebGL 3-point check uses.
// `origin` uses Cesium's HorizontalOrigin / VerticalOrigin enums —
// HorizontalOrigin: CENTER=0, LEFT=+1, RIGHT=-1; VerticalOrigin:
// CENTER=0, BOTTOM=+1, TOP=-1. With `origin.x = +1` (LEFT), the
// label is anchored at its left edge → label center sits +halfSize.x
// to the right of the anchor → `originTranslate = +1 * abs(half) =
// +abs(half)`. No negation.
fn addScreenSpaceOffsetClip(
  anchorClip: vec4<f32>,
  direction: vec2<f32>,
  origin: vec2<f32>,
  size: vec2<f32>,
  pixelOffset: vec2<f32>,
  rotation: f32,
  pixelToClip: vec2<f32>,
) -> vec4<f32> {
  let halfSize = size * 0.5;
  var halfSizeOffset = halfSize * (direction * 2.0 - 1.0);
  let originTranslate = origin * abs(halfSize);
  // 4th-pass audit fix — WebGL `BillboardCollectionVS.glsl:73-74`
  // rotates ONLY the direction-adjusted `halfSize`. Lines 83-84 then
  // add `originTranslate` and `pixelOffset` UN-rotated. Earlier
  // attempts rotated the whole sum, which produced wrong sample
  // points when both rotation and origin (or pixelOffset) were
  // simultaneously non-zero.
  if (abs(rotation) > 0.001) {
    let cosR = cos(rotation);
    let sinR = sin(rotation);
    halfSizeOffset = vec2<f32>(
      halfSizeOffset.x * cosR - halfSizeOffset.y * sinR,
      halfSizeOffset.x * sinR + halfSizeOffset.y * cosR,
    );
  }
  let totalOffset = halfSizeOffset + originTranslate + pixelOffset;
  var clipPos = anchorClip;
  clipPos.x = clipPos.x + totalOffset.x * pixelToClip.x * clipPos.w;
  clipPos.y = clipPos.y + totalOffset.y * pixelToClip.y * clipPos.w;
  return clipPos;
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

// WebGL's `BillboardCollectionVS.glsl` computes
// `textureCoordinatesBottomLeft + direction * range`, mapping the
// screen-bottom quad corner to the atlas rectangle's minimum v and the
// screen-top corner to its maximum v. Both backends upload the atlas with
// `flipY=true`, placing the image bottom at v=0, so reversing this mapping
// vertically flips asymmetric images and label glyphs. `QUAD_OFFSETS.y`
// increases upward after the positive `pixelToClip.y` transform; therefore
// corner.y=-0.5 maps to v=0 and corner.y=+0.5 maps to v=1.
const QUAD_UVS = array<vec2<f32>, 6>(
  vec2<f32>(0.0, 0.0),
  vec2<f32>(1.0, 0.0),
  vec2<f32>(1.0, 1.0),
  vec2<f32>(0.0, 0.0),
  vec2<f32>(1.0, 1.0),
  vec2<f32>(0.0, 1.0),
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

  // Squared eye distance is hoisted because five distance-aware gates (DDC,
  // DISABLE_DEPTH, and the three nearFarScalar gates) consume it. Computing once avoids
  // four redundant dot products in the hot path. `positionRTE` is
  // already the camera-relative offset, so dot-self is the squared
  // eye-space distance.
  let camDistSq = dot(positionRTE, positionRTE);

  // Apply EYE_DISTANCE_SCALING
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

  // Apply EYE_DISTANCE_PIXEL_OFFSET
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

  // Convert CSS-pixel offsets to clip space.
  // `viewportSize` is the device-pixel drawing buffer (canvas.width =
  // cssWidth * devicePixelRatio), but `size` and `pixelOffset` are authored
  // in CSS pixels. WebGL scales both by `czm_metersPerPixel`, which folds in
  // `czm_pixelRatio` (metersPerPixel.glsl:43), so a billboard of N CSS px
  // covers N*pixelRatio device px. Mirror that by baking `highResMultiplier`
  // (= frameState.pixelRatio) into the pixel→clip factor. Omitting it would
  // render billboards and labels at 1/pixelRatio the linear size (1/4 area at
  // DPR 2). Matches BufferPointMaterial.wgsl's `outerRadius * pixelRatio`.
  let pixelToClip = (2.0 * camera.highResMultiplier) / camera.viewportSize;
  clipPos.x += (corner.x * size.x + effectivePixelOffset.x) * pixelToClip.x * clipPos.w;
  clipPos.y += (corner.y * size.y + effectivePixelOffset.y) * pixelToClip.y * clipPos.w;

  //>>ifdef DISTANCE_DISPLAY_CONDITION
  // Gate visibility by the squared camera-to-billboard distance against the per-instance
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
  // Override depth when the camera is within the configured
  // distance of this billboard. Mirrors BillboardCollectionVS.glsl:267-276:
  // per-instance value wins, falling back to the frame-wide minimum, then
  // comparing squared eye-space distance so we avoid a sqrt.
  //
  // Set `clipPos.z = 0.0` so NDC z = 0, the WebGPU near plane, and the
  // billboard passes the `less-equal` depth test regardless of the buffer.
  // Setting `clipPos.z = clipPos.w` would target the far plane and fail against
  // closer geometry. WebGPU clip space is z∈[0,1] (near→far),
  // not WebGL's [-1,1]; "always on top" is the near plane (0), not the far plane.
  //
  // Check the raw signed value for the `< 0` infinity sentinel before
  // squaring. Squaring -1 to +1 would erase the sign and make the sentinel
  // branch unreachable.
  let disableRawDP = input.perInstanceFlags.x;
  if (disableRawDP < 0.0) {
    // Sentinel: always disable depth test.
    clipPos.z = 0.0;
  } else if (disableRawDP != 0.0) {
    let disableDepthSqDP = disableRawDP * disableRawDP;
    if (camDistSq < disableDepthSqDP) {
      clipPos.z = 0.0;
    }
  } else if (camera.minimumDisableDepthTestDistance != 0.0) {
    let frameMinSqDP =
      camera.minimumDisableDepthTestDistance *
      camera.minimumDisableDepthTestDistance;
    if (camDistSq < frameMinSqDP) {
      clipPos.z = 0.0;
    }
  }
  //>>endif

  //>>ifdef VS_THREE_POINT_DEPTH_CHECK
  // Full three-point depth check for clamp-to-ground billboards, matching
  // BillboardCollectionVS.glsl.
  // It only runs when the camera is within `threePointDepthTestDistance`
  // and `enableDepthCheck` remains true after the disable-depth-distance
  // escape hatch is applied.
  // Samples globe depth at three anchor key points (origin / top
  // / top-right) and collapses the vertex when all three are occluded
  // by terrain.
  let threshSq3PD =
    camera.threePointDepthTestDistance *
    camera.threePointDepthTestDistance;
  // Clear `enableDepthCheck` when the camera is within the per-billboard
  // or frame-wide `disableDepthTestDistance`. WebGL applies the same gate so
  // close-up clamped billboards
  // bypass the depth test (otherwise they'd be incorrectly occluded by
  // their own ground when the depth-test override fires).
  //
  // Check the raw signed value for the `< 0` sentinel before squaring.
  // The WebGL convention treats negative
  // `disableDepthTestDistance` as "always disable" (infinity). We
  // store raw meters in `perInstanceFlags.x`; squaring kills the sign.
  var enableDepthCheck3PD = input.threePointAttribs.z;
  let disableRaw3PD = input.perInstanceFlags.x;
  if (disableRaw3PD < 0.0) {
    // Sentinel: always disable depth test → drop the 3-point check.
    enableDepthCheck3PD = 0.0;
  } else if (disableRaw3PD != 0.0) {
    let disableDepthSq3PD = disableRaw3PD * disableRaw3PD;
    if (camDistSq < disableDepthSq3PD) {
      enableDepthCheck3PD = 0.0;
    }
  } else if (camera.minimumDisableDepthTestDistance != 0.0) {
    // Per-instance unset; fall back to the frame-wide minimum.
    let frameMinSq3PD =
      camera.minimumDisableDepthTestDistance *
      camera.minimumDisableDepthTestDistance;
    if (camDistSq < frameMinSq3PD) {
      enableDepthCheck3PD = 0.0;
    }
  }
  if (
    threshSq3PD > 0.0 && camDistSq < threshSq3PD && enableDepthCheck3PD > 0.5
  ) {
    // Three sample points: anchor (depthOrigin), top (depthOrigin +
    // vec2(0,1)), top-right (depthOrigin + vec2(1,1)). depthOrigin
    // comes from `threePointAttribs.xy` (label-only — billboards
    // default to 0,0 which is "inherit base origin"). The WebGL flow
    // resolves the "inherit" case in JS; we accept the JS-side value
    // here as-is.
    let depthOrigin = input.threePointAttribs.xy;
    let anchorClip = camera.mvpRelativeToEye * vec4<f32>(positionRTE, 1.0);
    let labelSize3PD = vec2<f32>(billboardWidth, billboardHeight) * effectiveScale;

    // NDC bias: small enough to not over-discard at far distances, big
    // enough to absorb float precision noise. WebGL's eye-space 10m
    // bias is distance-dependent in clip space; using a uniform NDC
    // bias is closer to what WebGL achieves in practice.
    let ndcBias = 0.0001;

    // Sample-point directions are WebGL's `vec2(0)` / `vec2(0,1)` /
    // `vec2(1)` (BL / TL / TR corners). depthOrigin is passed
    // separately as the label origin.
    let pClip1 = addScreenSpaceOffsetClip(
      anchorClip,
      vec2<f32>(0.0, 0.0),
      depthOrigin,
      labelSize3PD,
      effectivePixelOffset,
      rotation,
      pixelToClip,
    );
    let depth1 = getGlobeNdcDepth(pClip1);
    let labelNdcZ1 = candidateGlobeCompareDepth(pClip1);
    if (depth1 != 0.0 && labelNdcZ1 > depth1 + ndcBias) {
      // Anchor (BL) occluded — check sample point 2 (TL).
      let pClip2 = addScreenSpaceOffsetClip(
        anchorClip,
        vec2<f32>(0.0, 1.0),
        depthOrigin,
        labelSize3PD,
        effectivePixelOffset,
        rotation,
        pixelToClip,
      );
      let depth2 = getGlobeNdcDepth(pClip2);
      let labelNdcZ2 = candidateGlobeCompareDepth(pClip2);
      if (depth2 != 0.0 && labelNdcZ2 > depth2 + ndcBias) {
        // Top-left occluded too — check sample point 3 (TR).
        let pClip3 = addScreenSpaceOffsetClip(
          anchorClip,
          vec2<f32>(1.0, 1.0),
          depthOrigin,
          labelSize3PD,
          effectivePixelOffset,
          rotation,
          pixelToClip,
        );
        let depth3 = getGlobeNdcDepth(pClip3);
        let labelNdcZ3 = candidateGlobeCompareDepth(pClip3);
        if (depth3 != 0.0 && labelNdcZ3 > depth3 + ndcBias) {
          // ALL three sample points occluded → label fully behind
          // terrain → discard.
          clipPos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
        }
      }
    }
  }
  //>>endif

  output.position = clipPos;

  //>>ifdef SPLIT_ENABLED
  // Forward the per-instance split direction to the fragment
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

  // Apply EYE_DISTANCE_TRANSLUCENCY
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

  //>>ifdef LOG_DEPTH
  // Renderer-wide log depth — computed AFTER every clipPos override above
  // (DDC / translucency hide collapse to (0,0,0,1); DISABLE_DEPTH_DISTANCE
  // forces z = 0 for the always-on-top near-plane trick). A forced z == 0
  // maps to v_logDepth = 1.0 -> frag_depth 0 (the near plane), mirroring
  // WebGL's `v_depthFromNearPlusOne = 1.0` convention in
  // BillboardCollectionVS.glsl's disable-depth branch.
  if (output.position.z == 0.0) {
    output.v_logDepth = 1.0;
  } else {
    output.v_logDepth = csm_vertexLogDepth(output.position, camera.logDepthNear);
  }
  output.position = csm_updatePositionDepth(output.position);
  //>>endif

  return output;
}

struct FragOutput {
  @location(0) color: vec4<f32>,
  //>>ifdef LOG_DEPTH
  // Renderer-wide log depth — written for the depth TEST as well as the
  // write (frag_depth replaces the rasterized z in the comparison), so
  // translucent collection passes (depthWriteEnabled=false) still test
  // correctly against the globe's log depth.
  @builtin(frag_depth) depth: f32,
  //>>endif
};

@fragment
fn fragmentMain(input: VertexOutput) -> FragOutput {
  //>>ifdef SPLIT_ENABLED
  // Discard pixels on the wrong side of the split cutoff.
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

  var texColor = textureSample(atlasTexture, atlasSampler, input.texCoord);
  var vtxColor = input.color;
  // Mirror the WebGL `BillboardCollectionFS.glsl` HDR path by gamma-correcting
  // both the sampled atlas color and the vertex color before multiplication.
  // `camera.hdrGamma` holds `czm_gamma` in HDR and zero in SDR, so the default
  // SDR result remains `texColor * input.color`.
  if (camera.hdrGamma > 0.5) {
    let g = vec3<f32>(camera.hdrGamma);
    texColor = vec4<f32>(pow(max(texColor.rgb, vec3<f32>(0.0)), g), texColor.a);
    vtxColor = vec4<f32>(pow(max(vtxColor.rgb, vec3<f32>(0.0)), g), vtxColor.a);
  }
  let color = texColor * vtxColor;
  if (color.a < 0.005) {
    discard;
  }
  var out: FragOutput;
  out.color = color;
  //>>ifdef LOG_DEPTH
  out.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepthFactor);
  //>>endif
  return out;
}

// Per-pixel velocity emission for animated billboards.
//
// TAA's camera-only fallback (depth + camera-delta reprojection)
// is correct for static billboards but ghosts on animated billboards
// where per-instance position changes between frames (entity tracking,
// moving labels). The velocity emission here closes that gap.
//
// Rasterize the billboard quad the same way the color VS does
// (so the velocity texture covers the right pixels), but emit the
// center-only position delta as the velocity. Per-pixel rotation /
// per-pixel size deltas are intentionally ignored — for moving
// billboards (the common animated case), corner-induced offsets cancel
// (same corner relative to the moving center), so center-delta is the
// correct velocity for every fragment.
//
// Prev-instance VB (slot 1 on the velocity pipeline) carries
// `(prevPosHigh, _, prevPosLow, _)` at locations 11-12. The renderer
// maintains it as a CPU-side mirror of the previous frame's instance
// buffer; on the first frame it's zero-initialized and `prevPosHigh ==
// prevPosLow == 0`, so velocity emerges as `currentNdc - 0` — equivalent
// to "no prior history" which TAA's first-frame logic already handles.

struct VelocityVertexInput {
  @builtin(vertex_index) vertexIndex: u32,
  // Slot 0: current instance data (mirrors regular VertexInput)
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
  @location(10) threePointAttribs: vec4<f32>,
  // Slot 1: prev-frame instance data — only positions matter for
  // center-delta velocity. The renderer binds the same per-instance
  // buffer as slot 1 with one frame of lag.
  @location(11) prevPosHighAndScale: vec4<f32>,
  @location(12) prevPosLowAndRotation: vec4<f32>,
};

struct VelocityVertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) currentCenterClip: vec4<f32>,
  @location(1) prevCenterClip: vec4<f32>,
  //>>ifdef LOG_DEPTH
  // The velocity pass shares the scene depth buffer read-only — its depth
  // TEST must run in the same (log) space as the color pass wrote.
  @location(2) v_logDepth: f32,
  //>>endif
};

@vertex
fn vertexVelocityMain(input: VelocityVertexInput) -> VelocityVertexOutput {
  var output: VelocityVertexOutput;

  let show = input.miscFlags.x;
  if (show < 0.5) {
    output.position = vec4<f32>(0.0, 0.0, -2.0, 1.0);
    output.currentCenterClip = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    output.prevCenterClip = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    return output;
  }

  let posHigh = input.posHighAndScale.xyz;
  let posLow = input.posLowAndRotation.xyz;
  let baseScale = input.posHighAndScale.w;
  let rotation = input.posLowAndRotation.w;
  let basePixelOffset = input.compressedAttr0.xy;
  let billboardWidth = input.miscFlags.z;
  let billboardHeight = input.miscFlags.w;

  // Current-frame center clip (RTE).
  let positionRTE = translateRelativeToEye(
    posHigh, posLow, camera.encodedCameraHigh, camera.encodedCameraLow);
  let currentCenterClip = camera.mvpRelativeToEye * vec4<f32>(positionRTE, 1.0);

  // Previous-frame center clip — full-mat4 multiply of the world-space
  // position. Precision loss at planet scale is acceptable here because
  // the resulting NDC delta is small and TAA's velocity scale tolerates
  // it. (Model uses the same pattern at ModelPBRComplete.wgsl:769-770.)
  let prevPosHigh = input.prevPosHighAndScale.xyz;
  let prevPosLow = input.prevPosLowAndRotation.xyz;
  let prevWorldPos = vec4<f32>(prevPosHigh + prevPosLow, 1.0);
  let prevCenterClip = camera.previousViewProjection * prevWorldPos;

  // Rasterize the quad at the CURRENT-frame position so the velocity
  // texture covers the same pixels the color pass touched. (Sampling
  // velocity at the current pixel returns this fragment's NDC delta.)
  var clipPos = currentCenterClip;

  let cornerIndex = input.vertexIndex % 6u;
  var corner = QUAD_OFFSETS[cornerIndex];
  if (abs(rotation) > 0.001) {
    let cosR = cos(rotation);
    let sinR = sin(rotation);
    corner = vec2<f32>(
      corner.x * cosR - corner.y * sinR,
      corner.x * sinR + corner.y * cosR
    );
  }
  let size = vec2<f32>(billboardWidth, billboardHeight) * baseScale;
  // Use the same CSS-px to device-px conversion as the color VS so the
  // velocity quad covers exactly the pixels the color pass
  // rasterized.
  let pixelToClip = (2.0 * camera.highResMultiplier) / camera.viewportSize;
  clipPos.x += (corner.x * size.x + basePixelOffset.x) * pixelToClip.x * clipPos.w;
  clipPos.y += (corner.y * size.y + basePixelOffset.y) * pixelToClip.y * clipPos.w;

  output.position = clipPos;
  output.currentCenterClip = currentCenterClip;
  output.prevCenterClip = prevCenterClip;
  //>>ifdef LOG_DEPTH
  output.v_logDepth = csm_vertexLogDepth(output.position, camera.logDepthNear);
  output.position = csm_updatePositionDepth(output.position);
  //>>endif
  return output;
}

struct VelocityFragOutput {
  @location(0) velocity: vec2<f32>,
  //>>ifdef LOG_DEPTH
  @builtin(frag_depth) depth: f32,
  //>>endif
};

@fragment
fn fragmentVelocityMain(input: VelocityVertexOutput) -> VelocityFragOutput {
  var out: VelocityFragOutput;
  //>>ifdef LOG_DEPTH
  out.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepthFactor);
  //>>endif
  // Guard against degenerate clip-space w (off-screen / behind camera).
  // When prev or current is degenerate, emit zero velocity so TAA falls
  // back to camera-only reprojection for this fragment.
  let curW = input.currentCenterClip.w;
  let prevW = input.prevCenterClip.w;
  if (curW <= 0.0 || prevW <= 0.0) {
    out.velocity = vec2<f32>(0.0);
    return out;
  }
  let curNdc = input.currentCenterClip.xy / curW;
  let prevNdc = input.prevCenterClip.xy / prevW;
  out.velocity = curNdc - prevNdc;
  return out;
}
