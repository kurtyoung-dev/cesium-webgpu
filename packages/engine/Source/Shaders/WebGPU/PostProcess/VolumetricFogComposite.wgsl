// VolumetricFogComposite.wgsl — Phase 5a infrastructure pass.
//
// Samples the integrated volumetric fog 3D texture in screen UV +
// linearized depth, applies the standard alpha-over composite
// (`out = sceneColor * transmittance + scatteredLight`), and writes
// to the output color attachment.
//
// Phase 5a contract: the integrated 3D texture is cleared to
// `(0, 0, 0, 1)` (zero scattered light, full transmittance) so the
// composite is visually identical to passing the scene color through
// unchanged. Phase 5b/5c populate the texture with real density and
// scattered light values; the composite math doesn't change.
//
// Bind group layout:
//   binding 0: uniform CompositeUniforms { invViewProj, near/far, screen size }
//   binding 1: linear sampler
//   binding 2: scene color (read)
//   binding 3: scene depth (read, linearized)
//   binding 4: integrated fog 3D texture (rgba16float)

struct CompositeUniforms {
  // Inverse view-projection matrix — used to reconstruct the world-space
  // ray direction at each fragment so far/near are correctly mapped
  // into the froxel grid's depth slicing.
  invViewProjection: mat4x4<f32>,
  // x = near plane, y = far plane, z = froxelMaxDistance, w = unused
  depthParams: vec4<f32>,
  // x = screen width, y = screen height, z = unused, w = unused
  screenSize: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: CompositeUniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var sceneColor: texture_2d<f32>;
@group(0) @binding(3) var sceneDepth: texture_depth_2d;
@group(0) @binding(4) var fogVolume: texture_3d<f32>;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

// Full-screen triangle covers the viewport with three vertices — no
// vertex buffer required. Vertex IDs 0, 1, 2 produce
// (-1,-1), (3,-1), (-1,3) in clip space, which clips to a full screen.
@vertex
fn vertexMain(@builtin(vertex_index) vid: u32) -> VOut {
  var out: VOut;
  let x = f32((vid << 1u) & 2u);
  let y = f32(vid & 2u);
  out.pos = vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
  out.uv = vec2<f32>(x, y);
  return out;
}

// Linearize a depth-buffer value to view-space distance.
//   z' = far * near / (far - depth * (far - near))
// Standard reverse-Z friendly form.
fn linearizeDepth(depth: f32, near: f32, far: f32) -> f32 {
  return (far * near) / (far - depth * (far - near));
}

@fragment
fn fragmentMain(input: VOut) -> @location(0) vec4<f32> {
  let texSize = vec2<f32>(textureDimensions(sceneColor, 0));
  let pixelCoord = vec2<i32>(input.uv * texSize);

  // Sample scene color (no filtering needed — we're at exact pixel coords).
  let scene = textureLoad(sceneColor, pixelCoord, 0);

  // Sample scene depth → linearized eye-space distance.
  let rawDepth = textureLoad(sceneDepth, pixelCoord, 0);
  let near = u.depthParams.x;
  let far = u.depthParams.y;
  let froxelMaxDistance = u.depthParams.z;
  let linearDepth = linearizeDepth(rawDepth, near, far);

  // Map the linearized depth to the froxel grid's W coordinate using
  // the same log slicing the compute kernels use:
  //   linearDepth = near × pow(maxDistance/near, t)
  //   ⇒ t       = log(linearDepth/near) / log(maxDistance/near)
  // The composite must match the kernel's slicing or scattering will
  // sample at the wrong depth band and produce visibly wrong god rays.
  let logRatio = log(max(linearDepth / max(near, 1e-3), 1e-3))
               / log(max(froxelMaxDistance / max(near, 1e-3), 1.0001));
  let depthFraction = clamp(logRatio, 0.0, 1.0);

  // Sample the integrated fog volume.
  //   xyz = scattered light, w = transmittance
  let fogSample = textureSampleLevel(
    fogVolume,
    samp,
    vec3<f32>(input.uv, depthFraction),
    0.0,
  );
  let scatteredLight = fogSample.rgb;
  let transmittance = fogSample.a;

  // Standard alpha-over composite. Phase 5a clears the volume to
  // (0,0,0,1) so this is visually a no-op; Phase 5b/5c fill in the
  // real values and the same equation produces god rays + height fog.
  let composited = scene.rgb * transmittance + scatteredLight;
  return vec4<f32>(composited, scene.a);
}
