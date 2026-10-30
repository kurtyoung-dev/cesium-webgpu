// Shared view-ray deck selection and premultiplied integration.
// The detailed density march has one call site for both view entrypoints.

// Convert extinction-weighted HDR radiance to straight color. The opacity
// normalization cancels algebraically, keeping very thin contributions bounded.
fn cloudToneMappedRadiance(
  weightedRadiance: vec3<f32>,
  opacity: f32,
  exposure: f32,
) -> vec3<f32> {
  let exposed = weightedRadiance * exposure;
  let visible = opacity > 0.0;
  let denominator = select(vec3<f32>(1.0), exposed + vec3<f32>(opacity), visible);
  return select(vec3<f32>(0.0), exposed / denominator, visible);
}

struct CloudViewResult {
  radiance: vec3<f32>,
  alpha: f32,
//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION
  frontDistance: f32,
  weightedDistanceSum: f32,
//>>endif
};

fn cloudDeckEntryDistance(
  inner: vec2<f32>,
  outer: vec2<f32>,
  cameraAltitude: f32,
  bottom: f32,
  top: f32,
) -> f32 {
  if (outer.y <= 0.0) {
    return 1e30;
  }
  if (cameraAltitude < bottom) {
    return max(inner.y, 0.0);
  }
  if (cameraAltitude <= top) {
    return 0.0;
  }
  return max(outer.x, 0.0);
}

fn integrateCloudView(
  rayOrigin: vec3<f32>,
  rayDir: vec3<f32>,
  sceneDepth: f32,
  centerHigh: vec3<f32>,
  centerLow: vec3<f32>,
  marchSamplePhase: f32,
) -> CloudViewResult {
  var result: CloudViewResult;
  result.radiance = vec3<f32>(0.0);
  result.alpha = 0.0;
//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION
  result.frontDistance = -1.0;
  result.weightedDistanceSum = 0.0;
//>>endif
  var bottoms = array<f32, 3>(cloud.cloudLayerBottom, 0.0, 0.0);
  var tops = array<f32, 3>(cloud.cloudLayerTop, 0.0, 0.0);
  var order = array<i32, 3>(0, 1, 2);
  var deckCount = 1;
  if (multiDeckEnabled()) {
    deckCount = 3;
    bottoms = array<f32, 3>(
      cloud.deckBoundsLow.x, cloud.deckBoundsMid.x, cloud.deckBoundsHigh.x
    );
    tops = array<f32, 3>(
      cloud.deckBoundsLow.y, cloud.deckBoundsMid.y, cloud.deckBoundsHigh.y
    );
    var keys = array<f32, 3>(1e30, 1e30, 1e30);
    for (var i = 0; i < 3; i++) {
      let innerAxes = cloudShellAxes(bottoms[i]);
      let outerAxes = cloudShellAxes(tops[i]);
      var inner: vec2<f32>;
      var outer: vec2<f32>;
      if (highPrecisionEnabled()) {
        inner = rayEllipsoidIntersectRTE(rayDir, centerHigh, centerLow, innerAxes);
        outer = rayEllipsoidIntersectRTE(rayDir, centerHigh, centerLow, outerAxes);
      } else {
        inner = rayEllipsoidIntersect(rayOrigin, rayDir, innerAxes);
        outer = rayEllipsoidIntersect(rayOrigin, rayDir, outerAxes);
      }
      keys[i] = cloudDeckEntryDistance(
        inner, outer, cloud.cameraGeodeticHeight, bottoms[i], tops[i]
      );
    }
    for (var i = 1; i < 3; i++) {
      let index = order[i];
      let key = keys[index];
      var j = i - 1;
      loop {
        if (j < 0) { break; }
        if (keys[order[j]] <= key) { break; }
        order[j + 1] = order[j];
        j--;
      }
      order[j + 1] = index;
    }
  }
  let msOctaves = i32((u32(cloud.qualityFlags) >> QF_OCTAVES_SHIFT) & 7u);
  var transmittance = 1.0;
  for (var k = 0; k < deckCount; k++) {
    if (k >= 3 || transmittance < 0.005) { break; }
    let index = order[k];
    let deck = marchDeck(
      rayOrigin, rayDir, sceneDepth, bottoms[index], tops[index],
      msOctaves, centerHigh, centerLow, marchSamplePhase,
    );
    if (deck.alpha <= 0.0) { continue; }
//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION
    if (deck.frontDistance >= 0.0 &&
        (result.frontDistance < 0.0 || deck.frontDistance < result.frontDistance)) {
      result.frontDistance = deck.frontDistance;
    }
    result.weightedDistanceSum += transmittance * deck.weightedDistanceSum;
//>>endif
    result.radiance += transmittance * deck.alpha * deck.hazed;
    result.alpha += transmittance * deck.alpha;
    transmittance *= 1.0 - deck.alpha;
  }
  return result;
}

