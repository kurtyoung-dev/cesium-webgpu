// BillboardCollectionSDF.wgsl — Billboard rendering with SDF text support
// Extends BillboardCollection.wgsl with signed distance field rendering
// for antialiased text with outlines (used by LabelCollection).
//
// Instance data layout (192 bytes per billboard, 12 x vec4 — Batch 137):
//   @location(0)  posHighAndScale:           vec4<f32>
//   @location(1)  posLowAndRotation:         vec4<f32>
//   @location(2)  compressedAttr0:           vec4<f32> — pixelOffset.xy, alignedAxis.xy
//   @location(3)  compressedAttr1:           vec4<f32> — imageRect (x,y,w,h normalized)
//   @location(4)  color:                     vec4<f32> — fill color rgba
//   @location(5)  miscFlags:                 vec4<f32> — show, sizeInMeters, width, height
//   @location(6)  outlineColor:              vec4<f32> — outline color rgba
//   @location(7)  sdfParams:                 vec4<f32> — outlineWidth, sdfEdge, 0, 0
//   @location(8)  perInstanceFlags:          vec4<f32> — disableDepthTestDistance,
//                                              splitDirection,
//                                              distanceDisplayConditionNearSq,
//                                              distanceDisplayConditionFarSq
//   @location(9)  translucencyByDistance:    vec4<f32> — near, nearAlpha, far, farAlpha
//   @location(10) pixelOffsetScaleByDistance: vec4<f32> — near, nearScale, far, farScale
//   @location(11) scaleByDistance:           vec4<f32> — near, nearScale, far, farScale
//
// Batch 21 added @location(8) `perInstanceFlags` for DP-H42 / DP-H40.
// Batch 137 (Audit A.14 finish) extended with DDC packed into
// `perInstanceFlags.zw` plus three NearFarScalars at @locations 9/10/11.
// All gates are read only inside `//>>ifdef` blocks so the SDF fast
// path pays nothing when those features are off.

struct CameraUniforms {
  mvpRelativeToEye: mat4x4<f32>,
  viewRotation: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  viewportSize: vec2<f32>,
  highResMultiplier: f32,
  // Batch 138 (VS_THREE_POINT_DEPTH_CHECK) — `_threePointDepthTestDistance`
  // in meters; squared in shader. Same UBO position as base Billboard
  // (slot 43, was `_pad2`).
  threePointDepthTestDistance: f32,
  minimumDisableDepthTestDistance: f32,
  splitPosition: f32,
      previousViewProjection: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var atlasTexture: texture_2d<f32>;
@group(0) @binding(2) var atlasSampler: sampler;
// Batch 138 (VS_THREE_POINT_DEPTH_CHECK) — globe depth (packed-rgba)
// + sampler for terrain occlusion of clamp-to-ground labels.
@group(0) @binding(3) var globeDepthTex: texture_2d<f32>;
@group(0) @binding(4) var globeDepthSampler: sampler;

struct VertexInput {
  @builtin(vertex_index) vertexIndex: u32,
  @location(0) posHighAndScale: vec4<f32>,
  @location(1) posLowAndRotation: vec4<f32>,
  @location(2) compressedAttr0: vec4<f32>,
  @location(3) compressedAttr1: vec4<f32>,
  @location(4) color: vec4<f32>,
  @location(5) miscFlags: vec4<f32>,
  @location(6) outlineColor: vec4<f32>,
  @location(7) sdfParams: vec4<f32>,
  @location(8) perInstanceFlags: vec4<f32>,
  @location(9) translucencyByDistance: vec4<f32>,
  @location(10) pixelOffsetScaleByDistance: vec4<f32>,
  @location(11) scaleByDistance: vec4<f32>,
  // Batch 138 (VS_THREE_POINT_DEPTH_CHECK) — depthOrigin + enable.
  @location(12) threePointAttribs: vec4<f32>,
};

// AUDIT_2026_05_02 A.14 (Batch 137) — `czm_nearFarScalar` for the
// SDF / Label path. Identical implementation to the base Billboard
// shader so labels behave consistently with point/billboard primitives
// under camera-distance ramps.
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
  @location(1) fillColor: vec4<f32>,
  @location(2) outlineColor: vec4<f32>,
  @location(3) sdfParams: vec2<f32>, // outlineWidth, sdfEdge
  //>>ifdef SPLIT_ENABLED
  @location(4) splitDirection: f32,
  //>>endif
};

