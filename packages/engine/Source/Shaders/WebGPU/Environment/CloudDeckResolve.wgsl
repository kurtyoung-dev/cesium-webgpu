fn cloudResolveDeck(rayOrigin: vec3<f32>, rayDir: vec3<f32>, sunDir: vec3<f32>,
  tStart: f32, tEnd: f32, deckBottom: f32, deckTop: f32, weightedColor: vec3<f32>,
  transmittance: f32, visibleDistanceSum: f32, visibleAltitudeSum: f32) -> vec4<f32> {
  // Empty decks contribute neither radiance nor extinction and need no air integration.
  if (transmittance >= 1.0) { return vec4<f32>(0.0); }

  // The accumulated radiance already includes opacity. Tone-map its straight
  // source color so the deck compositor applies opacity exactly once.
  let opacity = 1.0 - transmittance;
  let toneMapped = cloudToneMappedRadiance(weightedColor, opacity, cloud.exposure);

  // Use the extinction weights that produced the pixel, so a nearby opaque
  // cloud does not inherit the range of the otherwise empty shell.
  let visible = cloudVisibleAerialSample(
    visibleDistanceSum, visibleAltitudeSum, opacity,
    tStart, tEnd, deckBottom, deckTop,
  );
  let visiblePos = rayOrigin + rayDir * visible.x;
  let surfaceAxes = cloudShellAxes(0.0);
  let visibleUp = normalize(visiblePos / (surfaceAxes * surfaceAxes));
  let aerial = cloudAerialFraction(
    visible.y, -rayDir, visibleUp, visible.x, cloud.aerialStrength,
    cloudAirCurvatureRadius(visibleUp, -rayDir),
  );
  var hazed = mix(toneMapped, cloud.aerialColor, aerial);

  if ((u32(cloud.qualityFlags) & QF_AERIAL_LUT) != 0u) {
    hazed = cloudPhysicalAerialColor(weightedColor, opacity, hazed,
      visible.y, -rayDir, visibleUp, visible.x,
      cloudAirCurvatureRadius(visibleUp, -rayDir), sunDir);
  }

  return vec4<f32>(hazed, opacity);
}
