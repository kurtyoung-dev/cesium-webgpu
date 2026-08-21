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
import Pass from "../Pass.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import SkyAtmosphereWGSL from "../../Shaders/WebGPU/Environment/SkyAtmosphere.js";
import { resolveSkyDynamicLighting } from "./WebGPUAtmosphereUniforms.js";
// Scene-framebuffer target helper.
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

// Keep shader modules per device. SkyAtmosphere is a scene singleton, but the
// shared cache pattern also gives it consistent device-loss handling.
const _skyAtmosphereShaderCaches = new WeakMap();

function getSkyAtmosphereShaderCache(device) {
  let cache = _skyAtmosphereShaderCaches.get(device);
  if (!cache) {
    cache = new WebGPUShaderModuleCache(device);
    _skyAtmosphereShaderCaches.set(device, cache);
  }
  return cache;
}

// The 496-byte uniform buffer remains 16-byte aligned. Its tail layout is:
//   windDirectionAndSpeed @64
//   inverseProjection     @68
//   inverseView           @84
//   atmosControl       @100 (improvedMiePhase / dualLightInline / ozoneEnabled)
//   ozoneCoefficient   @104 (+ pad @107)
//   moonLightDirWC     @108 (+ pad @111)
//   moonControl        @112 (phaseFraction / intensityScale)
//   eclipseControl     @116 (horizon-twilight gain)
//   ellipsoid weights  @120 (+ pad @123)
// Zero-valued gates preserve the baseline paths, while fixed offsets keep the
// shell and fullscreen bind groups compatible.
const UNIFORM_BUFFER_SIZE = 496;

// The visible sky does not sample the legacy inscatter LUT. Its
// cosViewZenith-by-altitude mapping has no view-to-sun azimuth axis, but must
// remain unchanged because globe, voxel, splat, point-cloud, and fog consumers
// depend on it. The inline march supplies the baseline visible sky, and a
// separate sun-relative sky-view LUT supplies its optional lookup path. The
// legacy bake still runs for its non-sky consumers.
const ENABLE_SKY_INSCATTER_LUT = false;

