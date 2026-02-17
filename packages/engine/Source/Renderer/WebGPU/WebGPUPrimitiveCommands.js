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
 * @private
 */
import Cartesian3 from "../../Core/Cartesian3.js";
import defined from "../../Core/defined.js";
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

// =========================================================================
// Scratch variables for per-frame uniform updates (avoid per-frame allocations)
// =========================================================================
const scratchModelViewMatrix = new Matrix4();
const scratchMVPMatrix = new Matrix4();
const scratchNormalMatrix = new Matrix4();
const scratchCenterTranslation = new Matrix4();
const scratchModelWithCenter = new Matrix4();
const scratchPhongUniformData = new Float32Array(64); // 256 bytes / 4 = 64 floats
const scratchBasicUniformData = new Float32Array(16); // 64 bytes / 4 = 16 floats

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
  // Only update WebGPU commands that have a uniform buffer
  if (!command.isWebGPUDrawCommand || !command._webgpuUniformBuffer) {
    return;
  }

  const context = frameState.context;
  const device = context.device;
  if (!device) {
    return;
  }

  const uniformState = context.uniformState;
  const viewMatrix = uniformState.view;
  const projectionMatrix = uniformState.projection;

  // If the command has a center offset (for relative-to-center rendering to avoid
  // float32 precision issues with large ECEF coordinates), incorporate it into the
  // model matrix: effectiveModel = modelMatrix * translate(center)
  let effectiveModelMatrix = modelMatrix;
  if (defined(command._webgpuCenterOffset)) {
    const center = command._webgpuCenterOffset;
    Matrix4.fromTranslation(center, scratchCenterTranslation);
    effectiveModelMatrix = Matrix4.multiply(
      modelMatrix,
      scratchCenterTranslation,
      scratchModelWithCenter,
    );
  }

  // Compute modelView = view * effectiveModel
  const modelView = Matrix4.multiply(
    viewMatrix,
    effectiveModelMatrix,
    scratchModelViewMatrix,
  );

  // Compute MVP = projection * modelView
  const mvp = Matrix4.multiply(projectionMatrix, modelView, scratchMVPMatrix);

  if (isPhongShader(command._webgpuShaderType)) {
    // Phong shader variants: MVP(16) + ModelView(16) + NormalMatrix(16) + LightDir(4) = 52 floats
    const uniformData = scratchPhongUniformData;

    // Pack MVP matrix (floats 0-15)
    Matrix4.pack(mvp, uniformData, 0);

    // Pack ModelView matrix (floats 16-31)
    Matrix4.pack(modelView, uniformData, 16);

    // Compute and pack NormalMatrix = transpose(inverse(modelView)) (floats 32-47)
    const normalMatrix = Matrix4.inverse(modelView, scratchNormalMatrix);
    Matrix4.transpose(normalMatrix, normalMatrix);
    Matrix4.pack(normalMatrix, uniformData, 32);

    // Light direction in eye space (floats 48-51)
    // Use sun direction from uniformState if available, otherwise default
    if (defined(uniformState.sunDirectionEC)) {
      uniformData[48] = uniformState.sunDirectionEC.x;
      uniformData[49] = uniformState.sunDirectionEC.y;
      uniformData[50] = uniformState.sunDirectionEC.z;
    } else {
      // Default light direction (top-right-front)
      uniformData[48] = 0.5;
      uniformData[49] = 0.7;
      uniformData[50] = 0.5;
    }
    uniformData[51] = 0.0;

    device.queue.writeBuffer(command._webgpuUniformBuffer, 0, uniformData);
  } else {
    // BasicColor shader: just MVP (16 floats)
    const uniformData = scratchBasicUniformData;
    Matrix4.pack(mvp, uniformData, 0);
    device.queue.writeBuffer(command._webgpuUniformBuffer, 0, uniformData);
  }
}

// =========================================================================
// WebGPU Command Creation
// =========================================================================

