/**
 * Handles WebGPU rendering of the SkyAtmosphere effect.
 * Renders an ellipsoid shell with Nishita-style atmospheric scattering.
 *
 * @private
 * @module WebGPUSkyAtmosphereRenderer
 */
import Cartesian3 from "../../Core/Cartesian3.js";
import defined from "../../Core/defined.js";
import Ellipsoid from "../../Core/Ellipsoid.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import SkyAtmosphereWGSL from "../../Shaders/WebGPU/Environment/SkyAtmosphere.js";
import { resolveSkyDynamicLighting } from "./WebGPUAtmosphereUniforms.js";
// Slice 5c-B Phase 1 (Batch 106) — scene-FB target helper.
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";
import {
  makeBindGroupLayout,
  sampler,
  texture,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { ShaderSourceId } from "./WebGPUShaderDefines.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";

// C-R7-SHADER-MODULE-DEDUP (Batch 185) — per-device module cache.
// SkyAtmosphere is singleton-per-scene so the dedup win per scene is
// negligible, but the cache unifies the pattern across the full
// renderer family and keeps device-loss handling consistent.
const _skyAtmosphereShaderCaches = new WeakMap();

function getSkyAtmosphereShaderCache(device) {
  let cache = _skyAtmosphereShaderCaches.get(device);
  if (!cache) {
    cache = new WebGPUShaderModuleCache(device);
    _skyAtmosphereShaderCaches.set(device, cache);
  }
  return cache;
}

// Uniform buffer: 256 bytes (aligned)
// Session 65 Batch 42 — Phase 4 completion (windSpeed/windDirection):
// bumped 256 → 272 to accommodate the `windDirectionAndSpeed: vec4<f32>`
// field appended after `dualLightControl`. WebGPU requires uniform
// buffer sizes to be a multiple of 16 bytes; 272 = 17 × 16 satisfies
// that. No bind-group layout change needed (the layout's minBindingSize
// is what matters and it sizes from this constant).
//
// Fullscreen-sky path — bumped 272 → 400 to append `inverseProjection` +
// `inverseView` (two mat4 = 128 bytes) at float offsets 68/84, used by the
// view-independent fullscreen sky option to reconstruct the per-pixel world ray.
// 400 = 25 × 16. The shell-mesh path packs them too but the shell shader ignores
// them.
//
// Batch 438 — bumped 400 → 464 to append four opt-in atmosphere-physics vec4s
// after `inverseView` (float offset 100):
//   atmosControl       @100 (improvedMiePhase / dualLightInline / ozoneEnabled)
//   ozoneCoefficient   @104 (+ pad @107)
//   moonLightDirWC     @108 (+ pad @111)
//   moonControl        @112 (phaseFraction / intensityScale)
// 464 = 29 × 16. ALL default-zero so the sky stays byte-identical with every
// flag off.
//
// C12-29 S6 — bumped 464 → 480 to append ONE vec4 at the TAIL (no existing
// offset moved):
//   eclipseControl     @116 (x = 360-degree horizon-twilight gain; y/z/w reserved)
// 480 = 30 × 16, still 16-aligned. Default zero, and the shader skips the
// block at zero, so the sky is byte-identical outside totality.
//
// Custom-ellipsoid horizon correctness — bumped 480 → 496 to append the
// active atmosphere ellipsoid's inverse-radii-squared at float offset 120
// (+ pad @123). No established offset moved.
const UNIFORM_BUFFER_SIZE = 496;

// Default atmosphere parameters
// Batch 247 (NEW-GROUND-VIEW-ENV-DIVERGENCES fix 1) — the SKY shader's
// inscatter-LUT fast path is DISABLED pending a sun-relative
// re-parameterization of the bake (DEFERRED_WORK:
// NEW-ATMOSPHERE-LUT-SUN-RELATIVE). The 2D LUT (AtmosphereLUT.wgsl
// computeInscatter) bakes the WORLD-space sun direction into a synthetic
// Y-up frame — geometrically unrelated to any fragment's local up — and
// its (cosViewZenith, altitude) parameterization cannot represent the
// view–sun azimuth dependence at all, so at ground level it rendered a
// frame-filling daytime-bright sky regardless of actual sun geometry
// (probe-ground-view-env: 1.73x the WebGL luminance). With the gate off,
// the fragment shader takes the inline 64-step ray-march, which is the
// parity port of WebGL's czm_computeScattering. The LUT BAKE still runs —
// the globe/voxel/splat fog drape paths sample the same inscatter texture
// and are tuned against it; only the sky shader's consumption is gated.
// All LUT scaffolding (bake dispatch, bind group, WGSL branch, dual-light
// moon LUT) stays in place for the re-parameterized bake to re-enable.
const ENABLE_SKY_INSCATTER_LUT = false;

const DEFAULT_RAYLEIGH_COEFFICIENT = new Cartesian3(5.5e-6, 13.0e-6, 22.4e-6);
const DEFAULT_MIE_COEFFICIENT = new Cartesian3(21e-6, 21e-6, 21e-6);
// Batch 438 (4.5 SKY-OZONE) — ozone Chappuis-band absorption coefficient
// (per-metre, RGB). Bruneton/Hillaire-derived: peak absorption in green/red
// (the Chappuis band), almost transparent in blue — this is the spectral shape
// that deepens twilight toward blue/violet at the zenith. Magnitude scaled to
// sit alongside the Rayleigh coefficient at the ~25 km tent peak. Only applied
// when `skyAtmosphere.ozone` is on; default is OFF (coefficient zeroed) so the
// sky is byte-identical.
const DEFAULT_OZONE_COEFFICIENT = new Cartesian3(0.65e-6, 1.881e-6, 0.085e-6);
const DEFAULT_RAYLEIGH_SCALE_HEIGHT = 8500.0;
const DEFAULT_MIE_SCALE_HEIGHT = 1200.0;
const DEFAULT_MIE_ANISOTROPY = 0.758;
const ATMOSPHERE_SCALE = 1.025;
// WebGL's scattering-shell thickness (czm_computeScattering's
// ATMOSPHERE_THICKNESS, computeScattering.glsl) — Batch 247.
const ATMOSPHERE_THICKNESS = 111e3;

// Scratch
const scratchModelView = new Matrix4();
const scratchMVRTE = new Matrix4();
const scratchMVPRTE = new Matrix4();
const scratchProjectionWebGPU = new Matrix4();
const scratchEncodedCamera = new EncodedCartesian3();

/**
 * Returns the SkyAtmosphere WGSL shader source.
 * Imported from the build-generated JS wrapper (no fetch needed).
 * @returns {string}
 * @private
 */
function getShaderSource() {
  return SkyAtmosphereWGSL;
}

/**
 * Generates the ellipsoid geometry vertices for the atmosphere shell.
 * Returns Float32Array with posHigh(3) + posLow(3) per vertex and Uint16Array indices.
 * @private
 */
function generateAtmosphereGeometry(ellipsoid, scale, slices, stacks) {
  const radii = ellipsoid.radii;
  const rx = radii.x * scale;
  const ry = radii.y * scale;
  const rz = radii.z * scale;

  const vertexCount = (slices + 1) * (stacks + 1);
  const positions = new Float32Array(vertexCount * 6); // posHigh(3) + posLow(3)
  const encodedPos = new EncodedCartesian3();
  const scratchPos = new Cartesian3();

  let idx = 0;
  for (let j = 0; j <= stacks; j++) {
    const phi = (Math.PI * j) / stacks;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    for (let i = 0; i <= slices; i++) {
      const theta = (2.0 * Math.PI * i) / slices;
      scratchPos.x = rx * sinPhi * Math.cos(theta);
      scratchPos.y = ry * sinPhi * Math.sin(theta);
      scratchPos.z = rz * cosPhi;
      EncodedCartesian3.fromCartesian(scratchPos, encodedPos);
      positions[idx++] = encodedPos.high.x;
      positions[idx++] = encodedPos.high.y;
      positions[idx++] = encodedPos.high.z;
      positions[idx++] = encodedPos.low.x;
      positions[idx++] = encodedPos.low.y;
      positions[idx++] = encodedPos.low.z;
    }
  }

  const indexCount = slices * stacks * 6;
  const indices = new Uint16Array(indexCount);
  let iIdx = 0;
  for (let j = 0; j < stacks; j++) {
    for (let i = 0; i < slices; i++) {
      const a = j * (slices + 1) + i;
      const b = a + slices + 1;
      indices[iIdx++] = a;
      indices[iIdx++] = b;
      indices[iIdx++] = a + 1;
      indices[iIdx++] = a + 1;
      indices[iIdx++] = b;
      indices[iIdx++] = b + 1;
    }
  }

  return { positions, indices, vertexCount, indexCount };
}

/**
 * Creates the render pipeline for sky atmosphere.
 * @private
 */
function createPipeline(
  device,
  shaderCode,
  format,
  depthFormat,
  sampleCount,
  fullscreen = false,
  reuseBgl = undefined,
  reuseLutBgl = undefined,
) {
  const shaderModule = getSkyAtmosphereShaderCache(device).getOrCreate(
    ShaderSourceId.SKY_ATMOSPHERE,
    shaderCode,
    0,
    "SkyAtmosphere shader",
  );

  // Reuse the shell's layouts for the fullscreen pipeline so the SAME bind
  // groups (built from the shell's bindGroupLayout) are valid on it — otherwise
  // WebGPU rejects the setBindGroup/draw as group-incompatible.
  const bindGroupLayout =
    reuseBgl ??
    makeBindGroupLayout(device, "SkyAtmosphere bind group layout", [
      uniformBuffer(0, Stage.VERTEX_FRAGMENT),
    ]);

  // Group 1 holds the precomputed atmosphere LUTs. Bound unconditionally so
  // the pipeline layout never changes — when the LUT compute path is
  // unavailable we still bind 1×1 placeholder views and clear the
  // `useLut` uniform flag so the fragment shader takes the ray-march path.
  //
  // Phase 1.3c — bindings 3 and 4 hold the moon LUT pair. They're bound
  // unconditionally too, falling back to the same placeholder when
  // dual-light scattering isn't active so the layout stays constant.
  const lutBindGroupLayout =
    reuseLutBgl ??
    makeBindGroupLayout(device, "SkyAtmosphere LUT bind group layout", [
      sampler(0, Stage.FRAGMENT),
      texture(1, Stage.FRAGMENT),
      texture(2, Stage.FRAGMENT),
      texture(3, Stage.FRAGMENT),
      texture(4, Stage.FRAGMENT),
      // Batch 427 (SKY-MS) — multiple-scattering LUT. Bound unconditionally
      // so the pipeline layout never changes; the shell binds the 1×1
      // placeholder when the extended bake hasn't run, the real MS view once
      // it has. The fragment shader only ADDS the term when the opt-in flag is
      // set, so an empty/placeholder binding is harmless on the default path.
      texture(5, Stage.FRAGMENT),
      // Batch 428 (A-LUT-REPARAM) — sun-relative sky-view LUT. Same
      // unconditional-binding rationale: placeholder until the extended bake
      // runs, real view after; only sampled when the opt-in
      // `useScatteringLut` flag is set.
      texture(6, Stage.FRAGMENT),
    ]);

  const pipelineLayout = device.createPipelineLayout({
    label: "SkyAtmosphere pipeline layout",
    bindGroupLayouts: [bindGroupLayout, lutBindGroupLayout],
  });

  const pipeline = device.createRenderPipeline({
    label: fullscreen
      ? "SkyAtmosphere fullscreen pipeline"
      : "SkyAtmosphere pipeline",
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      // Fullscreen path drives a 3-vert oversized triangle from
      // @builtin(vertex_index) — no vertex buffers; the shell path reads
      // posHigh/posLow from the ellipsoid mesh.
      entryPoint: fullscreen ? "vertexMainFullscreen" : "vertexMain",
      buffers: fullscreen
        ? []
        : [
            {
              arrayStride: 24, // 6 floats
              attributes: [
                { shaderLocation: 0, offset: 0, format: "float32x3" }, // posHigh
                { shaderLocation: 1, offset: 12, format: "float32x3" }, // posLow
              ],
            },
          ],
    },
    fragment: {
      module: shaderModule,
      entryPoint: fullscreen ? "fragmentMainFullscreen" : "fragmentMain",
      // Slice 5c-B Phase 1 (Batch 106) — scene-FB target. Standard
      // alpha-over blend for the sky atmosphere layer.
      targets: makeSceneFBTargets(format, {
        blend: {
          color: {
            srcFactor: "src-alpha",
            dstFactor: "one-minus-src-alpha",
            operation: "add",
          },
          alpha: {
            srcFactor: "one",
            dstFactor: "one-minus-src-alpha",
            operation: "add",
          },
        },
      }),
    },
    primitive: {
      topology: "triangle-list",
      // Shell: front-cull (render the inner/back faces from inside the shell).
      // Fullscreen: no cull (a single screen-covering triangle).
      cullMode: fullscreen ? "none" : "front",
    },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
    // Session 65 Batch 21 — match scene FB sample count so MSAA-on
    // doesn't fail attachment validation.
    multisample: sampleCount > 1 ? { count: sampleCount } : undefined,
  });

  return { pipeline, bindGroupLayout, lutBindGroupLayout };
}

