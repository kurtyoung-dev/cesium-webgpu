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
 * Creates sun procedural texture via CPU fallback.
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
 * Creates sun quad vertices.
 * @private
 */
function createSunQuadBuffer(device, sunPosition) {
  EncodedCartesian3.fromCartesian(sunPosition, scratchEncodedPos);
  const h = scratchEncodedPos.high;
  const l = scratchEncodedPos.low;

  // 6 vertices: posHigh(3) + posLow(3) + direction(2) = 8 floats
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
    vertices,
    "Sun vertices",
  );
  return buffer;
}

function packSunUniforms(uniformData, frameState) {
  const uniformState = frameState.context.uniformState;
  Matrix4.clone(uniformState.view, scratchModelView);
  Matrix4.clone(scratchModelView, scratchMVRTE);
  scratchMVRTE[12] = 0.0;
  scratchMVRTE[13] = 0.0;
  scratchMVRTE[14] = 0.0;
  Matrix4.multiply(uniformState.projection, scratchMVRTE, scratchMVPRTE);
  Matrix4.pack(scratchMVPRTE, uniformData, 0);

  EncodedCartesian3.fromCartesian(
    frameState.camera.positionWC,
    scratchEncodedCamera,
  );
  uniformData[16] = scratchEncodedCamera.high.x;
  uniformData[17] = scratchEncodedCamera.high.y;
  uniformData[18] = scratchEncodedCamera.high.z;
  uniformData[19] = 0.0;
  uniformData[20] = scratchEncodedCamera.low.x;
  uniformData[21] = scratchEncodedCamera.low.y;
  uniformData[22] = scratchEncodedCamera.low.z;
  uniformData[23] = 0.0;

  uniformData[24] = 0.02; // sunSize.x
  uniformData[25] = 0.02; // sunSize.y
  uniformData[26] = 1.0; // glowFactor
  uniformData[27] = 0.0;
}

/**
 * Updates WebGPU Sun rendering.
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

  if (!defined(cache.sunTexture)) {
    cache.sunTexture = createSunTexture(device, 256);
    cache.sunTextureView = cache.sunTexture.createView();
    cache.sampler = device.createSampler({
      minFilter: "linear",
      magFilter: "linear",
    });
  }

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
              alpha: {
                srcFactor: "one",
                dstFactor: "one",
                operation: "add",
              },
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

  if (!defined(cache.uniformBuffer)) {
    cache.uniformBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      UNIFORM_BUFFER_SIZE,
      undefined,
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
// Moon Renderer — Textured Sphere with Diffuse Lighting
// ============================================================

const MOON_SEGMENTS = 32;
const MOON_RINGS = 16;

/**
 * Generates a UV sphere mesh for the Moon.
 * Vertex layout: posHigh(3) + posLow(3) + normal(3) + uv(2) = 11 floats = 44 bytes
 * @private
 */
