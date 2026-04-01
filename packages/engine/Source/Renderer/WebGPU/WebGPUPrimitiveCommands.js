/**
 * @module WebGPUPrimitiveCommands
 *
 * WebGPU command creation and per-frame uniform update logic for the Primitive
 * rendering pipeline. Extracted from Primitive.js for better organization and
 * maintainability.
 *
 * Contains:
 * - createWebGPUCommands() — builds GPU pipelines, buffers, bind groups, and draw commands
 * - updateWebGPUCommandUniforms() — per-frame camera matrix updates for GPU uniform buffers
 *
 * ALL rendering uses RTE (Relative-To-Eye) emulated 64-bit precision:
 * - Vertex buffers carry positionHigh(3) + positionLow(3) for each vertex
 * - Uniform buffers carry mvpRelativeToEye + encodedCameraHigh/Low
 * - Shaders use translateRelativeToEye() for sub-meter precision at planetary scale
 *
 * @private
 */
import Cartesian3 from "../../Core/Cartesian3.js";
import defined from "../../Core/defined.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import Pass from "../Pass.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import WebGPUShaderModule from "./WebGPUShaderModule.js";
import { WebGPUTexture } from "./WebGPUTexture.js";
import {
  selectWebGPUShader,
  getVertexLayoutForShader,
  getUniformSizeForShader,
  getPickShaderForType,
  getMaterialPickShaderForType,
  getPickUniformSize,
  isPhongShader,
  isTexturedShader,
  selectMaterialShader,
  getMaterialVertexLayout,
  getMaterialUniformSize,
  isMaterialLitShader,
  isPBRShader,
} from "./WebGPUPrimitiveShaders.js";
import {
  getEffectsBindGroupLayout,
  getPlaceholderEffects,
} from "./WebGPUEffectsBindGroup.js";

// =========================================================================
// Scratch variables for per-frame uniform updates (avoid per-frame allocations)
// =========================================================================
const scratchModelViewMatrix = new Matrix4();
const scratchModelViewRTE = new Matrix4();
const scratchMVPRTE = new Matrix4();
const scratchNormalMatrix = new Matrix4();
const scratchInverseModel = new Matrix4();
const scratchCameraPositionMC = new Cartesian3();
const scratchEncodedCamera = new EncodedCartesian3();
// Scratch for encoding a single vertex position
const scratchEncodedPosition = new EncodedCartesian3();
// RTE uniform scratch buffers (64 floats = 256 bytes)
const scratchRTEUniformData = new Float32Array(64);

// =========================================================================
// Shared Position Extraction — RTE (positionHigh + positionLow)
// =========================================================================

/**
 * Extracts position data from geometry attributes as positionHigh/positionLow
 * pairs for RTE (Relative-To-Eye) rendering. This is CRITICAL for planetary-scale
 * precision — never use single float32 positions for world-space geometry.
 *
 * For geometry with position3DHigh/Low: uses the raw high/low arrays directly.
 * For geometry with only single position: encodes via EncodedCartesian3.
 *
 * @param {object} geometry - Geometry with attributes
 * @returns {null|{posHighValues: Float32Array, posLowValues: Float32Array, numVertices: number}}
 * @private
 */
function extractPositionData(geometry) {
  const posHighAttr = geometry.attributes.position3DHigh;
  const posLowAttr = geometry.attributes.position3DLow;
  const posAttr = geometry.attributes.position;
  const hasHL =
    defined(posHighAttr) &&
    defined(posHighAttr.values) &&
    defined(posLowAttr) &&
    defined(posLowAttr.values);

  if (hasHL) {
    // Direct high/low split from CesiumJS geometry pipeline
    const cpa = posHighAttr.componentsPerAttribute;
    const nv = posHighAttr.values.length / cpa;
    return {
      posHighValues: posHighAttr.values,
      posLowValues: posLowAttr.values,
      numVertices: nv,
    };
  }

  if (defined(posAttr) && defined(posAttr.values)) {
    // Single position — encode each position into high/low via EncodedCartesian3
    const values = posAttr.values;
    const cpa = posAttr.componentsPerAttribute;
    const nv = values.length / cpa;
    const highVals = new Float32Array(nv * 3);
    const lowVals = new Float32Array(nv * 3);
    const scratchCart = new Cartesian3();

    for (let v = 0; v < nv; v++) {
      const off = v * cpa;
      scratchCart.x = values[off];
      scratchCart.y = values[off + 1];
      scratchCart.z = values[off + 2];
      EncodedCartesian3.fromCartesian(scratchCart, scratchEncodedPosition);
      const h = scratchEncodedPosition.high;
      const l = scratchEncodedPosition.low;
      highVals[v * 3] = h.x;
      highVals[v * 3 + 1] = h.y;
      highVals[v * 3 + 2] = h.z;
      lowVals[v * 3] = l.x;
      lowVals[v * 3 + 1] = l.y;
      lowVals[v * 3 + 2] = l.z;
    }
    return {
      posHighValues: highVals,
      posLowValues: lowVals,
      numVertices: nv,
    };
  }

  return null;
}

/**
 * Helper: creates or reuses an index buffer for a geometry.
 * @private
 */
function ensureIndexBuffer(device, geometry, cache, i) {
  if (!defined(geometry.indices) || defined(cache.indexBuffers[i])) {
    return;
  }
  const indices = geometry.indices;
  cache.indexCounts[i] = indices.length;
  let u32 = false;
  for (let idx = 0; idx < indices.length; idx++) {
    if (indices[idx] > 65535) {
      u32 = true;
      break;
    }
  }
  const data = u32 ? new Uint32Array(indices) : new Uint16Array(indices);
  cache.indexFormats[i] = u32 ? "uint32" : "uint16";
  cache.indexBuffers[i] = WebGPUBuffer.createIndexBuffer(
    device,
    data,
    `IB ${i}`,
  );
}

/**
 * Computes RTE matrices and encoded camera for a given model matrix.
 * Returns { mvpRTE, modelViewRTE, modelView, camHigh, camLow }.
 * @private
 */
function computeRTEMatrices(uniformState, camera, modelMatrix) {
  const modelView = Matrix4.multiply(
    uniformState.view,
    modelMatrix,
    scratchModelViewMatrix,
  );
  Matrix4.clone(modelView, scratchModelViewRTE);
  scratchModelViewRTE[12] = 0.0;
  scratchModelViewRTE[13] = 0.0;
  scratchModelViewRTE[14] = 0.0;
  Matrix4.multiply(uniformState.projection, scratchModelViewRTE, scratchMVPRTE);

  // Encoded camera position in model coordinates
  Matrix4.inverse(modelMatrix, scratchInverseModel);
  Matrix4.multiplyByPoint(
    scratchInverseModel,
    camera.positionWC,
    scratchCameraPositionMC,
  );
  EncodedCartesian3.fromCartesian(
    scratchCameraPositionMC,
    scratchEncodedCamera,
  );

  return {
    mvpRTE: scratchMVPRTE,
    modelViewRTE: scratchModelViewRTE,
    modelView: modelView,
    camHigh: scratchEncodedCamera.high,
    camLow: scratchEncodedCamera.low,
  };
}

/**
 * Writes RTE uniform data for a flat (unlit) shader.
 * Layout: mvpRTE(16) + camHigh(3+1pad) + camLow(3+1pad) = 24 floats = 96 bytes
 * @private
 */
function writeRTEUniformsFlat(ud, rte) {
  Matrix4.pack(rte.mvpRTE, ud, 0);
  ud[16] = rte.camHigh.x;
  ud[17] = rte.camHigh.y;
  ud[18] = rte.camHigh.z;
  ud[19] = 0.0;
  ud[20] = rte.camLow.x;
  ud[21] = rte.camLow.y;
  ud[22] = rte.camLow.z;
  ud[23] = 0.0;
}

/**
 * Writes RTE uniform data for a lit (Phong/PBR) shader.
 * Layout: mvpRTE(16) + mvRTE(16) + normalMatrix(16) + camHigh(4) + camLow(4) + lightDir(4) = 60 floats = 240 bytes
 * @private
 */
