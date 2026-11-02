//>>ifdef CLOUD_PRIMARY_DENSITY_CACHE
fn cloudPrimaryDensityAt(relative: vec3<f32>, bottom: f32, top: f32,
  pixelFootprint: f32, segment: f32, height: f32, distance: f32, fine: bool) -> vec2<f32> {
  let frame = cloudDensityCacheFrame;
  if (fine == false || distance <= frame.control.y || frame.control.w <= 0.0) { return vec2<f32>(0.0); }
  // The integration segment supplies the ray footprint; the near band retains
  // direct point density. This filtered mean is never an empty-space oracle.
  let cached = cloudCachedDensity(relative, bottom, top, max(pixelFootprint, segment), height);
  let range = smoothstep(frame.control.y, frame.control.y + max(frame.control.z, 1.0), distance);
  return vec2<f32>(cached.x, cached.y * range * frame.control.w);
}
//>>else
//>>endif
