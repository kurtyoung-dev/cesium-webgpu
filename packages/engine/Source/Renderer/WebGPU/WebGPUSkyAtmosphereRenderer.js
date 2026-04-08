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
  const shaderModule = device.createShaderModule({
    label: "SkyAtmosphere shader",
    code: shaderCode,
  });

  const bindGroupLayout = device.createBindGroupLayout({
    label: "SkyAtmosphere bind group layout",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
    ],
  });

  // Group 1 holds the precomputed atmosphere LUTs. Bound unconditionally so
  // the pipeline layout never changes — when the LUT compute path is
  // unavailable we still bind 1×1 placeholder views and clear the
  // `useLut` uniform flag so the fragment shader takes the ray-march path.
  const lutBindGroupLayout = device.createBindGroupLayout({
    label: "SkyAtmosphere LUT bind group layout",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "filtering" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float", viewDimension: "2d" },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float", viewDimension: "2d" },
      },
    ],
  });

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

  const perfMgr =
    typeof context.performanceManager !== "undefined"
      ? context.performanceManager
      : null;
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
    cache.lutInscatterView !== res.inscatterView
  ) {
    cache.lutBindGroup = device.createBindGroup({
      label: "SkyAtmosphere LUT bind group",
      layout: cache.lutBindGroupLayout,
      entries: [
        { binding: 0, resource: cache.lutSampler },
        { binding: 1, resource: res.transmittanceView },
        { binding: 2, resource: res.inscatterView },
      ],
    });
    cache.lutTransmittanceView = res.transmittanceView;
    cache.lutInscatterView = res.inscatterView;
  }

  // If the LUT is dirty (first frame, or sun direction moved), dispatch
  // the compute pass on a one-shot encoder. We feed it the same scattering
  // constants we'd otherwise use in the ray march so the LUT and the
  // fallback path agree. Once `useLut` flips on, the fragment shader
  // shortcuts to a single texture sample.
  if (perfMgr.shouldRecomputeAtmosphereLUT()) {
    const ellipsoid = skyAtmosphere._ellipsoid || Ellipsoid.WGS84;
    const innerRadius = Cartesian3.maximumComponent(ellipsoid.radii);
    const outerRadius = innerRadius * ATMOSPHERE_SCALE;
    const encoder = device.createCommandEncoder({
      label: "SkyAtmosphere LUT dispatch",
    });
    const ok = perfMgr.dispatchAtmosphereLUT(encoder, device, {
      innerRadius,
      outerRadius,
      rayleighScaleHeight: DEFAULT_RAYLEIGH_SCALE_HEIGHT,
      mieScaleHeight: DEFAULT_MIE_SCALE_HEIGHT,
      mieAnisotropy: DEFAULT_MIE_ANISOTROPY,
      intensity: skyAtmosphere.atmosphereLightIntensity || 50.0,
      rayleighCoefficient: [
        DEFAULT_RAYLEIGH_COEFFICIENT.x,
        DEFAULT_RAYLEIGH_COEFFICIENT.y,
        DEFAULT_RAYLEIGH_COEFFICIENT.z,
      ],
      mieCoefficient: [
        DEFAULT_MIE_COEFFICIENT.x,
        DEFAULT_MIE_COEFFICIENT.y,
        DEFAULT_MIE_COEFFICIENT.z,
      ],
      sunDirection: [sunDir.x, sunDir.y, sunDir.z],
    });
    device.queue.submit([encoder.finish()]);
    if (ok) {
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

  Matrix4.multiply(camera.viewMatrix, Matrix4.IDENTITY, scratchModelView);
  Matrix4.clone(scratchModelView, scratchMVRTE);
  scratchMVRTE[12] = 0.0;
  scratchMVRTE[13] = 0.0;
  scratchMVRTE[14] = 0.0;
  Matrix4.multiply(
    camera.frustum.projectionMatrix,
    scratchMVRTE,
    scratchMVPRTE,
  );

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

  // sunDirectionWC
  const sunDir = defined(frameState.sunDirectionWC)
    ? frameState.sunDirectionWC
    : new Cartesian3(0, 0, 1);
  uniformData[28] = sunDir.x;
  uniformData[29] = sunDir.y;
  uniformData[30] = sunDir.z;
  uniformData[31] = 0.0;

  // radiiAndDynamicAtmosphere
  const ellipsoid = skyAtmosphere._ellipsoid || Ellipsoid.WGS84;
  const innerRadius = Cartesian3.maximumComponent(ellipsoid.radii);
  const outerRadius = innerRadius * ATMOSPHERE_SCALE;
  uniformData[32] = innerRadius;
  uniformData[33] = outerRadius;
  uniformData[34] = skyAtmosphere.atmosphereLightIntensity || 50.0;
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
}

/**
 * Updates or creates WebGPU draw commands for SkyAtmosphere.
 * @param {SkyAtmosphere} skyAtmosphere
 * @param {FrameState} frameState
 * @param {Array} commandList
 */
function updateWebGPUSkyAtmosphere(skyAtmosphere, frameState, commandList) {
  if (!skyAtmosphere.show) {
    return;
  }

  const context = frameState.context;
  const device = context.device;

  if (!defined(skyAtmosphere._webgpuCache)) {
    skyAtmosphere._webgpuCache = {};
  }
  const cache = skyAtmosphere._webgpuCache;

  // Create pipeline once (getShaderSource is synchronous — no await needed)
  if (!defined(cache.pipeline)) {
    const shaderCode = getShaderSource();
    const format = context.presentationFormat || "bgra8unorm";
    const depthFmt = context.depthFormat || "depth24plus-stencil8";
    const result = createPipeline(device, shaderCode, format, depthFmt);
    cache.pipeline = result.pipeline;
    cache.bindGroupLayout = result.bindGroupLayout;
    cache.lutBindGroupLayout = result.lutBindGroupLayout;
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
