// Light march: optical depth toward the sun.
// Dispatches to the cone path when QF_LIGHT_CONE is set, otherwise to the
// straight N-step march below.
fn lightMarch(
//>>ifdef CLOUD_CONTRIBUTION_LIGHTING
  lightingWeight: f32,
//>>else
//>>endif
  pos: vec3<f32>,
  heightFraction: f32,
  deckBottom: f32,
  deckTop: f32,
  densityCoordinates: CloudDensityCoordinates,
  morphologyCoordinate: vec3<f32>,
) -> f32 {
  //>>ifdef CLOUD_LIGHTING_PREVIEW
  // A vertical column estimate avoids secondary density evaluation at startup.
  let columnHeight = max(deckTop - deckBottom, 0.0) *
    (1.0 - clamp(heightFraction, 0.0, 1.0));
  return columnHeight * cloud.densityMultiplier * cloud.profileDensityScale * 0.05;
  //>>else
  if (lightConeEnabled()) {
    return lightMarchCone(
//>>ifdef CLOUD_CONTRIBUTION_LIGHTING
      lightingWeight,
//>>else
//>>endif
      pos, heightFraction, deckBottom, deckTop,
      densityCoordinates, morphologyCoordinate
    );
  }
  let sunDir = normalize(cloud.sunDirection);
  // Scale the light-march step count by the tier's lightSampleScale: 1.0 leaves
  // it alone, and lower tiers march fewer, bigger steps for roughly the same
  // optical depth at lower cost. `lightSteps` multiplies the per-view-sample
  // cost, so this is the cheapest lever the low tiers have.
//>>ifdef CLOUD_CONTRIBUTION_LIGHTING
  let steps = cloudLightingBudgetSamples(max(1, i32(cloud.lightSteps * cloud.lightSampleScale)), lightingWeight);
//>>else
  let steps = max(1, i32(cloud.lightSteps * cloud.lightSampleScale));
//>>endif
  let innerAxes = cloudShellAxes(deckBottom);
  let outerAxes = cloudShellAxes(deckTop);
  let innerInverseAxes = vec3<f32>(1.0) / innerAxes;
  let outerInverseAxes = vec3<f32>(1.0) / outerAxes;
  let layerThickness = deckTop - deckBottom;

  // March toward sun through remaining cloud
  let stepSize = layerThickness / f32(steps);
  var opticalDepth: f32 = 0.0;
  let usePlanetDensity = planetDensityEnabled() && noiseBakedEnabled();
  var canonicalStep = vec3<f32>(0.0);
  var shapeStep = vec3<f32>(0.0);
  var warpStep = vec3<f32>(0.0);
  var detailStep = vec3<f32>(0.0);
  if (usePlanetDensity) {
    canonicalStep =
      sunDir * stepSize * CLOUD_DENSITY_WORLD_TO_NOISE;
    shapeStep =
      CLOUD_DENSITY_SHAPE_ROTATION *
      (canonicalStep * cloud.puffSize);
    warpStep =
      CLOUD_DENSITY_WARP_ROTATION *
      (
        canonicalStep *
        cloud.puffSize *
        CLOUD_DENSITY_WARP_RATIO
      );
    detailStep =
      CLOUD_DENSITY_DETAIL_ROTATION *
      (canonicalStep * CLOUD_DENSITY_DETAIL_RATIO);
  }

  for (var i: i32 = 0; i < steps; i++) {
    let stepMultiple = f32(i + 1);
    let sampleDelta = sunDir * stepMultiple * stepSize;
    let samplePos = pos + sampleDelta;
    let hf = ellipsoidShellHeightFraction(
      samplePos, innerInverseAxes, outerInverseAxes
    );
    if (usePlanetDensity) {
      let sampleCoordinates = CloudDensityCoordinates(
        densityCoordinates.canonical + canonicalStep * stepMultiple,
        wrapCloudDensityDomain(
          densityCoordinates.shape + shapeStep * stepMultiple
        ),
        wrapCloudDensityDomain(
          densityCoordinates.warp + warpStep * stepMultiple
        ),
        wrapCloudDensityDomain(
          densityCoordinates.detail + detailStep * stepMultiple
        ),
      );
      let sampleMorphologyCoordinate =
        morphologyCoordinate + canonicalStep * stepMultiple;
      opticalDepth += cloudDensityAtCoordinates(
        samplePos,
        sampleCoordinates,
        sampleMorphologyCoordinate,
        hf,
        deckBottom,
        deckTop,
        stepSize,
      ) * stepSize;
    } else {
      opticalDepth += legacyCloudDensity(
        samplePos, hf, deckBottom, deckTop
      ) * stepSize;
    }
  }

  return opticalDepth;
  //>>endif
}
