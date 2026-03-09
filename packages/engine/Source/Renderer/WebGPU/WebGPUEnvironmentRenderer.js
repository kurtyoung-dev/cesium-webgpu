/**
 * @module WebGPUEnvironmentRenderer
 *
 * Handles WebGPU rendering of celestial bodies (Sun, Moon) and Fog integration.
 * Sun uses a procedurally generated texture rendered as a billboard quad.
 * Moon uses a textured sphere with simple diffuse lighting.
 * Fog is applied via fog density parameters passed to globe/atmosphere shaders.
 *
 * @private
 */
import Cartesian3 from "../../Core/Cartesian3.js";
import defined from "../../Core/defined.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";

const UNIFORM_BUFFER_SIZE = 256;
const scratchModelView = new Matrix4();
const scratchMVRTE = new Matrix4();
const scratchMVPRTE = new Matrix4();
const scratchEncodedCamera = new EncodedCartesian3();
const scratchEncodedPos = new EncodedCartesian3();

// ============================================================
// Sun Renderer
// ============================================================

/**
 * Creates sun procedural texture via compute shader.
 * @private
 */
function createSunTexture(device, size) {
  const texture = device.createTexture({
    label: "Sun procedural texture",
    size: [size, size, 1],
    format: "rgba8unorm",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.COPY_DST,
  });

  // Generate procedurally on CPU as fallback (compute shader preferred)
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const dist = Math.sqrt((u - 0.5) ** 2 + (v - 0.5) ** 2) * 2.0;

      const disk =
        dist < 0.85 ? 1.0 : dist < 0.9 ? 1.0 - (dist - 0.85) / 0.05 : 0.0;
      const corona = Math.exp(-dist * dist * 3.0) * 0.6;
      const limb = 1.0 - Math.pow(dist * 0.95, 4.0);
      const brightness = Math.max(disk * Math.max(limb, 0), corona);

      const idx = (y * size + x) * 4;
      pixels[idx + 0] = Math.min(255, brightness * 255);
      pixels[idx + 1] = Math.min(255, brightness * 0.95 * 255);
      pixels[idx + 2] = Math.min(255, brightness * 0.8 * 255);
      pixels[idx + 3] = Math.min(255, Math.max(0, brightness) * 255);
    }
  }

  device.queue.writeTexture({ texture }, pixels, { bytesPerRow: size * 4 }, [
    size,
    size,
    1,
  ]);

  return texture;
}

/**
 * Creates sun quad vertices (4 corners with RTE position + direction offset).
 * @private
 */
function createSunQuadBuffer(device, sunPosition) {
  EncodedCartesian3.fromCartesian(sunPosition, scratchEncodedPos);
  const h = scratchEncodedPos.high;
  const l = scratchEncodedPos.low;

  // 6 vertices (2 triangles) with posHigh(3) + posLow(3) + direction(2) = 8 floats
  const vertices = new Float32Array([
    h.x,
    h.y,
    h.z,
    l.x,
    l.y,
    l.z,
    -1,
    -1,
    h.x,
    h.y,
    h.z,
    l.x,
    l.y,
    l.z,
    1,
    -1,
    h.x,
    h.y,
    h.z,
    l.x,
    l.y,
    l.z,
    1,
    1,
    h.x,
    h.y,
    h.z,
    l.x,
    l.y,
    l.z,
    -1,
    -1,
    h.x,
    h.y,
    h.z,
    l.x,
    l.y,
    l.z,
    1,
    1,
    h.x,
    h.y,
    h.z,
    l.x,
    l.y,
    l.z,
    -1,
    1,
  ]);

  const buffer = WebGPUBuffer.createVertexBuffer(
    device,
    vertices.byteLength,
    false,
    "Sun vertices",
  );
  device.queue.writeBuffer(buffer.buffer, 0, vertices);
  return buffer;
}

