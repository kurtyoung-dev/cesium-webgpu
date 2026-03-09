/**
 * @module WebGPUModelRenderer
 *
 * Handles WebGPU rendering of glTF Model instances.
 * Integrates with the existing Model pipeline by intercepting at the
 * ModelSceneGraph level and creating WebGPU draw commands from
 * ModelRuntimePrimitive render resources.
 *
 * Architecture:
 * - Model.update() calls ModelSceneGraph.buildDrawCommands()
 * - We intercept after pipeline stages to create WebGPU commands
 * - Each ModelRuntimePrimitive gets a cached WebGPU pipeline + bind groups
 * - Per-frame: update camera/model uniforms, push commands
 *
 * @private
 */
import Cartesian3 from "../../Core/Cartesian3.js";
import defined from "../../Core/defined.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";

const CAMERA_UNIFORM_SIZE = 256; // mat4(mvpRTE) + mat4(mvRTE) + mat4(normal) + camH/L + camPosWC
const MODEL_UNIFORM_SIZE = 128; // mat4(model) + baseColor + emissive + metallic/roughness/alpha/normal/occlusion
const LIGHT_UNIFORM_SIZE = 64; // sunDir + sunColor + ambient

const scratchModelView = new Matrix4();
const scratchMVRTE = new Matrix4();
const scratchMVPRTE = new Matrix4();
const scratchNormal = new Matrix4();
const scratchEncodedCamera = new EncodedCartesian3();

/**
 * Packs camera uniforms for model rendering.
 * @private
 */
function packCameraUniforms(data, frameState, modelMatrix) {
  const camera = frameState.camera;

  // modelView = view * model
  Matrix4.multiply(camera.viewMatrix, modelMatrix, scratchModelView);
  // modelViewRTE = modelView with translation zeroed
  Matrix4.clone(scratchModelView, scratchMVRTE);
  scratchMVRTE[12] = 0.0;
  scratchMVRTE[13] = 0.0;
  scratchMVRTE[14] = 0.0;
  // mvpRTE = projection * modelViewRTE
  Matrix4.multiply(
    camera.frustum.projectionMatrix,
    scratchMVRTE,
    scratchMVPRTE,
  );

  Matrix4.pack(scratchMVPRTE, data, 0); // [0-15]
  Matrix4.pack(scratchMVRTE, data, 16); // [16-31]

  // Normal matrix = transpose(inverse(modelViewRTE))
  Matrix4.inverse(scratchMVRTE, scratchNormal);
  Matrix4.transpose(scratchNormal, scratchNormal);
  Matrix4.pack(scratchNormal, data, 32); // [32-47]

  // Encoded camera
  EncodedCartesian3.fromCartesian(camera.positionWC, scratchEncodedCamera);
  data[48] = scratchEncodedCamera.high.x;
  data[49] = scratchEncodedCamera.high.y;
  data[50] = scratchEncodedCamera.high.z;
  data[51] = 0.0;
  data[52] = scratchEncodedCamera.low.x;
  data[53] = scratchEncodedCamera.low.y;
  data[54] = scratchEncodedCamera.low.z;
  data[55] = 0.0;

  // Camera position WC
  data[56] = camera.positionWC.x;
  data[57] = camera.positionWC.y;
  data[58] = camera.positionWC.z;
  data[59] = 0.0;
}

/**
 * Packs model material uniforms.
 * @private
 */
function packModelUniforms(data, modelMatrix, material) {
  Matrix4.pack(modelMatrix, data, 0); // [0-15]

  // baseColorFactor
  const bc = material?.baseColorFactor || [1, 1, 1, 1];
  data[16] = bc[0];
  data[17] = bc[1];
  data[18] = bc[2];
  data[19] = bc[3];

  // emissiveFactor + metallicFactor
  const ef = material?.emissiveFactor || [0, 0, 0];
  data[20] = ef[0];
  data[21] = ef[1];
  data[22] = ef[2];
  data[23] = material?.metallicFactor ?? 1.0;

  // roughness, alphaCutoff, normalScale, occlusionStrength
  data[24] = material?.roughnessFactor ?? 1.0;
  data[25] = material?.alphaCutoff ?? 0.5;
  data[26] = material?.normalScale ?? 1.0;
  data[27] = material?.occlusionStrength ?? 1.0;
}

/**
 * Packs light uniforms.
 * @private
 */
