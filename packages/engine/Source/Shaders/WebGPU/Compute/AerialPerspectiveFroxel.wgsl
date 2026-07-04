// AerialPerspectiveFroxel — Hillaire 2020 aerial-perspective volume bake.
//
// Item 2.3 (AERIAL-FROXEL) of the atmosphere/cloud improvement plan. Bakes a
// low-res 3D froxel LUT (32³) of accumulated single-scatter INSCATTER (rgb) +
// mean TRANSMITTANCE (a) along the current view frustum, ONCE per frame, so
// AerialPerspective.wgsl can do a single trilinear fetch instead of the
// 10-step per-pixel analytic march. Decouples the aerial-perspective cost from
// screen resolution and is temporally stable.
//
// Froxel parameterization (matches AerialPerspective.wgsl's fragment sample):
//   - u = (x+0.5)/DIM, v = (y+0.5)/DIM  → the SAME screen UV the fragment uses
//     (ndc = (u*2-1, (1-v)*2-1)); the froxel column aligns with the fragment
//     pixel column so a fetch at the fragment's UV reads the right frustum ray.
//   - w = (z+0.5)/DIM ; the froxel stores the PREFIX integral from the camera
//     out to distance `d(w) = maxDistance * w²` (squared distribution → more
//     slices near the camera where the haze gradient is steepest). The fragment
//     inverts this with `w = sqrt(eyeDistance / maxDistance)`.
//
// The integrand is the parity port of AerialPerspective.wgsl's analytic march
// (computeScattering / AtmosphereCommon.glsl) — Rayleigh + Mie single scatter
// with the HG phase against the sun, optical depth back to the camera and out
// to the sun, optional ozone Chappuis absorption — so the froxel path LOOKS
// like the analytic path it replaces (this is an opt-in, default-OFF quality/
// perf feature; exact byte parity is not required, the OFF gate is).
//
// References:
//   - Sébastien Hillaire, "A Scalable and Production Ready Sky and Atmosphere
//     Rendering Technique" (EGSR 2020) — the aerial-perspective froxel volume.
//   - CesiumJS AtmosphereCommon.glsl computeScattering — the analytic march
//     this bake integrates per froxel.

const PI: f32 = 3.141592653589793;
const DIM: u32 = 32u;
const INSCATTER_STEPS: u32 = 10u;
const LIGHT_STEPS: u32 = 4u;

// Compact per-frame uniforms packed by WebGPUAerialPerspectiveEffect.setFrameData.
// Layout MUST match the JS pack order in `_froxelData` exactly (add-only).
struct FroxelUniforms {
  // xyz = camera ECEF (relative to ellipsoid centre); w = innerRadius (m).
  cameraPositionWC: vec4<f32>,
  // xyz = sun direction (world, normalized); w = atmosphere light intensity.
  sunDirectionWC: vec4<f32>,
  // xyz = Rayleigh scattering coefficient (per-metre); w = Rayleigh scale height.
  rayleighCoefficient: vec4<f32>,
  // xyz = Mie scattering coefficient (per-metre); w = Mie scale height.
  mieCoefficient: vec4<f32>,
  // x = Mie anisotropy g; y = near; z = far; w = atmosphere thickness (m).
  params0: vec4<f32>,
  // x = haze intensity (master); y = inscatter scale; z = froxel max distance (m);
  // w = reserved.
  params1: vec4<f32>,
  inverseProjection: mat4x4<f32>,
  inverseViewRotation: mat4x4<f32>,
  // xyz = ozone Chappuis absorption coefficient (per-metre); w = enabled (>0.5).
  ozoneCoefficient: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: FroxelUniforms;
@group(0) @binding(1) var froxelTex: texture_storage_3d<rgba16float, write>;

fn raySphereIntersect(origin: vec3<f32>, dir: vec3<f32>, radius: f32) -> vec2<f32> {
  let b = dot(origin, dir);
  let c = dot(origin, origin) - radius * radius;
  let disc = b * b - c;
  if (disc < 0.0) {
    return vec2<f32>(-1.0, -1.0);
  }
  let s = sqrt(disc);
  return vec2<f32>(-b - s, -b + s);
}

fn rayleighPhase(cosAngle: f32) -> f32 {
  return 3.0 / (16.0 * PI) * (1.0 + cosAngle * cosAngle);
}

fn miePhase(cosAngle: f32, g: f32) -> f32 {
  let g2 = g * g;
  let denom = 1.0 + g2 - 2.0 * g * cosAngle;
  return (1.0 - g2) / (4.0 * PI * pow(max(denom, 1e-4), 1.5));
}

fn ozoneDensity(height: f32) -> f32 {
  let center = 25000.0;
  let halfWidth = 15000.0;
  return max(0.0, 1.0 - abs(height - center) / halfWidth);
}

@compute @workgroup_size(4, 4, 4)
fn computeAerialFroxel(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= DIM || gid.y >= DIM || gid.z >= DIM) {
    return;
  }

  let cameraWC = u.cameraPositionWC.xyz;
  let innerRadius = u.cameraPositionWC.w;
  let thickness = u.params0.w;
  let outerRadius = innerRadius + thickness;
  let maxDistance = max(u.params1.z, 1.0);

