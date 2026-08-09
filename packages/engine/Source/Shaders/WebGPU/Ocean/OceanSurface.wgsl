// OceanSurface.wgsl — displaced ocean surface patch for the FFT spectral
// ocean. A flat ENU grid patch anchored at the camera sub-point is displaced by
// the merged FFT displacement map and shaded with a simple Fresnel water BRDF
// plus Jacobian foam. Positioning is relative-to-eye: the anchor is
// EncodedCartesian3-split into high and low halves and the vertex is
// transformed with mvpRelativeToEye, never an absolute f32 world position.
//
// Reference: displacement and normal reassembly follow gasgiant/FFT-Ocean (MIT)
// and Popov72/OceanDemo (MIT); see the Third-Party section of LICENSE.md. The
// relative-to-eye vertex path mirrors FlowFieldRender.wgsl.

struct CameraUniforms {
  mvpRelativeToEye: mat4x4<f32>,
  viewportSize: vec2<f32>,
  logDepthNearFar: vec2<f32>,
  encodedCameraHigh: vec3<f32>,
  logDepthFactor: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  previousViewProjection: mat4x4<f32>,
};

struct OceanUniforms {
  anchorHigh: vec3<f32>,
  _p0: f32,
  anchorLow: vec3<f32>,
  _p1: f32,
  east: vec3<f32>,
  patchExtent: f32,
  north: vec3<f32>,
  invRadius: f32,
  up: vec3<f32>,
  patchL: f32,
  sunDirection: vec3<f32>,
  foamStrength: f32,
  deepColor: vec3<f32>,
  waveFadeNear: f32,
  shallowColor: vec3<f32>,
  waveFadeFar: f32,
  uvOffset: vec2<f32>,
  texelSize: f32,
  detailScale: f32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var<uniform> ocean: OceanUniforms;
@group(0) @binding(2) var Displacement: texture_2d<f32>;
@group(0) @binding(3) var DisplacementSampler: sampler;

//>>ifdef LOG_DEPTH
fn csm_vertexLogDepth(clipPosition: vec4<f32>, near: f32) -> f32 {
  return (clipPosition.w - near) + 1.0;
}
fn csm_updatePositionDepth(clipPosition: vec4<f32>) -> vec4<f32> {
  var coords = clipPosition;
  coords.z = clamp(coords.z / coords.w, 0.0, 1.0) * coords.w;
  return coords;
}
fn csm_writeLogDepth(depthFromNearPlusOne: f32, factor: f32) -> f32 {
  return log2(depthFromNearPlusOne) * factor;
}
//>>endif

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) posRelEye: vec3<f32>,
  @location(2) fade: f32,
  //>>ifdef LOG_DEPTH
  @location(3) v_logDepth: f32,
  //>>endif
};

fn sampleDisp(uv: vec2<f32>) -> vec4<f32> {
  return textureSampleLevel(Displacement, DisplacementSampler, uv, 0.0);
}

