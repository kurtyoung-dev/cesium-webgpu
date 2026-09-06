// BillboardCollectionPick.wgsl — Pick shader for instanced billboard rendering
// Same vertex logic as BillboardCollection.wgsl but outputs pick color instead of texture.
//
// Instance data layout (160 bytes per billboard, 10 x vec4):
//   @location(0) posHighAndScale:           vec4<f32> — encodedPosition.high.xyz, uniformScale
//   @location(1) posLowAndRotation:         vec4<f32> — encodedPosition.low.xyz, rotation
//   @location(2) compressedAttr0:           vec4<f32> — pixelOffset.xy, alignedAxis.xy
//   @location(3) compressedAttr1:           vec4<f32> — imageRect (x,y,w,h in atlas, normalized)
//   @location(4) pickColor:                 vec4<f32> — pick ID rgba
//   @location(5) miscFlags:                 vec4<f32> — show, sizeInMeters, width, height
//   @location(6) perInstanceFlags:          vec4<f32> — disableDepthTestDistance,
//                                            splitDirection,
//                                            distanceDisplayConditionNearSq,
//                                            distanceDisplayConditionFarSq
//   @location(7) translucencyByDistance:    vec4<f32> — near, nearAlpha, far, farAlpha
//   @location(8) pixelOffsetScaleByDistance: vec4<f32> — near, nearScale, far, farScale
//   @location(9) scaleByDistance:           vec4<f32> — near, nearScale, far, farScale
//
// The pick path applies disable-depth distance, split clipping, DDC,
// translucency, pixel offset, and scaling the same way the color path does so
// the picked region matches the visible one. A billboard with zero
// translucency, zero scale, or an out-of-window DDC must not pick;
// `clipPos = (0,0,0,1)` collapses the quad so it cannot rasterize.

struct CameraUniforms {
  mvpRelativeToEye: mat4x4<f32>,
  viewRotation: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  // The pick pipeline reuses the color bind group and the same camera UB as
  // the color path. Padding lanes carry the log-depth encode frustum (near at
  // float 35, far at float 39) and float 46 carries the factor without
  // changing the byte layout. Only the `//>>ifdef LOG_DEPTH` pick module reads
  // them; the hyperbolic pick module never does. See BillboardCollection.wgsl
  // (color).
  logDepthNear: f32,
  encodedCameraLow: vec3<f32>,
  logDepthFar: f32,
  viewportSize: vec2<f32>,
  highResMultiplier: f32,
  _pad2: f32,
  minimumDisableDepthTestDistance: f32,
  splitPosition: f32,
  // Log-depth factor (oneOverLog2FarDepthFromNearPlusOne) at float 46 +
  // reserved float 47 — previously implicit padding before
  // `previousViewProjection`'s 16-byte alignment, so struct size / offsets are
  // unchanged.
  logDepthFactor: f32,
  _padLog: f32,
      previousViewProjection: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var atlasTexture: texture_2d<f32>;
@group(0) @binding(2) var atlasSampler: sampler;

//>>ifdef LOG_DEPTH
// Canonical inline log-depth helpers matching BillboardCollection.wgsl. They
// are compiled into the pick module only when `isWebGPUPickLogDepthActive` is
// true; inactive preprocessing leaves the non-log module's byte sequence
// unchanged.
fn csm_vertexLogDepth(clipPosition: vec4<f32>, near: f32) -> f32 {
  return (clipPosition.w - near) + 1.0;
}
fn csm_updatePositionDepth(clipPosition: vec4<f32>) -> vec4<f32> {
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
  @location(4) pickColor: vec4<f32>,
  @location(5) miscFlags: vec4<f32>,
  @location(6) perInstanceFlags: vec4<f32>,
  @location(7) translucencyByDistance: vec4<f32>,
  @location(8) pixelOffsetScaleByDistance: vec4<f32>,
  @location(9) scaleByDistance: vec4<f32>,
};

// `czm_nearFarScalar` for the pick path. Its implementation matches the color
// path so a primitive's distance-aware visibility is mirrored exactly.
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

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) texCoord: vec2<f32>,
  @location(1) pickColor: vec4<f32>,
  //>>ifdef SPLIT_ENABLED
  @location(2) splitDirection: f32,
  //>>endif
  //>>ifdef LOG_DEPTH
  // Interpolated linear depthFromNearPlusOne;
  // the pick FS converts it to frag_depth (matches the color sibling's varying).
  @location(3) v_logDepth: f32,
  //>>endif
};

