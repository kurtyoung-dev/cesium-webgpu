/**
 * NEW-VR-BASELINE-HIGH-DENSITY (Batch 224, extracted from inline JSON
 * string in Batch 225 cosmetic cleanup).
 *
 * Procedurally generates a deterministic 5K-sphere instance scene
 * around San Francisco. Crosses every threshold-gated GPU dispatcher's
 * activation point (gpuCuller HI=384, HiZ HI=2400, GPUSortKeys
 * HI=6000 not crossed at 5K). Opts the WebGPU viewer into eager
 * warm-up via `Scene.gpuCullingHint = 'always'` so the pipeline-
 * compile cost amortizes into the load frame instead of the first
 * threshold-cross frame.
 *
 * The mulberry32 RNG seeded by `params.rngSeed` produces identical
 * positions / colors on both viewers, so any pixel diff between
 * WebGL and WebGPU outputs reflects pipeline differences rather
 * than instance-position drift.
 *
 * Called as `new Function("params", src)(params)` from
 * `capture-and-diff.mjs`'s `applyScene`. The function returns a
 * Promise that resolves once the procedural geometry has been
 * uploaded so the caller's settle-frame wait operates on a stable
 * scene.
 */

/* global params */
// `params` is the formal parameter of the `new Function("params", src)`
// wrapper that capture-and-diff.mjs's applyScene compiles this file into.
const Cesium = window.Cesium;
const p = params;

// Mulberry32 — small, fast, deterministic. Same seed on both
// viewers means identical instance positions, so any visual diff
// is attributable to the pipeline, not RNG drift.
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(p.rngSeed);

function addInstances(viewer) {
  if (!viewer) return;

  // Pre-compute the lat/lon scale factors once. `dx` and `dy` are
  // meters in the local east/north frame; convert to degrees for
  // `fromDegrees`. Using fixed factors here is fine because we're
  // only spreading by ~200km — Earth-curvature error is below the
  // pixel-diff threshold.
  const lonScale = 1 / (111320 * Math.cos((p.centerLatitude * Math.PI) / 180));
  const latScale = 1 / 110540;

  const instances = new Array(p.instanceCount);
  for (let i = 0; i < p.instanceCount; i++) {
    const dx = (rng() - 0.5) * 2 * p.spreadMeters;
    const dy = (rng() - 0.5) * 2 * p.spreadMeters;
    const dz = (rng() - 0.5) * 2 * Math.max(1000, p.spreadMeters * 0.1);

    const lon = p.centerLongitude + dx * lonScale;
    const lat = p.centerLatitude + dy * latScale;
    const h = p.centerHeight + dz;

    const center = Cesium.Cartesian3.fromDegrees(lon, lat, h);
    // The local east-north-up frame at `center` is sufficient on
    // its own — no extra translation needed (the prior version
    // multiplied by a zero translation, which was a no-op).
    const modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(center);

    const geometry = new Cesium.SphereGeometry({
      radius: p.sphereRadius,
      vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
    });

    instances[i] = new Cesium.GeometryInstance({
      geometry,
      modelMatrix,
      attributes: {
        color: Cesium.ColorGeometryInstanceAttribute.fromColor(
          Cesium.Color.fromHsl((i * 0.0001) % 1, 0.7, 0.5, 1.0),
        ),
      },
    });
  }

  const primitive = new Cesium.Primitive({
    geometryInstances: instances,
    appearance: new Cesium.PerInstanceColorAppearance({ translucent: false }),
    asynchronous: false,
  });

  viewer.scene.primitives.add(primitive);
}

if (window.webgpuViewer) {
  // Eager warm-up — amortizes pipeline-compile cost into the load
  // frame instead of the first threshold-cross frame. Has no effect
  // on WebGL (the setter is a Scene-level no-op there).
  window.webgpuViewer.scene.gpuCullingHint = "always";
}

addInstances(window.webglViewer);
addInstances(window.webgpuViewer);

// Give the Primitive's worker compile + GPU upload a beat to
// settle. `asynchronous: false` makes most of this synchronous,
// but the GPU command queue still needs a frame or two before the
// initial draw.
return new Promise((resolve) => setTimeout(resolve, 1500));