function writeRTEUniformsLit(ud, rte, uniformState) {
  Matrix4.pack(rte.mvpRTE, ud, 0);
  Matrix4.pack(rte.modelViewRTE, ud, 16);
  const normalMatrix = Matrix4.inverse(rte.modelView, scratchNormalMatrix);
  Matrix4.transpose(normalMatrix, normalMatrix);
  Matrix4.pack(normalMatrix, ud, 32);
  ud[48] = rte.camHigh.x;
  ud[49] = rte.camHigh.y;
  ud[50] = rte.camHigh.z;
  ud[51] = 0.0;
  ud[52] = rte.camLow.x;
  ud[53] = rte.camLow.y;
  ud[54] = rte.camLow.z;
  ud[55] = 0.0;
  if (defined(uniformState) && defined(uniformState.sunDirectionEC)) {
    ud[56] = uniformState.sunDirectionEC.x;
    ud[57] = uniformState.sunDirectionEC.y;
    ud[58] = uniformState.sunDirectionEC.z;
  } else {
    ud[56] = 0.5;
    ud[57] = 0.7;
    ud[58] = 0.5;
  }
  ud[59] = 0.0;
}

/**
 * Writes RTE uniform data for a pick shader.
 * Layout: mvpRTE(16) + camHigh(4) + camLow(4) + pickColor(4) = 28 floats = 112 bytes
 * @private
 */
function writeRTEUniformsPick(ud, rte, pickColor) {
  Matrix4.pack(rte.mvpRTE, ud, 0);
  ud[16] = rte.camHigh.x;
  ud[17] = rte.camHigh.y;
  ud[18] = rte.camHigh.z;
  ud[19] = 0.0;
  ud[20] = rte.camLow.x;
  ud[21] = rte.camLow.y;
  ud[22] = rte.camLow.z;
  ud[23] = 0.0;
  if (defined(pickColor)) {
    ud[24] = pickColor.red;
    ud[25] = pickColor.green;
    ud[26] = pickColor.blue;
    ud[27] = pickColor.alpha;
  }
}

// =========================================================================
// Per-Frame Uniform Update
// =========================================================================

/**
 * Updates the GPU uniform buffer for a WebGPU draw command with current camera matrices.
 * Called every frame from updateAndQueueCommands() to keep the MVP matrix
 * in sync with the camera as it moves.
 *
 * @param {WebGPUDrawCommand} command - The WebGPU draw command to update
 * @param {FrameState} frameState - Current frame state (contains context, uniformState)
 * @param {Matrix4} modelMatrix - The primitive's model-to-world matrix
 * @private
 */
function updateWebGPUCommandUniforms(command, frameState, modelMatrix) {
  if (!command.isWebGPUDrawCommand || !command._webgpuUniformBuffer) {
    return;
  }

  const context = frameState.context;
  const device = context.device;
  if (!device) {
    return;
  }

  const rte = computeRTEMatrices(
    context.uniformState,
    frameState.camera,
    modelMatrix,
  );
  const ud = scratchRTEUniformData;

  if (isPhongShader(command._webgpuShaderType)) {
    writeRTEUniformsLit(ud, rte, context.uniformState);
    device.queue.writeBuffer(
      command._webgpuUniformBuffer,
      0,
      ud.buffer,
      0,
      240,
    );
  } else {
    writeRTEUniformsFlat(ud, rte);
    device.queue.writeBuffer(command._webgpuUniformBuffer, 0, ud.buffer, 0, 96);
  }
}

// =========================================================================
// Pick Uniform Update (per frame)
// =========================================================================

const scratchPickUniformData = new Float32Array(64);

/**
 * Updates the GPU uniform buffer for a WebGPU pick command with current camera matrices.
 * @private
 */
function updateWebGPUPickCommandUniforms(command, frameState, modelMatrix) {
  if (
    !command.isWebGPUDrawCommand ||
    !command._webgpuUniformBuffer ||
    !command._isPickCommand
  ) {
    return;
  }

  const context = frameState.context;
  const device = context.device;
  if (!device) {
    return;
  }

  const rte = computeRTEMatrices(
    context.uniformState,
    frameState.camera,
    modelMatrix,
  );
  const ud = scratchPickUniformData;
  writeRTEUniformsPick(ud, rte, command._webgpuPickColor);
  device.queue.writeBuffer(command._webgpuUniformBuffer, 0, ud.buffer, 0, 112);
}

// =========================================================================
// WebGPU Command Creation — Per-Instance-Color Path
// =========================================================================

/**
 * Creates WebGPU draw commands for a Primitive's geometries (PerInstanceColorAppearance).
 * Vertex buffers carry positionHigh(3) + positionLow(3) for RTE precision.
 * @private
 */
