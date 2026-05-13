/**
 * @module WebGPUSkyAtmosphereRenderer
 *
 * Handles WebGPU rendering of the SkyAtmosphere effect.
 * Renders an ellipsoid shell with Nishita-style atmospheric scattering.
 *
 * @private
 */
import Cartesian3 from "../../Core/Cartesian3.js";
import defined from "../../Core/defined.js";
import Ellipsoid from "../../Core/Ellipsoid.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import SkyAtmosphereWGSL from "../../Shaders/WebGPU/Environment/SkyAtmosphere.js";
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
const UNIFORM_BUFFER_SIZE = 256;

// Default atmosphere parameters
const DEFAULT_RAYLEIGH_COEFFICIENT = new Cartesian3(5.5e-6, 13.0e-6, 22.4e-6);
const DEFAULT_MIE_COEFFICIENT = new Cartesian3(21e-6, 21e-6, 21e-6);
const DEFAULT_RAYLEIGH_SCALE_HEIGHT = 8500.0;
const DEFAULT_MIE_SCALE_HEIGHT = 1200.0;
const DEFAULT_MIE_ANISOTROPY = 0.758;
const ATMOSPHERE_SCALE = 1.025;

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
function createPipeline(device, shaderCode, format, depthFormat) {
  const shaderModule = getSkyAtmosphereShaderCache(device).getOrCreate(
    ShaderSourceId.SKY_ATMOSPHERE,
    shaderCode,
    0,
    "SkyAtmosphere shader",
  );

  const bindGroupLayout = makeBindGroupLayout(
    device,
    "SkyAtmosphere bind group layout",
    [uniformBuffer(0, Stage.VERTEX_FRAGMENT)],
  );

  // Group 1 holds the precomputed atmosphere LUTs. Bound unconditionally so
  // the pipeline layout never changes — when the LUT compute path is
  // unavailable we still bind 1×1 placeholder views and clear the
  // `useLut` uniform flag so the fragment shader takes the ray-march path.
  //
  // Phase 1.3c — bindings 3 and 4 hold the moon LUT pair. They're bound
  // unconditionally too, falling back to the same placeholder when
  // dual-light scattering isn't active so the layout stays constant.
  const lutBindGroupLayout = makeBindGroupLayout(
    device,
    "SkyAtmosphere LUT bind group layout",
    [
      sampler(0, Stage.FRAGMENT),
      texture(1, Stage.FRAGMENT),
      texture(2, Stage.FRAGMENT),
      texture(3, Stage.FRAGMENT),
      texture(4, Stage.FRAGMENT),
    ],
  );

  const pipelineLayout = device.createPipelineLayout({
    label: "SkyAtmosphere pipeline layout",
    bindGroupLayouts: [bindGroupLayout, lutBindGroupLayout],
  });

  const pipeline = device.createRenderPipeline({
    label: "SkyAtmosphere pipeline",
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: [
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
      entryPoint: "fragmentMain",
      targets: [
        {
          format: format,
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
        },
      ],
    },
    primitive: {
      topology: "triangle-list",
      cullMode: "front", // Front-face culling for atmosphere
    },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
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
        ],
      });
    }
    return { bindGroup: cache.lutBindGroup, useLut: false };
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
  if (
    cache.lastHumidity !== humidityNow ||
    cache.lastAirQuality !== airQualityNow
  ) {
    cache.lastHumidity = humidityNow;
    cache.lastAirQuality = airQualityNow;
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
        ],
      });
    }
    return { bindGroup: cache.lutBindGroup, useLut: false };
  }

  // (Re)build the real bind group when the LUT views change. The views
  // come from the perf manager's cached textures and are stable for the
  // lifetime of the device, so this happens at most once.
  if (
    !defined(cache.lutBindGroup) ||
    cache.lutTransmittanceView !== res.transmittanceView ||
    cache.lutInscatterView !== res.inscatterView ||
    cache.lutMoonTransmittanceView !== res.moonTransmittanceView ||
    cache.lutMoonInscatterView !== res.moonInscatterView
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
      ],
    });
    cache.lutTransmittanceView = res.transmittanceView;
    cache.lutInscatterView = res.inscatterView;
    cache.lutMoonTransmittanceView = res.moonTransmittanceView;
    cache.lutMoonInscatterView = res.moonInscatterView;
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
        },
        "sun",
      );
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
        },
        "moon",
      );
    }

    device.queue.submit([encoder.finish()]);
    if (sunOk) {
      cache.lutReady = true;
    }
  }

  return { bindGroup: cache.lutBindGroup, useLut: cache.lutReady === true };
}

/**
 * Packs atmosphere uniform data.
 * @private
 */
