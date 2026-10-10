// BufferPolylineMaterial.wgsl — WebGPU port of BufferPolylineMaterialVS/FS.glsl
// Renders buffer-backed polylines as screen-space thick quads with RTE precision.
// Each vertex is placed by csm_getPolylineWindowCoordinatesEC, the port of the
// getPolylineWindowCoordinatesEC law WebGL's stage calls: the vertex's segment
// is clipped to the near plane, the joint is mitred from the previous and next
// positions, and the vertex is extruded in window coordinates.
//
// Attributes: current/prev/next positions as high/low RTE pairs, packed
// show/color/width/texCoord, alpha, the expand direction, and pick color.

#import CameraUniforms;
#import csm_translateRelativeToEye;
#import csm_polylineCommon;
#import csm_decodeRGB8;
#import csm_metersPerPixel;

// ── Uniform buffer ──────────────────────────────────────────────────────────
struct BufferPolylineUniforms {
  pixelRatio : f32,
  padding0   : f32,
  padding1   : f32,
  padding2   : f32,
  viewport   : vec4<f32>, // x,y,width,height in pixels
  // NDC to window (pixel) coordinates, and window coordinates back to WebGPU
  // clip space: czm_viewportTransformation and czm_viewportOrthographic over
  // the drawing buffer.
  viewportTransformation : mat4x4<f32>,
  viewportOrthographic   : mat4x4<f32>,
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
  // x=show, y=encodedRGB8(color), z=width, w=texCoord (WebGL's j / (jl - 1))
  // The vec4 above is fully saturated (all four lanes used), so material
  // color.alpha rides in a dedicated f32 lane at byte 16 of the same
  // interleaved buffer; the CPU pack, the pipeline's vertex layout and this
  // field are in lockstep. Mirrors the WebGL `in float alpha` attribute (the
  // GLSL path divides by 255; here we pack normalized alpha in [0,1] directly).
  @location(8) alpha            : f32,
  // WebGL's expandDir, gl_VertexID % 2 == 1 ? 1.0 : -1.0: -1.0 for the first
  // copy of each vertex and +1.0 for the second, at byte 20 of the same buffer.
  @location(9) expandDirection  : f32,
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

// usePrevious of WebGL's BufferPolylineMaterialVS.glsl, texCoord == 1.0: only
// the polyline's last vertex takes its own segment from its previous position.
// The renderer packs texCoord as j / (jl - 1), so it is exactly 1.0 there and
// below 1.0 at every other vertex.
fn bufferPolylineUsePrevious(texCoord: f32) -> bool {
  return texCoord == 1.0;
}

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
  let texCoord = input.showColorWidthAndTexCoord.w;

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
    // attribute unpack above.
    // 1.0e-7 is czm_epsilon7 (GLSL names the constant; this shader has no
    // constants chunk, so the literal is commented instead of left bare).
    widthCss = widthCss / max(
      csm_metersPerPixel(vec4<f32>(posEC, 1.0), params.pixelRatio,
                         params.viewport, camera.projectionMatrix),
      1.0e-7);
  }
  // The law takes the width in CSS pixels and scales the window-space offset
  // by the pixel ratio itself (PolylineCommon.glsl:166, czm_pixelRatio), so
  // the quad is extruded in framebuffer (device) pixels, which is what
  // params.viewport.zw and the viewport matrices measure. For a metres width
  // the ratio still cancels: csm_metersPerPixel above returns metres per CSS
  // pixel (metres per device pixel times the ratio), so the device-pixel
  // offset works out to metres / (2 * metresPerDevicePixel), as on WebGL at
  // any pixel ratio.
  //
  // The law clips the vertex's own segment to the near plane: the segment to
  // its next position, or to its previous one at the polyline's last vertex.
  // Its inputs are WebGL's own, each read exactly from its lane: texCoord,
  // usePrevious (texCoord == 1.0) and expandDirection.
  let positionWC = csm_getPolylineWindowCoordinatesEC(
    vec4<f32>(posEC, 1.0),
    vec4<f32>(prevEC, 1.0),
    vec4<f32>(nextEC, 1.0),
    input.expandDirection,
    widthCss,
    bufferPolylineUsePrevious(texCoord),
    camera.projectionMatrix,
    params.viewportTransformation,
    params.pixelRatio,
    camera.encodedCameraPositionMCHigh.w,
  );
  output.position = params.viewportOrthographic * positionWC;

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
  output.v_st = vec2<f32>(texCoord, (input.expandDirection + 1.0) * 0.5);

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