function packLightUniforms(data, frameState) {
  const sunDir = frameState.sunDirectionEC || new Cartesian3(0, 0, 1);
  data[0] = sunDir.x;
  data[1] = sunDir.y;
  data[2] = sunDir.z;
  data[3] = 0.0;

  // sunColor + intensity
  data[4] = 1.0;
  data[5] = 1.0;
  data[6] = 1.0;
  data[7] = frameState.light?.intensity ?? 2.0;

  // ambient
  data[8] = 0.2;
  data[9] = 0.2;
  data[10] = 0.2;
  data[11] = 0.0;
}

/**
 * Creates a basic PBR pipeline for model rendering.
 * Uses the ModelPBR.wgsl base shader.
 * @private
 */
function createModelPipeline(device, format, depthFormat) {
  // Inline simplified PBR shader for initial model support
  const code = `
struct CU { mvpRTE: mat4x4<f32>, mvRTE: mat4x4<f32>, nMat: mat4x4<f32>,
  camH: vec3<f32>, _p0: f32, camL: vec3<f32>, _p1: f32, camWC: vec3<f32>, _p2: f32 };
struct MU { model: mat4x4<f32>, baseColor: vec4<f32>,
  emissive: vec3<f32>, metallic: f32, roughness: f32, alphaCut: f32, normScale: f32, aoStr: f32 };
struct LU { sunDir: vec3<f32>, _p0: f32, sunCol: vec3<f32>, sunInt: f32, amb: vec3<f32>, _p1: f32 };

@group(0) @binding(0) var<uniform> cam: CU;
@group(1) @binding(0) var<uniform> mdl: MU;
@group(1) @binding(1) var<uniform> lit: LU;

struct VI { @location(0) pH: vec3<f32>, @location(1) pL: vec3<f32>, @location(2) n: vec3<f32>,
  @location(3) uv: vec2<f32>, @location(4) col: vec4<f32> };
struct VO { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>,
  @location(1) nEC: vec3<f32>, @location(2) pEC: vec3<f32>, @location(3) col: vec4<f32> };

@vertex fn vs(i: VI) -> VO {
  var o: VO;
  let rte = (i.pH - cam.camH) + (i.pL - cam.camL);
  o.pos = cam.mvpRTE * vec4f(rte, 1.0);
  o.pEC = (cam.mvRTE * vec4f(rte, 1.0)).xyz;
  o.nEC = normalize((cam.nMat * vec4f(i.n, 0.0)).xyz);
  o.uv = i.uv; o.col = i.col; return o;
}

const PI = 3.14159265;

@fragment fn fs(i: VO) -> @location(0) vec4<f32> {
  var bc = mdl.baseColor * i.col;
  if (bc.a < mdl.alphaCut) { discard; }
  let N = normalize(i.nEC);
  let V = normalize(-i.pEC);
  let L = normalize(lit.sunDir);
  let NdotL = max(dot(N, L), 0.0);
  let H = normalize(V + L);
  let diff = bc.rgb * NdotL;
  let spec = pow(max(dot(N, H), 0.0), mix(8.0, 128.0, 1.0 - mdl.roughness)) * (1.0 - mdl.roughness);
  let color = lit.amb * bc.rgb + (diff + vec3f(spec)) * lit.sunCol * lit.sunInt + mdl.emissive;
  let tm = color / (color + vec3f(1.0));
  return vec4f(pow(tm, vec3f(1.0/2.2)), bc.a);
}`;

  const mod = device.createShaderModule({ label: "Model PBR", code });

  const camBGL = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
    ],
  });
  const matBGL = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
    ],
  });

  const pipeline = device.createRenderPipeline({
    label: "Model PBR pipeline",
    layout: device.createPipelineLayout({ bindGroupLayouts: [camBGL, matBGL] }),
    vertex: {
      module: mod,
      entryPoint: "vs",
      buffers: [
        {
          arrayStride: 48, // posH(3)+posL(3)+normal(3)+uv(2)+color(4) but simplified
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" }, // posHigh
            { shaderLocation: 1, offset: 12, format: "float32x3" }, // posLow
            { shaderLocation: 2, offset: 24, format: "float32x3" }, // normal
            { shaderLocation: 3, offset: 36, format: "float32x2" }, // texCoord
            { shaderLocation: 4, offset: 44, format: "unorm8x4" }, // vertex color (packed)
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
    primitive: { topology: "triangle-list", cullMode: "back" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: true,
      depthCompare: "less-equal",
    },
  });

  return { pipeline, camBGL, matBGL };
}

/**
 * Updates or creates WebGPU draw commands for a Model.
 *
 * @param {Model} model - The Model instance
 * @param {FrameState} frameState
 * @param {Array} commandList
 */
function updateWebGPUModel(model, frameState, commandList) {
  if (!model.show || !model.ready) {
    return;
  }

  const context = frameState.context;
  const device = context.device;

  if (!defined(model._webgpuCache)) {
    model._webgpuCache = {};
  }
  const cache = model._webgpuCache;

  // Create pipeline once
  if (!defined(cache.pipeline)) {
    const format = context.presentationFormat || "bgra8unorm";
    const depthFmt = context.depthFormat || "depth24plus-stencil8";
    const result = createModelPipeline(device, format, depthFmt);
    cache.pipeline = result.pipeline;
    cache.camBGL = result.camBGL;
    cache.matBGL = result.matBGL;
  }

  // Camera uniform buffer (updated per frame)
  if (!defined(cache.cameraBuffer)) {
    cache.cameraBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      CAMERA_UNIFORM_SIZE,
      "Model camera",
    );
    cache.cameraData = new Float32Array(CAMERA_UNIFORM_SIZE / 4);
    cache.cameraBG = device.createBindGroup({
      layout: cache.camBGL,
      entries: [
        { binding: 0, resource: { buffer: cache.cameraBuffer.buffer } },
      ],
    });
  }

  const modelMatrix = model.modelMatrix || Matrix4.IDENTITY;
  packCameraUniforms(cache.cameraData, frameState, modelMatrix);
  device.queue.writeBuffer(
    cache.cameraBuffer.buffer,
    0,
    cache.cameraData.buffer,
    0,
    CAMERA_UNIFORM_SIZE,
  );

  // Model/Light uniform buffers (created once per model)
  if (!defined(cache.modelBuffer)) {
    cache.modelBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      MODEL_UNIFORM_SIZE,
      "Model material",
    );
    cache.modelData = new Float32Array(MODEL_UNIFORM_SIZE / 4);
    cache.lightBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      LIGHT_UNIFORM_SIZE,
      "Model light",
    );
    cache.lightData = new Float32Array(LIGHT_UNIFORM_SIZE / 4);

    packModelUniforms(cache.modelData, modelMatrix, null);
    packLightUniforms(cache.lightData, frameState);

    device.queue.writeBuffer(
      cache.modelBuffer.buffer,
      0,
      cache.modelData.buffer,
      0,
      MODEL_UNIFORM_SIZE,
    );
    device.queue.writeBuffer(
      cache.lightBuffer.buffer,
      0,
      cache.lightData.buffer,
      0,
      LIGHT_UNIFORM_SIZE,
    );

    cache.matBG = device.createBindGroup({
      layout: cache.matBGL,
      entries: [
        { binding: 0, resource: { buffer: cache.modelBuffer.buffer } },
        { binding: 1, resource: { buffer: cache.lightBuffer.buffer } },
      ],
    });
  }

  // Update lights per frame
  packLightUniforms(cache.lightData, frameState);
  device.queue.writeBuffer(
    cache.lightBuffer.buffer,
    0,
    cache.lightData.buffer,
    0,
    LIGHT_UNIFORM_SIZE,
  );

  // For each draw command in the model, create a WebGPU equivalent
  // This hooks into ModelSceneGraph's existing _drawCommands
  const sceneGraph = model._sceneGraph;
  if (!defined(sceneGraph) || !defined(sceneGraph._drawCommands)) {
    return;
  }

  const drawCommands = sceneGraph._drawCommands;
  for (let i = 0; i < drawCommands.length; i++) {
    const dc = drawCommands[i];
    if (!defined(dc) || !dc.show) {
      continue;
    }

    // Create WebGPU command wrapping the existing vertex data
    // This is a simplified path — full integration needs vertex buffer conversion
    const webgpuCmd = new WebGPUDrawCommand({
      pipeline: cache.pipeline,
      bindGroups: [cache.cameraBG, cache.matBG],
      vertexBuffers: cache.vertexBuffers || [],
      vertexCount: dc.count || 0,
      pass: dc.pass || 8,
      owner: model,
      boundingVolume: dc.boundingVolume || model.boundingSphere,
      modelMatrix: modelMatrix,
      cull: true,
    });

    commandList.push(webgpuCmd);
  }
}

function destroyWebGPUModelResources(model) {
  const cache = model._webgpuCache;
  if (!defined(cache)) {
    return;
  }
  if (defined(cache.cameraBuffer)) {
    cache.cameraBuffer.destroy();
  }
  if (defined(cache.modelBuffer)) {
    cache.modelBuffer.destroy();
  }
  if (defined(cache.lightBuffer)) {
    cache.lightBuffer.destroy();
  }
  model._webgpuCache = undefined;
}

export { updateWebGPUModel, destroyWebGPUModelResources };
export default { updateWebGPUModel, destroyWebGPUModelResources };
