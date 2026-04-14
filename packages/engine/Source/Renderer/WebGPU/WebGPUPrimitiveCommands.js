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
import {
  makeBindGroupLayout,
  sampler,
  texture,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { WebGPUTexture } from "./WebGPUTexture.js";
import {
  selectWebGPUShader,
  getVertexLayoutForShader,
  getPickShaderForType,
  getMaterialPickShaderForType,
  isPhongShader,
  isTexturedShader,
  selectMaterialShader,
  getMaterialVertexLayout,
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
// RTE camera uniform scratch buffers (60 floats = 240 bytes max for lit)
const scratchRTEUniformData = new Float32Array(64);

// Camera-only UBO sizes (no material fields)
const FLAT_CAMERA_BYTES = 96; // mvpRTE(64) + camHigh(16) + camLow(16)
const LIT_CAMERA_BYTES = 240; // mvpRTE(64) + mvRTE(64) + normalMatrix(64) + camHigh(16) + camLow(16) + lightDir(16)
const PICK_CAMERA_BYTES = 96; // same as flat

// Placeholder material UBO for shaders that don't use material uniforms
// Must be at least 16 bytes (vec4) for WebGPU minimum binding size
const PLACEHOLDER_MATERIAL_BYTES = 16;
// Pick material: pickColor(vec4) = 16 bytes
const PICK_MATERIAL_BYTES = 16;

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

// writeRTEUniformsPick removed — pick shaders now use split camera/material
// bind groups. Camera data uses writeRTEUniformsFlat; pick color goes in
// a separate material UBO.

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
  if (!command.isWebGPUDrawCommand || !command._webgpuCameraBuffer) {
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
      command._webgpuCameraBuffer,
      0,
      ud.buffer,
      0,
      LIT_CAMERA_BYTES,
    );
  } else {
    writeRTEUniformsFlat(ud, rte);
    device.queue.writeBuffer(
      command._webgpuCameraBuffer,
      0,
      ud.buffer,
      0,
      FLAT_CAMERA_BYTES,
    );
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
    !command._webgpuCameraBuffer ||
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

  // Write camera uniforms (flat layout for pick shaders)
  const ud = scratchPickUniformData;
  writeRTEUniformsFlat(ud, rte);
  device.queue.writeBuffer(
    command._webgpuCameraBuffer,
    0,
    ud.buffer,
    0,
    PICK_CAMERA_BYTES,
  );

  // Pick color is in the material buffer — only update if color changed
  // (pick colors are assigned once and don't change per frame)
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
      cameraBindGroupLayout: null,
      materialBindGroupLayout: null,
      cameraBuffers: [],
      cameraBindGroups: [],
      materialBuffer: null,
      materialBindGroup: null,
      vertexBuffers: [],
      indexBuffers: [],
      indexFormats: [],
      indexCounts: [],
      vertexCounts: [],
      pickShaderModule: null,
      pickPipeline: null,
      pickCameraBindGroupLayout: null,
      pickMaterialBindGroupLayout: null,
      pickCameraBuffers: [],
      pickCameraBindGroups: [],
      pickMaterialBuffers: [],
      pickMaterialBindGroups: [],
    };
  }
  const cache = primitive._webgpuCache;

  // ── Shader selection ──
  const firstGeometry = geometries[0];
  const shaderInfo = selectWebGPUShader(firstGeometry.attributes);
  const vertexLayout = getVertexLayoutForShader(shaderInfo.type);

  const shaderChanged = cache.shaderType !== shaderInfo.type;
  const needsTexture = isTexturedShader(shaderInfo.type);
  const isLit = isPhongShader(shaderInfo.type);
  const cameraBufferSize = isLit ? LIT_CAMERA_BYTES : FLAT_CAMERA_BYTES;

  if (shaderChanged) {
    cache.shaderType = shaderInfo.type;

    cache.shaderModule = WebGPUShaderModule.create({
      device: device,
      code: shaderInfo.code,
      label: `${shaderInfo.type} Shader`,
    });

    // Camera BGL — group(0): camera uniforms
    const cameraVisibility = isLit
      ? GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
      : GPUShaderStage.VERTEX;

    cache.cameraBindGroupLayout = makeBindGroupLayout(device, "Camera BGL", [
      uniformBuffer(0, cameraVisibility),
    ]);

    // Material BGL — group(1): placeholder material uniforms
    cache.materialBindGroupLayout = makeBindGroupLayout(
      device,
      "Material BGL",
      [uniformBuffer(0, Stage.VERTEX_FRAGMENT)],
    );

    const bindGroupLayouts = [
      cache.cameraBindGroupLayout,
      cache.materialBindGroupLayout,
    ];

    if (needsTexture) {
      cache.textureBindGroupLayout = makeBindGroupLayout(
        device,
        "Texture BGL",
        [sampler(0, Stage.FRAGMENT), texture(1, Stage.FRAGMENT)],
      );
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
        depthCompare: "less-equal",
      },
    });

    // Shared placeholder material buffer for per-instance-color shaders
    // (these shaders don't use material uniforms — just a placeholder vec4)
    cache.materialBuffer = device.createBuffer({
      size: PLACEHOLDER_MATERIAL_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Placeholder Material UB",
    });
    device.queue.writeBuffer(
      cache.materialBuffer,
      0,
      new Float32Array([0, 0, 0, 0]),
    );
    cache.materialBindGroup = device.createBindGroup({
      layout: cache.materialBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: cache.materialBuffer } }],
    });

    // Default placeholder texture for textured shaders
    if (needsTexture && !defined(cache.defaultTexture)) {
      const texSize = 64;
      const checkerboard = new Uint8Array(texSize * texSize * 4);
      const tileSize = 8;
      for (let y = 0; y < texSize; y++) {
        for (let x = 0; x < texSize; x++) {
          const idx = (y * texSize + x) * 4;
          const isLight2 =
            (Math.floor(x / tileSize) + Math.floor(y / tileSize)) % 2 === 0;
          const val = isLight2 ? 230 : 80;
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

    // ── Pick pipeline (split camera/material bind groups) ──
    if (hasPickIds) {
      const pickShaderCode = getPickShaderForType(shaderInfo.type);
      cache.pickShaderModule = WebGPUShaderModule.create({
        device: device,
        code: pickShaderCode,
        label: `${shaderInfo.type} Pick Shader`,
      });

      // Pick camera BGL — group(0)
      cache.pickCameraBindGroupLayout = makeBindGroupLayout(
        device,
        "Pick Camera BGL",
        [uniformBuffer(0, Stage.VERTEX)],
      );

      // Pick material BGL — group(1): pickColor
      cache.pickMaterialBindGroupLayout = makeBindGroupLayout(
        device,
        "Pick Material BGL",
        [uniformBuffer(0, Stage.FRAGMENT)],
      );

      cache.pickPipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({
          bindGroupLayouts: [
            cache.pickCameraBindGroupLayout,
            cache.pickMaterialBindGroupLayout,
          ],
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
          depthCompare: "less-equal",
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

    // ── Camera uniform buffer (RTE layout) ──
    if (!defined(cache.cameraBuffers[i])) {
      cache.cameraBuffers[i] = device.createBuffer({
        size: cameraBufferSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: `Primitive Camera UB ${i}`,
      });
    }

    // Write initial camera RTE uniform data
    const cameraData = new Float32Array(cameraBufferSize / 4);
    if (isLit) {
      writeRTEUniformsLit(cameraData, rte, context.uniformState);
    } else {
      writeRTEUniformsFlat(cameraData, rte);
    }
    device.queue.writeBuffer(cache.cameraBuffers[i], 0, cameraData);

    // ── Camera bind group — group(0) ──
    cache.cameraBindGroups[i] = device.createBindGroup({
      layout: cache.cameraBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: cache.cameraBuffers[i] } }],
    });

    const pass = translucent ? Pass.TRANSLUCENT : Pass.OPAQUE;

    // Build bind group array: [camera, material, texture?, effects]
    const commandBindGroups = [
      cache.cameraBindGroups[i],
      cache.materialBindGroup,
    ];
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

    command._webgpuCameraBuffer = cache.cameraBuffers[i];
    command._webgpuShaderType = shaderInfo.type;
    validCommands.push(command);

    // ── Pick command (split camera/material bind groups) ──
    if (hasPickIds && i < pickIds.length && defined(cache.pickPipeline)) {
      const pickColor = pickIds[i].color;

      // Pick camera buffer — same flat layout as basic camera
      if (!defined(cache.pickCameraBuffers[i])) {
        cache.pickCameraBuffers[i] = device.createBuffer({
          size: PICK_CAMERA_BYTES,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          label: `Pick Camera UB ${i}`,
        });
      }

      const pickCameraData = new Float32Array(PICK_CAMERA_BYTES / 4);
      writeRTEUniformsFlat(pickCameraData, rte);
      device.queue.writeBuffer(cache.pickCameraBuffers[i], 0, pickCameraData);

      cache.pickCameraBindGroups[i] = device.createBindGroup({
        layout: cache.pickCameraBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: cache.pickCameraBuffers[i] } },
        ],
      });

      // Pick material buffer — pickColor(vec4)
      if (!defined(cache.pickMaterialBuffers[i])) {
        cache.pickMaterialBuffers[i] = device.createBuffer({
          size: PICK_MATERIAL_BYTES,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          label: `Pick Material UB ${i}`,
        });
      }

      const pickMatData = new Float32Array(PICK_MATERIAL_BYTES / 4);
      if (defined(pickColor)) {
        pickMatData[0] = pickColor.red;
        pickMatData[1] = pickColor.green;
        pickMatData[2] = pickColor.blue;
        pickMatData[3] = pickColor.alpha;
      }
      device.queue.writeBuffer(cache.pickMaterialBuffers[i], 0, pickMatData);

      cache.pickMaterialBindGroups[i] = device.createBindGroup({
        layout: cache.pickMaterialBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: cache.pickMaterialBuffers[i] } },
        ],
      });

      const pickCommand = new WebGPUDrawCommand({
        pipeline: cache.pickPipeline,
        bindGroups: [
          cache.pickCameraBindGroups[i],
          cache.pickMaterialBindGroups[i],
        ],
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

      pickCommand._webgpuCameraBuffer = cache.pickCameraBuffers[i];
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
  isLit,
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

  // Camera BGL — group(0)
  const matCameraVisibility = isLit ? Stage.VERTEX_FRAGMENT : Stage.VERTEX;
  cache.cameraBindGroupLayout = makeBindGroupLayout(device, "Mat Camera BGL", [
    uniformBuffer(0, matCameraVisibility),
  ]);

  // Material BGL — group(1): material uniforms from MaterialUniformBuffer
  cache.materialBindGroupLayout = makeBindGroupLayout(
    device,
    "Mat Material BGL",
    [uniformBuffer(0, Stage.VERTEX_FRAGMENT)],
  );

  const bindGroupLayouts = [
    cache.cameraBindGroupLayout,
    cache.materialBindGroupLayout,
  ];

  if (shaderInfo.needsTexture) {
    cache.textureBindGroupLayout = makeBindGroupLayout(
      device,
      "Material Texture BGL",
      [sampler(0, Stage.FRAGMENT), texture(1, Stage.FRAGMENT)],
    );
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
      depthCompare: "less-equal",
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
      cameraBindGroupLayout: null,
      materialBindGroupLayout: null,
      textureBindGroupLayout: null,
      cameraBuffers: [],
      cameraBindGroups: [],
      materialBuffer: null,
      materialBindGroup: null,
      vertexBuffers: [],
      indexBuffers: [],
      indexFormats: [],
      indexCounts: [],
      vertexCounts: [],
      pickShaderModule: null,
      pickPipeline: null,
      pickCameraBindGroupLayout: null,
      pickMaterialBindGroupLayout: null,
      pickCameraBuffers: [],
      pickCameraBindGroups: [],
      pickMaterialBuffers: [],
      pickMaterialBindGroups: [],
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
  const cameraBufferSize = isLit ? LIT_CAMERA_BYTES : FLAT_CAMERA_BYTES;

  const shaderChanged = createMaterialPipelineAndCache(
    cache,
    device,
    shaderInfo,
    vertexLayout,
    context,
    isLit,
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

  // Pick support (split camera/material bind groups)
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

    // Pick camera BGL — group(0)
    cache.pickCameraBindGroupLayout = makeBindGroupLayout(
      device,
      "MatPick Camera BGL",
      [uniformBuffer(0, Stage.VERTEX)],
    );

    // Pick material BGL — group(1): pickColor
    cache.pickMaterialBindGroupLayout = makeBindGroupLayout(
      device,
      "MatPick Material BGL",
      [uniformBuffer(0, Stage.FRAGMENT)],
    );

    const fmt =
      context.presentationFormat || navigator.gpu.getPreferredCanvasFormat();
    cache.pickPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [
          cache.pickCameraBindGroupLayout,
          cache.pickMaterialBindGroupLayout,
        ],
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
        depthCompare: "less-equal",
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

  // Create or update shared material GPU buffer from MaterialUniformBuffer
  const matUB = defined(material) ? material._uniformBuffer : undefined;
  const matGpuData = defined(matUB) ? matUB.gpuData : undefined;
  const matByteSize = defined(matGpuData)
    ? Math.max(matGpuData.byteLength, PLACEHOLDER_MATERIAL_BYTES)
    : PLACEHOLDER_MATERIAL_BYTES;

  if (
    !defined(cache.materialBuffer) ||
    cache._materialBufferSize !== matByteSize
  ) {
    if (defined(cache.materialBuffer)) {
      cache.materialBuffer.destroy();
    }
    cache.materialBuffer = device.createBuffer({
      size: matByteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Mat Material UB",
    });
    cache._materialBufferSize = matByteSize;
    cache.materialBindGroup = null; // Force rebind
  }

  // Upload material data (only when dirty or first time)
  if (defined(matGpuData)) {
    if (!defined(matUB) || matUB.isDirty || !defined(cache.materialBindGroup)) {
      device.queue.writeBuffer(cache.materialBuffer, 0, matGpuData);
      if (defined(matUB)) {
        matUB.clearDirty();
      }
    }
  } else {
    // No material uniform buffer — write placeholder zeros
    device.queue.writeBuffer(
      cache.materialBuffer,
      0,
      new Float32Array(matByteSize / 4),
    );
  }

  // Create material bind group if needed
  if (!defined(cache.materialBindGroup)) {
    cache.materialBindGroup = device.createBindGroup({
      layout: cache.materialBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: cache.materialBuffer } }],
    });
  }

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

    // Camera uniform buffer — per geometry instance
    if (!defined(cache.cameraBuffers[i])) {
      cache.cameraBuffers[i] = device.createBuffer({
        size: cameraBufferSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: `Mat Camera UB ${i}`,
      });
    }

    // Write camera RTE data
    const cameraData = new Float32Array(cameraBufferSize / 4);
    if (isLit) {
      writeRTEUniformsLit(cameraData, rte, context.uniformState);
    } else {
      writeRTEUniformsFlat(cameraData, rte);
    }
    device.queue.writeBuffer(cache.cameraBuffers[i], 0, cameraData);

    // Camera bind group — group(0)
    cache.cameraBindGroups[i] = device.createBindGroup({
      layout: cache.cameraBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: cache.cameraBuffers[i] } }],
    });

    // Build bind group array: [camera, material, texture?]
    const cmdBGs = [cache.cameraBindGroups[i], cache.materialBindGroup];
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
    cmd._webgpuCameraBuffer = cache.cameraBuffers[i];
    cmd._webgpuShaderType = shaderInfo.type;
    validCommands.push(cmd);

    // Pick command (split camera/material bind groups)
    if (hasPickIds && i < pickIds.length && defined(cache.pickPipeline)) {
      const pc = pickIds[i].color;

      // Pick camera buffer
      if (!defined(cache.pickCameraBuffers[i])) {
        cache.pickCameraBuffers[i] = device.createBuffer({
          size: PICK_CAMERA_BYTES,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          label: `MatPick Camera UB ${i}`,
        });
      }

      const pickCameraData = new Float32Array(PICK_CAMERA_BYTES / 4);
      writeRTEUniformsFlat(pickCameraData, rte);
      device.queue.writeBuffer(cache.pickCameraBuffers[i], 0, pickCameraData);

      cache.pickCameraBindGroups[i] = device.createBindGroup({
        layout: cache.pickCameraBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: cache.pickCameraBuffers[i] } },
        ],
      });

      // Pick material buffer — pickColor(vec4)
      if (!defined(cache.pickMaterialBuffers[i])) {
        cache.pickMaterialBuffers[i] = device.createBuffer({
          size: PICK_MATERIAL_BYTES,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          label: `MatPick Material UB ${i}`,
        });
      }

      const pickMatData = new Float32Array(PICK_MATERIAL_BYTES / 4);
      if (defined(pc)) {
        pickMatData[0] = pc.red;
        pickMatData[1] = pc.green;
        pickMatData[2] = pc.blue;
        pickMatData[3] = pc.alpha;
      }
      device.queue.writeBuffer(cache.pickMaterialBuffers[i], 0, pickMatData);

      cache.pickMaterialBindGroups[i] = device.createBindGroup({
        layout: cache.pickMaterialBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: cache.pickMaterialBuffers[i] } },
        ],
      });

      const pickCmd = new WebGPUDrawCommand({
        pipeline: cache.pickPipeline,
        bindGroups: [
          cache.pickCameraBindGroups[i],
          cache.pickMaterialBindGroups[i],
        ],
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
      pickCmd._webgpuCameraBuffer = cache.pickCameraBuffers[i];
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

// Scratch buffer for per-frame material camera uniform updates
const scratchMaterialCameraData = new Float32Array(64);

/**
 * Updates camera matrices for a material/PBR draw command each frame.
 * Material parameters are in a separate bind group — only camera data needs per-frame update.
 * @private
 */
function updateWebGPUMaterialCommandUniforms(command, frameState, modelMatrix) {
  if (!command.isWebGPUDrawCommand || !command._webgpuCameraBuffer) {
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
  const isLit2 = isMaterialLitShader(shaderType) || isPBRShader(shaderType);

  const ud = scratchMaterialCameraData;

  if (isLit2) {
    writeRTEUniformsLit(ud, rte, context.uniformState);
    device.queue.writeBuffer(
      command._webgpuCameraBuffer,
      0,
      ud.buffer,
      0,
      LIT_CAMERA_BYTES,
    );
  } else {
    writeRTEUniformsFlat(ud, rte);
    device.queue.writeBuffer(
      command._webgpuCameraBuffer,
      0,
      ud.buffer,
      0,
      FLAT_CAMERA_BYTES,
    );
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