const DEFAULT_RAYLEIGH_COEFFICIENT = new Cartesian3(5.5e-6, 13.0e-6, 22.4e-6);
const DEFAULT_MIE_COEFFICIENT = new Cartesian3(21e-6, 21e-6, 21e-6);
// Per-metre RGB Chappuis-band absorption coefficient. Its green/red peak and
// weak blue absorption deepen twilight toward a blue-violet zenith. The value
// is scaled against Rayleigh scattering at the 25 km ozone-density peak and is
// zeroed unless ozone is enabled.
const DEFAULT_OZONE_COEFFICIENT = new Cartesian3(0.65e-6, 1.881e-6, 0.085e-6);
const DEFAULT_RAYLEIGH_SCALE_HEIGHT = 8500.0;
const DEFAULT_MIE_SCALE_HEIGHT = 1200.0;
const DEFAULT_MIE_ANISOTROPY = 0.758;
const ATMOSPHERE_SCALE = 1.025;
// Match `computeScattering.glsl` shell thickness.
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
 * Generates the atmosphere shell's ellipsoid vertices and indices. Vertex
 * high/low positions use Float32Array; indices use Uint16Array.
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
  // Bindings 3 and 4 hold the moon LUT pair. They use the same placeholder
  // while dual-light scattering is inactive so the layout remains constant.
  const lutBindGroupLayout =
    reuseLutBgl ??
    makeBindGroupLayout(device, "SkyAtmosphere LUT bind group layout", [
      sampler(0, Stage.FRAGMENT),
      texture(1, Stage.FRAGMENT),
      texture(2, Stage.FRAGMENT),
      texture(3, Stage.FRAGMENT),
      texture(4, Stage.FRAGMENT),
      // Keep multiple scattering bound unconditionally. A placeholder preserves
      // the layout until a real view is available, and the shader samples it
      // only when the feature gate is set.
      texture(5, Stage.FRAGMENT),
      // The sun-relative sky-view LUT follows the same placeholder pattern and
      // is sampled only when `useScatteringLut` is enabled.
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
                { shaderLocation: 0, offset: 0, format: "float32x3" }, // high
                { shaderLocation: 1, offset: 12, format: "float32x3" }, // low
              ],
            },
          ],
    },
    fragment: {
      module: shaderModule,
      entryPoint: fullscreen ? "fragmentMainFullscreen" : "fragmentMain",
      // Use standard alpha-over blending in the scene framebuffer.
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
    // Match the scene framebuffer sample count for attachment compatibility.
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
          // Moon LUTs use the same zero placeholder as the sun side. The
          // renderer clears the dual-light gate when compute is unavailable,
          // so this path cannot sample them.
          { binding: 3, resource: cache.placeholderLutView },
          { binding: 4, resource: cache.placeholderLutView },
          // Multiple-scattering placeholder; compute availability gates use.
          { binding: 5, resource: cache.placeholderLutView },
          // Sky-view placeholder under the same compute gate.
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

  // Track moon-direction changes with the same threshold as the sun. The moon
  // LUT is considered only when dual light is enabled and `Moon.update` has
  // populated a direction.
  const ac = frameState.atmosphericConditions;
  const lighting = ac && ac.lighting ? ac.lighting : undefined;
  const enableDualLight =
    lighting && lighting.enableDualLightAtmosphere !== false;
  const moonDir = defined(frameState.moonDirectionWC)
    ? frameState.moonDirectionWC
    : undefined;

  // Invalidate both light LUTs when weather coefficients change because those
  // coefficients are baked. Keeping sun and moon invalidation in lockstep
  // prevents the two scattering media from diverging.
  const weatherCheck = ac && ac.weather ? ac.weather : undefined;
  const humidityNow =
    weatherCheck && typeof weatherCheck.humidity === "number"
      ? weatherCheck.humidity
      : 0.5;
  const airQualityNow =
    weatherCheck && typeof weatherCheck.airQuality === "number"
      ? weatherCheck.airQuality
      : 1.0;
  // Treat the ozone gate like other bake inputs so every LUT path adds or
  // removes its extinction together.
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
          // Multiple-scattering placeholder.
          { binding: 5, resource: cache.placeholderLutView },
          // Sky-view placeholder.
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

  // Rebuild the real bind group when LUT views change. The performance
  // manager's cached views remain stable for the device lifetime, so this
  // happens at most once. Use the real multiple-scattering view when present
  // and keep the placeholder for partial implementations to preserve layout.
  const msView = res.multipleScatterView ?? cache.placeholderLutView;
  // Apply the same fallback for the sky-view texture.
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
  // shortcuts to a single texture sample. If the enabled moon LUT is also
  // dirty, use the same encoder to avoid another queue submission.
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

    // The sky-view bake needs sun zenith relative to the camera's local up so
    // it can place the sun on its canonical meridian. Fall back to world z when
    // camera position is unavailable or degenerate.
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

    // Atmospheric conditions modulate coefficients before the LUT bake:
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
    // Bake ozone into every table so sky view, aerial perspective, and fog
    // receive the same extinction as the inline march. A disabled gate supplies
    // a zero coefficient.
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
          // Observer-relative sun zenith for `computeSkyView`; other kernels
          // ignore this field.
          sunCosZenith,
          // Ozone extinction baked into the LUTs.
          ozoneCoefficient,
        },
        "sun",
      );
      // Chain multiple scattering and irradiance on the same encoder after a
      // successful sun bake. They consume the transmittance and
      // single-scattering outputs. The method check keeps partial performance
      // managers on the base LUT path.
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
          // Use the same ozone extinction for the moon LUT.
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

  // Multiple scattering is ready only after a successful sun bake and binding
  // of its real view. Track it separately because the legacy inscatter lookup
  // remains disabled for the visible sky.
  const msReady =
    cache.lutReady === true &&
    defined(res.multipleScatterView) &&
    cache.lutMultipleScatterView === res.multipleScatterView;
  // Sky view is ready only after the sun bake and binding of its real view. It
  // is independent of the disabled legacy-inscatter lookup.
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
  // Use the current multi-frustum band's near/far instead of the full camera
  // frustum range. The sky shell renders inside the frustum loop on the far
  // band (`i === 0`); later globe tiles in that band write depth normalized to
  // the band's near/far through `_updateFrustumUniforms`. If the shell uses
  // the full `camera.frustum.near/far`, sky and globe depth are computed from
  // different mappings of physical distance to NDC z. The mismatch produces
  // a dark line where the sky shell wraps in front of the globe silhouette.
  //
  // `_updateFrustumUniforms → updateFrustum` sets the Cartesian2
  // `uniformState.currentFrustum` for each band. Fall back to the full
  // frustum when unavailable. In a single-frustum scene it matches the
  // camera's near/far and is a no-op; in a multi-frustum scene it keeps
  // sky-shell and per-band globe depth consistent at the silhouette.
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

  // Resolve the dynamic-lighting enum from the `SkyAtmosphere` instance, where
  // `Scene.updateEnvironment` stores the value selected from scene and globe
  // state. Sky scattering coefficients remain instance-owned. `SCENE_LIGHT`
  // uses the scene direction; `NONE` and `SUNLIGHT` use the astronomical sun.
  // `LEGACY_OVERHEAD` derives local up per fragment in the shader.
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

  // Pack WebGL's scattering-shell geometry and the dynamic-lighting enum:
  //
  //   radiusAdjust = (radiiDiff / 4) + distanceAdjust(eyeHeight)
  //   atmosphereInnerRadius = (|cameraWC| - eyeHeight) - radiusAdjust
  //   atmosphereOuterRadius = atmosphereInnerRadius + 111e3
  //
  // The radius adjustment aligns density height with WebGL. The `.w` slot
  // carries `czm_eyeHeight + atmosphereInnerRadius` for altitude opacity,
  // while the 1.025 ellipsoid scale controls only rasterized shell coverage.
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

  // Read visible-sky scale heights and anisotropy from the instance, matching
  // WebGL and honoring user configuration. The legacy inscatter bake retains
  // its established constants because non-sky fog consumers depend on that
  // mapping and tuning.
  uniformData[36] =
    skyAtmosphere.atmosphereRayleighScaleHeight ??
    DEFAULT_RAYLEIGH_SCALE_HEIGHT;
  uniformData[37] =
    skyAtmosphere.atmosphereMieScaleHeight ?? DEFAULT_MIE_SCALE_HEIGHT;
  uniformData[38] =
    skyAtmosphere.atmosphereMieAnisotropy ?? DEFAULT_MIE_ANISOTROPY;
  // Match `SkyAtmosphere.js` by applying the instance's eclipse light factor to
  // inline-scattering intensity. `SkyAtmosphere.update` refreshes the factor;
  // it is exactly one outside an eclipse.
  //
  // Do not multiply the LUT bake input. Its invalidation follows sun direction,
  // which barely moves during an eclipse, so baking the transient factor could
  // retain stale dimming after totality.
  uniformData[39] =
    (skyAtmosphere.atmosphereLightIntensity || 50.0) *
    (skyAtmosphere._eclipseLightFactor ?? 1.0);

  // hsbShift + useLut flag (replaces _pad4 — see SkyAtmosphere.wgsl Uniforms)
  uniformData[40] = skyAtmosphere.hueShift || 0.0;
  uniformData[41] = skyAtmosphere.saturationShift || 0.0;
  uniformData[42] = skyAtmosphere.brightnessShift || 0.0;
  uniformData[43] = useLut ? 1.0 : 0.0;

  // Apply the bake's humidity and air-quality scaling to inline coefficients as
  // well. This keeps atmospheric character stable when orbital cameras cross
  // from LUT sampling to ray marching.
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

  // Read instance coefficients to match WebGL and honor user configuration.
  // Default humidity and air quality leave the weather scale neutral.
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

  // Debug controls. Read from frame state so a scene property can toggle the
  // diagnostic. Layout matches `SkyAtmosphere.wgsl`:
  //   x: disableScattering — bypass Rayleigh+Mie, emit flat magenta
  //   y: multipleScatteringEnabled — add the precomputed higher-order term.
  //      The renderer sets it only when requested and the LUT is ready.
  //   z: useSkyViewLut — select the separate sun-relative table.
  //   w: reserved
  uniformData[52] = frameState.debugDisableAtmosphereScattering ? 1.0 : 0.0;
  uniformData[53] = multipleScatteringEnabled ? 1.0 : 0.0;
  uniformData[54] = useSkyViewLut ? 1.0 : 0.0;
  uniformData[55] = 0.0;

  // Dual-light atmosphere inputs. `moonDirectionWC` occupies offsets 56-59.
  // Use positive z before a moon update so the shader never reads
  // uninitialized vector data.
  const moonDir = defined(frameState.moonDirectionWC)
    ? frameState.moonDirectionWC
    : { x: 0, y: 0, z: 1 };
  uniformData[56] = moonDir.x;
  uniformData[57] = moonDir.y;
  uniformData[58] = moonDir.z;
  uniformData[59] = 0.0;

  // `dualLightControl` packs enablement, moon phase, and intensity scale. Scene
  // lighting owns the parity-off default; the LUT branch also requires a moon
  // direction and available lookup resources. The 0.05 fallback intensity
  // keeps full-moon scattering far below daylight.
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

  // Pack world-space wind direction and metres-per-second speed from
  // atmospheric weather. This shader reserves but does not consume the
  // values; a positive-z direction and zero speed encode a calm state without
  // uninitialized data.
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

  // `atmosControl` at offset 100 gates improved Mie phase, inline dual light,
  // ozone, and translucent-globe scattering. Zero leaves each branch inactive.
  uniformData[100] = improvedMiePhase ? 1.0 : 0.0;
  uniformData[101] = dualLightInline ? 1.0 : 0.0;
  uniformData[102] = ozoneEnabled ? 1.0 : 0.0;
  // Mirror WebGL's `GLOBE_TRANSLUCENT` branch. Rays through a translucent globe
  // use the dark distance-faded horizon gradient instead of full scattering,
  // preventing daylight blue from flooding the see-through planet disk.
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

  // `moonControl` at offset 112 packs phase fraction, intensity scale, and two
  // reserved values. The inline gate ignores it when disabled. Since the moon
  // march already uses full atmosphere light intensity, its scale is the
  // fraction of daytime sky shown as moonglow. The 0.12 fallback remains
  // visible after 8-bit output quantization and can be overridden by
  // atmospheric lighting.
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

  // `eclipseControl` at offset 116 carries the horizon-twilight gain. Both
  // backends read the value refreshed by `SkyAtmosphere.update`; zero skips the
  // shader contribution outside totality.
  uniformData[116] = skyAtmosphere._eclipseHorizonTwilight ?? 0.0;
  uniformData[117] = 0.0;
  uniformData[118] = 0.0;
  uniformData[119] = 0.0;

  // `ellipsoidInverseRadiiSquared` at offset 120 supplies the gradient used for
  // geodetic up in the horizon-twilight block. Use the same active ellipsoid as
  // shell geometry and scattering radii.
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

  // Invalidate cached pipelines when HDR or MSAA changes the scene target
  // generation. A pipeline retains its fragment format and would be invalid
  // against the recreated framebuffer; generation checks avoid rebuilds once
  // the format stabilizes.
  const currentGen = context._scenePipelineFormatGeneration ?? 0;
  if (
    defined(cache.pipeline) &&
    cache._pipelineFormatGeneration !== currentGen
  ) {
    cache.pipeline = undefined;
    cache.fullscreenPipeline = undefined;
    cache._pipelineFailed = false;
    // Commands hold direct pipeline references and must rebuild with it.
    cache.command = undefined;
    cache.fullscreenCommand = undefined;
    // Bind groups target the recreated layouts, so clear both references and
    // let the normal setup branch rebuild them.
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
      // The fullscreen pipeline reuses the shader module and bind-group layouts
      // so shell bind groups remain compatible. Only entry points, vertex
      // buffers, and face culling differ.
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
  // Create the bind group independently from its buffer so pipeline
  // invalidation can rebuild the group without reallocating GPU memory.
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

  // Update uniforms every frame. The legacy inscatter lookup is disabled for
  // the visible sky; its bake serves fog, globe, voxel, splat, and point-cloud
  // consumers. Multiple scattering needs both a request and a ready real LUT.
  const multipleScatteringEnabled =
    skyAtmosphere.multipleScattering === true && lutInfo.msReady === true;
  // The separate sun-relative sky-view lookup also requires an explicit
  // option and a ready texture; otherwise the inline march remains active.
  const useSkyViewLut =
    skyAtmosphere.useScatteringLut === true && lutInfo.skyViewReady === true;
  // Optional atmosphere-physics flags map directly to independent WGSL gates.
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

  // The view-independent option draws a fullscreen triangle and reconstructs
  // each ray in the shader. It covers the sky at every altitude without the
  // shell mesh's ground-view gap and shares the shell's uniforms and LUT group.
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
        pass: Pass.ENVIRONMENT,
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
      pass: Pass.ENVIRONMENT,
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