function createWebGPUCommands(
  primitive,
  appearance,
  material,
  translucent,
  twoPasses,
  colorCommands,
  pickCommands,
  frameState,
) {
  const context = frameState.context;
  const device = context.device;

  const webgpuGeomData = primitive._webgpuGeometryData;
  const rawGeometries = primitive._geometries;

  if (!defined(device)) {
    colorCommands.length = 0;
    return;
  }

  const useWebGPUData = defined(webgpuGeomData) && webgpuGeomData.length > 0;
  const useRawGeom = defined(rawGeometries) && rawGeometries.length > 0;

  if (!useWebGPUData && !useRawGeom) {
    colorCommands.length = 0;
    return;
  }

  const geometries = useWebGPUData ? webgpuGeomData : rawGeometries;
  const validCommands = [];

  const batchTable = primitive._batchTable;
  const colorIndex = primitive._batchTableAttributeIndices?.color;
  const hasInstanceColors = defined(batchTable) && defined(colorIndex);

  const allowPicking = primitive._allowPicking;
  const pickIds = primitive._pickIds;
  const hasPickIds = allowPicking && defined(pickIds) && pickIds.length > 0;

  // ── Initialize GPU object cache ──
  if (!defined(primitive._webgpuCache)) {
    primitive._webgpuCache = {
      shaderType: null,
      shaderModule: null,
      pipeline: null,
      bindGroupLayout: null,
      uniformBuffers: [],
      bindGroups: [],
      vertexBuffers: [],
      indexBuffers: [],
      indexFormats: [],
      indexCounts: [],
      vertexCounts: [],
      pickShaderModule: null,
      pickPipeline: null,
      pickBindGroupLayout: null,
      pickUniformBuffers: [],
      pickBindGroups: [],
    };
  }
  const cache = primitive._webgpuCache;

  // ── Shader selection ──
  const firstGeometry = geometries[0];
  const shaderInfo = selectWebGPUShader(firstGeometry.attributes);
  const vertexLayout = getVertexLayoutForShader(shaderInfo.type);
  const uniformSize = getUniformSizeForShader(shaderInfo.type);

  const shaderChanged = cache.shaderType !== shaderInfo.type;
  const needsTexture = isTexturedShader(shaderInfo.type);

  if (shaderChanged) {
    cache.shaderType = shaderInfo.type;

    cache.shaderModule = WebGPUShaderModule.create({
      device: device,
      code: shaderInfo.code,
      label: `${shaderInfo.type} Shader`,
    });

    const uniformVisibility = isPhongShader(shaderInfo.type)
      ? GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
      : GPUShaderStage.VERTEX;

    cache.bindGroupLayout = device.createBindGroupLayout({
      label: "Uniform BGL",
      entries: [
        {
          binding: 0,
          visibility: uniformVisibility,
          buffer: { type: "uniform" },
        },
      ],
    });

    const bindGroupLayouts = [cache.bindGroupLayout];

    if (needsTexture) {
      cache.textureBindGroupLayout = device.createBindGroupLayout({
        label: "Texture BGL",
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
        ],
      });
      bindGroupLayouts.push(cache.textureBindGroupLayout);
    } else {
      cache.textureBindGroupLayout = null;
    }

    // Effects BGL (shadow receive + clipping) — always present via placeholder
    const effectsBGL = getEffectsBindGroupLayout(device);
    bindGroupLayouts.push(effectsBGL);
    cache.effectsBGL = effectsBGL;

    const canvasFormat =
      context.presentationFormat || navigator.gpu.getPreferredCanvasFormat();
    cache.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: bindGroupLayouts,
      }),
      vertex: {
        module: cache.shaderModule.module,
        entryPoint: "vertexMain",
        buffers: [vertexLayout.layout],
      },
      fragment: {
        module: cache.shaderModule.module,
        entryPoint: "fragmentMain",
        targets: [{ format: canvasFormat }],
      },
      primitive: {
        topology: "triangle-list",
        cullMode: "none",
        frontFace: "ccw",
      },
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });

    // Default placeholder texture for textured shaders
    if (needsTexture && !defined(cache.defaultTexture)) {
      const texSize = 64;
      const checkerboard = new Uint8Array(texSize * texSize * 4);
      const tileSize = 8;
      for (let y = 0; y < texSize; y++) {
        for (let x = 0; x < texSize; x++) {
          const idx = (y * texSize + x) * 4;
          const isLight =
            (Math.floor(x / tileSize) + Math.floor(y / tileSize)) % 2 === 0;
          const val = isLight ? 230 : 80;
          checkerboard[idx] = val;
          checkerboard[idx + 1] = val;
          checkerboard[idx + 2] = val;
          checkerboard[idx + 3] = 255;
        }
      }
      cache.defaultTexture = WebGPUTexture.create2D(
        device,
        texSize,
        texSize,
        "rgba8unorm",
        1,
        "DefaultCheckerboard",
      );
      cache.defaultTexture.write(checkerboard);
      cache.defaultSampler = device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "repeat",
        addressModeV: "repeat",
      });
      cache.textureBindGroup = device.createBindGroup({
        layout: cache.textureBindGroupLayout,
        entries: [
          { binding: 0, resource: cache.defaultSampler },
          { binding: 1, resource: cache.defaultTexture.view },
        ],
      });
    }

    // ── Pick pipeline ──
    if (hasPickIds) {
      const pickShaderCode = getPickShaderForType(shaderInfo.type);
      cache.pickShaderModule = WebGPUShaderModule.create({
        device: device,
        code: pickShaderCode,
        label: `${shaderInfo.type} Pick Shader`,
      });
      cache.pickBindGroupLayout = device.createBindGroupLayout({
        label: "Pick BGL",
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: { type: "uniform" },
          },
        ],
      });
      cache.pickPipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({
          bindGroupLayouts: [cache.pickBindGroupLayout],
        }),
        vertex: {
          module: cache.pickShaderModule.module,
          entryPoint: "vertexMain",
          buffers: [vertexLayout.layout],
        },
        fragment: {
          module: cache.pickShaderModule.module,
          entryPoint: "fragmentMain",
          targets: [
            {
              format:
                context.presentationFormat ||
                navigator.gpu.getPreferredCanvasFormat(),
            },
          ],
        },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: {
          format: "depth24plus-stencil8",
          depthWriteEnabled: true,
          depthCompare: "less",
        },
      });
    }
  }

  const validPickCommands = [];

  // Compute RTE matrices for initial uniform writes
  Matrix4.setDepthRangeType("webgpu");
  const rte = computeRTEMatrices(
    context.uniformState,
    frameState.camera,
    primitive.modelMatrix,
  );

  for (let i = 0; i < geometries.length; i++) {
    const geometry = geometries[i];

    // ── Extract RTE position data (positionHigh + positionLow) ──
    const posData = extractPositionData(geometry);
    if (!posData) {
      continue;
    }
    const { posHighValues, posLowValues, numVertices } = posData;

    // ── Extract normals ──
    const normalAttr = geometry.attributes.normal;
    const hasNormals = defined(normalAttr) && defined(normalAttr.values);
    const normals = hasNormals ? normalAttr.values : null;
    const normalCPA = hasNormals ? normalAttr.componentsPerAttribute || 3 : 3;

    // ── Extract UVs ──
    const stAttr = geometry.attributes.st;
    const hasUV = defined(stAttr) && defined(stAttr.values);
    const uvs = hasUV ? stAttr.values : null;
    const stCPA = hasUV ? stAttr.componentsPerAttribute || 2 : 2;

    // ── Per-instance color ──
    let instanceColor = [1.0, 1.0, 1.0, 1.0];
    let gotInstanceColor = false;

    if (hasInstanceColors && i < primitive._numberOfInstances) {
      try {
        const batchColor = batchTable.getBatchedAttribute(i, colorIndex);
        if (defined(batchColor)) {
          if (defined(batchColor.red)) {
            instanceColor = [
              batchColor.red,
              batchColor.green,
              batchColor.blue,
              batchColor.alpha,
            ];
            gotInstanceColor = true;
          } else if (defined(batchColor.x)) {
            const r = batchColor.x;
            const g = batchColor.y;
            const b = batchColor.z;
            const a = batchColor.w;
            if (r > 1.0 || g > 1.0 || b > 1.0 || a > 1.0) {
              instanceColor = [r / 255.0, g / 255.0, b / 255.0, a / 255.0];
            } else {
              instanceColor = [r, g, b, a];
            }
            gotInstanceColor = true;
          }
        }
      } catch (e) {
        // Silently fall through
      }
    }

    if (!gotInstanceColor) {
      const colorAttr = geometry.attributes.color;
      if (
        defined(colorAttr) &&
        defined(colorAttr.values) &&
        colorAttr.values.length >= 4
      ) {
        instanceColor = [
          colorAttr.values[0],
          colorAttr.values[1],
          colorAttr.values[2],
          colorAttr.values[3],
        ];
      }
    }

    // ── Build RTE vertex data: posHigh(3) + posLow(3) + other attributes ──
    const fpv = vertexLayout.floatsPerVertex;
    const vertexData = new Float32Array(numVertices * fpv);

    for (let v = 0; v < numVertices; v++) {
      const posOff = v * 3;
      const vOff = v * fpv;

      // positionHigh (3 floats)
      vertexData[vOff] = posHighValues[posOff];
      vertexData[vOff + 1] = posHighValues[posOff + 1];
      vertexData[vOff + 2] = posHighValues[posOff + 2];
      // positionLow (3 floats)
      vertexData[vOff + 3] = posLowValues[posOff];
      vertexData[vOff + 4] = posLowValues[posOff + 1];
      vertexData[vOff + 5] = posLowValues[posOff + 2];

      if (shaderInfo.type === "phongTextured") {
        // posHigh(3)+posLow(3)+normal(3)+uv(2)+color(4) = 15 floats
        if (hasNormals) {
          const nOff = v * normalCPA;
          vertexData[vOff + 6] = normals[nOff];
          vertexData[vOff + 7] = normals[nOff + 1];
          vertexData[vOff + 8] = normals[nOff + 2];
        } else {
          vertexData[vOff + 6] = 0.0;
          vertexData[vOff + 7] = 1.0;
          vertexData[vOff + 8] = 0.0;
        }
        if (hasUV) {
          const uOff = v * stCPA;
          vertexData[vOff + 9] = uvs[uOff];
          vertexData[vOff + 10] = uvs[uOff + 1];
        } else {
          vertexData[vOff + 9] = 0.0;
          vertexData[vOff + 10] = 0.0;
        }
        vertexData[vOff + 11] = instanceColor[0];
        vertexData[vOff + 12] = instanceColor[1];
        vertexData[vOff + 13] = instanceColor[2];
        vertexData[vOff + 14] = instanceColor[3];
      } else if (shaderInfo.type === "basicTextured") {
        // posHigh(3)+posLow(3)+uv(2)+color(4) = 12 floats
        if (hasUV) {
          const uOff = v * stCPA;
          vertexData[vOff + 6] = uvs[uOff];
          vertexData[vOff + 7] = uvs[uOff + 1];
        } else {
          vertexData[vOff + 6] = 0.0;
          vertexData[vOff + 7] = 0.0;
        }
        vertexData[vOff + 8] = instanceColor[0];
        vertexData[vOff + 9] = instanceColor[1];
        vertexData[vOff + 10] = instanceColor[2];
        vertexData[vOff + 11] = instanceColor[3];
      } else if (shaderInfo.type === "phong") {
        // posHigh(3)+posLow(3)+normal(3)+color(4) = 13 floats
        if (hasNormals) {
          const nOff = v * normalCPA;
          vertexData[vOff + 6] = normals[nOff];
          vertexData[vOff + 7] = normals[nOff + 1];
          vertexData[vOff + 8] = normals[nOff + 2];
        } else {
          vertexData[vOff + 6] = 0.0;
          vertexData[vOff + 7] = 1.0;
          vertexData[vOff + 8] = 0.0;
        }
        vertexData[vOff + 9] = instanceColor[0];
        vertexData[vOff + 10] = instanceColor[1];
        vertexData[vOff + 11] = instanceColor[2];
        vertexData[vOff + 12] = instanceColor[3];
      } else {
        // basic: posHigh(3)+posLow(3)+color(4) = 10 floats
        vertexData[vOff + 6] = instanceColor[0];
        vertexData[vOff + 7] = instanceColor[1];
        vertexData[vOff + 8] = instanceColor[2];
        vertexData[vOff + 9] = instanceColor[3];
      }
    }

    // ── Vertex buffer ──
    if (!defined(cache.vertexBuffers[i]) || shaderChanged) {
      if (defined(cache.vertexBuffers[i])) {
        cache.vertexBuffers[i].destroy();
      }
      cache.vertexBuffers[i] = WebGPUBuffer.createVertexBuffer(
        device,
        vertexData,
        `Primitive VB ${i}`,
      );
    }

    // ── Index buffer ──
    ensureIndexBuffer(device, geometry, cache, i);
    cache.vertexCounts[i] = numVertices;

    // ── Uniform buffer (RTE layout) ──
    if (!defined(cache.uniformBuffers[i])) {
      cache.uniformBuffers[i] = device.createBuffer({
        size: uniformSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: `Primitive UB ${i}`,
      });
    }

    // Write initial RTE uniform data
    const uniformData = new Float32Array(uniformSize / 4);
    if (isPhongShader(shaderInfo.type)) {
      writeRTEUniformsLit(uniformData, rte, context.uniformState);
    } else {
      writeRTEUniformsFlat(uniformData, rte);
    }
    device.queue.writeBuffer(cache.uniformBuffers[i], 0, uniformData);

    // ── Bind group ──
    cache.bindGroups[i] = device.createBindGroup({
      layout: cache.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: cache.uniformBuffers[i] } }],
    });

    const pass = translucent ? Pass.TRANSLUCENT : Pass.OPAQUE;

    const commandBindGroups = [cache.bindGroups[i]];
    if (needsTexture && defined(cache.textureBindGroup)) {
      commandBindGroups.push(cache.textureBindGroup);
    }
    // Effects bind group (shadow + clipping) — placeholder when inactive
    const effectsPlaceholder = getPlaceholderEffects(device);
    commandBindGroups.push(effectsPlaceholder.bindGroup);

    const command = new WebGPUDrawCommand({
      pipeline: cache.pipeline,
      bindGroups: commandBindGroups,
      vertexBuffer: cache.vertexBuffers[i],
      indexBuffer: cache.indexBuffers[i],
      indexFormat: cache.indexFormats[i],
      vertexCount: defined(cache.indexBuffers[i])
        ? undefined
        : cache.vertexCounts[i],
      indexCount: defined(cache.indexBuffers[i])
        ? cache.indexCounts[i]
        : undefined,
      pass: pass,
      owner: primitive,
    });

    command._webgpuUniformBuffer = cache.uniformBuffers[i];
    command._webgpuShaderType = shaderInfo.type;
    validCommands.push(command);

    // ── Pick command ──
    if (hasPickIds && i < pickIds.length && defined(cache.pickPipeline)) {
      const pickColor = pickIds[i].color;
      const pickUniformSize = getPickUniformSize();

      if (!defined(cache.pickUniformBuffers[i])) {
        cache.pickUniformBuffers[i] = device.createBuffer({
          size: pickUniformSize,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          label: `Pick UB ${i}`,
        });
      }

      const pickUD = new Float32Array(pickUniformSize / 4);
      writeRTEUniformsPick(pickUD, rte, pickColor);
      device.queue.writeBuffer(cache.pickUniformBuffers[i], 0, pickUD);

      cache.pickBindGroups[i] = device.createBindGroup({
        layout: cache.pickBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: cache.pickUniformBuffers[i] } },
        ],
      });

      const pickCommand = new WebGPUDrawCommand({
        pipeline: cache.pickPipeline,
        bindGroups: [cache.pickBindGroups[i]],
        vertexBuffer: cache.vertexBuffers[i],
        indexBuffer: cache.indexBuffers[i],
        indexFormat: cache.indexFormats[i],
        vertexCount: defined(cache.indexBuffers[i])
          ? undefined
          : cache.vertexCounts[i],
        indexCount: defined(cache.indexBuffers[i])
          ? cache.indexCounts[i]
          : undefined,
        pass: pass,
        owner: primitive,
      });

      pickCommand._webgpuUniformBuffer = cache.pickUniformBuffers[i];
      pickCommand._webgpuShaderType = "pick";
      pickCommand._webgpuPickColor = pickColor;
      pickCommand._isPickCommand = true;
      validPickCommands.push(pickCommand);
    }
  }

  colorCommands.length = validCommands.length;
  for (let i = 0; i < validCommands.length; i++) {
    colorCommands[i] = validCommands[i];
  }
  pickCommands.length = validPickCommands.length;
  for (let i = 0; i < validPickCommands.length; i++) {
    pickCommands[i] = validPickCommands[i];
  }
}