function packUniforms(uniformData, frameState, skyAtmosphere, useLut) {
  const camera = frameState.camera;

  // Session 65 (2026-05-11): build the projection matrix in WebGPU NDC
  // depth range ([0, 1]) instead of reading `camera.frustum.projectionMatrix`
  // which is cached in WebGL convention ([-1, 1]).
  //
  // The frustum caches its `_perspectiveMatrix` keyed only on
  // near/far/left/right/top/bottom (see `PerspectiveOffCenterFrustum.update`).
  // It does NOT invalidate when `Matrix4._depthRangeType` toggles, so a
  // late `setDepthRangeType("webgpu")` returns the stale WebGL-range
  // cached matrix. WebGL convention emits clip-space z in [-1, 1]; the
  // WebGPU clip test rejects fragments with NDC z < 0, which silently
  // culls roughly half the shell mesh. Outside-shell views (orbital
  // altitudes) still render because every shell fragment sits in front
  // of the camera (positive view-space z) and the projection naturally
  // maps that into [0, 1]. Inside-shell views (low altitude — Aerometrex
  // SF, Particle Fireworks, every ground-level photogrammetry demo)
  // have shell fragments on both sides of the camera direction; the
  // negative half gets clipped, leaving a black sky where WebGL shows
  // blue atmosphere.
  //
  // We compute the WebGPU-range projection directly so the frustum
  // cache stays clean for the WebGL path (which reads the same
  // `camera.frustum.projectionMatrix` and depends on [-1, 1] depth).
  Matrix4.setDepthRangeType("webgpu");
  const off = camera.frustum.offCenterFrustum ?? camera.frustum;
  Matrix4.computePerspectiveOffCenter(
    off.left,
    off.right,
    off.bottom,
    off.top,
    off.near,
    off.far,
    scratchProjectionWebGPU,
  );
  Matrix4.setDepthRangeType("webgl");

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
  const dynamicLighting = frameState.atmosphere?.dynamicLighting ?? 0;
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
  // Forward-compatible: when the WGSL adds a per-fragment NONE
  // branch, it can read `u.radiiAndDynamicAtmosphere.z` to make the
  // decision without any further JS changes.
  const ellipsoid = skyAtmosphere._ellipsoid || Ellipsoid.WGS84;
  const innerRadius = Cartesian3.maximumComponent(ellipsoid.radii);
  const outerRadius = innerRadius * ATMOSPHERE_SCALE;
  uniformData[32] = innerRadius;
  uniformData[33] = outerRadius;
  uniformData[34] = dynamicLighting;
  uniformData[35] = 0.0;

  // Scale heights and anisotropy
  uniformData[36] = DEFAULT_RAYLEIGH_SCALE_HEIGHT;
  uniformData[37] = DEFAULT_MIE_SCALE_HEIGHT;
  uniformData[38] = DEFAULT_MIE_ANISOTROPY;
  uniformData[39] = skyAtmosphere.atmosphereLightIntensity || 50.0;

  // hsbShift + useLut flag (replaces _pad4 — see SkyAtmosphere.wgsl Uniforms)
  uniformData[40] = skyAtmosphere.hueShift || 0.0;
  uniformData[41] = skyAtmosphere.saturationShift || 0.0;
  uniformData[42] = skyAtmosphere.brightnessShift || 0.0;
  uniformData[43] = useLut ? 1.0 : 0.0;

  // rayleighCoefficient
  uniformData[44] = DEFAULT_RAYLEIGH_COEFFICIENT.x;
  uniformData[45] = DEFAULT_RAYLEIGH_COEFFICIENT.y;
  uniformData[46] = DEFAULT_RAYLEIGH_COEFFICIENT.z;
  uniformData[47] = 0.0;

  // mieCoefficient
  uniformData[48] = DEFAULT_MIE_COEFFICIENT.x;
  uniformData[49] = DEFAULT_MIE_COEFFICIENT.y;
  uniformData[50] = DEFAULT_MIE_COEFFICIENT.z;
  uniformData[51] = 0.0;

  // Tier 1 debug controls. Read from frameState (set by Scene each frame)
  // so a single property toggle on Scene flips the diagnostic on. Layout
  // matches the WGSL `debug: vec4<f32>` field — see SkyAtmosphere.wgsl.
  //   x: disableScattering — bypass Rayleigh+Mie, emit flat magenta
  //   y/z/w: reserved for Tier 3 (LUT inspector, sun-dir override)
  uniformData[52] = frameState.debugDisableAtmosphereScattering ? 1.0 : 0.0;
  uniformData[53] = 0.0;
  uniformData[54] = 0.0;
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
}

/**
 * Updates or creates WebGPU draw commands for SkyAtmosphere.
 * @param {SkyAtmosphere} skyAtmosphere
 * @param {FrameState} frameState
 * @param {Array} commandList
 */
function updateWebGPUSkyAtmosphere(skyAtmosphere, frameState, commandList) {
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
    cache._pipelineFailed = false;
    // The cached `WebGPUDrawCommand` carries a direct reference to
    // the OLD pipeline. Drop it so it rebuilds with the new pipeline.
    cache.command = undefined;
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
      const result = createPipeline(device, shaderCode, format, depthFmt);
      cache.pipeline = result.pipeline;
      cache.bindGroupLayout = result.bindGroupLayout;
      cache.lutBindGroupLayout = result.lutBindGroupLayout;
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

  // Update uniforms every frame
  packUniforms(cache.uniformData, frameState, skyAtmosphere, lutInfo.useLut);
  device.queue.writeBuffer(
    cache.uniformBuffer.buffer,
    0,
    cache.uniformData.buffer,
    0,
    UNIFORM_BUFFER_SIZE,
  );

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

  commandList.push(cache.command);

  //>>includeStart('debug', pragmas.debug);
  if (!globalScope.__skyAtmoDiagFinalLogged) {
    globalScope.__skyAtmoDiagFinalLogged = true;
    console.log(
      `[WebGPU:SkyAtmo] command pushed — indexCount=${cache.indexCount} ` +
        `listLenAfterPush=${commandList.length}`,
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
  update(skyAtmosphere, frameState, globe) {
    return updateWebGPUSkyAtmosphere(skyAtmosphere, frameState, globe);
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