/**
 * Creates WebGPU draw commands for a Primitive's geometries.
 * Handles shader selection, pipeline creation, buffer creation, bind groups,
 * texture setup, and per-geometry draw command generation.
 *
 * Supports GPU object caching on the primitive via `primitive._webgpuCache`
 * to avoid recreating GPU objects every frame.
 *
 * @param {Primitive} primitive - The Primitive instance
 * @param {Appearance} appearance - The appearance used for rendering
 * @param {Material} material - The material (may be undefined)
 * @param {boolean} translucent - Whether the appearance is translucent
 * @param {boolean} twoPasses - Whether to use two-pass rendering
 * @param {Array} colorCommands - Output array for color draw commands
 * @param {Array} pickCommands - Output array for pick draw commands (not yet implemented)
 * @param {FrameState} frameState - Current frame state
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

  // Use saved geometry data if available (preserved before VertexArray.fromGeometry consumed it)
  // Fall back to _geometries for cases where createVertexArray hasn't run yet
  const webgpuGeomData = primitive._webgpuGeometryData;
  const rawGeometries = primitive._geometries;

  if (!defined(device)) {
    colorCommands.length = 0;
    return;
  }

  // Prefer saved webgpu geometry data (with intact .values arrays)
  // Fall back to raw _geometries if saved data not available yet
  const useWebGPUData = defined(webgpuGeomData) && webgpuGeomData.length > 0;
  const useRawGeom = defined(rawGeometries) && rawGeometries.length > 0;

  if (!useWebGPUData && !useRawGeom) {
    colorCommands.length = 0;
    return;
  }

  const geometries = useWebGPUData ? webgpuGeomData : rawGeometries;
  const validCommands = [];

  // Check if we have batch table with colors
  const batchTable = primitive._batchTable;
  const colorIndex = primitive._batchTableAttributeIndices?.color;
  const hasInstanceColors = defined(batchTable) && defined(colorIndex);

  // Check if picking is enabled
  const allowPicking = primitive._allowPicking;
  const pickIds = primitive._pickIds;
  const hasPickIds = allowPicking && defined(pickIds) && pickIds.length > 0;

  // ── Initialize GPU object cache on the primitive ──
  if (!defined(primitive._webgpuCache)) {
    primitive._webgpuCache = {
      shaderType: null,
      shaderModule: null,
      pipeline: null,
      bindGroupLayout: null,
      uniformBuffers: [], // one per geometry
      bindGroups: [], // one per geometry (rebuilt when uniform buffer changes)
      vertexBuffers: [], // one per geometry
      indexBuffers: [], // one per geometry
      indexFormats: [], // one per geometry
      indexCounts: [], // one per geometry
      vertexCounts: [], // one per geometry
      // Pick pipeline state
      pickShaderModule: null,
      pickPipeline: null,
      pickBindGroupLayout: null,
      pickUniformBuffers: [], // one per geometry (MVP + pickColor)
      pickBindGroups: [], // one per geometry
    };
  }
  const cache = primitive._webgpuCache;

  // ── Shader selection based on geometry attributes ──
  const firstGeometry = geometries[0];
  const shaderInfo = selectWebGPUShader(firstGeometry.attributes);
  const vertexLayout = getVertexLayoutForShader(shaderInfo.type);
  const uniformSize = getUniformSizeForShader(shaderInfo.type);

  // Rebuild pipeline if shader type changed
  const shaderChanged = cache.shaderType !== shaderInfo.type;
  const needsTexture = isTexturedShader(shaderInfo.type);

  if (shaderChanged) {
    cache.shaderType = shaderInfo.type;

    cache.shaderModule = WebGPUShaderModule.create({
      device: device,
      code: shaderInfo.code,
      label: `${shaderInfo.type} Shader`,
    });

    // Create bind group layout for group(0): uniforms
    // Phong variants need fragment visibility for lighting uniforms
    const uniformVisibility = isPhongShader(shaderInfo.type)
      ? GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
      : GPUShaderStage.VERTEX;

    cache.bindGroupLayout = device.createBindGroupLayout({
      label: "Uniform Bind Group Layout",
      entries: [
        {
          binding: 0,
          visibility: uniformVisibility,
          buffer: { type: "uniform" },
        },
      ],
    });

    // Create bind group layout for group(1): texture + sampler (textured shaders only)
    const bindGroupLayouts = [cache.bindGroupLayout];

    if (needsTexture) {
      cache.textureBindGroupLayout = device.createBindGroupLayout({
        label: "Texture Bind Group Layout",
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

    // Create render pipeline
    // Use the context's presentation format (matches what beginFrame's render pass uses)
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
        // Disable culling - CesiumJS geometry may have varying winding orders
        // and the WebGPU default frontFace (ccw) may not match all geometry.
        cullMode: "none",
        frontFace: "ccw",
      },
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });

    // Create default placeholder texture for textured shaders (checkerboard pattern)
    // This will be replaced with actual material textures when Material support is added
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
          checkerboard[idx + 0] = val;
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
        label: "DefaultTextureSampler",
      });

      // Create the texture bind group (shared across all geometries using this shader)
      cache.textureBindGroup = device.createBindGroup({
        layout: cache.textureBindGroupLayout,
        entries: [
          { binding: 0, resource: cache.defaultSampler },
          { binding: 1, resource: cache.defaultTexture.view },
        ],
      });
    }

    // ── Create pick pipeline (if picking is enabled) ──
    // Pick shaders share the same vertex layout but output a uniform pick color
    // instead of per-vertex colors or lighting
    if (hasPickIds) {
      const pickShaderCode = getPickShaderForType(shaderInfo.type);
      cache.pickShaderModule = WebGPUShaderModule.create({
        device: device,
        code: pickShaderCode,
        label: `${shaderInfo.type} Pick Shader`,
      });

      // Pick shader uniform layout: MVP + pickColor → needs vertex + fragment visibility
      cache.pickBindGroupLayout = device.createBindGroupLayout({
        label: "Pick Uniform Bind Group Layout",
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: { type: "uniform" },
          },
        ],
      });

      const canvasFormatForPick =
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
          targets: [{ format: canvasFormatForPick }],
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
    }
  }

  // Track valid pick commands separately
  const validPickCommands = [];

  for (let i = 0; i < geometries.length; i++) {
    const geometry = geometries[i];

    // Extract position attribute - handle high/low encoded positions (RTE)
    // CesiumJS encodes large ECEF positions as position3DHigh + position3DLow
    // to avoid float32 precision loss. We reconstruct full positions using
    // double-precision arithmetic and use relative-to-center (RTC) rendering.
    const posHighAttr = geometry.attributes.position3DHigh;
    const posLowAttr = geometry.attributes.position3DLow;
    const posAttr = geometry.attributes.position;
    const hasHighLow =
      defined(posHighAttr) &&
      defined(posHighAttr.values) &&
      defined(posLowAttr) &&
      defined(posLowAttr.values);

    let positionValues; // Float32Array of relative-to-center positions
    let numVertices;
    let centerOffset = null; // Cartesian3 center for RTC rendering

    if (hasHighLow) {
      // Reconstruct full positions using double precision (high + low)
      const high = posHighAttr.values;
      const low = posLowAttr.values;
      const cpa = posHighAttr.componentsPerAttribute;
      numVertices = high.length / cpa;

      // Compute center from bounding sphere or average of positions
      let cx = 0,
        cy = 0,
        cz = 0;
      if (
        defined(geometry.boundingSphere) &&
        defined(geometry.boundingSphere.center)
      ) {
        cx = geometry.boundingSphere.center.x;
        cy = geometry.boundingSphere.center.y;
        cz = geometry.boundingSphere.center.z;
      } else {
        // Compute average as center (using double precision)
        for (let v = 0; v < numVertices; v++) {
          const off = v * cpa;
          cx += high[off] + low[off];
          cy += high[off + 1] + low[off + 1];
          cz += high[off + 2] + low[off + 2];
        }
        cx /= numVertices;
        cy /= numVertices;
        cz /= numVertices;
      }
      centerOffset = new Cartesian3(cx, cy, cz);

      // Compute positions relative to center (small values, safe for float32)
      positionValues = new Float32Array(numVertices * 3);
      for (let v = 0; v < numVertices; v++) {
        const off = v * cpa;
        // Double-precision: (high + low) - center
        positionValues[v * 3 + 0] = high[off] + low[off] - cx;
        positionValues[v * 3 + 1] = high[off + 1] + low[off + 1] - cy;
        positionValues[v * 3 + 2] = high[off + 2] + low[off + 2] - cz;
      }
    } else if (defined(posAttr) && defined(posAttr.values)) {
      positionValues = posAttr.values;
      numVertices = positionValues.length / posAttr.componentsPerAttribute;
    } else {
      continue; // No valid position data
    }

    // ── Extract normals when available ──
    const normalAttr = geometry.attributes.normal;
    const hasNormals = defined(normalAttr) && defined(normalAttr.values);
    const normals = hasNormals ? normalAttr.values : null;

    // ── Extract texture coordinates (st) when available ──
    const stAttr = geometry.attributes.st;
    const hasUV = defined(stAttr) && defined(stAttr.values);
    const uvs = hasUV ? stAttr.values : null;

    // Get per-instance color (must be in 0.0–1.0 float range for the shader)
    let instanceColor = [1.0, 1.0, 1.0, 1.0];
    let gotInstanceColor = false;

    if (hasInstanceColors && i < primitive._numberOfInstances) {
      try {
        const batchColor = batchTable.getBatchedAttribute(i, colorIndex);
        if (defined(batchColor)) {
          if (defined(batchColor.red)) {
            // Already a Color object with 0-1 float values
            instanceColor = [
              batchColor.red,
              batchColor.green,
              batchColor.blue,
              batchColor.alpha,
            ];
            gotInstanceColor = true;
          } else if (defined(batchColor.x)) {
            // Cartesian4 from batch table — values are 0-255 byte range
            // (ColorGeometryInstanceAttribute stores as UNSIGNED_BYTE with normalize=true)
            // Normalize to 0.0-1.0 for the GPU shader
            const r = batchColor.x;
            const g = batchColor.y;
            const b = batchColor.z;
            const a = batchColor.w;
            // Detect if values are in byte range (>1.0) and normalize
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

    // Fallback: geometry color attribute (if no instance color was found)
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

    // ── Build vertex data based on shader type ──
    const fpv = vertexLayout.floatsPerVertex;
    const vertexData = new Float32Array(numVertices * fpv);

    for (let v = 0; v < numVertices; v++) {
      const posOffset = v * 3;
      const vOffset = v * fpv;

      // Position (3 floats) — always first (from positionValues, already RTC if high/low)
      vertexData[vOffset + 0] = positionValues[posOffset + 0];
      vertexData[vOffset + 1] = positionValues[posOffset + 1];
      vertexData[vOffset + 2] = positionValues[posOffset + 2];

      if (shaderInfo.type === "phongTextured") {
        // phongTextured: position(3) + normal(3) + uv(2) + color(4)
        if (hasNormals) {
          const nOffset = v * normalAttr.componentsPerAttribute;
          vertexData[vOffset + 3] = normals[nOffset + 0];
          vertexData[vOffset + 4] = normals[nOffset + 1];
          vertexData[vOffset + 5] = normals[nOffset + 2];
        } else {
          vertexData[vOffset + 3] = 0.0;
          vertexData[vOffset + 4] = 1.0;
          vertexData[vOffset + 5] = 0.0;
        }
        if (hasUV) {
          const uvOffset = v * stAttr.componentsPerAttribute;
          vertexData[vOffset + 6] = uvs[uvOffset + 0];
          vertexData[vOffset + 7] = uvs[uvOffset + 1];
        } else {
          vertexData[vOffset + 6] = 0.0;
          vertexData[vOffset + 7] = 0.0;
        }
        vertexData[vOffset + 8] = instanceColor[0];
        vertexData[vOffset + 9] = instanceColor[1];
        vertexData[vOffset + 10] = instanceColor[2];
        vertexData[vOffset + 11] = instanceColor[3];
      } else if (shaderInfo.type === "basicTextured") {
        // basicTextured: position(3) + uv(2) + color(4)
        if (hasUV) {
          const uvOffset = v * stAttr.componentsPerAttribute;
          vertexData[vOffset + 3] = uvs[uvOffset + 0];
          vertexData[vOffset + 4] = uvs[uvOffset + 1];
        } else {
          vertexData[vOffset + 3] = 0.0;
          vertexData[vOffset + 4] = 0.0;
        }
        vertexData[vOffset + 5] = instanceColor[0];
        vertexData[vOffset + 6] = instanceColor[1];
        vertexData[vOffset + 7] = instanceColor[2];
        vertexData[vOffset + 8] = instanceColor[3];
      } else if (shaderInfo.type === "phong") {
        // phong: position(3) + normal(3) + color(4)
        if (hasNormals) {
          const nOffset = v * normalAttr.componentsPerAttribute;
          vertexData[vOffset + 3] = normals[nOffset + 0];
          vertexData[vOffset + 4] = normals[nOffset + 1];
          vertexData[vOffset + 5] = normals[nOffset + 2];
        } else {
          vertexData[vOffset + 3] = 0.0;
          vertexData[vOffset + 4] = 1.0;
          vertexData[vOffset + 5] = 0.0;
        }
        vertexData[vOffset + 6] = instanceColor[0];
        vertexData[vOffset + 7] = instanceColor[1];
        vertexData[vOffset + 8] = instanceColor[2];
        vertexData[vOffset + 9] = instanceColor[3];
      } else {
        // basic: position(3) + color(4)
        vertexData[vOffset + 3] = instanceColor[0];
        vertexData[vOffset + 4] = instanceColor[1];
        vertexData[vOffset + 5] = instanceColor[2];
        vertexData[vOffset + 6] = instanceColor[3];
      }
    }

    // ── Reuse or create vertex buffer ──
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

    // ── Reuse or create index buffer ──
    if (defined(geometry.indices) && !defined(cache.indexBuffers[i])) {
      const indices = geometry.indices;
      cache.indexCounts[i] = indices.length;

      let needsUint32 = false;
      for (let idx = 0; idx < indices.length; idx++) {
        if (indices[idx] > 65535) {
          needsUint32 = true;
          break;
        }
      }
      const indexData = needsUint32
        ? new Uint32Array(indices)
        : new Uint16Array(indices);
      cache.indexFormats[i] = needsUint32 ? "uint32" : "uint16";
      cache.indexBuffers[i] = WebGPUBuffer.createIndexBuffer(
        device,
        indexData,
        `Primitive IB ${i}`,
      );
    }
    cache.vertexCounts[i] = numVertices;

    // ── Reuse or create uniform buffer ──
    if (!defined(cache.uniformBuffers[i])) {
      cache.uniformBuffers[i] = device.createBuffer({
        size: uniformSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: `Primitive UB ${i}`,
      });
    }

    // Write initial uniform data
    const uniformState = context.uniformState;
    const modelMatrix = primitive.modelMatrix;
    const viewMatrix = uniformState.view;
    const projectionMatrix = uniformState.projection;
    Matrix4.setDepthRangeType("webgpu");

    const modelView = Matrix4.multiply(viewMatrix, modelMatrix, new Matrix4());
    const mvp = Matrix4.multiply(projectionMatrix, modelView, new Matrix4());

    if (isPhongShader(shaderInfo.type)) {
      // Phong variants: MVP(16) + ModelView(16) + NormalMatrix(16) + LightDir(4) = 52 floats
      const uniformData = new Float32Array(uniformSize / 4);
      Matrix4.pack(mvp, uniformData, 0);
      Matrix4.pack(modelView, uniformData, 16);
      const normalMatrix = Matrix4.inverse(modelView, new Matrix4());
      Matrix4.transpose(normalMatrix, normalMatrix);
      Matrix4.pack(normalMatrix, uniformData, 32);
      // Light direction (sun direction in view space, default to top-right)
      uniformData[48] = 0.5;
      uniformData[49] = 0.7;
      uniformData[50] = 0.5;
      uniformData[51] = 0.0;
      device.queue.writeBuffer(cache.uniformBuffers[i], 0, uniformData);
    } else {
      const uniformData = new Float32Array(16);
      Matrix4.pack(mvp, uniformData, 0);
      device.queue.writeBuffer(cache.uniformBuffers[i], 0, uniformData);
    }

    // ── Rebuild bind group (references uniform buffer) ──
    cache.bindGroups[i] = device.createBindGroup({
      layout: cache.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: cache.uniformBuffers[i] } }],
    });

    // Determine the pass for this command
    const pass = translucent ? Pass.TRANSLUCENT : Pass.OPAQUE;

    // Build bind groups array: group(0) = uniforms, group(1) = texture (if textured)
    const commandBindGroups = [cache.bindGroups[i]];
    if (needsTexture && defined(cache.textureBindGroup)) {
      commandBindGroups.push(cache.textureBindGroup);
    }

    // Create WebGPUDrawCommand
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

    // Store reference for per-frame uniform updates
    command._webgpuUniformBuffer = cache.uniformBuffers[i];
    command._webgpuShaderType = shaderInfo.type;
    // Store center offset for relative-to-center rendering (handles float32 precision)
    command._webgpuCenterOffset = centerOffset;

    validCommands.push(command);

    // ── Create pick command for this geometry instance ──
    if (hasPickIds && i < pickIds.length && defined(cache.pickPipeline)) {
      const pickColor = pickIds[i].color;
      const pickUniformSize = getPickUniformSize();

      // Reuse or create pick uniform buffer (MVP + pickColor)
      if (!defined(cache.pickUniformBuffers[i])) {
        cache.pickUniformBuffers[i] = device.createBuffer({
          size: pickUniformSize,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          label: `Primitive Pick UB ${i}`,
        });
      }

      // Write pick uniform data: MVP(16 floats) + pickColor(4 floats)
      const pickUniformData = new Float32Array(pickUniformSize / 4);
      Matrix4.pack(mvp, pickUniformData, 0);
      // Pick color (floats 16-19): encode as normalized float RGBA
      pickUniformData[16] = pickColor.red;
      pickUniformData[17] = pickColor.green;
      pickUniformData[18] = pickColor.blue;
      pickUniformData[19] = pickColor.alpha;
      device.queue.writeBuffer(cache.pickUniformBuffers[i], 0, pickUniformData);

      // Rebuild pick bind group
      cache.pickBindGroups[i] = device.createBindGroup({
        layout: cache.pickBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: cache.pickUniformBuffers[i] } },
        ],
      });

      // Create pick draw command (shares vertex/index buffers with color command)
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

      // Store references for per-frame uniform updates
      pickCommand._webgpuUniformBuffer = cache.pickUniformBuffers[i];
      pickCommand._webgpuShaderType = "pick"; // Special type for pick shader updates
      pickCommand._webgpuCenterOffset = centerOffset;
      pickCommand._webgpuPickColor = pickColor; // Store the pick color for re-writing
      // Mark as a pick command so Scene.js can distinguish
      pickCommand._isPickCommand = true;

      validPickCommands.push(pickCommand);
    }
  }

  colorCommands.length = validCommands.length;
  for (let i = 0; i < validCommands.length; i++) {
    colorCommands[i] = validCommands[i];
  }

  // Populate pick commands array
  pickCommands.length = validPickCommands.length;
  for (let i = 0; i < validPickCommands.length; i++) {
    pickCommands[i] = validPickCommands[i];
  }
}

// =========================================================================
// Pick Uniform Update (per frame)
// =========================================================================

// Scratch buffer for pick uniform updates (MVP + pickColor = 20 floats, padded to 64 floats for 256 bytes)
const scratchPickUniformData = new Float32Array(64);

/**
 * Updates the GPU uniform buffer for a WebGPU pick command with current camera matrices.
 * Called every frame to keep the pick command's MVP matrix in sync with the camera.
 * The pick color is constant (set at creation time) but is re-written along with MVP
 * to avoid a separate write for a small amount of data.
 *
 * @param {WebGPUDrawCommand} command - The WebGPU pick draw command to update
 * @param {FrameState} frameState - Current frame state
 * @param {Matrix4} modelMatrix - The primitive's model-to-world matrix
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

  const uniformState = context.uniformState;
  const viewMatrix = uniformState.view;
  const projectionMatrix = uniformState.projection;

  // Compute effective model matrix with center offset
  let effectiveModelMatrix = modelMatrix;
  if (defined(command._webgpuCenterOffset)) {
    const center = command._webgpuCenterOffset;
    Matrix4.fromTranslation(center, scratchCenterTranslation);
    effectiveModelMatrix = Matrix4.multiply(
      modelMatrix,
      scratchCenterTranslation,
      scratchModelWithCenter,
    );
  }

  const modelView = Matrix4.multiply(
    viewMatrix,
    effectiveModelMatrix,
    scratchModelViewMatrix,
  );
  const mvp = Matrix4.multiply(projectionMatrix, modelView, scratchMVPMatrix);

  const uniformData = scratchPickUniformData;
  Matrix4.pack(mvp, uniformData, 0);

  // Re-write the pick color (constant, stored on the command)
  const pickColor = command._webgpuPickColor;
  if (defined(pickColor)) {
    uniformData[16] = pickColor.red;
    uniformData[17] = pickColor.green;
    uniformData[18] = pickColor.blue;
    uniformData[19] = pickColor.alpha;
  }

  device.queue.writeBuffer(command._webgpuUniformBuffer, 0, uniformData);
}

// =========================================================================
// Material Uniform Packing
// =========================================================================

// Scratch uniform data for material shaders (64 floats = 256 bytes)
const scratchMaterialUniformData = new Float32Array(64);

/**
 * Packs material-specific uniform parameters into a Float32Array.
 * Camera matrices (MVP, ModelView, NormalMatrix, LightDir) are packed separately;
 * this function fills the material parameter slots only.
 *
 * @param {Float32Array} uniformData - Target array (64 floats / 256 bytes)
 * @param {string} shaderType - Material shader type (e.g., "matColorFlat", "matCheckerLit")
 * @param {object} material - CesiumJS Material object with .uniforms property
 * @param {number} startOffset - Float offset where material params begin (16 for flat, 52 for lit)
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
  } else if (shaderType === "matGridFlat") {
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
  } else if (shaderType === "matStripeFlat") {
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
  } else if (shaderType === "pbrSimple" || shaderType === "pbrTextured") {
    // PBR: baseColorFactor(4f) + pbrParams(4f) + emissiveFactor(4f)
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
 * Creates (or reuses) the GPU pipeline for a material shader and caches it
 * on `primitive._webgpuCache`. Handles shader module, bind group layout,
 * optional texture layout (group 1), and render pipeline creation.
 *
 * @param {object} cache - The primitive's _webgpuCache object
 * @param {GPUDevice} device - The WebGPU device
 * @param {object} shaderInfo - { type, code, needsTexture } from selectMaterialShader()
 * @param {object} vertexLayout - From getMaterialVertexLayout()
 * @param {object} context - The rendering context (for presentationFormat)
 * @returns {boolean} True if the pipeline was (re)created, false if reused
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
    return false; // Pipeline already cached for this shader type
  }
  cache.shaderType = shaderInfo.type;

  cache.shaderModule = WebGPUShaderModule.create({
    device: device,
    code: shaderInfo.code,
    label: `${shaderInfo.type} Material Shader`,
  });

  // All material shaders need VERTEX | FRAGMENT visibility (fragment reads material params)
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

  // Texture bind group layout for image-based material shaders (group 1)
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
// Material Vertex Data Builder
// =========================================================================

/**
 * Builds interleaved vertex data for material shaders (no per-vertex color).
 * Flat layout: position(3) + st(2) = 5 floats/vertex
 * Lit layout:  position(3) + normal(3) + st(2) = 8 floats/vertex
 *
 * @param {Float32Array} positionValues - Position data (xyz)
 * @param {Float32Array|null} normals - Normal data (xyz), null for flat shaders
 * @param {Float32Array|null} uvs - Texture coordinate data (st)
 * @param {number} numVertices - Number of vertices
 * @param {boolean} isLit - Whether the shader is a lit variant (needs normals)
 * @param {number} normalCPA - Components per attribute for normals
 * @param {number} stCPA - Components per attribute for UVs
 * @returns {Float32Array} Interleaved vertex data
 * @private
 */
