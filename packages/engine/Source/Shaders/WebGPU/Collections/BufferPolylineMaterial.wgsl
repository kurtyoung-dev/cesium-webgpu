// BufferPolylineMaterial.wgsl — WebGPU port of BufferPolylineMaterialVS/FS.glsl
// Renders buffer-backed polylines as screen-space thick quads with RTE precision.
// Each line segment is expanded into a quad using prev/next positions for
// miter-join direction computation. Matches upstream GLSL miter logic.
//
// Attributes: current/prev/next positions as high/low RTE pairs, packed
// show/color/width/texCoord, and pick color.

#import CameraUniforms;
#import csm_translateRelativeToEye;
#import csm_vertexLogDepth;
#import csm_writeLogDepth;
#import csm_decodeRGB8;
#import csm_metersPerPixel;

// ── Uniform buffer ──────────────────────────────────────────────────────────
struct BufferPolylineUniforms {
  pixelRatio : f32,
  padding0   : f32,
  padding1   : f32,
  padding2   : f32,
  viewport   : vec4<f32>, // x,y,width,height in pixels
};

@group(0) @binding(0) var<uniform> camera : CameraUniforms;
@group(1) @binding(0) var<uniform> params : BufferPolylineUniforms;

// ── Vertex input ────────────────────────────────────────────────────────────
struct VertexInput {
  @location(0) positionHigh     : vec3<f32>,
  @location(1) positionLow      : vec3<f32>,
  @location(2) prevPositionHigh : vec3<f32>,
  @location(3) prevPositionLow  : vec3<f32>,
  @location(4) nextPositionHigh : vec3<f32>,
  @location(5) nextPositionLow  : vec3<f32>,
  @location(6) pickColor        : vec4<f32>,
  @location(7) showColorWidthAndTexCoord : vec4<f32>,
  // x=show, y=encodedRGB8(color), z=width, w=texCoord(packed s + direction)
  // The vec4 above is fully saturated (all four lanes used), so material
  // color.alpha rides in a dedicated f32 lane. CPU pack (alphaArr, width 1),
  // GPU layout (arrayStride 4 / float32 / shaderLocation 8) and this field
  // are in lockstep. Mirrors the WebGL `in float alpha` attribute (the GLSL
  // path divides by 255; here we pack normalized alpha in [0,1] directly).
  @location(8) alpha            : f32,
};

// ── Vertex → Fragment ───────────────────────────────────────────────────────
struct VertexOutput {
  @builtin(position) position     : vec4<f32>,
  @location(0) v_pickColor        : vec4<f32>,
  @location(1) v_color            : vec4<f32>,
  @location(2) v_st               : vec2<f32>,
  //>>ifdef LOG_DEPTH
  // Interpolated linear depthFromNearPlusOne; FS converts to frag_depth.
  @location(3) v_logDepth         : f32,
  //>>endif
};