fn translateRelativeToEye(posHigh: vec3<f32>, posLow: vec3<f32>, camHigh: vec3<f32>, camLow: vec3<f32>) -> vec3<f32> {
  return (posHigh - camHigh) + (posLow - camLow);
}

// Batch 138 (VS_THREE_POINT_DEPTH_CHECK) — see BillboardCollection.wgsl
// for full comment block. Identical implementation copied here
// because WGSL doesn't share helpers across files; future refactor
// could extract to a shared chunk.
fn czm_unpackDepth(packedDepth: vec4<f32>) -> f32 {
  return dot(
    packedDepth,
    vec4<f32>(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0),
  );
}

// Batch 139 — see BillboardCollection.wgsl for the full helper
// design (NDC-z return + addScreenSpaceOffsetClip companion).
fn getGlobeNdcDepth(clipPos: vec4<f32>) -> f32 {
  if (clipPos.w <= 0.0) {
    return 0.0;
  }
  let ndc = clipPos.xy / clipPos.w;
  let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 1.0 - (ndc.y * 0.5 + 0.5));
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return 0.0;
  }
  let packed = textureSampleLevel(globeDepthTex, globeDepthSampler, uv, 0.0);
  return czm_unpackDepth(packed);
}

// Batch 139 (4th-pass audit fix) — see BillboardCollection.wgsl for
// the full WebGL-parity math note. `originScale` removes the
// spurious negation that the 3rd-pass version introduced.
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
  // 4th-pass audit fix — only halfSizeOffset rotates; originTranslate
  // and pixelOffset stay un-rotated, matching WebGL
  // `BillboardCollectionVS.glsl:73-84`.
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
    output.position = vec4<f32>(0.0, 0.0, -2.0, 1.0);
    output.texCoord = vec2<f32>(0.0);
    output.fillColor = vec4<f32>(0.0);
    output.outlineColor = vec4<f32>(0.0);
    output.sdfParams = vec2<f32>(0.0);
    //>>ifdef SPLIT_ENABLED
    // Struct init guard so WGSL doesn't flag the hidden-branch return as
    // leaving `splitDirection` uninitialised.
    output.splitDirection = 0.0;
    //>>endif
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

  let positionRTE = translateRelativeToEye(posHigh, posLow, camera.encodedCameraHigh, camera.encodedCameraLow);
  var clipPos = camera.mvpRelativeToEye * vec4<f32>(positionRTE, 1.0);

  // AUDIT_2026_05_02 A.14 (Batch 137) — squared eye distance, hoisted
  // for the four distance-aware gates below.
  let camDistSq = dot(positionRTE, positionRTE);

  // AUDIT_2026_05_02 A.14 (Batch 137) — apply EYE_DISTANCE_SCALING
  // BEFORE the corner expansion so the label glyph collapses cleanly
  // when the user's `label.scaleByDistance.farValue=0`. Mirrors the
  // base BillboardCollection.wgsl path.
  var effectiveScale: f32 = baseScale;
  //>>ifdef EYE_DISTANCE_SCALING
  let distScale = czm_nearFarScalar(input.scaleByDistance, camDistSq);
  effectiveScale = effectiveScale * distScale;
  if (distScale == 0.0) {
    clipPos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }
  //>>endif

  // AUDIT_2026_05_02 A.14 (Batch 137) — apply EYE_DISTANCE_PIXEL_OFFSET
  // before the offset is added to clip space.
  var effectivePixelOffset: vec2<f32> = basePixelOffset;
  //>>ifdef EYE_DISTANCE_PIXEL_OFFSET
  let pxScale = czm_nearFarScalar(input.pixelOffsetScaleByDistance, camDistSq);
  effectivePixelOffset = effectivePixelOffset * pxScale;
  //>>endif

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

  let size = vec2<f32>(billboardWidth, billboardHeight) * effectiveScale;
  let pixelToClip = 2.0 / camera.viewportSize;
  clipPos.x += (corner.x * size.x + effectivePixelOffset.x) * pixelToClip.x * clipPos.w;
  clipPos.y += (corner.y * size.y + effectivePixelOffset.y) * pixelToClip.y * clipPos.w;

  //>>ifdef DISTANCE_DISPLAY_CONDITION
  // AUDIT_2026_05_02 A.14 (Batch 137) — DDC gate. Out-of-window
  // labels collapse to a degenerate clip-pos. Critical for KML labels
  // that should disappear at far zoom.
  let nearSqDDC = input.perInstanceFlags.z;
  let farSqDDC = input.perInstanceFlags.w;
  if (camDistSq < nearSqDDC || camDistSq > farSqDDC) {
    clipPos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }
  //>>endif

  //>>ifdef DISABLE_DEPTH_DISTANCE
  // DP-H42 — same logic as BillboardCollection.wgsl. Batch 139
  // (4th-pass audit) — raw-sentinel pattern. Batch 219 — "render on top"
  // is the WebGPU NEAR plane (NDC z = 0, depth range [0,1] / less-equal
  // compare), NOT z = w (that is the FAR plane and pushes the label
  // BEHIND everything). Matches the billboard + point bug-3 fix.
  let disableRawDP = input.perInstanceFlags.x;
  if (disableRawDP < 0.0) {
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
  // Batch 138 + Batch 139 — full three-point depth check for clamp-to-
  // ground labels. Mirrors BillboardCollection.wgsl. Critical for
  // KML/GeoJSON labels with `heightReference: CLAMP_TO_GROUND` to hide
  // behind hills.
  let threshSqLabel =
    camera.threePointDepthTestDistance *
    camera.threePointDepthTestDistance;
  // Batch 139 (NEW-VS-THREE-POINT-DISABLE-DEPTH-INTERACTION) — same
  // disable-depth-distance escape hatch as Billboard. Raw-value
  // sentinel check BEFORE squaring (the original draft squared first
  // and the `< 0` check could never fire).
  var enableDepthCheckLabel = input.threePointAttribs.z;
  let disableRawLabel = input.perInstanceFlags.x;
  if (disableRawLabel < 0.0) {
    enableDepthCheckLabel = 0.0;
  } else if (disableRawLabel != 0.0) {
    let disableDepthSqLabel = disableRawLabel * disableRawLabel;
    if (camDistSq < disableDepthSqLabel) {
      enableDepthCheckLabel = 0.0;
    }
  } else if (camera.minimumDisableDepthTestDistance != 0.0) {
    let frameMinSqLabel =
      camera.minimumDisableDepthTestDistance *
      camera.minimumDisableDepthTestDistance;
    if (camDistSq < frameMinSqLabel) {
      enableDepthCheckLabel = 0.0;
    }
  }
  if (
    threshSqLabel > 0.0 &&
    camDistSq < threshSqLabel &&
    enableDepthCheckLabel > 0.5
  ) {
    let depthOriginLabel = input.threePointAttribs.xy;
    let anchorClipLabel = camera.mvpRelativeToEye * vec4<f32>(positionRTE, 1.0);
    let labelSize3PD =
      vec2<f32>(billboardWidth, billboardHeight) * effectiveScale;
    let ndcBias = 0.0001;

    // Sample-point directions: BL / TL / TR. depthOrigin is the
    // label-side anchor (LEFT/CENTER/RIGHT × TOP/CENTER/BOTTOM).
    let pClip1 = addScreenSpaceOffsetClip(
      anchorClipLabel,
      vec2<f32>(0.0, 0.0),
      depthOriginLabel,
      labelSize3PD,
      effectivePixelOffset,
      rotation,
      pixelToClip,
    );
    let depth1 = getGlobeNdcDepth(pClip1);
    let labelNdcZ1 = pClip1.z / pClip1.w;
    if (depth1 != 0.0 && labelNdcZ1 > depth1 + ndcBias) {
      let pClip2 = addScreenSpaceOffsetClip(
        anchorClipLabel,
        vec2<f32>(0.0, 1.0),
        depthOriginLabel,
        labelSize3PD,
        effectivePixelOffset,
        rotation,
        pixelToClip,
      );
      let depth2 = getGlobeNdcDepth(pClip2);
      let labelNdcZ2 = pClip2.z / pClip2.w;
      if (depth2 != 0.0 && labelNdcZ2 > depth2 + ndcBias) {
        let pClip3 = addScreenSpaceOffsetClip(
          anchorClipLabel,
          vec2<f32>(1.0, 1.0),
          depthOriginLabel,
          labelSize3PD,
          effectivePixelOffset,
          rotation,
          pixelToClip,
        );
        let depth3 = getGlobeNdcDepth(pClip3);
        let labelNdcZ3 = pClip3.z / pClip3.w;
        if (depth3 != 0.0 && labelNdcZ3 > depth3 + ndcBias) {
          clipPos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
        }
      }
    }
  }
  //>>endif

  output.position = clipPos;

  //>>ifdef SPLIT_ENABLED
  output.splitDirection = input.perInstanceFlags.y;
  //>>endif

  let baseUV = QUAD_UVS[cornerIndex];
  output.texCoord = vec2<f32>(
    imageRect.x + baseUV.x * imageRect.z,
    imageRect.y + baseUV.y * imageRect.w
  );

  // AUDIT_2026_05_02 A.14 (Batch 137) — translucencyByDistance ramp
  // applied to BOTH fill and outline alpha so the label fades
  // coherently. translucency=0 → vertex pushed behind the near plane
  // (matches WebGL) and the FS will discard via the smoothstep alpha
  // anyway when the per-vertex alpha is zero.
  var alphaMultiplier: f32 = 1.0;
  //>>ifdef EYE_DISTANCE_TRANSLUCENCY
  let translucency = czm_nearFarScalar(input.translucencyByDistance, camDistSq);
  alphaMultiplier = translucency;
  if (translucency == 0.0) {
    output.position = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }
  //>>endif
  output.fillColor = vec4<f32>(input.color.rgb, input.color.a * alphaMultiplier);
  output.outlineColor = vec4<f32>(
    input.outlineColor.rgb,
    input.outlineColor.a * alphaMultiplier,
  );
  output.sdfParams = input.sdfParams.xy; // outlineWidth, sdfEdge
  return output;
}