  // Screen UV for this froxel column (matches the fragment's ndc derivation).
  let uv = vec2<f32>(
    (f32(gid.x) + 0.5) / f32(DIM),
    (f32(gid.y) + 0.5) / f32(DIM),
  );
  let ndc = vec2<f32>(uv.x * 2.0 - 1.0, (1.0 - uv.y) * 2.0 - 1.0);
  let eyeH = u.inverseProjection * vec4<f32>(ndc, 0.0, 1.0);
  let eyeDir = normalize(eyeH.xyz / eyeH.w);
  let rayDir = normalize((u.inverseViewRotation * vec4<f32>(eyeDir, 0.0)).xyz);

  // Squared slice distribution → dense near the camera.
  let wCoord = (f32(gid.z) + 0.5) / f32(DIM);
  let sliceDist = maxDistance * wCoord * wCoord;

  let camR = max(length(cameraWC), innerRadius);

  let sunDir = u.sunDirectionWC.xyz;
  let lightIntensity = u.sunDirectionWC.w;
  let rayleighCoeff = u.rayleighCoefficient.xyz;
  let mieCoeff = u.mieCoefficient.xyz;
  let rayleighScaleH = u.rayleighCoefficient.w;
  let mieScaleH = u.mieCoefficient.w;
  let mieG = u.params0.x;
  let hazeIntensity = u.params1.x;
  let inscatterScale = u.params1.y;

  let ozoneEnabled = u.ozoneCoefficient.w > 0.5;
  let ozoneCoeff = select(vec3<f32>(0.0), u.ozoneCoefficient.xyz, ozoneEnabled);

  // March the camera→sliceDist segment within the atmosphere shell.
  let camToTop = raySphereIntersect(cameraWC, rayDir, outerRadius);
  var marchStart = 0.0;
  if (camR > outerRadius) {
    marchStart = max(camToTop.x, 0.0);
  }
  let marchEnd = min(sliceDist, max(camToTop.y, 0.0));
  let segment = max(marchEnd - marchStart, 0.0);

  var rayleighAccum = vec3<f32>(0.0);
  var mieAccum = vec3<f32>(0.0);
  var rOpticalDepth = 0.0;
  var mOpticalDepth = 0.0;
  var oOpticalDepth = 0.0;

  if (segment > 0.0) {
    let stepLen = segment / f32(INSCATTER_STEPS);
    for (var i = 0u; i < INSCATTER_STEPS; i = i + 1u) {
      let t = marchStart + (f32(i) + 0.5) * stepLen;
      let samplePos = cameraWC + rayDir * t;
      let h = max(length(samplePos) - innerRadius, 0.0);

      let rDensity = exp(-h / rayleighScaleH) * stepLen;
      let mDensity = exp(-h / mieScaleH) * stepLen;
      rOpticalDepth = rOpticalDepth + rDensity;
      mOpticalDepth = mOpticalDepth + mDensity;
      oOpticalDepth = oOpticalDepth + ozoneDensity(h) * stepLen;

      let sunHit = raySphereIntersect(samplePos, sunDir, outerRadius);
      if (sunHit.y > 0.0) {
        let sunLen = sunHit.y;
        let lightStep = sunLen / f32(LIGHT_STEPS);
        var rSunOD = 0.0;
        var mSunOD = 0.0;
        var oSunOD = 0.0;
        for (var j = 0u; j < LIGHT_STEPS; j = j + 1u) {
          let lp = samplePos + sunDir * (f32(j) + 0.5) * lightStep;
          let lh = max(length(lp) - innerRadius, 0.0);
          rSunOD = rSunOD + exp(-lh / rayleighScaleH) * lightStep;
          mSunOD = mSunOD + exp(-lh / mieScaleH) * lightStep;
          oSunOD = oSunOD + ozoneDensity(lh) * lightStep;
        }
        let attenuation = exp(
          -(rayleighCoeff * (rOpticalDepth + rSunOD) +
            mieCoeff * (mOpticalDepth + mSunOD) +
            ozoneCoeff * (oOpticalDepth + oSunOD))
        );
        rayleighAccum = rayleighAccum + rDensity * attenuation;
        mieAccum = mieAccum + mDensity * attenuation;
      }
    }
  }

  let cosAngle = dot(rayDir, sunDir);
  let rPhase = rayleighPhase(cosAngle);
  let mPhase = miePhase(cosAngle, mieG);
  let rayleighColor = rayleighCoeff * rayleighAccum * rPhase;
  let mieColor = mieCoeff * mieAccum * mPhase;
  let inscatter =
    (rayleighColor + mieColor) * lightIntensity * inscatterScale * hazeIntensity;

  // Camera→slice transmittance (Beer-Lambert over the marched optical depth),
  // blended by the master haze intensity (matches the fragment's composite).
  let extinction = exp(
    -(rayleighCoeff * rOpticalDepth + mieCoeff * mOpticalDepth +
      ozoneCoeff * oOpticalDepth)
  );
  let transmittance = mix(vec3<f32>(1.0), extinction, hazeIntensity);
  // Store the mean transmittance in .a (Hillaire packs a scalar); the fragment
  // multiplies the scene colour by it.
  let meanT = (transmittance.r + transmittance.g + transmittance.b) / 3.0;

  textureStore(
    froxelTex,
    vec3<i32>(i32(gid.x), i32(gid.y), i32(gid.z)),
    vec4<f32>(inscatter, meanT),
  );
}