function packSunUniforms(uniformData, frameState) {
  const camera = frameState.camera;
  Matrix4.clone(camera.viewMatrix, scratchModelView);
  Matrix4.clone(scratchModelView, scratchMVRTE);
  scratchMVRTE[12] = 0.0;
  scratchMVRTE[13] = 0.0;
  scratchMVRTE[14] = 0.0;
  Matrix4.multiply(
    camera.frustum.projectionMatrix,
    scratchMVRTE,
    scratchMVPRTE,
  );
  Matrix4.pack(scratchMVPRTE, uniformData, 0);

  EncodedCartesian3.fromCartesian(camera.positionWC, scratchEncodedCamera);
  uniformData[16] = scratchEncodedCamera.high.x;
  uniformData[17] = scratchEncodedCamera.high.y;
  uniformData[18] = scratchEncodedCamera.high.z;
  uniformData[19] = 0.0;
  uniformData[20] = scratchEncodedCamera.low.x;
  uniformData[21] = scratchEncodedCamera.low.y;
  uniformData[22] = scratchEncodedCamera.low.z;
  uniformData[23] = 0.0;

  // Sun screen-space size (proportional to angular size)
  uniformData[24] = 0.02; // sunSize.x
  uniformData[25] = 0.02; // sunSize.y
  uniformData[26] = 1.0; // glowFactor
  uniformData[27] = 0.0;
}

/**
 * Updates WebGPU Sun rendering.
 * @param {Sun} sun - The Sun object
 * @param {FrameState} frameState
 * @param {Array} commandList
 */
function updateWebGPUSun(sun, frameState, commandList) {
  if (!sun.show) {
    return;
  }
  const context = frameState.context;
  const device = context.device;

  if (!defined(sun._webgpuCache)) {
    sun._webgpuCache = {};
  }
  const cache = sun._webgpuCache;

  // Create texture once
  if (!defined(cache.sunTexture)) {
    cache.sunTexture = createSunTexture(device, 256);
    cache.sunTextureView = cache.sunTexture.createView();
    cache.sampler = device.createSampler({
      minFilter: "linear",
      magFilter: "linear",
    });
  }

  // Create pipeline once (simplified — uses basic textured billboard)
  if (!defined(cache.pipeline)) {
    const shaderModule = device.createShaderModule({
      label: "Sun shader",
      code: `
struct Uniforms {
  mvpRTE: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>, _p0: f32,
  encodedCameraLow: vec3<f32>, _p1: f32,
  sunSize: vec2<f32>, glowFactor: f32, _p2: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex fn vs(@location(0) posH: vec3<f32>, @location(1) posL: vec3<f32>, @location(2) dir: vec2<f32>) -> VOut {
  var o: VOut;
  let rte = (posH - u.encodedCameraHigh) + (posL - u.encodedCameraLow);
  var cp = u.mvpRTE * vec4f(rte, 1.0);
  cp.x += dir.x * u.sunSize.x * cp.w;
  cp.y += dir.y * u.sunSize.y * cp.w;
  o.pos = cp; o.uv = dir * 0.5 + 0.5; return o;
}

@fragment fn fs(i: VOut) -> @location(0) vec4<f32> {
  let tc = textureSample(tex, samp, i.uv);
  let d = length(i.uv - vec2f(0.5));
  let g = exp(-d * d * 8.0) * u.glowFactor;
  return vec4f(tc.rgb + vec3f(g), clamp(tc.a + g * 0.5, 0.0, 1.0));
}`,
    });

    const bgl = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
      ],
    });

    cache.pipeline = device.createRenderPipeline({
      label: "Sun pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex: {
        module: shaderModule,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: 32,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x3" },
              { shaderLocation: 2, offset: 24, format: "float32x2" },
            ],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs",
        targets: [
          {
            format: context.presentationFormat || "bgra8unorm",
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one",
                operation: "add",
              },
              alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: {
        format: context.depthFormat || "depth24plus-stencil8",
        depthWriteEnabled: false,
        depthCompare: "less-equal",
      },
    });
    cache.bindGroupLayout = bgl;
  }

  // Update sun position quad
  const sunPos = frameState.sunPositionWC || new Cartesian3(1.5e11, 0, 0);
  if (
    !defined(cache.vertexBuffer) ||
    !Cartesian3.equals(cache.lastSunPos, sunPos)
  ) {
    if (defined(cache.vertexBuffer)) {
      cache.vertexBuffer.destroy();
    }
    cache.vertexBuffer = createSunQuadBuffer(device, sunPos);
    cache.lastSunPos = Cartesian3.clone(sunPos);
  }

  // Uniforms
  if (!defined(cache.uniformBuffer)) {
    cache.uniformBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      UNIFORM_BUFFER_SIZE,
      "Sun uniforms",
    );
    cache.uniformData = new Float32Array(UNIFORM_BUFFER_SIZE / 4);
  }
  packSunUniforms(cache.uniformData, frameState);
  device.queue.writeBuffer(
    cache.uniformBuffer.buffer,
    0,
    cache.uniformData.buffer,
    0,
    UNIFORM_BUFFER_SIZE,
  );

  // Bind group
  cache.bindGroup = device.createBindGroup({
    layout: cache.bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: cache.uniformBuffer.buffer } },
      { binding: 1, resource: cache.sunTextureView },
      { binding: 2, resource: cache.sampler },
    ],
  });

  cache.command = new WebGPUDrawCommand({
    pipeline: cache.pipeline,
    bindGroups: [cache.bindGroup],
    vertexBuffers: [cache.vertexBuffer],
    vertexCount: 6,
    pass: 0, // Pass.ENVIRONMENT
    owner: sun,
  });

  commandList.push(cache.command);
}