// SDF rendering: distance field is stored in the red channel of the atlas
// SDF_EDGE is the distance value at the glyph boundary (1.0 - CUTOFF = 0.75)
fn getSDFColor(
  texCoord: vec2<f32>,
  fillColor: vec4<f32>,
  outlineColor: vec4<f32>,
  outlineWidth: f32,
  sdfEdge: f32,
  smoothing: f32,
) -> vec4<f32> {
  let distance = textureSample(atlasTexture, atlasSampler, texCoord).r;

  if (outlineWidth > 0.0) {
    // Outline edge: move inward from the glyph edge
    let outlineEdge = clamp(sdfEdge - outlineWidth, 0.0, sdfEdge);
    // Transition from outline to fill at the SDF edge
    let outlineFactor = smoothstep(sdfEdge - smoothing, sdfEdge + smoothing, distance);
    let sdfColor = mix(outlineColor, fillColor, outlineFactor);
    // Alpha: glyph visible from outline edge outward
    let alpha = smoothstep(outlineEdge - smoothing, outlineEdge + smoothing, distance);
    return vec4<f32>(sdfColor.rgb, sdfColor.a * alpha);
  } else {
    // No outline — simple fill with antialiased edge
    let alpha = smoothstep(sdfEdge - smoothing, sdfEdge + smoothing, distance);
    return vec4<f32>(fillColor.rgb, fillColor.a * alpha);
  }
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  //>>ifdef SPLIT_ENABLED
  // DP-H40 — discard pixels on the wrong side of the split cutoff before
  // doing any SDF math. Same convention as BillboardCollection.wgsl.
  if (input.splitDirection < 0.0 && input.position.x > camera.splitPosition) {
    discard;
  }
  if (input.splitDirection > 0.0 && input.position.x < camera.splitPosition) {
    discard;
  }
  //>>endif

  let outlineWidth = input.sdfParams.x;
  let sdfEdge = input.sdfParams.y;

  // Smoothing based on screen-space derivatives for resolution-independent AA
  let dx = dpdx(input.texCoord);
  let dy = dpdy(input.texCoord);
  let smoothing = length(vec2<f32>(length(dx), length(dy))) * 1.4142;

  // 5-tap supersampling: center + 4 diagonal neighbors
  let sampleOffset = 0.354 * (dx + dy);

  let center = getSDFColor(input.texCoord, input.fillColor, input.outlineColor, outlineWidth, sdfEdge, smoothing);
  let c1 = getSDFColor(input.texCoord + vec2<f32>(sampleOffset.x, sampleOffset.y), input.fillColor, input.outlineColor, outlineWidth, sdfEdge, smoothing);
  let c2 = getSDFColor(input.texCoord + vec2<f32>(-sampleOffset.x, sampleOffset.y), input.fillColor, input.outlineColor, outlineWidth, sdfEdge, smoothing);
  let c3 = getSDFColor(input.texCoord + vec2<f32>(-sampleOffset.x, -sampleOffset.y), input.fillColor, input.outlineColor, outlineWidth, sdfEdge, smoothing);
  let c4 = getSDFColor(input.texCoord + vec2<f32>(sampleOffset.x, -sampleOffset.y), input.fillColor, input.outlineColor, outlineWidth, sdfEdge, smoothing);

  var color = (center + c1 + c2 + c3 + c4) * 0.2;

  if (color.a < 0.005) {
    discard;
  }

  return color;
}