fn translateRelativeToEye(posHigh: vec3<f32>, posLow: vec3<f32>, camHigh: vec3<f32>, camLow: vec3<f32>) -> vec3<f32> {
  return (posHigh - camHigh) + (posLow - camLow);
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

// Use the color pass's v orientation for the pick quad so atlas-alpha discard
// rejects the same transparent pixels that the color pass leaves invisible.
// See `BillboardCollection.wgsl` for the coordinate derivation.
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
    output.pickColor = vec4<f32>(0.0);
    return output;
  }

  let posHigh = input.posHighAndScale.xyz;
  let posLow = input.posLowAndRotation.xyz;
  let baseScale = input.posHighAndScale.w;
  let rotation = input.posLowAndRotation.w;
  let basePixelOffset = input.compressedAttr0.xy;
  let imageRect = input.compressedAttr1;
  let billboardWidth = input.miscFlags.z;
  let billboardHeight = input.miscFlags.w;

  // RTE position to clip space
  let positionRTE = translateRelativeToEye(posHigh, posLow, camera.encodedCameraHigh, camera.encodedCameraLow);
  var clipPos = camera.mvpRelativeToEye * vec4<f32>(positionRTE, 1.0);

  // Hoist the squared eye distance because the distance-aware gates reuse it.
  let camDistSq = dot(positionRTE, positionRTE);

  // Apply EYE_DISTANCE_SCALING
  // before the corner expansion so a `scaleByDistance.farValue=0`
  // billboard collapses and is unpickable. Mirrors the color path.
  var effectiveScale: f32 = baseScale;
  //>>ifdef EYE_DISTANCE_SCALING
  let distScale = czm_nearFarScalar(input.scaleByDistance, camDistSq);
  effectiveScale = effectiveScale * distScale;
  if (distScale == 0.0) {
    clipPos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }
  //>>endif

  // Apply EYE_DISTANCE_PIXEL_OFFSET before the pixel-to-clip conversion so
  // the pick path remains aligned with the color path.
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

  // Convert CSS-pixel offsets to clip space. Pick quads must cover the same
  // device pixels as the color pass so picks land on the rendered billboard.
  // Bake pixelRatio (highResMultiplier) into the CSS-px to device-px
  // conversion; see BillboardCollection.wgsl.
  let pixelToClip = (2.0 * camera.highResMultiplier) / camera.viewportSize;
  clipPos.x += (corner.x * size.x + effectivePixelOffset.x) * pixelToClip.x * clipPos.w;
  clipPos.y += (corner.y * size.y + effectivePixelOffset.y) * pixelToClip.y * clipPos.w;

  //>>ifdef DISTANCE_DISPLAY_CONDITION
  // Out-of-window DDC billboards collapse to a degenerate clip position so the
  // pick fragment never rasterizes.
  let nearSqDDC = input.perInstanceFlags.z;
  let farSqDDC = input.perInstanceFlags.w;
  if (camDistSq < nearSqDDC || camDistSq > farSqDDC) {
    clipPos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }
  //>>endif

  //>>ifdef DISABLE_DEPTH_DISTANCE
  // Check the raw sentinel before squaring so
  // `disableDepthTestDistance = Infinity` (packed as -1) retains its sign.
  //
  // The pick pass overrides depth to the NEAR plane, exactly as the color pass
  // does. WebGL has no colour/pick split to reproduce here: one vertex shader
  // (`BillboardCollectionVS.glsl`) serves both passes, and `Scene`'s pick
  // derivation replaces only the fragment stage, so `gl_Position.z =
  // -gl_Position.w` — the WebGL near plane — is what the WebGL pick pass gets.
  // The WebGPU pick pass rasterizes globe terrain into the same depth target
  // (`WebGPUGlobeSurfaceRenderer` dispatches the terrain pick pipeline), so a
  // far-plane pick fragment loses `less-equal` against terrain and the
  // billboard is unpickable — which is the whole behaviour the property exists
  // to defeat.
  // WebGL-parity clip guard (BillboardCollectionVS.glsl:340-344). The override
  // is a WRITE, not a test: `clipPos.z = 0.0` pulls a vertex whose z was
  // outside [0, w] — nearer than the near plane, or past the far plane, at
  // positive w — back INSIDE the clip volume, so the API rasterizes a fragment
  // WebGL leaves clipped. Guarding on the pre-override z is what stops that.
  // A w <= 0 vertex is clipped on both backends whatever z the block writes;
  // the w test is upstream's own, because z/w is not a valid comparison at
  // non-positive w. WebGL spells the same test in its [-1, 1] convention as
  // `zclip < -1.0 || zclip > 1.0`; WebGPU clip z is [0, w], so the low bound
  // is 0.0. `select` yields the out-of-volume sentinel so a w <= 0 divide
  // never reaches the comparison.
  let zclipDPick = select(-1.0, clipPos.z / clipPos.w, clipPos.w > 0.0);
  if (zclipDPick >= 0.0 && zclipDPick <= 1.0) {
    let disableRawDPick = input.perInstanceFlags.x;
    if (disableRawDPick < 0.0) {
      clipPos.z = 0.0;
    } else if (disableRawDPick != 0.0) {
      let disableDepthSqDPick = disableRawDPick * disableRawDPick;
      if (camDistSq < disableDepthSqDPick) {
        clipPos.z = 0.0;
      }
    } else if (camera.minimumDisableDepthTestDistance != 0.0) {
      let frameMinSqDPick =
        camera.minimumDisableDepthTestDistance *
        camera.minimumDisableDepthTestDistance;
      if (camDistSq < frameMinSqDPick) {
        clipPos.z = 0.0;
      }
    }
  }
  //>>endif

  // A billboard with zero translucency is unpickable.
  // For partial translucency (0 < t < 1) the pick still fires because
  // the user can still see and interact with the billboard.
  //>>ifdef EYE_DISTANCE_TRANSLUCENCY
  let translucency = czm_nearFarScalar(input.translucencyByDistance, camDistSq);
  if (translucency == 0.0) {
    clipPos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }
  //>>endif

  output.position = clipPos;

  //>>ifdef SPLIT_ENABLED
  output.splitDirection = input.perInstanceFlags.y;
  //>>endif

  // Texture coordinates from atlas rect (used for alpha discard)
  let baseUV = QUAD_UVS[cornerIndex];
  output.texCoord = vec2<f32>(
    imageRect.x + baseUV.x * imageRect.z,
    imageRect.y + baseUV.y * imageRect.w
  );

  output.pickColor = input.pickColor;

  //>>ifdef LOG_DEPTH
  // Mirror BillboardCollection.wgsl's color block. Compute this after every
  // clipPos override above. A forced z == 0 (near-plane / hide collapse) maps to
  // v_logDepth = 1.0; every other case takes the general encode.
  if (output.position.z == 0.0) {
    output.v_logDepth = 1.0;
  } else {
    output.v_logDepth = csm_vertexLogDepth(output.position, camera.logDepthNear);
  }
  output.position = csm_updatePositionDepth(output.position);
  //>>endif

  return output;
}