// =========================================================================
// Material Texture Binding — Real textures from Material._imageSources
// =========================================================================

/**
 * Returns the texture uniform name for a given material shader type.
 * Most materials use 'image'; Water uses 'specularMap'.
 * @private
 */
function getTextureUniformName(shaderType) {
  if (shaderType.includes("Water")) {
    return "specularMap";
  }
  return "image";
}

/**
 * Creates or reuses a WebGPU texture bind group from a Material's loaded image.
 * Falls back to the context's 1×1 white default texture if the image hasn't
 * loaded yet. Replaces the old checkerboard placeholder approach (MAT-1 fix).
 *
 * @param {object} context - WebGPU context with createTextureFromImage()
 * @param {GPUDevice} device - The GPU device
 * @param {object} material - CesiumJS Material with _imageSources map
 * @param {string} shaderType - Material shader type (e.g., 'matImageFlat')
 * @param {object} cache - Primitive's _webgpuCache
 * @returns {boolean} true if a valid texture bind group exists
 * @private
 */
function ensureMaterialTextureBindGroup(
  context,
  device,
  material,
  shaderType,
  cache,
) {
  const uniformName = getTextureUniformName(shaderType);
  const imageSources = defined(material) ? material._imageSources : undefined;
  const imageSource = defined(imageSources)
    ? imageSources[uniformName]
    : undefined;

  // Check if cached texture is still current (same image source)
  if (
    defined(cache._matTextureSource) &&
    cache._matTextureSource === imageSource &&
    defined(cache.textureBindGroup)
  ) {
    return true;
  }

  // Ensure sampler exists (reused across texture changes)
  if (!defined(cache._matSampler)) {
    cache._matSampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "repeat",
    });
  }

  let gpuTexView;

  if (defined(imageSource) && defined(context.createTextureFromImage)) {
    // Create WebGPU texture from raw image (Image, ImageBitmap, Canvas)
    const gpuTex = context.createTextureFromImage(
      imageSource,
      "rgba8unorm",
      true,
    );
    if (defined(gpuTex)) {
      // Destroy previous material-created GPU texture
      if (defined(cache._matGpuTexture)) {
        cache._matGpuTexture.destroy();
      }
      cache._matGpuTexture = gpuTex;
      cache._matTextureSource = imageSource;
      gpuTexView = gpuTex.view;
    }
  }

  // Fall back to 1×1 white default texture
  if (!defined(gpuTexView)) {
    const defaultTex = context.defaultTexture;
    if (defined(defaultTex) && defined(defaultTex.view)) {
      gpuTexView = defaultTex.view;
    } else {
      // No default texture available yet — create minimal fallback
      if (!defined(cache.defaultTexture)) {
        cache.defaultTexture = WebGPUTexture.create2D(
          device,
          1,
          1,
          "rgba8unorm",
          1,
          "FallbackWhite",
        );
        cache.defaultTexture.write(new Uint8Array([255, 255, 255, 255]));
      }
      gpuTexView = cache.defaultTexture.view;
    }
    cache._matTextureSource = undefined;
  }

  cache.textureBindGroup = device.createBindGroup({
    layout: cache.textureBindGroupLayout,
    entries: [
      { binding: 0, resource: cache._matSampler },
      { binding: 1, resource: gpuTexView },
    ],
  });

  return true;
}

