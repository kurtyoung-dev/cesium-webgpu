//>>ifdef CLOUD_CONTRIBUTION_LIGHTING
@group(0) @binding(26) var<uniform> cloudLightingBudget: vec4<f32>;
fn cloudLightingBudgetWeight(density: f32, segment: f32, transmittance: f32, cosTheta: f32) -> f32 {
  let tau = density * segment * effectiveAbsorption();
  if (tau <= cloudLightingBudget.z || tau != tau || tau > 1000000.0) { return 1.0; }
  let forward = genusForwardG();
  if (abs(forward) >= 1.0 || abs(cloud.phaseG2) >= 1.0 || cosTheta < -1.0 || cosTheta > 1.0) { return 1.0; }
  let phase = max(max(hgPhase(cosTheta, forward), hgPhase(cosTheta, cloud.phaseG2)), 0.07957747154594767);
  let top = max(max(cloud.cloudTopColor.x, cloud.cloudTopColor.y), cloud.cloudTopColor.z);
  let bottom = max(max(cloud.cloudBaseColor.x, cloud.cloudBaseColor.y), cloud.cloudBaseColor.z);
  let color = max(top, bottom);
  let gain = max(1.0, max(cloud.sunIntensity, 0.0) * max(color, 1.0) *
    max(phase + cloud.silverLiningIntensity, cloud.isotropicFloor));
  let importance = (1.0 - exp(-tau)) * clamp(transmittance, 0.0, 1.0) * gain;
  if (importance != importance || importance > 10000000000.0 || cloudLightingBudget.x <= 0.0) { return 1.0; }
  return clamp(importance / cloudLightingBudget.x, 0.0, 1.0);
}
fn cloudLightingBudgetSamples(requested: i32, weight: f32) -> i32 {
  let count = max(requested, 1);
  let minimum = min(count, max(1, i32(cloudLightingBudget.y)));
  return clamp(i32(ceil(f32(count) * weight)), minimum, count);
}
//>>else
//>>endif
