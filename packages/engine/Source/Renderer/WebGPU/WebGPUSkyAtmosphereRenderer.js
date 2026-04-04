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

  const pipelineLayout = device.createPipelineLayout({
    label: "SkyAtmosphere pipeline layout",
    bindGroupLayouts: [bindGroupLayout],
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

  return { pipeline, bindGroupLayout };
}

/**
 * Packs atmosphere uniform data.
 * @private
 */
function packUniforms(uniformData, frameState, skyAtmosphere) {
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

  // hsbShift
  uniformData[40] = skyAtmosphere.hueShift || 0.0;
  uniformData[41] = skyAtmosphere.saturationShift || 0.0;
  uniformData[42] = skyAtmosphere.brightnessShift || 0.0;
  uniformData[43] = 0.0;

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

  // Update uniforms every frame
  packUniforms(cache.uniformData, frameState, skyAtmosphere);
  device.queue.writeBuffer(
    cache.uniformBuffer.buffer,
    0,
    cache.uniformData.buffer,
    0,
    UNIFORM_BUFFER_SIZE,
  );

  // Create or reuse command
  if (!defined(cache.command)) {
    cache.command = new WebGPUDrawCommand({
      pipeline: cache.pipeline,
      bindGroups: [cache.bindGroup],
      vertexBuffers: [cache.vertexBuffer],
      indexBuffer: cache.indexBuffer,
      indexCount: cache.indexCount,
      indexFormat: "uint16",
      pass: 0, // Pass.ENVIRONMENT
      owner: skyAtmosphere,
    });
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
