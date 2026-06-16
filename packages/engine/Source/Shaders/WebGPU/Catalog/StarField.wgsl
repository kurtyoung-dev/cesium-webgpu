// StarField.wgsl — Yale Bright Star Catalog point starfield for CesiumJS WebGPU.
//
// Technique credit:
//   - Pogson magnitude scale (N. R. Pogson, 1856) for magnitude→intensity.
//   - Blackbody B−V → color-temperature approximation following the
//     standard Ballesteros (2012) relation, then a compact Planckian-locus
//     RGB fit (after Takram's geospatial-visuals research notes,
//     migration_doc/RESEARCH_TAKRAM_GEOSPATIAL_VISUALS.md). Implemented
//     fresh here; no third-party code copied.
//
// Each catalog entry is drawn as a view-facing point sprite. The star's
// inertial (J2000 / TEME) direction is rotated into the Earth-fixed frame
// on the CPU (TEME→pseudo-fixed matrix, matching SkyBox), then placed at
// the far plane so it sits behind all scene geometry. Output is HDR and
// additively blended into the scene framebuffer so the existing bloom
// post-process makes the brightest stars glow.
//
// Geometry: instanced draw — 6 vertices (two triangles) per instance,
// one instance per star. The per-instance buffer carries the fixed-frame
// unit direction (already rotated), the Pogson intensity, and the
// blackbody RGB color. The 6-vertex quad corners come from @builtin
// vertex_index so no separate corner buffer is needed.

struct Uniforms {
  // Projection × view with translation removed (stars are directional —
  // no RTE position split needed; they live on the unit sphere at the
  // far plane). Column-major mat4.
  viewProjectionNoTranslation: mat4x4<f32>,
  // Point-sprite half-size in NDC (x = horizontal, y = vertical;
  // aspect-corrected on the CPU from the projection focal terms).
  pointSize: vec2<f32>,
  // Global intensity multiplier (lets the app dim/brighten the field;
  // also folds in the day/twilight fade so stars vanish in daylight).
  intensityScale: f32,
  // Minimum on-screen pixel radius floor → keeps faint stars from
  // collapsing to sub-pixel flicker. Expressed in NDC half-extent.
  minPointSize: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VertexInput {
  // Per-vertex: which of the 6 quad corners (0..5).
  @builtin(vertex_index) vertexIndex: u32,
  // Per-instance star record (see WebGPUStarFieldRenderer pack).
  @location(0) directionFixed: vec3<f32>,  // unit vector, Earth-fixed frame
  @location(1) intensity: f32,             // Pogson-scaled brightness
  @location(2) color: vec3<f32>,           // blackbody RGB (B−V derived)
  @location(3) sizeBoost: f32,             // extra radius for bright stars
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) corner: vec2<f32>,   // [-1,1] quad-local coordinate
  @location(1) color: vec3<f32>,    // HDR color (already intensity-weighted)
};

// Two-triangle quad corner table indexed by vertex_index 0..5.
fn cornerForIndex(idx: u32) -> vec2<f32> {
  // 0:(-1,-1) 1:(1,-1) 2:(1,1) | 3:(-1,-1) 4:(1,1) 5:(-1,1)
  switch (idx) {
    case 0u: { return vec2<f32>(-1.0, -1.0); }
    case 1u: { return vec2<f32>( 1.0, -1.0); }
    case 2u: { return vec2<f32>( 1.0,  1.0); }
    case 3u: { return vec2<f32>(-1.0, -1.0); }
    case 4u: { return vec2<f32>( 1.0,  1.0); }
    default: { return vec2<f32>(-1.0,  1.0); }
  }
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  // Project the unit direction with the translation-free view-projection.
  // The star sits on the unit sphere; we only care about its angular
  // position, so a plain direction transform suffices.
  var clip = u.viewProjectionNoTranslation * vec4<f32>(input.directionFixed, 1.0);

  // Behind-camera cull: collapse the quad off-screen so the rasterizer
  // discards it. Without this, stars behind the camera wrap around and
  // smear across the frame.
  if (clip.w <= 0.0) {
    output.position = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    output.corner = vec2<f32>(0.0);
    output.color = vec3<f32>(0.0);
    return output;
  }

  let corner = cornerForIndex(input.vertexIndex);

  // Per-instance point radius: base size + a brightness-driven boost so
  // first-magnitude stars read as visibly larger discs than fourth-
  // magnitude pinpoints, then a floor so nothing sub-pixels out.
  let halfX = max(u.pointSize.x * (1.0 + input.sizeBoost), u.minPointSize);
  let halfY = max(u.pointSize.y * (1.0 + input.sizeBoost), u.minPointSize);

  // Offset the clip-space corner. Multiplying by clip.w keeps the sprite
  // a constant NDC size regardless of depth (the perspective divide
  // restores .x/.y after this).
  clip.x += corner.x * halfX * clip.w;
  clip.y += corner.y * halfY * clip.w;

  // Pin to the far plane so stars render behind every other surface.
  // clip-z = clip-w → NDC z = 1.0 (the [0,1] WebGPU far plane); the
  // less-equal depth compare still lets the star pass against cleared
  // depth.
  output.position = vec4<f32>(clip.x, clip.y, clip.w, clip.w);
  output.corner = corner;
  output.color = input.color * input.intensity * u.intensityScale;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  // Soft radial falloff → a round, anti-aliased point with a bright
  // core and a softer halo. dist in [0,√2]; a wide Gaussian core (so the
  // disc is visibly filled, not a single hot texel) plus a smoothstep
  // cutoff at the quad edge for anti-aliasing. The additive blend reads
  // the result as a glowing star.
  let dist = length(input.corner);
  let core = exp(-dist * dist * 2.2);
  let edge = smoothstep(1.0, 0.45, dist); // fade the outer half of the quad
  let alpha = core * edge;

  // HDR additive output: bright stars overflow 1.0 in the scene FB float
  // target and feed the bloom bright-pass. RGB is the blackbody color
  // already weighted by Pogson intensity in the VS.
  let rgb = input.color * alpha;
  return vec4<f32>(rgb, alpha);
}