// =========================================================================
// Material Uniform Packing
// =========================================================================

const scratchMaterialUniformData = new Float32Array(64);

/**
 * Packs material-specific uniform parameters into a Float32Array.
 * Camera/RTE matrices are packed separately; this fills material parameter slots.
 *
 * @param {Float32Array} uniformData - Target array (64 floats / 256 bytes)
 * @param {string} shaderType - Material shader type
 * @param {object} material - CesiumJS Material object
 * @param {number} startOffset - Float offset where material params begin
 *   Flat shaders: 24 (after mvpRTE + camHigh + camLow)
 *   Lit shaders:  60 (after mvpRTE + mvRTE + normalMatrix + camHigh + camLow + lightDir)
 * @private
 */
function packMaterialUniforms(uniformData, shaderType, material, startOffset) {
  const u =
    defined(material) && defined(material.uniforms) ? material.uniforms : {};
  const o = startOffset;

  if (shaderType === "matColorFlat" || shaderType === "matColorLit") {
    const c = defined(u.color)
      ? u.color
      : { red: 1, green: 1, blue: 1, alpha: 1 };
    uniformData[o] = defined(c.red) ? c.red : 1.0;
    uniformData[o + 1] = defined(c.green) ? c.green : 1.0;
    uniformData[o + 2] = defined(c.blue) ? c.blue : 1.0;
    uniformData[o + 3] = defined(c.alpha) ? c.alpha : 1.0;
  } else if (
    shaderType === "matCheckerFlat" ||
    shaderType === "matCheckerLit"
  ) {
    const lc = u.lightColor || { red: 1, green: 1, blue: 1, alpha: 1 };
    const dc = u.darkColor || { red: 0, green: 0, blue: 0, alpha: 1 };
    const rep = u.repeat || { x: 5.0, y: 5.0 };
    uniformData[o] = lc.red ?? 1;
    uniformData[o + 1] = lc.green ?? 1;
    uniformData[o + 2] = lc.blue ?? 1;
    uniformData[o + 3] = lc.alpha ?? 1;
    uniformData[o + 4] = dc.red ?? 0;
    uniformData[o + 5] = dc.green ?? 0;
    uniformData[o + 6] = dc.blue ?? 0;
    uniformData[o + 7] = dc.alpha ?? 1;
    uniformData[o + 8] = rep.x ?? 5;
    uniformData[o + 9] = rep.y ?? 5;
    uniformData[o + 10] = 0;
    uniformData[o + 11] = 0;
  } else if (shaderType === "matGridFlat" || shaderType === "matGridLit") {
    const gc = u.color || { red: 1, green: 1, blue: 0, alpha: 1 };
    uniformData[o] = gc.red ?? 1;
    uniformData[o + 1] = gc.green ?? 1;
    uniformData[o + 2] = gc.blue ?? 0;
    uniformData[o + 3] = gc.alpha ?? 1;
    uniformData[o + 4] = u.cellAlpha ?? 0.1;
    uniformData[o + 5] = u.lineCount?.x ?? 8;
    uniformData[o + 6] = u.lineCount?.y ?? 8;
    uniformData[o + 7] = 0;
    uniformData[o + 8] = u.lineThickness?.x ?? 1;
    uniformData[o + 9] = u.lineThickness?.y ?? 1;
    uniformData[o + 10] = u.lineOffset?.x ?? 0;
    uniformData[o + 11] = u.lineOffset?.y ?? 0;
  } else if (shaderType === "matStripeFlat" || shaderType === "matStripeLit") {
    const ec = u.evenColor || { red: 1, green: 1, blue: 1, alpha: 1 };
    const oc = u.oddColor || { red: 0, green: 0, blue: 1, alpha: 1 };
    uniformData[o] = ec.red ?? 1;
    uniformData[o + 1] = ec.green ?? 1;
    uniformData[o + 2] = ec.blue ?? 1;
    uniformData[o + 3] = ec.alpha ?? 1;
    uniformData[o + 4] = oc.red ?? 0;
    uniformData[o + 5] = oc.green ?? 0;
    uniformData[o + 6] = oc.blue ?? 1;
    uniformData[o + 7] = oc.alpha ?? 1;
    uniformData[o + 8] = u.offset ?? 0;
    uniformData[o + 9] = u.repeat ?? 5;
    uniformData[o + 10] = u.horizontal === true ? 1.0 : 0.0;
    uniformData[o + 11] = 0;
  } else if (shaderType === "matDotFlat" || shaderType === "matDotLit") {
    const lc = u.lightColor || { red: 1, green: 1, blue: 0, alpha: 1 };
    const dc = u.darkColor || { red: 0, green: 0, blue: 0, alpha: 1 };
    const rep = u.repeat || { x: 5.0, y: 5.0 };
    uniformData[o] = lc.red ?? 1;
    uniformData[o + 1] = lc.green ?? 1;
    uniformData[o + 2] = lc.blue ?? 0;
    uniformData[o + 3] = lc.alpha ?? 1;
    uniformData[o + 4] = dc.red ?? 0;
    uniformData[o + 5] = dc.green ?? 0;
    uniformData[o + 6] = dc.blue ?? 0;
    uniformData[o + 7] = dc.alpha ?? 1;
    uniformData[o + 8] = rep.x ?? 5;
    uniformData[o + 9] = rep.y ?? 5;
    uniformData[o + 10] = 0;
    uniformData[o + 11] = 0;
  } else if (shaderType === "matFadeFlat" || shaderType === "matFadeLit") {
    const fi = u.fadeInColor || { red: 1, green: 1, blue: 1, alpha: 1 };
    const fo = u.fadeOutColor || { red: 0, green: 0, blue: 0, alpha: 0 };
    uniformData[o] = fi.red ?? 1;
    uniformData[o + 1] = fi.green ?? 1;
    uniformData[o + 2] = fi.blue ?? 1;
    uniformData[o + 3] = fi.alpha ?? 1;
    uniformData[o + 4] = fo.red ?? 0;
    uniformData[o + 5] = fo.green ?? 0;
    uniformData[o + 6] = fo.blue ?? 0;
    uniformData[o + 7] = fo.alpha ?? 0;
    uniformData[o + 8] = u.maximumDistance ?? 0.5;
    uniformData[o + 9] = u.repeat === true ? 1.0 : 0.0;
    uniformData[o + 10] = u.offset ?? 0;
    uniformData[o + 11] = 0;
  } else if (shaderType === "matImageFlat" || shaderType === "matImageLit") {
    const tint = u.color || { red: 1, green: 1, blue: 1, alpha: 1 };
    const rep = u.repeat || { x: 1.0, y: 1.0 };
    uniformData[o] = tint.red ?? 1;
    uniformData[o + 1] = tint.green ?? 1;
    uniformData[o + 2] = tint.blue ?? 1;
    uniformData[o + 3] = tint.alpha ?? 1;
    uniformData[o + 4] = rep.x ?? 1;
    uniformData[o + 5] = rep.y ?? 1;
    uniformData[o + 6] = 0;
    uniformData[o + 7] = 0;
  } else if (
    shaderType === "matRimLightingFlat" ||
    shaderType === "matRimLightingLit"
  ) {
    const c = u.color || { red: 1, green: 1, blue: 1, alpha: 1 };
    const rc = u.rimColor || { red: 1, green: 1, blue: 1, alpha: 1 };
    uniformData[o] = c.red ?? 1;
    uniformData[o + 1] = c.green ?? 1;
    uniformData[o + 2] = c.blue ?? 1;
    uniformData[o + 3] = c.alpha ?? 1;
    uniformData[o + 4] = rc.red ?? 1;
    uniformData[o + 5] = rc.green ?? 1;
    uniformData[o + 6] = rc.blue ?? 1;
    uniformData[o + 7] = rc.alpha ?? 1;
    uniformData[o + 8] = u.width ?? 0.3;
    uniformData[o + 9] = 0;
    uniformData[o + 10] = 0;
    uniformData[o + 11] = 0;
  } else if (
    shaderType === "matAlphaMapFlat" ||
    shaderType === "matAlphaMapLit"
  ) {
    // AlphaMap: base color + repeat + channel index (0=r,1=g,2=b,3=a)
    const c = u.color || { red: 1, green: 1, blue: 1, alpha: 1 };
    const rep = u.repeat || { x: 1.0, y: 1.0 };
    const ch =
      u.channel === "r" ? 0 : u.channel === "g" ? 1 : u.channel === "b" ? 2 : 3;
    uniformData[o] = c.red ?? 1;
    uniformData[o + 1] = c.green ?? 1;
    uniformData[o + 2] = c.blue ?? 1;
    uniformData[o + 3] = c.alpha ?? 1;
    uniformData[o + 4] = rep.x ?? 1;
    uniformData[o + 5] = rep.y ?? 1;
    uniformData[o + 6] = ch;
    uniformData[o + 7] = 0;
  } else if (
    shaderType === "matEmissionMapFlat" ||
    shaderType === "matEmissionMapLit"
  ) {
    // EmissionMap: tint color + repeat
    const c = u.color || { red: 1, green: 1, blue: 1, alpha: 1 };
    const rep = u.repeat || { x: 1.0, y: 1.0 };
    uniformData[o] = c.red ?? 1;
    uniformData[o + 1] = c.green ?? 1;
    uniformData[o + 2] = c.blue ?? 1;
    uniformData[o + 3] = c.alpha ?? 1;
    uniformData[o + 4] = rep.x ?? 1;
    uniformData[o + 5] = rep.y ?? 1;
    uniformData[o + 6] = 0;
    uniformData[o + 7] = 0;
  } else if (
    shaderType === "matSpecularMapFlat" ||
    shaderType === "matSpecularMapLit"
  ) {
    // SpecularMap: base color + repeat + channel index (0=r,1=g,2=b)
    const c = u.color || { red: 1, green: 1, blue: 1, alpha: 1 };
    const rep = u.repeat || { x: 1.0, y: 1.0 };
    const ch = u.channel === "g" ? 1 : u.channel === "b" ? 2 : 0;
    uniformData[o] = c.red ?? 1;
    uniformData[o + 1] = c.green ?? 1;
    uniformData[o + 2] = c.blue ?? 1;
    uniformData[o + 3] = c.alpha ?? 1;
    uniformData[o + 4] = rep.x ?? 1;
    uniformData[o + 5] = rep.y ?? 1;
    uniformData[o + 6] = ch;
    uniformData[o + 7] = 0;
  } else if (
    shaderType === "matBumpMapFlat" ||
    shaderType === "matBumpMapLit"
  ) {
    // BumpMap: repeat + channel + strength
    const rep = u.repeat || { x: 1.0, y: 1.0 };
    const ch =
      u.channel === "g" ? 1 : u.channel === "b" ? 2 : u.channel === "a" ? 3 : 0;
    uniformData[o] = rep.x ?? 1;
    uniformData[o + 1] = rep.y ?? 1;
    uniformData[o + 2] = ch;
    uniformData[o + 3] = u.strength ?? 0.8;
  } else if (
    shaderType === "matNormalMapFlat" ||
    shaderType === "matNormalMapLit"
  ) {
    // NormalMap: repeat + strength + channels swizzle indices
    const rep = u.repeat || { x: 1.0, y: 1.0 };
    const channelStr = u.channels || "rgb";
    const channelMap = { r: 0, g: 1, b: 2, a: 3 };
    uniformData[o] = rep.x ?? 1;
    uniformData[o + 1] = rep.y ?? 1;
    uniformData[o + 2] = u.strength ?? 0.8;
    uniformData[o + 3] = 0;
    uniformData[o + 4] = channelMap[channelStr[0]] ?? 0;
    uniformData[o + 5] = channelMap[channelStr[1]] ?? 1;
    uniformData[o + 6] = channelMap[channelStr[2]] ?? 2;
    uniformData[o + 7] = 0;
  } else if (shaderType === "matWaterFlat" || shaderType === "matWaterLit") {
    // Water: baseWaterColor + blendColor + scalar params + time
    const bwc = u.baseWaterColor || {
      red: 0.2,
      green: 0.3,
      blue: 0.6,
      alpha: 1.0,
    };
    const blc = u.blendColor || {
      red: 0.0,
      green: 1.0,
      blue: 0.699,
      alpha: 1.0,
    };
    uniformData[o] = bwc.red ?? 0.2;
    uniformData[o + 1] = bwc.green ?? 0.3;
    uniformData[o + 2] = bwc.blue ?? 0.6;
    uniformData[o + 3] = bwc.alpha ?? 1.0;
    uniformData[o + 4] = blc.red ?? 0.0;
    uniformData[o + 5] = blc.green ?? 1.0;
    uniformData[o + 6] = blc.blue ?? 0.699;
    uniformData[o + 7] = blc.alpha ?? 1.0;
    uniformData[o + 8] = u.frequency ?? 10.0;
    uniformData[o + 9] = u.animationSpeed ?? 0.01;
    uniformData[o + 10] = u.amplitude ?? 1.0;
    uniformData[o + 11] = u.specularIntensity ?? 0.5;
    uniformData[o + 12] = u.fadeFactor ?? 1.0;
    uniformData[o + 13] = performance.now() * 0.001; // time in seconds
    uniformData[o + 14] = 0;
    uniformData[o + 15] = 0;
  } else if (
    shaderType === "matElevContourFlat" ||
    shaderType === "matElevContourLit"
  ) {
    // ElevationContour: color + spacing + width
    const c = u.color || { red: 1, green: 1, blue: 0, alpha: 1 };
    uniformData[o] = c.red ?? 1;
    uniformData[o + 1] = c.green ?? 1;
    uniformData[o + 2] = c.blue ?? 0;
    uniformData[o + 3] = c.alpha ?? 1;
    uniformData[o + 4] = u.spacing ?? 100.0;
    uniformData[o + 5] = u.width ?? 1.0;
    uniformData[o + 6] = 0;
    uniformData[o + 7] = 0;
  } else if (
    shaderType === "matElevRampFlat" ||
    shaderType === "matElevRampLit"
  ) {
    // ElevationRamp: minimumHeight + maximumHeight
    uniformData[o] = u.minimumHeight ?? 0.0;
    uniformData[o + 1] = u.maximumHeight ?? 8848.0;
    uniformData[o + 2] = 0;
    uniformData[o + 3] = 0;
  } else if (
    shaderType === "matSlopeRampFlat" ||
    shaderType === "matSlopeRampLit" ||
    shaderType === "matAspectRampFlat" ||
    shaderType === "matAspectRampLit"
  ) {
    // SlopeRamp / AspectRamp: no additional material uniforms beyond texture
    // (slope/aspect are computed from geometry, ramp is a texture lookup)
  } else if (shaderType === "pbrSimple" || shaderType === "pbrTextured") {
    const bc = u.baseColorFactor || { red: 1, green: 1, blue: 1, alpha: 1 };
    uniformData[o] = bc.red ?? 1;
    uniformData[o + 1] = bc.green ?? 1;
    uniformData[o + 2] = bc.blue ?? 1;
    uniformData[o + 3] = bc.alpha ?? 1;
    uniformData[o + 4] = u.metallic ?? 0.0;
    uniformData[o + 5] = u.roughness ?? 0.5;
    uniformData[o + 6] = u.occlusionStrength ?? 1.0;
    uniformData[o + 7] = 0;
    const em = u.emissiveFactor || { red: 0, green: 0, blue: 0 };
    uniformData[o + 8] = em.red ?? 0;
    uniformData[o + 9] = em.green ?? 0;
    uniformData[o + 10] = em.blue ?? 0;
    uniformData[o + 11] = 0;
  }
}