// AUDIT_2026_05_02 B.10 (Batch 144, NEW-COLLECTIONS-MOTION-VECTORS) —
// per-pixel velocity emission for animated labels. Mirrors the
// Billboard pattern from Batch 143; see `BillboardCollection.wgsl`
// for the full design notes (center-only delta, prev-instance VB at
// slot 1, w<=0 fallback).
//
// Label SDF instance buffer uses locations 0-12 for current data, so
// prev-position locations start at 13 / 14.

struct VelocityVertexInput {
  @builtin(vertex_index) vertexIndex: u32,
  // Slot 0: current instance data (mirrors regular VertexInput).
  @location(0) posHighAndScale: vec4<f32>,
  @location(1) posLowAndRotation: vec4<f32>,
  @location(2) compressedAttr0: vec4<f32>,
  @location(3) compressedAttr1: vec4<f32>,
  @location(4) color: vec4<f32>,
  @location(5) miscFlags: vec4<f32>,
  @location(6) outlineColor: vec4<f32>,
  @location(7) sdfParams: vec4<f32>,
  @location(8) perInstanceFlags: vec4<f32>,
  @location(9) translucencyByDistance: vec4<f32>,
  @location(10) pixelOffsetScaleByDistance: vec4<f32>,
  @location(11) scaleByDistance: vec4<f32>,
  @location(12) threePointAttribs: vec4<f32>,
  // Slot 1: prev-frame instance data — only positions matter for
  // center-delta velocity. The renderer binds the prev-instance buffer
  // (one frame of lag on the same SDF instance stride) at this slot.
  @location(13) prevPosHighAndScale: vec4<f32>,
  @location(14) prevPosLowAndRotation: vec4<f32>,
};

