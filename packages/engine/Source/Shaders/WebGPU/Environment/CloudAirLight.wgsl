//>>ifdef CLOUD_LIGHTING_PREVIEW
fn cloudPhysicalAerialColor(
  weightedRadiance: vec3<f32>, opacity: f32, baselineColor: vec3<f32>,
  altitude: f32, towardCamera: vec3<f32>, upAtCloud: vec3<f32>, pathLength: f32,
  curvatureRadius: f32, sunDir: vec3<f32>,
) -> vec3<f32> {
  return baselineColor;
}
//>>else
struct CloudAirTransport {
  transmittance: vec3<f32>,
  radiance: vec3<f32>,
};

const CLOUD_AIR_NODES = array<vec2<f32>, 8>(
  vec2<f32>(0.9602898565, 0.1012285363),
  vec2<f32>(0.7966664774, 0.2223810345),
  vec2<f32>(0.5255324099, 0.3137066459),
  vec2<f32>(0.1834346425, 0.3626837834),
  vec2<f32>(-0.1834346425, 0.3626837834),
  vec2<f32>(-0.5255324099, 0.3137066459),
  vec2<f32>(-0.7966664774, 0.2223810345),
  vec2<f32>(-0.9602898565, 0.1012285363)
);

fn cloudAirSegmentWeight(extinction: f32, distance: f32) -> f32 {
  let stepLength = max(distance, 0.0);
  let sigma = max(extinction, 0.0);
  let tau = sigma * stepLength;
  if (tau < 1e-3) {
    return stepLength * (1.0 - 0.5 * tau + tau * tau / 6.0);
  }
  return (1.0 - exp(-tau)) / sigma;
}

fn cloudAirRayleighPhase(cosine: f32) -> f32 {
  return 3.0 * (1.0 + cosine * cosine) / (16.0 * PI);
}

fn cloudAirMiePhase(cosine: f32, anisotropy: f32) -> f32 {
  let g = clamp(anisotropy, -0.95, 0.95);
  return (1.0 - g * g) /
    (4.0 * PI * pow(max(1.0 + g * g - 2.0 * g * cosine, 1e-4), 1.5));
}

// A bounded Chapman-like approximation supplies sunlight while the universal
// transmittance table is unavailable. The table replaces it without a new recipe.
fn cloudAirSunColumn(height: f32, cosine: f32, scaleHeight: f32, radius: f32) -> f32 {
  let h = max(height, 0.0);
  let scale = max(scaleHeight, 1.0);
  let curvature = 2.0 * scale / (PI * (radius + h));
  let airMass = 1.0 / sqrt(max(cosine * cosine + curvature, 1e-8));
  let descending = 2.0 * exp(min((radius + h) * cosine * cosine / (2.0 * scale), 20.0)) - 1.0;
  return scale * exp(-h / scale) * airMass * select(1.0, descending, cosine < 0.0);
}

fn cloudAirSolarVisibility(height: f32, cosine: f32, radius: f32) -> f32 {
  let dip = acos(clamp(radius / (radius + max(height, 0.0)), 0.0, 1.0));
  return cloudSolarDiskVisibility(asin(clamp(cosine, -1.0, 1.0)) + dip, 0.00465);
}

fn cloudAirSunTransmittance(height: f32, cosine: f32, radius: f32) -> vec3<f32> {
  let uv = vec2<f32>(clamp(cosine * 0.5 + 0.5, 0.0, 1.0),
    clamp(height / max(cloud.airLightControl.z, 1.0), 0.0, 1.0));
  let baked = textureSampleLevel(cloudTransmittanceLut, cloudLutSampler, uv, 0.0);
  // Alpha distinguishes a valid opaque path from the zero-initialized texture.
  if (cloud.airLightControl.y > 0.5 && baked.a > 0.5) {
    return clamp(baked.rgb, vec3<f32>(0.0), vec3<f32>(1.0));
  }
  let rayleigh = cloudAirSunColumn(height, cosine, cloud.airRayleigh.w, radius);
  let mie = cloudAirSunColumn(height, cosine, cloud.airMie.w, radius);
  let ozone = max(0.0, 1.0 - abs(height - 25000.0) / 15000.0) *
    cloudAirSunColumn(height, cosine, 8500.0, radius);
  return exp(-(cloud.airRayleigh.xyz * rayleigh + cloud.airMie.xyz * mie +
    cloud.airOzonePhase.xyz * ozone));
}