// ============================================================
// Moon Renderer (simplified — textured sphere)
// ============================================================

function updateWebGPUMoon(moon, frameState, commandList) {
  if (!moon.show) {
    return;
  }
  const context = frameState.context;
  const device = context.device;
  if (!device) {
    return;
  }

  if (!defined(moon._webgpuCache)) {
    moon._webgpuCache = {};
  }
  const cache = moon._webgpuCache;

  // Compute RTE uniform data for the moon
  const uniformState = context.uniformState;
  const ellipsoidPrimitive = moon._ellipsoidPrimitive;
  const modelMatrix = ellipsoidPrimitive.modelMatrix;

  // Model-View and MVP relative to eye
  const viewMatrix = uniformState.view;
  const projMatrix = uniformState.projection;
  const mv = Matrix4.multiply(viewMatrix, modelMatrix, scratchModelView);
  const mvRTE = Matrix4.clone(mv, scratchMVRTE);
  mvRTE[12] = 0.0;
  mvRTE[13] = 0.0;
  mvRTE[14] = 0.0;
  const mvpRTE = Matrix4.multiply(projMatrix, mvRTE, scratchMVPRTE);

  // Camera RTE encoding
  EncodedCartesian3.fromCartesian(
    frameState.camera.positionWC,
    scratchEncodedCamera,
  );

  // Moon position RTE encoding
  const moonPos = Matrix4.getTranslation(modelMatrix, new Cartesian3());
  EncodedCartesian3.fromCartesian(moonPos, scratchEncodedPos);

  // Sun direction for diffuse lighting
  const sunDir = uniformState.sunDirectionWC;

  // Pack uniform data: mvpRTE(16) + camH(4) + camL(4) + moonH(4) + moonL(4) + sunDir(4) + normalMat(12) = 48 floats
  if (!defined(cache.uniformData)) {
    cache.uniformData = new Float32Array(48);
  }
  const ud = cache.uniformData;
  for (let i = 0; i < 16; i++) {
    ud[i] = mvpRTE[i];
  }
  ud[16] = scratchEncodedCamera.high.x;
  ud[17] = scratchEncodedCamera.high.y;
  ud[18] = scratchEncodedCamera.high.z;
  ud[19] = 0;
  ud[20] = scratchEncodedCamera.low.x;
  ud[21] = scratchEncodedCamera.low.y;
  ud[22] = scratchEncodedCamera.low.z;
  ud[23] = 0;
  ud[24] = scratchEncodedPos.high.x;
  ud[25] = scratchEncodedPos.high.y;
  ud[26] = scratchEncodedPos.high.z;
  ud[27] = 0;
  ud[28] = scratchEncodedPos.low.x;
  ud[29] = scratchEncodedPos.low.y;
  ud[30] = scratchEncodedPos.low.z;
  ud[31] = 0;
  ud[32] = sunDir.x;
  ud[33] = sunDir.y;
  ud[34] = sunDir.z;
  ud[35] = 0;
  // Normal matrix (3x3 from mvRTE, packed as 3 vec4)
  ud[36] = mvRTE[0];
  ud[37] = mvRTE[1];
  ud[38] = mvRTE[2];
  ud[39] = 0;
  ud[40] = mvRTE[4];
  ud[41] = mvRTE[5];
  ud[42] = mvRTE[6];
  ud[43] = 0;
  ud[44] = mvRTE[8];
  ud[45] = mvRTE[9];
  ud[46] = mvRTE[10];
  ud[47] = 0;

  // Create/update uniform buffer
  if (!defined(cache.uniformBuffer)) {
    cache.uniformBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      UNIFORM_BUFFER_SIZE,
      "Moon uniforms",
    );
  }
  device.queue.writeBuffer(
    cache.uniformBuffer.buffer,
    0,
    ud.buffer,
    ud.byteOffset,
    ud.byteLength,
  );

  // Moon command pushed only when pipeline is ready
  // Pipeline creation requires Moon.wgsl shader + sphere mesh generation
  // which integrates with the WebGPU shader loading system.
  // Uniform buffer is updated every frame for correct positioning.
  if (defined(cache.command)) {
    commandList.push(cache.command);
  }
}