struct VelocityVertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) currentCenterClip: vec4<f32>,
  @location(1) prevCenterClip: vec4<f32>,
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
  let glyphWidth = input.miscFlags.z;
  let glyphHeight = input.miscFlags.w;

  // Current-frame center clip via RTE.
  let positionRTE = translateRelativeToEye(
    posHigh, posLow, camera.encodedCameraHigh, camera.encodedCameraLow);
  let currentCenterClip = camera.mvpRelativeToEye * vec4<f32>(positionRTE, 1.0);

  // Previous-frame center clip via full mat4 (precision loss at
  // planet scale acceptable for NDC delta magnitudes).
  let prevPosHigh = input.prevPosHighAndScale.xyz;
  let prevPosLow = input.prevPosLowAndRotation.xyz;
  let prevWorldPos = vec4<f32>(prevPosHigh + prevPosLow, 1.0);
  let prevCenterClip = camera.previousViewProjection * prevWorldPos;

  // Rasterize the glyph quad at the CURRENT-frame position so the
  // velocity texture covers the same pixels the color pass touched.
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
  let size = vec2<f32>(glyphWidth, glyphHeight) * baseScale;
  let pixelToClip = 2.0 / camera.viewportSize;
  clipPos.x += (corner.x * size.x + basePixelOffset.x) * pixelToClip.x * clipPos.w;
  clipPos.y += (corner.y * size.y + basePixelOffset.y) * pixelToClip.y * clipPos.w;

  output.position = clipPos;
  output.currentCenterClip = currentCenterClip;
  output.prevCenterClip = prevCenterClip;
  return output;
}

@fragment
fn fragmentVelocityMain(input: VelocityVertexOutput) -> @location(0) vec2<f32> {
  let curW = input.currentCenterClip.w;
  let prevW = input.prevCenterClip.w;
  if (curW <= 0.0 || prevW <= 0.0) {
    return vec2<f32>(0.0);
  }
  let curNdc = input.currentCenterClip.xy / curW;
  let prevNdc = input.prevCenterClip.xy / prevW;
  return curNdc - prevNdc;
}