// Shared pick output. Without LOG_DEPTH this single-field struct is
// byte-equivalent to the bare `-> @location(0) vec4<f32>` return. With
// LOG_DEPTH it also carries the color sibling's log-encoded
// `@builtin(frag_depth)`, keeping depth tests coherent in the shared pick
// framebuffer.
struct PickFragOutput {
  @location(0) color: vec4<f32>,
  //>>ifdef LOG_DEPTH
  @builtin(frag_depth) depth: f32,
  //>>endif
};

@fragment
fn fragmentMain(input: VertexOutput) -> PickFragOutput {
  //>>ifdef SPLIT_ENABLED
  if (input.splitDirection < 0.0 && input.position.x > camera.splitPosition) {
    discard;
  }
  if (input.splitDirection > 0.0 && input.position.x < camera.splitPosition) {
    discard;
  }
  //>>endif

  // Sample atlas texture for alpha — discard transparent pixels
  let texAlpha = textureSample(atlasTexture, atlasSampler, input.texCoord).a;
  if (texAlpha < 0.005) {
    discard;
  }
  // Output pick color (ID encoded as RGBA)
  var out: PickFragOutput;
  out.color = input.pickColor;
  //>>ifdef LOG_DEPTH
  out.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepthFactor);
  //>>endif
  return out;
}