// =========================================================================
// Material Pipeline Creation
// =========================================================================

/**
 * Creates (or reuses) the GPU pipeline for a material shader.
 * @private
 */
function createMaterialPipelineAndCache(
  cache,
  device,
  shaderInfo,
  vertexLayout,
  context,
) {
  if (cache.shaderType === shaderInfo.type) {
    return false;
  }
  cache.shaderType = shaderInfo.type;

  cache.shaderModule = WebGPUShaderModule.create({
    device: device,
    code: shaderInfo.code,
    label: `${shaderInfo.type} Material Shader`,
  });

  cache.bindGroupLayout = device.createBindGroupLayout({
    label: "Material Uniform BGL",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
    ],
  });

  const bindGroupLayouts = [cache.bindGroupLayout];

  if (shaderInfo.needsTexture) {
    cache.textureBindGroupLayout = device.createBindGroupLayout({
      label: "Material Texture BGL",
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
      ],
    });
    bindGroupLayouts.push(cache.textureBindGroupLayout);
  } else {
    cache.textureBindGroupLayout = null;
  }

  const canvasFormat =
    context.presentationFormat || navigator.gpu.getPreferredCanvasFormat();
  cache.pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts }),
    vertex: {
      module: cache.shaderModule.module,
      entryPoint: "vertexMain",
      buffers: [vertexLayout.layout],
    },
    fragment: {
      module: cache.shaderModule.module,
      entryPoint: "fragmentMain",
      targets: [{ format: canvasFormat }],
    },
    primitive: {
      topology: "triangle-list",
      cullMode: "none",
      frontFace: "ccw",
    },
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: true,
      depthCompare: "less",
    },
  });

  return true;
}