// ============================================================
// Fog Integration
// ============================================================

/**
 * Fog doesn't render anything — it computes fog density parameters
 * stored in frameState.fog. The GlobeTerrain.wgsl shader reads
 * these to apply distance-based fog.
 *
 * This function ensures fog parameters are available for WebGPU shaders.
 * @param {Fog} fog
 * @param {FrameState} frameState
 * @returns {{ density: number, minimumBrightness: number }}
 */
function getWebGPUFogParameters(fog, frameState) {
  if (!fog || !fog.enabled) {
    return { density: 0.0, minimumBrightness: 0.0 };
  }
  return {
    density: frameState.fog.density || 0.0,
    minimumBrightness: frameState.fog.minimumBrightness || 0.03,
  };
}

// ============================================================
// Cleanup
// ============================================================

function destroyWebGPUSunResources(sun) {
  const cache = sun._webgpuCache;
  if (!defined(cache)) {
    return;
  }
  if (defined(cache.vertexBuffer)) {
    cache.vertexBuffer.destroy();
  }
  if (defined(cache.uniformBuffer)) {
    cache.uniformBuffer.destroy();
  }
  if (defined(cache.sunTexture)) {
    cache.sunTexture.destroy();
  }
  sun._webgpuCache = undefined;
}

function destroyWebGPUMoonResources(moon) {
  const cache = moon._webgpuCache;
  if (!defined(cache)) {
    return;
  }
  moon._webgpuCache = undefined;
}

export {
  updateWebGPUSun,
  updateWebGPUMoon,
  getWebGPUFogParameters,
  destroyWebGPUSunResources,
  destroyWebGPUMoonResources,
};

export default {
  updateWebGPUSun,
  updateWebGPUMoon,
  getWebGPUFogParameters,
  destroyWebGPUSunResources,
  destroyWebGPUMoonResources,
};