@vertex
fn vertexMain(@location(0) gridPos: vec2<f32>) -> VertexOutput {
  var out: VertexOutput;

  // Local ENU planar coordinates (meters), grid in [-0.5, 0.5].
  let e0 = gridPos.x * ocean.patchExtent;
  let n0 = gridPos.y * ocean.patchExtent;

  let uv = vec2<f32>(e0, n0) / ocean.patchL + ocean.uvOffset;
  let disp = sampleDisp(uv);

  // Distance fade of wave amplitude (matches the B630 water-mask handover band).
  let planarDist = length(vec2<f32>(e0, n0));
  let fadeLin = clamp(
    (planarDist - ocean.waveFadeNear) /
      max(ocean.waveFadeFar - ocean.waveFadeNear, 1.0),
    0.0, 1.0);
  let amp = pow(1.0 - fadeLin, 5.0);

  let e = e0 + disp.x * amp;
  let n = n0 + disp.z * amp;
  // Curvature drop so far vertices hug the ellipsoid instead of the tangent plane.
  let drop = -(e0 * e0 + n0 * n0) * 0.5 * ocean.invRadius;
  let up = disp.y * amp + drop;

  // ENU -> ECEF offset from the anchor origin.
  let worldRel = ocean.east * e + ocean.north * n + ocean.up * up;

  // RTE: subtract the encoded camera from the anchor (high/low), add the small
  // local offset, transform with mvpRelativeToEye.
  var highDiff = ocean.anchorHigh - camera.encodedCameraHigh;
  if (length(highDiff) == 0.0) {
    highDiff = vec3<f32>(0.0);
  }
  let lowDiff = ocean.anchorLow - camera.encodedCameraLow;
  let posRelEye = highDiff + lowDiff + worldRel;

  var clip = camera.mvpRelativeToEye * vec4<f32>(posRelEye, 1.0);
  out.position = clip;
  out.uv = uv;
  out.posRelEye = posRelEye;
  out.fade = amp;
  //>>ifdef LOG_DEPTH
  out.v_logDepth = csm_vertexLogDepth(out.position, camera.logDepthNearFar.x);
  out.position = csm_updatePositionDepth(out.position);
  //>>endif
  return out;
}

struct FragOutput {
  @location(0) color: vec4<f32>,
  //>>ifdef LOG_DEPTH
  @builtin(frag_depth) depth: f32,
  //>>endif
};

@fragment
fn fragmentMain(input: VertexOutput) -> FragOutput {
  // Normal from the height-gradient of the displacement map (finite difference).
  let t = ocean.texelSize;
  let hL = sampleDisp(input.uv - vec2<f32>(t, 0.0)).y;
  let hR = sampleDisp(input.uv + vec2<f32>(t, 0.0)).y;
  let hD = sampleDisp(input.uv - vec2<f32>(0.0, t)).y;
  let hU = sampleDisp(input.uv + vec2<f32>(0.0, t)).y;
  let worldStep = 2.0 * t * ocean.patchL;
  let slopeE = (hR - hL) / max(worldStep, 1e-3) * ocean.detailScale * input.fade;
  let slopeN = (hU - hD) / max(worldStep, 1e-3) * ocean.detailScale * input.fade;
  let nLocal = normalize(vec3<f32>(-slopeE, -slopeN, 1.0));
  let worldNormal = normalize(
    ocean.east * nLocal.x + ocean.north * nLocal.y + ocean.up * nLocal.z);

  let viewDir = normalize(-input.posRelEye);
  let nDotV = max(dot(worldNormal, viewDir), 0.0);
  // Schlick Fresnel, F0 = 0.02 for water.
  let fresnel = 0.02 + 0.98 * pow(1.0 - nDotV, 5.0);

  // Sky reflection: brighten with the up-component of the reflected ray.
  let reflectDir = reflect(-viewDir, worldNormal);
  let skyUp = clamp(dot(reflectDir, normalize(ocean.up)), 0.0, 1.0);
  let skyColor = mix(ocean.shallowColor, vec3<f32>(0.55, 0.72, 0.92), skyUp);

  var color = mix(ocean.deepColor, skyColor, fresnel);

  // Sun specular (Blinn-Phong).
  let sunDir = normalize(ocean.sunDirection);
  let halfway = normalize(sunDir + viewDir);
  let spec = pow(max(dot(worldNormal, halfway), 0.0), 200.0);
  color += vec3<f32>(1.0, 0.98, 0.9) * spec * nDotV;

  // Foam from the Jacobian channel.
  let foam = clamp(sampleDisp(input.uv).w * ocean.foamStrength, 0.0, 1.0) * input.fade;
  color = mix(color, vec3<f32>(0.92, 0.95, 0.97), foam);

  var outc: FragOutput;
  outc.color = vec4<f32>(color, 1.0);
  //>>ifdef LOG_DEPTH
  outc.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepthFactor);
  //>>endif
  return outc;
}