// =========================================================================
// Material Vertex Data Builder — RTE (posHigh + posLow)
// =========================================================================

/**
 * Builds interleaved vertex data for material shaders with RTE positions.
 * Flat layout:  posHigh(3) + posLow(3) + st(2) = 8 floats/vertex
 * Lit layout:   posHigh(3) + posLow(3) + normal(3) + st(2) = 11 floats/vertex
 * @private
 */
function buildMaterialVertexData(
  posHighValues,
  posLowValues,
  normals,
  uvs,
  numVertices,
  isLit,
  normalCPA,
  stCPA,
) {
  const fpv = isLit ? 11 : 8;
  const vertexData = new Float32Array(numVertices * fpv);

  for (let v = 0; v < numVertices; v++) {
    const posOff = v * 3;
    const vOff = v * fpv;

    // positionHigh (3 floats)
    vertexData[vOff] = posHighValues[posOff];
    vertexData[vOff + 1] = posHighValues[posOff + 1];
    vertexData[vOff + 2] = posHighValues[posOff + 2];
    // positionLow (3 floats)
    vertexData[vOff + 3] = posLowValues[posOff];
    vertexData[vOff + 4] = posLowValues[posOff + 1];
    vertexData[vOff + 5] = posLowValues[posOff + 2];

    if (isLit) {
      // Normal (3 floats) at offset 6
      if (normals) {
        const nOff = v * normalCPA;
        vertexData[vOff + 6] = normals[nOff];
        vertexData[vOff + 7] = normals[nOff + 1];
        vertexData[vOff + 8] = normals[nOff + 2];
      } else {
        vertexData[vOff + 6] = 0.0;
        vertexData[vOff + 7] = 1.0;
        vertexData[vOff + 8] = 0.0;
      }
      // ST (2 floats) at offset 9
      if (uvs) {
        const uOff = v * stCPA;
        vertexData[vOff + 9] = uvs[uOff];
        vertexData[vOff + 10] = uvs[uOff + 1];
      }
    } else if (uvs) {
      // Flat: ST (2 floats) at offset 6
      const uOff = v * stCPA;
      vertexData[vOff + 6] = uvs[uOff];
      vertexData[vOff + 7] = uvs[uOff + 1];
    }
  }
  return vertexData;
}

// =========================================================================
// Material Command Creation — MaterialAppearance Path
// =========================================================================

/**
 * Creates WebGPU draw commands for a Primitive using MaterialAppearance.
 * Vertex buffers carry positionHigh(3) + positionLow(3) for RTE precision.
 * @private
 */