function buildMaterialVertexData(
  positionValues,
  normals,
  uvs,
  numVertices,
  isLit,
  normalCPA,
  stCPA,
) {
  const fpv = isLit ? 8 : 5;
  const vertexData = new Float32Array(numVertices * fpv);

  for (let v = 0; v < numVertices; v++) {
    const posOff = v * 3;
    const vOff = v * fpv;

    // Position (3 floats)
    vertexData[vOff] = positionValues[posOff];
    vertexData[vOff + 1] = positionValues[posOff + 1];
    vertexData[vOff + 2] = positionValues[posOff + 2];

    if (isLit) {
      // Normal (3 floats)
      if (normals) {
        const nOff = v * normalCPA;
        vertexData[vOff + 3] = normals[nOff];
        vertexData[vOff + 4] = normals[nOff + 1];
        vertexData[vOff + 5] = normals[nOff + 2];
      } else {
        vertexData[vOff + 3] = 0.0;
        vertexData[vOff + 4] = 1.0;
        vertexData[vOff + 5] = 0.0;
      }
      // ST (2 floats) at offset 6-7
      if (uvs) {
        const uOff = v * stCPA;
        vertexData[vOff + 6] = uvs[uOff];
        vertexData[vOff + 7] = uvs[uOff + 1];
      }
    } else if (uvs) {
      // Flat: ST (2 floats) at offset 3-4
      const uOff = v * stCPA;
      vertexData[vOff + 3] = uvs[uOff];
      vertexData[vOff + 4] = uvs[uOff + 1];
    }
  }
  return vertexData;
}