/**
 * Lazily ensures the atmosphere LUT compute pass has been dispatched at
 * least once and that a sampler + bind group exist for sampling it from
 * the sky fragment shader. Returns a `{ bindGroup, useLut }` pair so the
 * caller can bind the LUTs even on devices that lack compute (in which
 * case `useLut` is false and a 1×1 placeholder is bound).
 *
 * The dispatch happens on a transient command encoder, submitted in
 * isolation. This avoids coupling the renderer to the scene's per-frame
 * encoder lifecycle — the LUT only needs regeneration when the sun
 * direction changes, so the cost is amortized across hundreds of frames.
 *
 * @private
 */
function ensureLutBindGroup(cache, context, device, frameState, skyAtmosphere) {
  // Build the placeholder once. Used as the steady-state binding when
  // compute is unavailable, and as the temporary binding before the first
  // dispatch on devices that do support compute.
  if (!defined(cache.placeholderLutTexture)) {
    cache.placeholderLutTexture = device.createTexture({
      label: "SkyAtmosphere LUT placeholder",
      size: { width: 1, height: 1 },
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    cache.placeholderLutView = cache.placeholderLutTexture.createView();
    cache.lutSampler = device.createSampler({
      label: "SkyAtmosphere LUT sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
  }

  const perfMgr = context.performanceManager ?? null;
  const computeOk = !!perfMgr && context.supportsComputeShaders === true;

  if (!computeOk) {
    if (!defined(cache.lutBindGroup)) {
      cache.lutBindGroup = device.createBindGroup({
        label: "SkyAtmosphere LUT bind group (placeholder)",
        layout: cache.lutBindGroupLayout,
        entries: [
          { binding: 0, resource: cache.lutSampler },
          { binding: 1, resource: cache.placeholderLutView },
          { binding: 2, resource: cache.placeholderLutView },
          // Phase 1.3c — moon LUT placeholders. Same 1×1 zero texture
          // as the sun side; the fragment shader's dual-light branch is
          // gated on `dualLightControl.x > 0.5`, which the renderer
          // clears whenever compute is unavailable, so these are never
          // sampled in this code path.
          { binding: 3, resource: cache.placeholderLutView },
          { binding: 4, resource: cache.placeholderLutView },
          // Batch 427 (SKY-MS) — multiple-scattering placeholder. Sampled
          // only when the opt-in flag is set, which the renderer clears
          // whenever compute (and thus the MS bake) is unavailable.
          { binding: 5, resource: cache.placeholderLutView },
          // Batch 428 (A-LUT-REPARAM) — sky-view placeholder. Same gating.
          { binding: 6, resource: cache.placeholderLutView },
        ],
      });
    }
    return {
      bindGroup: cache.lutBindGroup,
      useLut: false,
      msReady: false,
      skyViewReady: false,
    };
  }

  // Detect sun-direction change beyond a small threshold so we don't
  // re-dispatch the compute pass on every micro-update. The renderer
  // owns this rather than the scene to keep the LUT decoupled from any
  // particular tick source.
  const sunDir = defined(frameState.sunDirectionWC)
    ? frameState.sunDirectionWC
    : new Cartesian3(0, 0, 1);
  const last = cache.lastSunDirection;
  if (!last) {
    cache.lastSunDirection = Cartesian3.clone(sunDir, new Cartesian3());
    perfMgr.invalidateAtmosphereLUT();
  } else {
    const dot = last.x * sunDir.x + last.y * sunDir.y + last.z * sunDir.z;
    if (dot < 0.9999) {
      Cartesian3.clone(sunDir, last);
      perfMgr.invalidateAtmosphereLUT();
    }
  }

  // Phase 1.3c — track moon direction changes for the dual-light LUT.
  // Same threshold-gated invalidation pattern as the sun above. Only
  // active when both `enableDualLightAtmosphere` is on and the moon
  // direction has been populated by Moon.update() — on the first frame
  // (before Moon.update has run) the moon direction is undefined and
  // we skip the moon LUT dispatch entirely.
  const ac = frameState.atmosphericConditions;
  const lighting = ac && ac.lighting ? ac.lighting : undefined;
  const enableDualLight =
    lighting && lighting.enableDualLightAtmosphere !== false;
  const moonDir = defined(frameState.moonDirectionWC)
    ? frameState.moonDirectionWC
    : undefined;

  // Phase 1.4 — invalidate BOTH LUTs when weather coefficients change.
  // The LUT bakes the rayleigh/mie coefficients at compute time, so a
  // mid-session humidity change wouldn't take effect until the sun
  // moved without this. Compare against the cached previous values
  // and force a re-dispatch on any meaningful delta. Also invalidates
  // the moon LUT in lockstep so dual-light scattering stays coherent.
  const weatherCheck = ac && ac.weather ? ac.weather : undefined;
  const humidityNow =
    weatherCheck && typeof weatherCheck.humidity === "number"
      ? weatherCheck.humidity
      : 0.5;
  const airQualityNow =
    weatherCheck && typeof weatherCheck.airQuality === "number"
      ? weatherCheck.airQuality
      : 1.0;
  // Batch 438 (4.5 SKY-OZONE) — re-bake the LUTs when the ozone flag toggles, so
  // the LUT-sampled paths pick up (or drop) the ozone extinction. Treated as a
  // bake-input change exactly like humidity/airQuality above.
  const ozoneNow = skyAtmosphere.ozone === true;
  if (
    cache.lastHumidity !== humidityNow ||
    cache.lastAirQuality !== airQualityNow ||
    cache.lastOzone !== ozoneNow
  ) {
    cache.lastHumidity = humidityNow;
    cache.lastAirQuality = airQualityNow;
    cache.lastOzone = ozoneNow;
    perfMgr.invalidateAtmosphereLUT();
    if (enableDualLight) {
      perfMgr.invalidateMoonAtmosphereLUT();
    }
  }

  if (enableDualLight && defined(moonDir)) {
    const lastMoon = cache.lastMoonDirection;
    if (!lastMoon) {
      cache.lastMoonDirection = Cartesian3.clone(moonDir, new Cartesian3());
      perfMgr.invalidateMoonAtmosphereLUT();
    } else {
      const moonDot =
        lastMoon.x * moonDir.x +
        lastMoon.y * moonDir.y +
        lastMoon.z * moonDir.z;
      if (moonDot < 0.9999) {
        Cartesian3.clone(moonDir, lastMoon);
        perfMgr.invalidateMoonAtmosphereLUT();
      }
    }
  }

  // Resolve the LUT views so we can build the bind group. If perf manager
  // returns null we degrade to the placeholder path.
  const res = perfMgr.ensureAtmosphereLUTResources(device);
  if (!res) {
    if (!defined(cache.lutBindGroup)) {
      cache.lutBindGroup = device.createBindGroup({
        label: "SkyAtmosphere LUT bind group (placeholder)",
        layout: cache.lutBindGroupLayout,
        entries: [
          { binding: 0, resource: cache.lutSampler },
          { binding: 1, resource: cache.placeholderLutView },
          { binding: 2, resource: cache.placeholderLutView },
          { binding: 3, resource: cache.placeholderLutView },
          { binding: 4, resource: cache.placeholderLutView },
          // Batch 427 (SKY-MS) — multiple-scattering placeholder.
          { binding: 5, resource: cache.placeholderLutView },
          // Batch 428 (A-LUT-REPARAM) — sky-view placeholder.
          { binding: 6, resource: cache.placeholderLutView },
        ],
      });
    }
    return {
      bindGroup: cache.lutBindGroup,
      useLut: false,
      msReady: false,
      skyViewReady: false,
    };
  }

  // (Re)build the real bind group when the LUT views change. The views
  // come from the perf manager's cached textures and are stable for the
  // lifetime of the device, so this happens at most once.
  // Batch 427 (SKY-MS) — bind the real multiple-scattering view when it
  // exists; otherwise keep the 1×1 placeholder so the layout stays constant
  // on perf-manager stubs that predate the extended LUT.
  const msView = res.multipleScatterView ?? cache.placeholderLutView;
  // Batch 428 (A-LUT-REPARAM) — bind the real sky-view view when present;
  // otherwise the 1×1 placeholder so the layout stays constant on perf-manager
  // stubs that predate the sky-view LUT.
  const skyViewView = res.skyViewView ?? cache.placeholderLutView;
  if (
    !defined(cache.lutBindGroup) ||
    cache.lutTransmittanceView !== res.transmittanceView ||
    cache.lutInscatterView !== res.inscatterView ||
    cache.lutMoonTransmittanceView !== res.moonTransmittanceView ||
    cache.lutMoonInscatterView !== res.moonInscatterView ||
    cache.lutMultipleScatterView !== msView ||
    cache.lutSkyViewView !== skyViewView
  ) {
    cache.lutBindGroup = device.createBindGroup({
      label: "SkyAtmosphere LUT bind group",
      layout: cache.lutBindGroupLayout,
      entries: [
        { binding: 0, resource: cache.lutSampler },
        { binding: 1, resource: res.transmittanceView },
        { binding: 2, resource: res.inscatterView },
        { binding: 3, resource: res.moonTransmittanceView },
        { binding: 4, resource: res.moonInscatterView },
        { binding: 5, resource: msView },
        { binding: 6, resource: skyViewView },
      ],
    });
    cache.lutTransmittanceView = res.transmittanceView;
    cache.lutInscatterView = res.inscatterView;
    cache.lutMoonTransmittanceView = res.moonTransmittanceView;
    cache.lutMoonInscatterView = res.moonInscatterView;
    cache.lutMultipleScatterView = msView;
    cache.lutSkyViewView = skyViewView;
  }

  // If the LUT is dirty (first frame, or sun direction moved), dispatch
  // the compute pass on a one-shot encoder. We feed it the same scattering
  // constants we'd otherwise use in the ray march so the LUT and the
  // fallback path agree. Once `useLut` flips on, the fragment shader
  // shortcuts to a single texture sample. Phase 1.3c — when the moon LUT
  // is also dirty AND dual-light is enabled, batch both dispatches into
  // the same one-shot encoder so the moon path doesn't pay an extra
  // submit cost.
  const sunDirty = perfMgr.shouldRecomputeAtmosphereLUT();
  const moonDirty =
    enableDualLight &&
    defined(moonDir) &&
    perfMgr.shouldRecomputeMoonAtmosphereLUT();

  if (sunDirty || moonDirty) {
    const ellipsoid = skyAtmosphere._ellipsoid || Ellipsoid.WGS84;
    const innerRadius = Cartesian3.maximumComponent(ellipsoid.radii);
    const outerRadius = innerRadius * ATMOSPHERE_SCALE;
    const intensity = skyAtmosphere.atmosphereLightIntensity || 50.0;

    // Batch 428 (A-LUT-REPARAM) — the sun's zenith cosine relative to the
    // CAMERA's local up. The single-scatter bake places the sun in a synthetic
    // Y-up frame where its elevation is implicit, but the sky-view bake
    // (computeSkyView) needs the true observer-relative sun elevation to place
    // the sun on its canonical meridian. Computed from the world sun direction
    // and the camera position. Falls back to the sun's z when the camera
    // position is degenerate (first frame).
    const camPos = frameState.camera?.positionWC;
    let sunCosZenith = sunDir.z;
    if (defined(camPos)) {
      const camMag = Cartesian3.magnitude(camPos);
      if (camMag > 1.0) {
        sunCosZenith =
          (sunDir.x * camPos.x + sunDir.y * camPos.y + sunDir.z * camPos.z) /
          camMag;
      }
    }

    // Phase 1.4 — atmospheric conditions modulate the scattering
    // coefficients before the LUT compute pass:
    //   humidity   (0..1, default 0.5) → mie scale (0.5 + humidity)
    //                 0.0 → 0.5× (very dry, sharp horizon)
    //                 0.5 → 1.0× (no change)
    //                 1.0 → 1.5× (humid haze, softer horizon)
    //   airQuality (0..2+, default 1.0) → rayleigh scale 1/airQuality
    //                 1.0 → 1.0× (clean air, full blue sky)
    //                 0.5 → 2.0× rayleigh (strong scattering)
    //                 2.0 → 0.5× rayleigh (washed out, dusty)
    // The coefficients are baked into the LUT once per direction
    // change, so the cost is amortized — switching weather presets
    // recomputes the LUT but per-frame cost stays at one texture sample.
    const ac = frameState.atmosphericConditions;
    const weather = ac && ac.weather ? ac.weather : undefined;
    const humidity =
      weather && typeof weather.humidity === "number" ? weather.humidity : 0.5;
    const airQuality =
      weather && typeof weather.airQuality === "number"
        ? weather.airQuality
        : 1.0;
    const mieScale = 0.5 + humidity;
    const rayleighScale = airQuality > 0.001 ? 1.0 / airQuality : 1000.0;

    const rayleighCoefficient = [
      DEFAULT_RAYLEIGH_COEFFICIENT.x * rayleighScale,
      DEFAULT_RAYLEIGH_COEFFICIENT.y * rayleighScale,
      DEFAULT_RAYLEIGH_COEFFICIENT.z * rayleighScale,
    ];
    const mieCoefficient = [
      DEFAULT_MIE_COEFFICIENT.x * mieScale,
      DEFAULT_MIE_COEFFICIENT.y * mieScale,
      DEFAULT_MIE_COEFFICIENT.z * mieScale,
    ];
    // Batch 438 (4.5 SKY-OZONE) — bake ozone into the LUTs (transmittance /
    // inscatter / sky-view / MS) when `skyAtmosphere.ozone` is on, so the
    // LUT-sampled paths (sky-view fast-path, aerial perspective, fog drape)
    // get the same ozone deepening as the inline march. OFF → [0,0,0] →
    // exp(-0) = identity bake → byte-identical.
    const ozoneOn = skyAtmosphere.ozone === true;
    const ozoneCoefSrc =
      skyAtmosphere.atmosphereOzoneCoefficient ?? DEFAULT_OZONE_COEFFICIENT;
    const ozoneCoefficient = ozoneOn
      ? [ozoneCoefSrc.x, ozoneCoefSrc.y, ozoneCoefSrc.z]
      : [0.0, 0.0, 0.0];

    const encoder = device.createCommandEncoder({
      label: "SkyAtmosphere LUT dispatch",
    });

    let sunOk = true;
    if (sunDirty) {
      sunOk = perfMgr.dispatchAtmosphereLUT(
        encoder,
        device,
        {
          innerRadius,
          outerRadius,
          rayleighScaleHeight: DEFAULT_RAYLEIGH_SCALE_HEIGHT,
          mieScaleHeight: DEFAULT_MIE_SCALE_HEIGHT,
          mieAnisotropy: DEFAULT_MIE_ANISOTROPY,
          intensity,
          rayleighCoefficient,
          mieCoefficient,
          sunDirection: [sunDir.x, sunDir.y, sunDir.z],
          // Batch 428 (A-LUT-REPARAM) — observer-relative sun zenith for the
          // chained sky-view bake (computeSkyView). Ignored by the single-
          // scatter / MS / irradiance kernels.
          sunCosZenith,
          // Batch 438 (4.5 SKY-OZONE) — ozone extinction baked into the LUTs.
          ozoneCoefficient,
        },
        "sun",
      );
      // Track V-A1 (NEW-ATMO-BRUNETON-FULL-LUTS) — chain the multiple-
      // scattering + irradiance extension passes on the same encoder. They
      // read the sun transmittance + single-scattering LUTs we just wrote
      // and populate the multiple-scatter + irradiance targets. Gated on the
      // sun dispatch succeeding (compute available). No-op on devices where
      // the method is absent (older perf-manager stubs in tests).
      if (
        sunOk &&
        typeof perfMgr.dispatchAtmosphereExtendedLUT === "function"
      ) {
        perfMgr.dispatchAtmosphereExtendedLUT(encoder, device);
      }
    }

    if (moonDirty) {
      // The moon dispatch reuses the same compute kernel; only the
      // direction (and the per-light params buffer it writes into)
      // differs. Rayleigh / Mie / scale heights stay identical because
      // the scattering medium is the same atmosphere — only the source
      // light direction changes.
      perfMgr.dispatchAtmosphereLUT(
        encoder,
        device,
        {
          innerRadius,
          outerRadius,
          rayleighScaleHeight: DEFAULT_RAYLEIGH_SCALE_HEIGHT,
          mieScaleHeight: DEFAULT_MIE_SCALE_HEIGHT,
          mieAnisotropy: DEFAULT_MIE_ANISOTROPY,
          intensity,
          rayleighCoefficient,
          mieCoefficient,
          sunDirection: [moonDir.x, moonDir.y, moonDir.z],
          // Batch 438 (4.5 SKY-OZONE) — same ozone extinction for the moon LUT.
          ozoneCoefficient,
        },
        "moon",
      );
    }

    device.queue.submit([encoder.finish()]);
    if (sunOk) {
      cache.lutReady = true;
    }
  }

  // Batch 427 (SKY-MS) — MS is "ready" once the sun bake (which chains the
  // computeMultipleScattering extended pass) has run AND the real MS view is
  // bound (not the placeholder). `useLut` independently gates the inscatter
  // fast-path; MS readiness is tracked separately so the opt-in MS add works
  // even while the inscatter LUT fast-path stays disabled
  // (ENABLE_SKY_INSCATTER_LUT).
  const msReady =
    cache.lutReady === true &&
    defined(res.multipleScatterView) &&
    cache.lutMultipleScatterView === res.multipleScatterView;
  // Batch 428 (A-LUT-REPARAM) — sky-view LUT is "ready" once the sun bake
  // (which chains computeSkyView via the extended pass) has run AND the real
  // sky-view view is bound (not the placeholder). Independent of `useLut`: the
  // sky-view fast-path works even while the inscatter LUT fast-path stays
  // disabled (ENABLE_SKY_INSCATTER_LUT).
  const skyViewReady =
    cache.lutReady === true &&
    defined(res.skyViewView) &&
    cache.lutSkyViewView === res.skyViewView;
  return {
    bindGroup: cache.lutBindGroup,
    useLut: cache.lutReady === true,
    msReady,
    skyViewReady,
  };
}

/**
 * Packs atmosphere uniform data.
 * @private
 */
function packUniforms(
  uniformData,
  frameState,
  skyAtmosphere,
  useLut,
  multipleScatteringEnabled = false,
  useSkyViewLut = false,
  improvedMiePhase = false,
  dualLightInline = false,
  ozoneEnabled = false,
) {
  const camera = frameState.camera;

  // Build the band-specific projection with the context-owned convention.
  // This keeps split-screen contexts independent while preserving the
  // atmosphere's current-frustum near/far depth mapping.
  const off = camera.frustum.offCenterFrustum ?? camera.frustum;
  // Use the CURRENT multi-frustum band's near/far rather than the full
  // camera frustum range. The sky shell is rendered inside the frustum
  // loop on the FAR band (i === 0); subsequent globe tiles in that
  // band write depth values normalized to that band's near/far via
  // `_updateFrustumUniforms`. If the shell uses `camera.frustum.near/far`
  // (the full range), the depth-comparison between sky and globe is
  // computed against two DIFFERENT mappings of physical distance →
  // NDC z, producing a visible dark line at the globe silhouette where
  // the sky shell intermittently wraps in front of the globe edge.
  // `uniformState.currentFrustum` (Cartesian2) is set per-frustum-band
  // by `_updateFrustumUniforms → updateFrustum`. Fall back to the full
  // frustum if unavailable (first frame).
  // Use per-frustum-band near/far when available (multi-frustum scenes).
  // For single-frustum scenes (default 3D orbit), `currentFrustum` equals
  // the camera's own near/far, so this is a no-op. For multi-frustum
  // scenes it keeps sky-shell depth values consistent with the per-band
  // globe depth — relevant when depth-test ordering at the silhouette
  // depends on matching projection ranges.
  const us = frameState.context?.uniformState;
  const bandNear = us?.currentFrustum?.x ?? off.near;
  const bandFar = us?.currentFrustum?.y ?? off.far;
  Matrix4.computePerspectiveOffCenter(
    off.left,
    off.right,
    off.bottom,
    off.top,
    bandNear,
    bandFar,
    scratchProjectionWebGPU,
    frameState.context.clipSpaceConvention,
  );

  Matrix4.multiply(camera.viewMatrix, Matrix4.IDENTITY, scratchModelView);
  Matrix4.clone(scratchModelView, scratchMVRTE);
  scratchMVRTE[12] = 0.0;
  scratchMVRTE[13] = 0.0;
  scratchMVRTE[14] = 0.0;
  Matrix4.multiply(scratchProjectionWebGPU, scratchMVRTE, scratchMVPRTE);

  // mvpRelativeToEye (16 floats at offset 0)
  Matrix4.pack(scratchMVPRTE, uniformData, 0);

  // encodedCameraHigh/Low
  EncodedCartesian3.fromCartesian(camera.positionWC, scratchEncodedCamera);
  uniformData[16] = scratchEncodedCamera.high.x;
  uniformData[17] = scratchEncodedCamera.high.y;
  uniformData[18] = scratchEncodedCamera.high.z;
  uniformData[19] = 0.0;
  uniformData[20] = scratchEncodedCamera.low.x;
  uniformData[21] = scratchEncodedCamera.low.y;
  uniformData[22] = scratchEncodedCamera.low.z;
  uniformData[23] = 0.0;

  // cameraPositionWC
  uniformData[24] = camera.positionWC.x;
  uniformData[25] = camera.positionWC.y;
  uniformData[26] = camera.positionWC.z;
  uniformData[27] = 0.0;

  // sunDirectionWC — Session 65 Batch 18 + Batch 20: respect
  // `frameState.atmosphere.dynamicLighting` enum, mirroring upstream
  // `czm_getDynamicAtmosphereLightDirection`:
  //   NONE        (0, default) → per-fragment `normalize(positionWC)`
  //                     ("lit from directly above"). Handled in
  //                     `SkyAtmosphere.wgsl` since the direction is
  //                     per-fragment; the value packed into
  //                     `sunDirectionWC` here is unused on the NONE
  //                     path. We still write a defined value (the sun
  //                     direction as a safe placeholder) so future
  //                     WGSL changes that read it for non-NONE
  //                     fallback paths don't blow up.
  //   SCENE_LIGHT (1) → use `uniformState.lightDirectionWC` (honors
  //                     `scene.light` overrides such as a custom
  //                     `DirectionalLight`).
  //   SUNLIGHT    (2) → use `frameState.sunDirectionWC` (force sun
  //                     regardless of `scene.light`).
  // 1 = DynamicAtmosphereLightingType.SCENE_LIGHT (see
  // `Source/Scene/DynamicAtmosphereLightingType.js`).
  // DP-H47 (Campaign-7) — resolve the dynamic-lighting enum through the shared
  // `WebGPUAtmosphereUniforms` seam. The sky's scattering coefficients stay on
  // the SkyAtmosphere instance (WebGL-faithful — see the resolver's module
  // docstring), so only `dynamicLighting` routes through the seam here.
  //
  // C12-29 S6 / obs-1 (2026-07-25) — this was `resolveDynamicLighting(frameState)`,
  // i.e. `scene.atmosphere.dynamicLighting`, which WebGL hands to the sky ONLY
  // when there is no globe. With a globe, `Scene.updateEnvironment` calls
  // `skyAtmosphere.setDynamicLighting(DynamicAtmosphereLightingType.fromGlobeFlags(globe))`,
  // so any scene with `globe.enableLighting = true` resolved SCENE_LIGHT on
  // WebGL and NONE here. In the WGSL that turns `isDynamic` false, pins
  // `nightAlpha` at 1.0, and makes `alpha = mix(finalColor.b, 1.0, opacity)`
  // exactly 1.0 for a ground camera (altitudeOpacity == 1) — an opaque shell in
  // every direction. What that hid is exactly the two draws `SceneRenderer`
  // PREPENDS ahead of the binned atmosphere: the **skyBox cubemap** and the
  // returned **star-catalogue command**. The moon (appended) and sun (binned
  // after the atmosphere) execute AFTER the shell. `resolveSkyDynamicLighting`
  // reads the value Scene already resolved.
  const dynamicLighting = resolveSkyDynamicLighting(skyAtmosphere, frameState);
  const useSceneLight = dynamicLighting === 1;
  const uniformState = frameState.context?.uniformState;
  const sceneLightWC = uniformState?.lightDirectionWC;
  const sunDir =
    useSceneLight && defined(sceneLightWC)
      ? sceneLightWC
      : defined(frameState.sunDirectionWC)
        ? frameState.sunDirectionWC
        : new Cartesian3(0, 0, 1);
  uniformData[28] = sunDir.x;
  uniformData[29] = sunDir.y;
  uniformData[30] = sunDir.z;
  uniformData[31] = 0.0;

  // radiiAndDynamicAtmosphere — Session 65 Batch 18: pack the
  // `dynamicLighting` enum into the `.z` slot (matches the WGSL
  // struct comment "z=dynamicLighting"). The atmosphere light
  // intensity that previously occupied this slot is already
  // duplicated at `uniformData[39]` (the `intensity: f32` field of
  // the WGSL struct), so removing it here doesn't lose any data the
  // shader actually reads — `u.radiiAndDynamicAtmosphere.z` was
  // documented as the enum slot but was never consumed by the WGSL.
  //
  // Batch 247 (NEW-GROUND-VIEW-ENV-DIVERGENCES fix 1) — port WebGL's
  // scattering-shell geometry EXACTLY (SkyAtmosphereCommon.glsl L43-54 +
  // czm_computeScattering's ATMOSPHERE_THICKNESS = 111e3):
  //
  //   radiusAdjust = (radiiDiff / 4) + distanceAdjust(eyeHeight)
  //   atmosphereInnerRadius = (|cameraWC| - eyeHeight) - radiusAdjust
  //   atmosphereOuterRadius = atmosphereInnerRadius + 111e3
  //
  // The previous packing used innerRadius = max ellipsoid radius and
  // outerRadius = innerRadius × 1.025 (≈ 159.5 km shell). Two parity
  // consequences at ground level: (a) density heights lacked WebGL's
  // ~5.3 km radiusAdjust offset, over-weighting the Rayleigh integrand
  // by ~1/exp(-5346/10000) ≈ 1.7× — the dominant term of the measured
  // 1.7-1.8× ground-sky over-brightness; (b) the 43%-thicker shell
  // stretched the altitude-opacity ramp. The `.w` slot packs WebGL's
  // camera-height convention (`czm_eyeHeight + atmosphereInnerRadius`,
  // SkyAtmosphereCommon.glsl L104) for the WGSL altitudeOpacity ramp.
  // The shell MESH stays at ellipsoid × 1.025 (rasterization coverage
  // only, same as WebGL's scaled ellipsoid geometry).
  const ellipsoid = skyAtmosphere._ellipsoid || Ellipsoid.WGS84;
  const maxRadius = Cartesian3.maximumComponent(ellipsoid.radii);
  const camDist = Cartesian3.magnitude(camera.positionWC);
  const eyeHeight = camera.positionCartographic?.height ?? camDist - maxRadius;
  const radiiDiff = ellipsoid.radii.x - ellipsoid.radii.z;
  const distanceAdjustMin = maxRadius / 4.0;
  const distanceAdjustMax = maxRadius;
  const distanceAdjustT = Math.min(
    1.0,
    Math.max(
      0.0,
      (eyeHeight - distanceAdjustMin) / (distanceAdjustMax - distanceAdjustMin),
    ),
  );
  const radiusAdjust = radiiDiff / 4.0 + (radiiDiff / 2.0) * distanceAdjustT;
  const innerRadius = camDist - eyeHeight - radiusAdjust;
  const outerRadius = innerRadius + ATMOSPHERE_THICKNESS;
  uniformData[32] = innerRadius;
  uniformData[33] = outerRadius;
  uniformData[34] = dynamicLighting;
  uniformData[35] = eyeHeight + innerRadius;

  // Scale heights and anisotropy — Batch 247 (NEW-GROUND-VIEW-ENV-
  // DIVERGENCES fix 1): read the per-instance SkyAtmosphere properties
  // (WebGL parity — `u_atmosphere*` uniforms in SkyAtmosphere.js) instead
  // of module constants that had silently diverged from the WebGL
  // defaults (8500/1200/0.758 vs WebGL's 10000/3200/0.9). This both
  // matches the WebGL reference AND honors user-configured values.
  // NOTE: the LUT bake dispatch (createOrUpdateLutResources) still uses
  // the legacy DEFAULT_* constants — the inscatter LUT now only feeds the
  // globe/voxel/splat fog drape paths (see ENABLE_SKY_INSCATTER_LUT),
  // which are tuned against those constants. Unify when the LUT is
  // re-parameterized (DEFERRED_WORK: NEW-ATMOSPHERE-LUT-SUN-RELATIVE).
  uniformData[36] =
    skyAtmosphere.atmosphereRayleighScaleHeight ??
    DEFAULT_RAYLEIGH_SCALE_HEIGHT;
  uniformData[37] =
    skyAtmosphere.atmosphereMieScaleHeight ?? DEFAULT_MIE_SCALE_HEIGHT;
  uniformData[38] =
    skyAtmosphere.atmosphereMieAnisotropy ?? DEFAULT_MIE_ANISOTROPY;
  // C12-29 S2 — the WGSL twin of `SkyAtmosphere.js`'s
  // `u_atmosphereLightIntensity` closure. `u.intensity` is the linear scale on
  // the inline ray-march (`SkyAtmosphere.wgsl` — the DEFAULT path: the
  // inscatter LUT is compile-time off via `ENABLE_SKY_INSCATTER_LUT` and the
  // sky-view LUT needs the opt-in `skyAtmosphere.useScatteringLut`), so one
  // multiply here dims the shell exactly as the WebGL uniform does.
  // `_eclipseLightFactor` was refreshed by `SkyAtmosphere.update` before this
  // renderer ran; 1.0 outside an eclipse, and `x * 1.0` is bit-exact.
  //
  // The LUT BAKE input (the `intensity` local in `createOrUpdateLutResources`)
  // is deliberately NOT multiplied: that bake is debounced on sun DIRECTION,
  // which barely moves across an eclipse, so a dimmed bake would latch at
  // whatever factor happened to be current and stay wrong long after totality.
  // Both LUT paths are off at defaults; carrying the eclipse factor into them
  // needs the quantised-eclipse debounce input that S3/C13 owns
  // (ECLIPSE_EFFECTS_RESEARCH_2026-07-24.md §5).
  uniformData[39] =
    (skyAtmosphere.atmosphereLightIntensity || 50.0) *
    (skyAtmosphere._eclipseLightFactor ?? 1.0);

  // hsbShift + useLut flag (replaces _pad4 — see SkyAtmosphere.wgsl Uniforms)
  uniformData[40] = skyAtmosphere.hueShift || 0.0;
  uniformData[41] = skyAtmosphere.saturationShift || 0.0;
  uniformData[42] = skyAtmosphere.brightnessShift || 0.0;
  uniformData[43] = useLut ? 1.0 : 0.0;

  // rayleighCoefficient — Session 65 Batch 29 (Phase 4 completion):
  // applies the same `humidity` → mieScale and `airQuality` → rayleigh
  // Scale that the LUT compute dispatch uses (lines 441-459 above), so
  // the inline `computeScattering` path (active for orbit cameras
  // beyond 2× shell thickness, and for any frame that misses the LUT
  // path) produces the same atmospheric character as the LUT-cached
  // path. Without this, the LUT path got humidity/airQuality scaling
  // but orbit cameras (which use the inline ray-march) saw default
  // coefficients — producing inconsistent sky color across the
  // altitude crossover.
  const acRT = frameState.atmosphericConditions;
  const weatherRT = acRT && acRT.weather ? acRT.weather : undefined;
  const humidityRT =
    weatherRT && typeof weatherRT.humidity === "number"
      ? weatherRT.humidity
      : 0.5;
  const airQualityRT =
    weatherRT && typeof weatherRT.airQuality === "number"
      ? weatherRT.airQuality
      : 1.0;
  const mieScaleRT = 0.5 + humidityRT;
  const rayleighScaleRT = airQualityRT > 0.001 ? 1.0 / airQualityRT : 1000.0;

  // Batch 247 — read the per-instance coefficients (WebGL parity; the
  // module DEFAULT_RAYLEIGH_COEFFICIENT's blue term 22.4e-6 had diverged
  // from WebGL's 28.4e-6 default). Weather scaling stays a fork extra
  // (neutral at default humidity 0.5 / airQuality 1.0).
  const rayleighCoefRT =
    skyAtmosphere.atmosphereRayleighCoefficient ?? DEFAULT_RAYLEIGH_COEFFICIENT;
  const mieCoefRT =
    skyAtmosphere.atmosphereMieCoefficient ?? DEFAULT_MIE_COEFFICIENT;
  uniformData[44] = rayleighCoefRT.x * rayleighScaleRT;
  uniformData[45] = rayleighCoefRT.y * rayleighScaleRT;
  uniformData[46] = rayleighCoefRT.z * rayleighScaleRT;
  uniformData[47] = 0.0;

  // mieCoefficient (humidity-scaled — see comment above).
  uniformData[48] = mieCoefRT.x * mieScaleRT;
  uniformData[49] = mieCoefRT.y * mieScaleRT;
  uniformData[50] = mieCoefRT.z * mieScaleRT;
  uniformData[51] = 0.0;

  // Tier 1 debug controls. Read from frameState (set by Scene each frame)
  // so a single property toggle on Scene flips the diagnostic on. Layout
  // matches the WGSL `debug: vec4<f32>` field — see SkyAtmosphere.wgsl.
  //   x: disableScattering — bypass Rayleigh+Mie, emit flat magenta
  //   y: multipleScatteringEnabled (Batch 427 SKY-MS) — when > 0.5 the
  //      fragment shader ADDS the precomputed multiple-scattering LUT term to
  //      the single-scatter result. Renderer only sets this when the user's
  //      `skyAtmosphere.multipleScattering` opt-in is on AND the MS LUT is
  //      baked; default 0 keeps the sky byte-identical to single scatter.
  //   z/w: reserved for Tier 3 (LUT inspector, sun-dir override)
  uniformData[52] = frameState.debugDisableAtmosphereScattering ? 1.0 : 0.0;
  uniformData[53] = multipleScatteringEnabled ? 1.0 : 0.0;
  // Batch 428 (A-LUT-REPARAM) — debug.z = useSkyViewLut. Set only when the user
  // opt-in `skyAtmosphere.useScatteringLut` is on AND the sky-view LUT is baked;
  // default 0 keeps the inline march (byte-identical to today).
  uniformData[54] = useSkyViewLut ? 1.0 : 0.0;
  uniformData[55] = 0.0;

  // Phase 1.3c — Dual-light atmosphere scattering inputs.
  // moonDirectionWC (vec3 + pad) at offsets 56-59. Default to a "full
  // moon overhead" stand-in (0,0,1) when the moon hasn't been ticked
  // yet so the shader's vec3 read never picks up uninitialised data.
  const moonDir = defined(frameState.moonDirectionWC)
    ? frameState.moonDirectionWC
    : { x: 0, y: 0, z: 1 };
  uniformData[56] = moonDir.x;
  uniformData[57] = moonDir.y;
  uniformData[58] = moonDir.z;
  uniformData[59] = 0.0;

  // dualLightControl: x=enableDualLight, y=moonPhaseFraction, z=intensityScale, w=pad.
  // Driven by `frameState.atmosphericConditions.lighting.enableDualLightAtmosphere`
  // (default ON per B12/B14 lock) AND requires that compute shaders /
  // the moon LUT are actually available — `useLut` gates the entire
  // shader-side LUT path, and the dual-light branch is only entered
  // when the inscatter LUTs are bound. The intensity scale defaults to
  // 0.05 (~5% of sun) so a full-moon-overhead night sky reads as a
  // gentle blue glow rather than full daytime blue.
  const acLighting =
    frameState.atmosphericConditions &&
    frameState.atmosphericConditions.lighting
      ? frameState.atmosphericConditions.lighting
      : undefined;
  const enableDual =
    !!acLighting &&
    acLighting.enableDualLightAtmosphere !== false &&
    defined(frameState.moonDirectionWC) &&
    useLut === true;
  uniformData[60] = enableDual ? 1.0 : 0.0;
  uniformData[61] = frameState.moonPhaseFraction ?? 1.0;
  uniformData[62] = acLighting?.moonIntensity ?? 0.05;
  uniformData[63] = 0.0;

  // Session 65 Batch 42 — Phase 4 completion. Wind state for Phase 5/6
  // consumers (volumetric fog advection, cloud motion). Source is
  // `frameState.atmosphericConditions.weather.{windDirection,windSpeed}`.
  // `windDirection` is expected to be a normalized 3-vector in world
  // coords; `windSpeed` is m/s.
  //
  // No fragment shader path consumes these yet — they're scaffolding.
  // Default direction (0, 0, 1) + speed 0 means "calm" so any future
  // consumer that conditionally short-circuits on `windSpeed > 0`
  // remains backwards-compatible.
  const acWeather =
    frameState.atmosphericConditions && frameState.atmosphericConditions.weather
      ? frameState.atmosphericConditions.weather
      : undefined;
  const windDir = acWeather?.windDirection;
  uniformData[64] = windDir?.x ?? 0.0;
  uniformData[65] = windDir?.y ?? 0.0;
  uniformData[66] = windDir?.z ?? 1.0;
  uniformData[67] = acWeather?.windSpeed ?? 0.0;

  // Fullscreen-sky path — inverseProjection @68, inverseView @84. Same source
  // the cloud renderer's getWorldRay uses (uniformState), so the reconstructed
  // ray matches that proven path. Identity fallback on the first frame.
  const us2 = frameState.context?.uniformState;
  if (defined(us2?.inverseProjection)) {
    Matrix4.pack(us2.inverseProjection, uniformData, 68);
  } else {
    Matrix4.pack(Matrix4.IDENTITY, uniformData, 68);
  }
  if (defined(us2?.inverseView)) {
    Matrix4.pack(us2.inverseView, uniformData, 84);
  } else {
    Matrix4.pack(Matrix4.IDENTITY, uniformData, 84);
  }

  // Batch 438 — three opt-in atmosphere-physics flags + their inputs.
  // atmosControl @100: x=improvedMiePhase, y=dualLightInline, z=ozoneEnabled,
  // w=globeTranslucent. ALL default 0 → every gated WGSL branch stays closed
  // → byte-identical.
  uniformData[100] = improvedMiePhase ? 1.0 : 0.0;
  uniformData[101] = dualLightInline ? 1.0 : 0.0;
  uniformData[102] = ozoneEnabled ? 1.0 : 0.0;
  // GLOBE-TRANSLUCENCY-ALPHA — mirrors WebGL's GLOBE_TRANSLUCENT shader
  // define (SkyAtmosphere.js:410-412): when the globe renders translucent,
  // sky rays that hit the planet substitute the dark distance-faded horizon
  // gradient (SkyAtmosphereCommon.glsl lines 63-90) instead of the full
  // scattering integral, so the see-through planet disk doesn't flood with
  // daylight blue. 0 whenever translucency is off (the default).
  uniformData[103] =
    frameState.globeTranslucencyState &&
    frameState.globeTranslucencyState.translucent
      ? 1.0
      : 0.0;

  // ozoneCoefficient @104 (+ pad @107). Only non-zero when the inline ozone
  // gate (atmosControl.z) is on; zeroed otherwise so the inline march's
  // extinction exp() is identity even if the flag word were misread.
  const ozoneCoef = ozoneEnabled
    ? (skyAtmosphere.atmosphereOzoneCoefficient ?? DEFAULT_OZONE_COEFFICIENT)
    : Cartesian3.ZERO;
  uniformData[104] = ozoneCoef.x;
  uniformData[105] = ozoneCoef.y;
  uniformData[106] = ozoneCoef.z;
  uniformData[107] = 0.0;

  // moonLightDirWC @108 (+ pad @111). The moon direction for the inline
  // dual-light march. Reuse the same frameState.moonDirectionWC the LUT
  // dual-light path used; safe (0,0,1) placeholder before Moon.update ticks.
  const moonDirInline = defined(frameState.moonDirectionWC)
    ? frameState.moonDirectionWC
    : { x: 0, y: 0, z: 1 };
  uniformData[108] = moonDirInline.x;
  uniformData[109] = moonDirInline.y;
  uniformData[110] = moonDirInline.z;
  uniformData[111] = 0.0;

  // moonControl @112: x=moonPhaseFraction, y=moonIntensityScale, z/w reserved.
  // When dualLightInline is off the WGSL gate (atmosControl.y) ignores these.
  // The moon march reuses computeScattering with the full atmosphereLightIntensity
  // (~50) baked in, so the intensity scale is the FRACTION of a daytime sky the
  // moonlit sky shows. The default 0.12 reads as a gentle, clearly-visible blue
  // moonglow over a dark night sky (a literal ~0.05 sun-fraction is photometric
  // but rounds toward black in 8-bit). Overridable via
  // atmosphericConditions.lighting.moonIntensity.
  const acMoon =
    frameState.atmosphericConditions &&
    frameState.atmosphericConditions.lighting
      ? frameState.atmosphericConditions.lighting
      : undefined;
  uniformData[112] = dualLightInline
    ? (frameState.moonPhaseFraction ?? 1.0)
    : 0.0;
  uniformData[113] = acMoon?.moonIntensity ?? 0.12;
  uniformData[114] = 0.0;
  uniformData[115] = 0.0;

  // eclipseControl @116 — C12-29 S6, the 360-degree horizon-twilight gain.
  // The WGSL twin of `SkyAtmosphere.js`'s `u_eclipseHorizonTwilight` closure;
  // both read the same `frameState.eclipseHorizonTwilight` scalar through the
  // instance field `SkyAtmosphere.update` refreshes, so the two backends add
  // one identical number. Exactly 0.0 outside totality, and the shader skips
  // the whole block at 0 — byte-identical.
  uniformData[116] = skyAtmosphere._eclipseHorizonTwilight ?? 0.0;
  uniformData[117] = 0.0;
  uniformData[118] = 0.0;
  uniformData[119] = 0.0;

  // ellipsoidInverseRadiiSquared @120 (+ pad @123). This is the gradient
  // weight used to derive the observer's geodetic up direction in the S6
  // horizon-twilight block. `ellipsoid` is the same active SkyAtmosphere
  // ellipsoid used above for shell geometry and scattering radii.
  const inverseRadiiSquared = ellipsoid.oneOverRadiiSquared;
  uniformData[120] = inverseRadiiSquared.x;
  uniformData[121] = inverseRadiiSquared.y;
  uniformData[122] = inverseRadiiSquared.z;
  uniformData[123] = 0.0;
}

/**
 * Updates or creates WebGPU draw commands for SkyAtmosphere.
 * @param {SkyAtmosphere} skyAtmosphere
 * @param {FrameState} frameState
 * @returns {WebGPUDrawCommand|undefined} The cached environment command.
 */
function updateWebGPUSkyAtmosphere(skyAtmosphere, frameState) {
  //>>includeStart('debug', pragmas.debug);
  // Diagnostic — one-shot log covering the early-exit reasons so we can
  // tell why `envState.isSkyAtmosphereVisible` stays false in the EnvInject
  // log. Fires once per renderer instance; won't spam.
  const globalScope = /** @type {any} */ (globalThis);
  if (!globalScope.__skyAtmoDiagLogged) {
    globalScope.__skyAtmoDiagLogged = true;
    console.log(
      `[WebGPU:SkyAtmo] update entry — show=${skyAtmosphere.show} ` +
        `mode=${frameState.mode} renderPass=${frameState.passes?.render} ` +
        `hasContext=${!!frameState.context} ` +
        `hasDevice=${!!frameState.context?.device}`,
    );
  }
  //>>includeEnd('debug');

  if (!skyAtmosphere.show) {
    return;
  }

  const context = frameState.context;
  const device = context.device;

  //>>includeStart('debug', pragmas.debug);
  if (!globalScope.__skyAtmoDiagPushLogged) {
    globalScope.__skyAtmoDiagPushLogged = true;
    console.log(
      `[WebGPU:SkyAtmo] past show check — hasPipeline=${!!skyAtmosphere._webgpuCache?.pipeline} ` +
        `presentationFormat=${context.presentationFormat} ` +
        `depthFormat=${context.depthFormat}`,
    );
  }
  //>>includeEnd('debug');

  if (!defined(skyAtmosphere._webgpuCache)) {
    skyAtmosphere._webgpuCache = {};
  }
  const cache = skyAtmosphere._webgpuCache;

  // Batch 110 — invalidate cached pipeline when the scene pipeline
  // format generation bumps (HDR toggle, MSAA toggle). Without this
  // the cached pipeline keeps its old fragment target format and
  // produces validation warnings + black sky against the recreated
  // scene FB. The pipeline rebuild is one-time per format change;
  // steady-state HDR-on or HDR-off frames pay zero cost.
  const currentGen = context._scenePipelineFormatGeneration ?? 0;
  if (
    defined(cache.pipeline) &&
    cache._pipelineFormatGeneration !== currentGen
  ) {
    cache.pipeline = undefined;
    cache.fullscreenPipeline = undefined;
    cache._pipelineFailed = false;
    // The cached `WebGPUDrawCommand` carries a direct reference to
    // the OLD pipeline. Drop it so it rebuilds with the new pipeline.
    cache.command = undefined;
    cache.fullscreenCommand = undefined;
    // The bind groups were built against the OLD bindGroupLayout
    // (which is recreated alongside the pipeline). Forcing a rebuild
    // by clearing the BGL refs below makes the existing bind-group
    // setup branch (`if (!defined(cache.bindGroup))`) re-fire.
    cache.bindGroup = undefined;
    cache.bindGroupLayout = undefined;
    cache.lutBindGroupLayout = undefined;
  }

  // Create pipeline once (getShaderSource is synchronous — no await needed)
  if (!defined(cache.pipeline)) {
    try {
      const shaderCode = getShaderSource();
      const format = context.scenePipelineFormat || "bgra8unorm";
      const depthFmt = context.depthFormat || "depth24plus-stencil8";
      const sampleCount = context._msaaSamples ?? 1;
      const result = createPipeline(
        device,
        shaderCode,
        format,
        depthFmt,
        sampleCount,
      );
      cache.pipeline = result.pipeline;
      cache.bindGroupLayout = result.bindGroupLayout;
      cache.lutBindGroupLayout = result.lutBindGroupLayout;
      // Fullscreen-sky pipeline (view-independent option). Same shader module +
      // bind group layouts (makeBindGroupLayout dedupes identical descriptors, so
      // the shell's bind groups bind here too); differs only in vertex/fragment
      // entry points, no vertex buffers, and no face cull.
      const resultFs = createPipeline(
        device,
        shaderCode,
        format,
        depthFmt,
        sampleCount,
        true,
        result.bindGroupLayout, // reuse so the shell's bind groups bind here
        result.lutBindGroupLayout,
      );
      cache.fullscreenPipeline = resultFs.pipeline;
      cache._pipelineFormatGeneration = currentGen;
    } catch (e) {
      console.error(
        `[WebGPU:SkyAtmosphere] pipeline creation failed: ${e?.message ?? e}. ` +
          `Sky atmosphere will not render. Check shader compile errors above.`,
      );
      cache._pipelineFailed = true;
      return;
    }
  }
  if (cache._pipelineFailed) {
    return;
  }

  // Create geometry once
  if (!defined(cache.vertexBuffer)) {
    const ellipsoid = skyAtmosphere._ellipsoid || Ellipsoid.WGS84;
    const geo = generateAtmosphereGeometry(ellipsoid, ATMOSPHERE_SCALE, 64, 64);
    cache.vertexBuffer = WebGPUBuffer.createVertexBuffer(
      device,
      geo.positions,
      "SkyAtmosphere vertices",
    );

    cache.indexBuffer = WebGPUBuffer.createIndexBuffer(
      device,
      geo.indices,
      "SkyAtmosphere indices",
    );
    cache.indexCount = geo.indexCount;
  }

  // Uniform buffer
  if (!defined(cache.uniformBuffer)) {
    cache.uniformBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      UNIFORM_BUFFER_SIZE,
      undefined,
      "SkyAtmosphere uniforms",
    );
    cache.uniformData = new Float32Array(UNIFORM_BUFFER_SIZE / 4);
  }
  // Batch 110 — split bindGroup creation out of the uniformBuffer init
  // branch so a Batch 110 invalidation (which clears bindGroup but
  // keeps uniformBuffer to avoid reallocating GPU memory) re-creates
  // the bindGroup against the freshly recreated bindGroupLayout.
  if (!defined(cache.bindGroup)) {
    cache.bindGroup = device.createBindGroup({
      layout: cache.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: cache.uniformBuffer.buffer } },
      ],
    });
  }

  // Resolve / dispatch the LUT and obtain the group-1 binding. Returns a
  // placeholder bind group + useLut=false on devices without compute, so
  // the pipeline layout stays stable across backend capability tiers.
  const lutInfo = ensureLutBindGroup(
    cache,
    context,
    device,
    frameState,
    skyAtmosphere,
  );

  // Update uniforms every frame. The SKY shader's LUT fast-path is gated
  // off (ENABLE_SKY_INSCATTER_LUT) — see the constant's doc block; the
  // bake itself still runs above because the globe fog drape consumes
  // the same inscatter texture.
  // Batch 427 (SKY-MS) — opt-in multiple-scattering add. Only enabled when the
  // user flips `skyAtmosphere.multipleScattering` on AND the extended bake has
  // produced a real MS LUT (msReady). Default-false → byte-identical to the
  // single-scattering sky (the shader skips the add).
  const multipleScatteringEnabled =
    skyAtmosphere.multipleScattering === true && lutInfo.msReady === true;
  // Batch 428 (A-LUT-REPARAM / NEW-ATMOSPHERE-LUT-SUN-RELATIVE) — opt-in
  // sun-relative sky-view LUT fast-path. Only enabled when the user flips
  // `skyAtmosphere.useScatteringLut` on AND the extended bake has produced a
  // real sky-view LUT (skyViewReady). Default-false → byte-identical to the
  // inline-march sky (the shader's `u.debug.z` stays 0).
  const useSkyViewLut =
    skyAtmosphere.useScatteringLut === true && lutInfo.skyViewReady === true;
  // Batch 438 — three opt-in atmosphere-physics flags. Each defaults false; the
  // packed uniform stays 0 and the corresponding WGSL gate is closed → the sky
  // is byte-identical with all three off.
  const improvedMiePhase = skyAtmosphere.improvedMiePhase === true;
  const dualLightInline = skyAtmosphere.dualLightInline === true;
  const ozoneEnabled = skyAtmosphere.ozone === true;
  packUniforms(
    cache.uniformData,
    frameState,
    skyAtmosphere,
    ENABLE_SKY_INSCATTER_LUT && lutInfo.useLut,
    multipleScatteringEnabled,
    useSkyViewLut,
    improvedMiePhase,
    dualLightInline,
    ozoneEnabled,
  );
  device.queue.writeBuffer(
    cache.uniformBuffer.buffer,
    0,
    cache.uniformData.buffer,
    0,
    UNIFORM_BUFFER_SIZE,
  );

  // View-independent fullscreen-sky option. When `skyAtmosphere._webgpuFullscreen`
  // is set, push a fullscreen-triangle command (no vertex buffer, draw 3) that
  // reconstructs the per-pixel ray in the shader — covers the whole sky at any
  // altitude, sidestepping the shell mesh's ground-view coverage gap. Same
  // uniform buffer + LUT bind group as the shell path.
  if (
    skyAtmosphere._webgpuFullscreen === true &&
    defined(cache.fullscreenPipeline)
  ) {
    if (!defined(cache.fullscreenCommand)) {
      cache.fullscreenCommand = new WebGPUDrawCommand({
        pipeline: cache.fullscreenPipeline,
        bindGroups: [cache.bindGroup, lutInfo.bindGroup],
        vertexBuffers: [], // verts come from @builtin(vertex_index)
        vertexCount: 3,
        pass: 0, // Pass.ENVIRONMENT
        owner: skyAtmosphere,
      });
    } else if (cache.fullscreenCommand.bindGroups[1] !== lutInfo.bindGroup) {
      cache.fullscreenCommand.bindGroups[1] = lutInfo.bindGroup;
    }
    return cache.fullscreenCommand;
  }

  // Create or reuse command. Group 1 (LUTs) may swap from placeholder to
  // real after the first dispatch — keep the command in sync.
  if (!defined(cache.command)) {
    cache.command = new WebGPUDrawCommand({
      pipeline: cache.pipeline,
      bindGroups: [cache.bindGroup, lutInfo.bindGroup],
      vertexBuffers: [cache.vertexBuffer],
      indexBuffer: cache.indexBuffer,
      indexCount: cache.indexCount,
      indexFormat: "uint16",
      pass: 0, // Pass.ENVIRONMENT
      owner: skyAtmosphere,
    });
  } else if (cache.command.bindGroups[1] !== lutInfo.bindGroup) {
    cache.command.bindGroups[1] = lutInfo.bindGroup;
  }

  //>>includeStart('debug', pragmas.debug);
  if (!globalScope.__skyAtmoDiagFinalLogged) {
    globalScope.__skyAtmoDiagFinalLogged = true;
    console.log(
      `[WebGPU:SkyAtmo] command ready — indexCount=${cache.indexCount}`,
    );
  }
  //>>includeEnd('debug');
  return cache.command;
}