fn cloudFiniteAirTransport(
  altitude: f32, towardCamera: vec3<f32>, upAtCloud: vec3<f32>,
  pathLength: f32, curvatureRadius: f32, sunDir: vec3<f32>,
) -> CloudAirTransport {
  var result: CloudAirTransport;
  result.transmittance = vec3<f32>(1.0);
  result.radiance = vec3<f32>(0.0);
  let strength = max(cloud.aerialStrength, 0.0);
  let h0 = max(altitude, 0.0);
  let radius = max(curvatureRadius, 1.0);
  let mu = clamp(dot(towardCamera, upAtCloud), -1.0, 1.0);
  let interval = cloudCurvedAirInterval(h0, mu, pathLength, radius);
  let middle = 0.5 * (interval.x + interval.y);
  let halfWidth = 0.5 * (interval.y - interval.x);
  if (halfWidth <= 0.0 || strength <= 0.0) { return result; }
  let cosine = clamp(dot(-towardCamera, sunDir), -1.0, 1.0);
  let rayleighPhase = cloudAirRayleighPhase(cosine);
  let miePhase = cloudAirMiePhase(cosine, cloud.airOzonePhase.w);
  // Traverse from the camera toward the cloud. Quadrature weights represent
  // homogeneous optical cells, whose exact Beer integral remains bounded.
  for (var i = 0u; i < 8u; i = i + 1u) {
    let node = CLOUD_AIR_NODES[i];
    let distance = middle + halfWidth * node.x;
    let stepLength = halfWidth * node.y;
    let height = cloudCurvedAirHeight(h0, mu, distance, radius);
    let localUp = normalize(upAtCloud * (radius + h0) + towardCamera * distance);
    let sunCosine = clamp(dot(localUp, sunDir), -1.0, 1.0);
    let rayleigh = exp(-height / cloud.airRayleigh.w);
    let mie = exp(-height / cloud.airMie.w);
    let ozone = max(0.0, 1.0 - abs(height - 25000.0) / 15000.0);
    let extinction = (cloud.airRayleigh.xyz * rayleigh +
      cloud.airMie.xyz * mie + cloud.airOzonePhase.xyz * ozone) * strength;
    let scattering = (cloud.airRayleigh.xyz * (rayleigh * rayleighPhase) +
      cloud.airMie.xyz * (mie * miePhase)) * strength;
    let visibility = cloudAirSolarVisibility(height, sunCosine, radius);
    let sunlight = cloudAirSunTransmittance(height, sunCosine, radius) *
      (cloud.airLightControl.x * visibility);
    let integratedLength = vec3<f32>(
      cloudAirSegmentWeight(extinction.x, stepLength),
      cloudAirSegmentWeight(extinction.y, stepLength),
      cloudAirSegmentWeight(extinction.z, stepLength)
    );
    result.radiance += result.transmittance * scattering * sunlight * integratedLength;
    result.transmittance *= exp(-extinction * stepLength);
  }
  return result;
}

fn cloudPhysicalAerialColor(
  weightedRadiance: vec3<f32>, opacity: f32, baselineColor: vec3<f32>,
  altitude: f32, towardCamera: vec3<f32>, upAtCloud: vec3<f32>, pathLength: f32,
  curvatureRadius: f32, sunDir: vec3<f32>,
) -> vec3<f32> {
  let air = cloudFiniteAirTransport(
    altitude, towardCamera, upAtCloud, pathLength, curvatureRadius, sunDir
  );
  // Both terms remain HDR and premultiplied until the one final tone map.
  let transported = weightedRadiance * air.transmittance + opacity * air.radiance;
  return cloudToneMappedRadiance(transported, opacity, cloud.exposure);
}
//>>endif