// ── Vertex shader ───────────────────────────────────────────────────────────
@vertex
fn vertexMain(input : VertexInput) -> VertexOutput {
  var output : VertexOutput;

  // Unpack attributes
  let show = input.showColorWidthAndTexCoord.x;
  var color = csm_decodeRGB8(input.showColorWidthAndTexCoord.y);
  // Fold material color.alpha into the RGB decode (csm_decodeRGB8 returns
  // alpha=1). Matches WebGL's `v_color.a *= alpha` (show is applied via the
  // degenerate-position hide below, not an alpha multiply).
  color.a = input.alpha;
  let texCoordPacked = input.showColorWidthAndTexCoord.w;

  // Unpack texCoord: integer part = s coordinate, fractional part encodes direction
  let s = floor(texCoordPacked);
  let direction = sign(fract(texCoordPacked) - 0.5); // -1 or +1

  // RTE positioning for current, previous, and next vertices
  let pCurr = csm_translateRelativeToEye(
    input.positionHigh, input.positionLow,
    camera.encodedCameraPositionMCHigh.xyz, camera.encodedCameraPositionMCLow.xyz
  );
  let pPrev = csm_translateRelativeToEye(
    input.prevPositionHigh, input.prevPositionLow,
    camera.encodedCameraPositionMCHigh.xyz, camera.encodedCameraPositionMCLow.xyz
  );
  let pNext = csm_translateRelativeToEye(
    input.nextPositionHigh, input.nextPositionLow,
    camera.encodedCameraPositionMCHigh.xyz, camera.encodedCameraPositionMCLow.xyz
  );

  let posEC = (camera.modelViewRelativeToEye * pCurr).xyz;
  let prevEC = (camera.modelViewRelativeToEye * pPrev).xyz;
  let nextEC = (camera.modelViewRelativeToEye * pNext).xyz;

  // A negative packed magnitude marks a width in ground METRES rather than
  // CSS pixels — BufferPolylineCollection's `widthUnits`, fixed at
  // construction (no setter). Convention set by the CPU/GLSL oracles this
  // transliterates: renderBufferPolylineCollection.js:174/225 packs the sign,
  // BufferPolylineMaterialVS.glsl:46-52 reads it. abs() recovers the
  // magnitude; the sign decides whether it still needs the metres->pixels
  // conversion below.
  let signedWidth = input.showColorWidthAndTexCoord.z;
  var widthCss = abs(signedWidth);
  if (signedWidth < 0.0) {
    // csm_metersPerPixel needs eye-space position at THIS vertex's depth
    // (metres-per-pixel varies with distance to camera) — the reason this
    // unpack waits for posEC instead of running with the rest of the
    // attribute unpack above, where `width` used to be computed.
    // 1.0e-7 is czm_epsilon7 (GLSL names the constant; this shader has no
    // constants chunk, so the literal is commented instead of left bare).
    widthCss = widthCss / max(
      csm_metersPerPixel(vec4<f32>(posEC, 1.0), params.pixelRatio,
                         params.viewport, camera.projectionMatrix),
      1.0e-7);
  }
  // This shader extrudes in FRAMEBUFFER (device) pixels — params.viewport.zw
  // is context.drawingBufferWidth/Height, not CSS pixels — which is why the
  // pre-existing pixels path already multiplied by params.pixelRatio (kept
  // below as the last step, unchanged). For the metres path the ratio
  // appears TWICE and still cancels correctly: on WebGL,
  // getPolylineWindowCoordinatesEC multiplies the half-width by
  // czm_pixelRatio when it offsets in window coordinates
  // (PolylineCommon.glsl:166), so GLSL's `width` is in CSS pixels, while
  // czm_metersPerPixel(positionEC) returns metres per CSS pixel (metres per
  // device pixel * czm_pixelRatio). So WebGL's device-pixel offset for a
  // metres line works out to metres / (2 * metresPerDevicePixel) — the ratio
  // cancels exactly. Passing params.pixelRatio into csm_metersPerPixel above
  // and then multiplying by it again here reproduces that same
  // cancellation, so a metres-wide line matches WebGL on a HiDPI display and
  // not only at pixelRatio == 1.
  let width = widthCss * params.pixelRatio;

  // Project to clip space
  let clipPos = camera.projectionMatrix * vec4<f32>(posEC, 1.0);
  let prevClip = camera.projectionMatrix * vec4<f32>(prevEC, 1.0);
  let nextClip = camera.projectionMatrix * vec4<f32>(nextEC, 1.0);

  // Convert to screen space for miter computation
  let viewport = params.viewport;
  let screenCurr = (clipPos.xy / clipPos.w) * 0.5 * viewport.zw;
  let screenPrev = (prevClip.xy / prevClip.w) * 0.5 * viewport.zw;
  let screenNext = (nextClip.xy / nextClip.w) * 0.5 * viewport.zw;

  // Compute miter direction
  let dirPrev = normalize(screenCurr - screenPrev);
  let dirNext = normalize(screenNext - screenCurr);
  let tangent = normalize(dirPrev + dirNext);
  let miterDir = vec2<f32>(-tangent.y, tangent.x);

  // Miter length (clamped to avoid spikes)
  let cosHalfAngle = max(dot(miterDir, vec2<f32>(-dirPrev.y, dirPrev.x)), 0.1);
  let miterLen = (width * 0.5) / cosHalfAngle;
  let clampedMiterLen = min(miterLen, width * 2.0);

  // Extrude in screen space
  let extrusion = miterDir * direction * clampedMiterLen;
  let screenOffset = extrusion / (0.5 * viewport.zw);

  output.position = vec4<f32>(
    clipPos.xy + screenOffset * clipPos.w,
    clipPos.z,
    clipPos.w,
  );

  // Hide if not shown
  if (show == 0.0) {
    output.position = vec4<f32>(0.0, 0.0, -2.0, 1.0);
  }

  //>>ifdef LOG_DEPTH
  // NEW-BUFFER-LOG-DEPTH (Batch 263) — log-depth varying + clip-z clamp on the
  // rasterized (extruded) position. near rides in encodedCameraPositionMCHigh.w.
  output.v_logDepth = csm_vertexLogDepth(output.position, camera.encodedCameraPositionMCHigh.w);
  output.position = csm_updatePositionDepth(output.position);
  //>>endif

  output.v_pickColor = input.pickColor;
  output.v_color = color;
  output.v_st = vec2<f32>(s, (direction + 1.0) * 0.5);

  return output;
}

// ── Fragment shader ─────────────────────────────────────────────────────────
//>>ifdef LOG_DEPTH
struct FragOutput {
  @location(0) color : vec4<f32>,
  // Written for the depth TEST too. factor rides in cameraPosition.w.
  @builtin(frag_depth) depth : f32,
};
@fragment
fn fragmentMain(input : VertexOutput) -> FragOutput {
  var outColor = input.v_color;

  if (outColor.a < 0.005) {
    discard;
  }

  var out : FragOutput;
  out.color = outColor;
  out.depth = csm_writeLogDepth(input.v_logDepth, camera.cameraPosition.w);
  return out;
}
//>>else
@fragment
fn fragmentMain(input : VertexOutput) -> @location(0) vec4<f32> {
  var outColor = input.v_color;

  if (outColor.a < 0.005) {
    discard;
  }

  return outColor;
}
//>>endif