/**
 * Destroys WebGPU resources.
 * @param {SkyAtmosphere} skyAtmosphere
 */
function destroyWebGPUSkyAtmosphereResources(skyAtmosphere) {
  const cache = skyAtmosphere._webgpuCache;
  if (!defined(cache)) {
    return;
  }
  if (defined(cache.vertexBuffer)) {
    cache.vertexBuffer.destroy();
  }
  if (defined(cache.indexBuffer)) {
    cache.indexBuffer.destroy();
  }
  if (defined(cache.uniformBuffer)) {
    cache.uniformBuffer.destroy();
  }
  if (defined(cache.placeholderLutTexture)) {
    cache.placeholderLutTexture.destroy();
  }
  skyAtmosphere._webgpuCache = undefined;
}

/**
 * Feature renderer class for SkyAtmosphere.
 * Wraps the module-level functions to match the feature renderer interface.
 * @private
 */
class WebGPUSkyAtmosphereRenderer {
  update(skyAtmosphere, frameState) {
    return updateWebGPUSkyAtmosphere(skyAtmosphere, frameState);
  }

  destroy(skyAtmosphere) {
    destroyWebGPUSkyAtmosphereResources(skyAtmosphere);
  }
}

export {
  WebGPUSkyAtmosphereRenderer,
  updateWebGPUSkyAtmosphere,
  destroyWebGPUSkyAtmosphereResources,
};

export default WebGPUSkyAtmosphereRenderer;