//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION
fn cloudViewReconstructionDepth(result: CloudViewResult) -> vec2<f32> {
  if (result.frontDistance < 0.0 || result.alpha <= 0.0) {
    return vec2<f32>(-1.0, -1.0);
  }
  return vec2<f32>(
    result.frontDistance,
    result.weightedDistanceSum / max(result.alpha, CLOUD_EMIT_MIN_ALPHA)
  );
}
//>>else
//>>endif

fn loadCloudSceneDepth(uv: vec2<f32>) -> f32 {
  let size = vec2<i32>(textureDimensions(depthTex));
  let pixel = clamp(vec2<i32>(uv * vec2<f32>(size)), vec2<i32>(0), size - vec2<i32>(1));
  return textureLoad(depthTex, pixel, 0).r;
}

@fragment
//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION
fn fragmentMain(input: VertexOutput) -> CloudMarchOutput {
//>>else
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
//>>endif
  var uv = input.uv;
  if (halfResEnabled()) {
    let index = u32(cloud.frameCounter) & 15u;
    let offset = vec2<f32>(BAYER4[index], BAYER4[(index + 5u) & 15u]) - 0.5;
    uv += offset / max(cloud.resolution, vec2<f32>(1.0));
  }
  let sceneColor = textureSample(colorTex, texSampler, uv);
  let sceneDepth = loadCloudSceneDepth(uv);
  let view = integrateCloudView(
    cloud.cameraPosition, getWorldRay(uv), sceneDepth,
    -cloud.encodedCameraHigh, -cloud.encodedCameraLow,
    cloudRaySamplePhase(input.position.xy),
  );
  var color = vec4<f32>(view.radiance, view.alpha);
  if (!halfResEnabled()) {
    color = vec4<f32>(
      sceneColor.rgb * (1.0 - view.alpha) + view.radiance, sceneColor.a
    );
  }
//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION
  return CloudMarchOutput(color, cloudViewReconstructionDepth(view));
//>>else
  return color;
//>>endif
}

// Screen-space cloud transmittance mask, for cloud-aware god rays: the view-ray
// transmittance of the same deck integration the visible pass runs, at the
// exact midpoint sample phase.
//
// Reference: Shota Matsuda, Takram — `@takram/three-clouds` in three-geospatial
// (MIT), https://github.com/takram-design-engineering/three-geospatial — the
// approach of resolving cloud occlusion of light shafts from the cloud pass's
// own march rather than from scene depth. Theirs writes a shadow-length
// integral (`marchShadowLength`) to a separate target; this emits the view-ray
// transmittance product instead, which the shaft pass multiplies by directly.
// Technique only — no source was copied.
@fragment
fn fragmentCloudMaskMain(input: VertexOutput) -> @location(0) f32 {
  let sceneDepth = loadCloudSceneDepth(input.uv);
  let view = integrateCloudView(
    cloud.cameraPosition, getWorldRay(input.uv), sceneDepth,
    -cloud.encodedCameraHigh, -cloud.encodedCameraLow, 0.5,
  );
  return clamp(1.0 - view.alpha, 0.0, 1.0);
}

//>>ifdef CLOUD_PRIMARY_REUSE
struct CloudPrimaryOutput {
  @location(0) color: vec4<f32>,
  @location(1) transmittance: f32,
//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION
  @location(2) depth: vec2<f32>,
//>>else
//>>endif
};

@fragment
fn fragmentCloudPrimaryMain(input: VertexOutput) -> CloudPrimaryOutput {
  var uv = input.uv;
  if (halfResEnabled()) {
    let index = u32(cloud.frameCounter) & 15u;
    let offset = vec2<f32>(BAYER4[index], BAYER4[(index + 5u) & 15u]) - 0.5;
    uv += offset / max(cloud.resolution, vec2<f32>(1.0));
  }
  let view = integrateCloudView(
    cloud.cameraPosition, getWorldRay(uv), loadCloudSceneDepth(uv),
    -cloud.encodedCameraHigh, -cloud.encodedCameraLow,
    cloudRaySamplePhase(input.position.xy),
  );
  let color = vec4<f32>(view.radiance, view.alpha);
  let transmittance = clamp(1.0 - view.alpha, 0.0, 1.0);
//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION
  return CloudPrimaryOutput(color, transmittance, cloudViewReconstructionDepth(view));
//>>else
  return CloudPrimaryOutput(color, transmittance);
//>>endif
}
//>>else
//>>endif