// =========================================================================
// Shared Position Extraction
// =========================================================================

/**
 * Extracts position data from geometry attributes, handling high/low encoded
 * positions (RTE) for float32 precision. Returns relative-to-center positions
 * and an optional center offset for RTC rendering.
 *
 * @param {object} geometry - Geometry with attributes
 * @returns {null|{positionValues: Float32Array, numVertices: number, centerOffset: Cartesian3|null}}
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
    const high = posHighAttr.values;
    const low = posLowAttr.values;
    const cpa = posHighAttr.componentsPerAttribute;
    const nv = high.length / cpa;
    let cx = 0,
      cy = 0,
      cz = 0;
    if (
      defined(geometry.boundingSphere) &&
      defined(geometry.boundingSphere.center)
    ) {
      cx = geometry.boundingSphere.center.x;
      cy = geometry.boundingSphere.center.y;
      cz = geometry.boundingSphere.center.z;
    } else {
      for (let v = 0; v < nv; v++) {
        const off = v * cpa;
        cx += high[off] + low[off];
        cy += high[off + 1] + low[off + 1];
        cz += high[off + 2] + low[off + 2];
      }
      cx /= nv;
      cy /= nv;
      cz /= nv;
    }
    const pv = new Float32Array(nv * 3);
    for (let v = 0; v < nv; v++) {
      const off = v * cpa;
      pv[v * 3] = high[off] + low[off] - cx;
      pv[v * 3 + 1] = high[off + 1] + low[off + 1] - cy;
      pv[v * 3 + 2] = high[off + 2] + low[off + 2] - cz;
    }
    return {
      positionValues: pv,
      numVertices: nv,
      centerOffset: new Cartesian3(cx, cy, cz),
    };
  }
  if (defined(posAttr) && defined(posAttr.values)) {
    return {
      positionValues: posAttr.values,
      numVertices: posAttr.values.length / posAttr.componentsPerAttribute,
      centerOffset: null,
    };
  }
  return null;
}

/**
 * Helper: creates or reuses an index buffer for a geometry.
 * @param {GPUDevice} device
 * @param {object} geometry
 * @param {object} cache
 * @param {number} i - Geometry index
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
    `Mat IB ${i}`,
  );
}

// =========================================================================
// Material Command Creation (main orchestrator)
// =========================================================================

/**
 * Creates WebGPU draw commands for a Primitive that uses MaterialAppearance.
 * Selects the appropriate material shader, builds material vertex data (no per-vertex color),
 * packs material-specific uniforms, and creates draw + pick commands.
 *
 * @param {Primitive} primitive - The Primitive instance
 * @param {Appearance} appearance - The MaterialAppearance
 * @param {Material} material - The CesiumJS Material object
 * @param {boolean} translucent - Whether appearance is translucent
 * @param {boolean} twoPasses - Whether two-pass rendering is used
 * @param {Array} colorCommands - Output array for color draw commands
 * @param {Array} pickCommands - Output array for pick draw commands
 * @param {FrameState} frameState - Current frame state
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

  // Initialize cache
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

  // Determine shader from material type and geometry attributes
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

  // Create / cache pipeline
  const shaderChanged = createMaterialPipelineAndCache(
    cache,
    device,
    shaderInfo,
    vertexLayout,
    context,
  );

  // Create placeholder texture for image-based materials
  if (shaderInfo.needsTexture && !defined(cache.defaultTexture)) {
    const sz = 64;
    const checker = new Uint8Array(sz * sz * 4);
    for (let y = 0; y < sz; y++) {
      for (let x = 0; x < sz; x++) {
        const idx = (y * sz + x) * 4;
        const val =
          (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0 ? 230 : 80;
        checker[idx] = val;
        checker[idx + 1] = val;
        checker[idx + 2] = val;
        checker[idx + 3] = 255;
      }
    }
    cache.defaultTexture = WebGPUTexture.create2D(
      device,
      sz,
      sz,
      "rgba8unorm",
      1,
      "MatDefaultTex",
    );
    cache.defaultTexture.write(checker);
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
    // Pick pipeline uses the material vertex layout (same pos+normal+st layout, no color)
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
  }

  Matrix4.setDepthRangeType("webgpu");
  const uniformState = context.uniformState;
  const mdlMatrix = primitive.modelMatrix;
  const modelView = Matrix4.multiply(
    uniformState.view,
    mdlMatrix,
    new Matrix4(),
  );
  const mvp = Matrix4.multiply(
    uniformState.projection,
    modelView,
    new Matrix4(),
  );
  const pass = translucent ? Pass.TRANSLUCENT : Pass.OPAQUE;
  const materialParamOffset = isLit ? 52 : 16;

  const validCommands = [];
  const validPickCommands = [];

  for (let i = 0; i < geometries.length; i++) {
    const geometry = geometries[i];
    const posData = extractPositionData(geometry);
    if (!posData) {
      continue;
    }

    const { positionValues, numVertices, centerOffset } = posData;
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

    // Build material vertex buffer
    const vertexData = buildMaterialVertexData(
      positionValues,
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

    // Uniform buffer
    if (!defined(cache.uniformBuffers[i])) {
      cache.uniformBuffers[i] = device.createBuffer({
        size: uniformSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: `Mat UB ${i}`,
      });
    }

    // Pack full uniform data: camera matrices + material params
    const ud = new Float32Array(uniformSize / 4);
    Matrix4.pack(mvp, ud, 0);
    if (isLit) {
      Matrix4.pack(modelView, ud, 16);
      const nm = Matrix4.inverse(modelView, new Matrix4());
      Matrix4.transpose(nm, nm);
      Matrix4.pack(nm, ud, 32);
      ud[48] = 0.5;
      ud[49] = 0.7;
      ud[50] = 0.5;
      ud[51] = 0.0;
    }
    packMaterialUniforms(ud, shaderInfo.type, material, materialParamOffset);
    device.queue.writeBuffer(cache.uniformBuffers[i], 0, ud);

    // Bind group
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
    cmd._webgpuCenterOffset = centerOffset;
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
      Matrix4.pack(mvp, pud, 0);
      pud[16] = pc.red;
      pud[17] = pc.green;
      pud[18] = pc.blue;
      pud[19] = pc.alpha;
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
      pickCmd._webgpuCenterOffset = centerOffset;
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
 * Updates the GPU uniform buffer for a material/PBR draw command with
 * current camera matrices. Material parameters (colors, repeat, etc.)
 * are constant and were written at creation time — only the camera
 * matrices (MVP, ModelView, NormalMatrix, LightDir) need per-frame updates.
 *
 * @param {WebGPUDrawCommand} command - Material draw command to update
 * @param {FrameState} frameState - Current frame state
 * @param {Matrix4} modelMatrix - The primitive's model-to-world matrix
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

  const uniformState = context.uniformState;
  let effectiveModel = modelMatrix;
  if (defined(command._webgpuCenterOffset)) {
    Matrix4.fromTranslation(
      command._webgpuCenterOffset,
      scratchCenterTranslation,
    );
    effectiveModel = Matrix4.multiply(
      modelMatrix,
      scratchCenterTranslation,
      scratchModelWithCenter,
    );
  }

  const modelView = Matrix4.multiply(
    uniformState.view,
    effectiveModel,
    scratchModelViewMatrix,
  );
  const mvp = Matrix4.multiply(
    uniformState.projection,
    modelView,
    scratchMVPMatrix,
  );

  const shaderType = command._webgpuShaderType;
  const isLit = isMaterialLitShader(shaderType) || isPBRShader(shaderType);

  const ud = scratchMaterialUniformData;
  Matrix4.pack(mvp, ud, 0);

  if (isLit) {
    Matrix4.pack(modelView, ud, 16);
    const nm = Matrix4.inverse(modelView, scratchNormalMatrix);
    Matrix4.transpose(nm, nm);
    Matrix4.pack(nm, ud, 32);
    if (defined(uniformState.sunDirectionEC)) {
      ud[48] = uniformState.sunDirectionEC.x;
      ud[49] = uniformState.sunDirectionEC.y;
      ud[50] = uniformState.sunDirectionEC.z;
    } else {
      ud[48] = 0.5;
      ud[49] = 0.7;
      ud[50] = 0.5;
    }
    ud[51] = 0.0;
    // Write only the camera matrix portion (first 52 floats = 208 bytes)
    device.queue.writeBuffer(
      command._webgpuUniformBuffer,
      0,
      ud.buffer,
      0,
      208,
    );
  } else {
    // Flat: only MVP (first 16 floats = 64 bytes)
    device.queue.writeBuffer(command._webgpuUniformBuffer, 0, ud.buffer, 0, 64);
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