function createMoonSphereGeometry(device, radii) {
  const rx = radii.x;
  const ry = radii.y;
  const rz = radii.z;
  const segments = MOON_SEGMENTS;
  const rings = MOON_RINGS;

  const vertCount = (segments + 1) * (rings + 1);
  const idxCount = segments * rings * 6;
  const floatsPerVert = 11;
  const vertices = new Float32Array(vertCount * floatsPerVert);
  const indices = new Uint16Array(idxCount);

  let vOff = 0;
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);

    for (let s = 0; s <= segments; s++) {
      const theta = (s / segments) * 2.0 * Math.PI;
      const sinT = Math.sin(theta);
      const cosT = Math.cos(theta);

      // Normal (unit sphere)
      const nx = cosT * sinPhi;
      const ny = cosPhi;
      const nz = sinT * sinPhi;

      // Position (scaled by radii)
      const px = nx * rx;
      const py = ny * ry;
      const pz = nz * rz;

      // RTE encode model-local position
      // Model-local positions are small (~1737km), posHigh ≈ position, posLow ≈ 0
      EncodedCartesian3.fromCartesian(
        new Cartesian3(px, py, pz),
        scratchEncodedPos,
      );

      vertices[vOff + 0] = scratchEncodedPos.high.x;
      vertices[vOff + 1] = scratchEncodedPos.high.y;
      vertices[vOff + 2] = scratchEncodedPos.high.z;
      vertices[vOff + 3] = scratchEncodedPos.low.x;
      vertices[vOff + 4] = scratchEncodedPos.low.y;
      vertices[vOff + 5] = scratchEncodedPos.low.z;
      vertices[vOff + 6] = nx;
      vertices[vOff + 7] = ny;
      vertices[vOff + 8] = nz;
      vertices[vOff + 9] = s / segments;
      vertices[vOff + 10] = r / rings;
      vOff += floatsPerVert;
    }
  }

  let iOff = 0;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s;
      const b = a + segments + 1;
      indices[iOff++] = a;
      indices[iOff++] = b;
      indices[iOff++] = a + 1;
      indices[iOff++] = a + 1;
      indices[iOff++] = b;
      indices[iOff++] = b + 1;
    }
  }

  const vb = WebGPUBuffer.createVertexBuffer(
    device,
    vertices,
    "Moon sphere VB",
  );

  const ib = device.createBuffer({
    label: "Moon sphere IB",
    size: indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(ib, 0, indices);

  return { vertexBuffer: vb, indexBuffer: ib, indexCount: idxCount };
}

/**
 * Creates the Moon rendering pipeline (textured sphere + diffuse lighting).
 * @private
 */
function createMoonPipeline(device, format, depthFormat) {
  const code = `
struct U {
  mvpRTE: mat4x4<f32>,
  camH: vec3<f32>, _p0: f32,
  camL: vec3<f32>, _p1: f32,
  moonH: vec3<f32>, _p2: f32,
  moonL: vec3<f32>, _p3: f32,
  sunDir: vec3<f32>, _p4: f32,
  nMat0: vec3<f32>, _p5: f32,
  nMat1: vec3<f32>, _p6: f32,
  nMat2: vec3<f32>, _p7: f32,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct VI {
  @location(0) pH: vec3<f32>,
  @location(1) pL: vec3<f32>,
  @location(2) n: vec3<f32>,
  @location(3) uv: vec2<f32>,
};
struct VO {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) nEC: vec3<f32>,
};

@vertex fn vs(i: VI) -> VO {
  var o: VO;
  let rte = (i.pH - u.camH) + (i.pL - u.camL);
  o.pos = u.mvpRTE * vec4f(rte, 1.0);
  let nMat = mat3x3<f32>(u.nMat0, u.nMat1, u.nMat2);
  o.nEC = normalize(nMat * i.n);
  o.uv = i.uv;
  return o;
}

@fragment fn fs(i: VO) -> @location(0) vec4<f32> {
  let tc = textureSample(tex, samp, i.uv);
  let N = normalize(i.nEC);
  let NdotL = max(dot(N, normalize(u.sunDir)), 0.0);
  let ambient = 0.05;
  let diffuse = NdotL;
  let color = tc.rgb * (ambient + diffuse);
  return vec4f(color, 1.0);
}`;

  const mod = device.createShaderModule({ label: "Moon shader", code });

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

  const pipeline = device.createRenderPipeline({
    label: "Moon pipeline",
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    vertex: {
      module: mod,
      entryPoint: "vs",
      buffers: [
        {
          arrayStride: 44, // 11 floats
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" }, // posHigh
            { shaderLocation: 1, offset: 12, format: "float32x3" }, // posLow
            { shaderLocation: 2, offset: 24, format: "float32x3" }, // normal
            { shaderLocation: 3, offset: 36, format: "float32x2" }, // uv
          ],
        },
      ],
    },
    fragment: {
      module: mod,
      entryPoint: "fs",
      targets: [
        {
          format,
          blend: {
            color: {
              srcFactor: "one",
              dstFactor: "zero",
              operation: "add",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "zero",
              operation: "add",
            },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list", cullMode: "back" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
  });

  return { pipeline, bgl };
}

/**
 * Creates a placeholder 4x4 gray texture for the Moon when the real texture hasn't loaded.
 * @private
 */
function createMoonPlaceholderTexture(device) {
  const size = 4;
  const pixels = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    pixels[i * 4 + 0] = 180;
    pixels[i * 4 + 1] = 180;
    pixels[i * 4 + 2] = 180;
    pixels[i * 4 + 3] = 255;
  }
  const texture = device.createTexture({
    label: "Moon placeholder",
    size: [size, size, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture }, pixels, { bytesPerRow: size * 4 }, [
    size,
    size,
    1,
  ]);
  return texture;
}

/**
 * Updates WebGPU Moon rendering with full sphere geometry + pipeline + draw command.
 */
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

  // Create sphere geometry once
  if (!defined(cache.geometry)) {
    const radii = moon._ellipsoid.radii;
    cache.geometry = createMoonSphereGeometry(device, radii);
  }

  // Create pipeline once
  if (!defined(cache.pipeline)) {
    const format = context.presentationFormat || "bgra8unorm";
    const depthFmt = context.depthFormat || "depth24plus-stencil8";
    const result = createMoonPipeline(device, format, depthFmt);
    cache.pipeline = result.pipeline;
    cache.bgl = result.bgl;
  }

  // Moon texture (placeholder until real texture loads)
  if (!defined(cache.moonTexture)) {
    cache.moonTexture = createMoonPlaceholderTexture(device);
    cache.moonTextureView = cache.moonTexture.createView();
    cache.sampler = device.createSampler({
      minFilter: "linear",
      magFilter: "linear",
    });
  }

  // Uniform buffer
  if (!defined(cache.uniformBuffer)) {
    cache.uniformBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      UNIFORM_BUFFER_SIZE,
      undefined,
      "Moon uniforms",
    );
    cache.uniformData = new Float32Array(UNIFORM_BUFFER_SIZE / 4);
  }

  // Compute RTE uniforms
  const uniformState = context.uniformState;
  const ellipsoidPrimitive = moon._ellipsoidPrimitive;
  const modelMatrix = ellipsoidPrimitive.modelMatrix;

  const viewMatrix = uniformState.view;
  const projMatrix = uniformState.projection;
  const mv = Matrix4.multiply(viewMatrix, modelMatrix, scratchModelView);
  const mvRTE = Matrix4.clone(mv, scratchMVRTE);
  mvRTE[12] = 0.0;
  mvRTE[13] = 0.0;
  mvRTE[14] = 0.0;
  const mvpRTE = Matrix4.multiply(projMatrix, mvRTE, scratchMVPRTE);

  EncodedCartesian3.fromCartesian(
    frameState.camera.positionWC,
    scratchEncodedCamera,
  );

  const moonPos = Matrix4.getTranslation(modelMatrix, new Cartesian3());
  EncodedCartesian3.fromCartesian(moonPos, scratchEncodedPos);

  const sunDir = uniformState.sunDirectionWC;

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

  device.queue.writeBuffer(
    cache.uniformBuffer.buffer,
    0,
    ud.buffer,
    ud.byteOffset,
    ud.byteLength,
  );

  // Create bind group (recreated each frame for simplicity)
  cache.bindGroup = device.createBindGroup({
    layout: cache.bgl,
    entries: [
      { binding: 0, resource: { buffer: cache.uniformBuffer.buffer } },
      { binding: 1, resource: cache.moonTextureView },
      { binding: 2, resource: cache.sampler },
    ],
  });

  // Create draw command with indexed geometry
  cache.command = new WebGPUDrawCommand({
    pipeline: cache.pipeline,
    bindGroups: [cache.bindGroup],
    vertexBuffers: [cache.geometry.vertexBuffer],
    indexBuffer: cache.geometry.indexBuffer,
    indexCount: cache.geometry.indexCount,
    indexFormat: "uint16",
    pass: 0, // Pass.ENVIRONMENT
    owner: moon,
  });

  commandList.push(cache.command);
}

// ============================================================
// Fog Integration
// ============================================================

/**
 * Extracts fog parameters for WebGPU shaders.
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
  if (defined(cache.geometry)) {
    if (defined(cache.geometry.vertexBuffer)) {
      cache.geometry.vertexBuffer.destroy();
    }
    if (defined(cache.geometry.indexBuffer)) {
      cache.geometry.indexBuffer.destroy();
    }
  }
  if (defined(cache.uniformBuffer)) {
    cache.uniformBuffer.destroy();
  }
  if (defined(cache.moonTexture)) {
    cache.moonTexture.destroy();
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