function createWebGPUMaterialCommands(
  primitive,
  appearance,
  material,
  translucent,
  twoPasses,
  colorCommands,
  pickCommands,
  frameState,
) {
  const context = frameState.context;
  const device = context.device;
  if (!defined(device)) {
    colorCommands.length = 0;
    return;
  }

  const webgpuGeomData = primitive._webgpuGeometryData;
  const rawGeometries = primitive._geometries;
  const useW = defined(webgpuGeomData) && webgpuGeomData.length > 0;
  const useR = defined(rawGeometries) && rawGeometries.length > 0;
  if (!useW && !useR) {
    colorCommands.length = 0;
    return;
  }
  const geometries = useW ? webgpuGeomData : rawGeometries;

  if (!defined(primitive._webgpuCache)) {
    primitive._webgpuCache = {
      shaderType: null,
      shaderModule: null,
      pipeline: null,
      bindGroupLayout: null,
      textureBindGroupLayout: null,
      uniformBuffers: [],
      bindGroups: [],
      vertexBuffers: [],
      indexBuffers: [],
      indexFormats: [],
      indexCounts: [],
      vertexCounts: [],
      pickShaderModule: null,
      pickPipeline: null,
      pickBindGroupLayout: null,
      pickUniformBuffers: [],
      pickBindGroups: [],
    };
  }
  const cache = primitive._webgpuCache;

  const firstGeom = geometries[0];
  const attrs = firstGeom.attributes;
  const hasNormals = defined(attrs.normal) && defined(attrs.normal.values);
  const hasST = defined(attrs.st) && defined(attrs.st.values);
  const isFlat = defined(appearance.flat) ? appearance.flat : false;

  const shaderInfo = selectMaterialShader(material, isFlat, hasNormals, hasST);
  const isLit =
    isMaterialLitShader(shaderInfo.type) || isPBRShader(shaderInfo.type);
  const vertexLayout = getMaterialVertexLayout(shaderInfo.type);
  const uniformSize = getMaterialUniformSize(shaderInfo.type);

  const shaderChanged = createMaterialPipelineAndCache(
    cache,
    device,
    shaderInfo,
    vertexLayout,
    context,
  );

  // Bind real material texture (from Material._imageSources) or fall back to
  // context.defaultTexture (1×1 white). This replaces the old checkerboard
  // placeholder (MAT-1 fix). Called every command creation so async-loaded
  // textures are picked up as soon as they arrive.
  if (shaderInfo.needsTexture && defined(cache.textureBindGroupLayout)) {
    ensureMaterialTextureBindGroup(
      context,
      device,
      material,
      shaderInfo.type,
      cache,
    );
  }

  // Pick support
  const pickIds = primitive._pickIds;
  const hasPickIds =
    primitive._allowPicking && defined(pickIds) && pickIds.length > 0;
  if (hasPickIds && shaderChanged) {
    const pickCode = getMaterialPickShaderForType(shaderInfo.type);
    cache.pickShaderModule = WebGPUShaderModule.create({
      device,
      code: pickCode,
      label: `${shaderInfo.type} MatPick`,
    });
    cache.pickBindGroupLayout = device.createBindGroupLayout({
      label: "MatPick BGL",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });
    const fmt =
      context.presentationFormat || navigator.gpu.getPreferredCanvasFormat();
    cache.pickPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [cache.pickBindGroupLayout],
      }),
      vertex: {
        module: cache.pickShaderModule.module,
        entryPoint: "vertexMain",
        buffers: [vertexLayout.layout],
      },
      fragment: {
        module: cache.pickShaderModule.module,
        entryPoint: "fragmentMain",
        targets: [{ format: fmt }],
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });
  }

  Matrix4.setDepthRangeType("webgpu");
  const rte = computeRTEMatrices(
    context.uniformState,
    frameState.camera,
    primitive.modelMatrix,
  );
  const pass = translucent ? Pass.TRANSLUCENT : Pass.OPAQUE;

  // Material param offset: AFTER RTE camera uniforms
  // Flat: mvpRTE(16) + camHigh(4) + camLow(4) = 24 → material starts at 24
  // Lit:  mvpRTE(16) + mvRTE(16) + normalMatrix(16) + camHigh(4) + camLow(4) + lightDir(4) = 60 → material starts at 60
  const materialParamOffset = isLit ? 60 : 24;

  const validCommands = [];
  const validPickCommands = [];

  for (let i = 0; i < geometries.length; i++) {
    const geometry = geometries[i];
    const posData = extractPositionData(geometry);
    if (!posData) {
      continue;
    }

    const { posHighValues, posLowValues, numVertices } = posData;
    const normalAttr = geometry.attributes.normal;
    const stAttr = geometry.attributes.st;
    const normals =
      defined(normalAttr) && defined(normalAttr.values)
        ? normalAttr.values
        : null;
    const uvs =
      defined(stAttr) && defined(stAttr.values) ? stAttr.values : null;
    const nCPA = normalAttr ? normalAttr.componentsPerAttribute || 3 : 3;
    const sCPA = stAttr ? stAttr.componentsPerAttribute || 2 : 2;

    // Build RTE material vertex buffer
    const vertexData = buildMaterialVertexData(
      posHighValues,
      posLowValues,
      normals,
      uvs,
      numVertices,
      isLit,
      nCPA,
      sCPA,
    );
    if (!defined(cache.vertexBuffers[i]) || shaderChanged) {
      if (defined(cache.vertexBuffers[i])) {
        cache.vertexBuffers[i].destroy();
      }
      cache.vertexBuffers[i] = WebGPUBuffer.createVertexBuffer(
        device,
        vertexData,
        `Mat VB ${i}`,
      );
    }

    ensureIndexBuffer(device, geometry, cache, i);
    cache.vertexCounts[i] = numVertices;

    if (!defined(cache.uniformBuffers[i])) {
      cache.uniformBuffers[i] = device.createBuffer({
        size: uniformSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: `Mat UB ${i}`,
      });
    }

    // Pack RTE uniforms + material params
    const ud = new Float32Array(uniformSize / 4);
    if (isLit) {
      writeRTEUniformsLit(ud, rte, context.uniformState);
    } else {
      writeRTEUniformsFlat(ud, rte);
    }
    packMaterialUniforms(ud, shaderInfo.type, material, materialParamOffset);
    device.queue.writeBuffer(cache.uniformBuffers[i], 0, ud);

    cache.bindGroups[i] = device.createBindGroup({
      layout: cache.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: cache.uniformBuffers[i] } }],
    });

    const cmdBGs = [cache.bindGroups[i]];
    if (shaderInfo.needsTexture && defined(cache.textureBindGroup)) {
      cmdBGs.push(cache.textureBindGroup);
    }

    const cmd = new WebGPUDrawCommand({
      pipeline: cache.pipeline,
      bindGroups: cmdBGs,
      vertexBuffer: cache.vertexBuffers[i],
      indexBuffer: cache.indexBuffers[i],
      indexFormat: cache.indexFormats[i],
      vertexCount: defined(cache.indexBuffers[i]) ? undefined : numVertices,
      indexCount: defined(cache.indexBuffers[i])
        ? cache.indexCounts[i]
        : undefined,
      pass,
      owner: primitive,
    });
    cmd._webgpuUniformBuffer = cache.uniformBuffers[i];
    cmd._webgpuShaderType = shaderInfo.type;
    validCommands.push(cmd);

    // Pick command
    if (hasPickIds && i < pickIds.length && defined(cache.pickPipeline)) {
      const pc = pickIds[i].color;
      const puSize = getPickUniformSize();
      if (!defined(cache.pickUniformBuffers[i])) {
        cache.pickUniformBuffers[i] = device.createBuffer({
          size: puSize,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          label: `MatPick UB ${i}`,
        });
      }
      const pud = new Float32Array(puSize / 4);
      writeRTEUniformsPick(pud, rte, pc);
      device.queue.writeBuffer(cache.pickUniformBuffers[i], 0, pud);
      cache.pickBindGroups[i] = device.createBindGroup({
        layout: cache.pickBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: cache.pickUniformBuffers[i] } },
        ],
      });
      const pickCmd = new WebGPUDrawCommand({
        pipeline: cache.pickPipeline,
        bindGroups: [cache.pickBindGroups[i]],
        vertexBuffer: cache.vertexBuffers[i],
        indexBuffer: cache.indexBuffers[i],
        indexFormat: cache.indexFormats[i],
        vertexCount: defined(cache.indexBuffers[i]) ? undefined : numVertices,
        indexCount: defined(cache.indexBuffers[i])
          ? cache.indexCounts[i]
          : undefined,
        pass,
        owner: primitive,
      });
      pickCmd._webgpuUniformBuffer = cache.pickUniformBuffers[i];
      pickCmd._webgpuShaderType = "pick";
      pickCmd._webgpuPickColor = pc;
      pickCmd._isPickCommand = true;
      validPickCommands.push(pickCmd);
    }
  }

  colorCommands.length = validCommands.length;
  for (let i = 0; i < validCommands.length; i++) {
    colorCommands[i] = validCommands[i];
  }
  pickCommands.length = validPickCommands.length;
  for (let i = 0; i < validPickCommands.length; i++) {
    pickCommands[i] = validPickCommands[i];
  }
}

// =========================================================================
// Material Per-Frame Uniform Update
// =========================================================================

/**
 * Updates camera matrices for a material/PBR draw command each frame.
 * Material parameters are constant — only camera matrices need updating.
 * @private
 */
function updateWebGPUMaterialCommandUniforms(command, frameState, modelMatrix) {
  if (!command.isWebGPUDrawCommand || !command._webgpuUniformBuffer) {
    return;
  }
  const context = frameState.context;
  const device = context.device;
  if (!device) {
    return;
  }

  const rte = computeRTEMatrices(
    context.uniformState,
    frameState.camera,
    modelMatrix,
  );
  const shaderType = command._webgpuShaderType;
  const isLit = isMaterialLitShader(shaderType) || isPBRShader(shaderType);

  const ud = scratchMaterialUniformData;

  if (isLit) {
    writeRTEUniformsLit(ud, rte, context.uniformState);
    device.queue.writeBuffer(
      command._webgpuUniformBuffer,
      0,
      ud.buffer,
      0,
      240,
    );
  } else {
    writeRTEUniformsFlat(ud, rte);
    device.queue.writeBuffer(command._webgpuUniformBuffer, 0, ud.buffer, 0, 96);
  }
}

const WebGPUPrimitiveCommands = {
  createWebGPUCommands,
  createWebGPUMaterialCommands,
  updateWebGPUCommandUniforms,
  updateWebGPUMaterialCommandUniforms,
  updateWebGPUPickCommandUniforms,
};

export default WebGPUPrimitiveCommands;
export {
  createWebGPUCommands,
  createWebGPUMaterialCommands,
  updateWebGPUCommandUniforms,
  updateWebGPUMaterialCommandUniforms,
  updateWebGPUPickCommandUniforms,
};
