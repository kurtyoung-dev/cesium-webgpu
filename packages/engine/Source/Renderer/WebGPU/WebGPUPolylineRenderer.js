/**
 * @module WebGPUPolylineRenderer
 *
 * Handles WebGPU rendering of PolylineCollection with material support.
 * Polylines are rendered as instanced screen-space quads per line segment.
 *
 * Supports material types: Color (default), PolylineArrow, PolylineDash,
 * PolylineGlow, PolylineOutline.
 *
 * Instance data per segment (80 bytes, 5 x vec4):
 *   startPosHighAndWidth(4) + startPosLow(3)+sStart(1) +
 *   endPosHighAndMiter(4) + endPosLow(3)+sEnd(1) + color(4) = 20 floats
 *
 * The .w padding slots of startPosLow and endPosLow carry normalized
 * texture coordinates (sStart/sEnd) along the polyline for material shaders.
 * The base PolylineCollection.wgsl ignores these via .xyz access, so RTE
 * precision is unaffected.
 *
 * @private
 */
import defined from "../../Core/defined.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import { getCollectionShaderSource } from "./WebGPUCollectionShaders.js";

const FLOATS_PER_SEGMENT = 20;
const BYTES_PER_SEGMENT = FLOATS_PER_SEGMENT * 4;
const VERTICES_PER_SEGMENT = 6;
const UNIFORM_BUFFER_SIZE = 256;

// Camera uniforms occupy floats [0..27] = 112 bytes.
// Material uniforms start at float offset 28 = byte offset 112.
const MATERIAL_UNIFORM_OFFSET = 28;

const scratchModelView = new Matrix4();
const scratchMVRTE = new Matrix4();
const scratchMVPRTE = new Matrix4();
const scratchEncodedCamera = new EncodedCartesian3();
const scratchEncodedStart = new EncodedCartesian3();
const scratchEncodedEnd = new EncodedCartesian3();

// =========================================================================
// Material type → shader key mapping
// =========================================================================

/**
 * Maps CesiumJS material type strings to WebGPUCollectionShaders keys.
 * Unsupported types fall back to "polylineColor" (solid color).
 * @private
 */
const MATERIAL_SHADER_KEYS = {
  Color: "polylineColor",
  PolylineArrow: "polylineArrow",
  PolylineDash: "polylineDash",
  PolylineGlow: "polylineGlow",
  PolylineOutline: "polylineOutline",
};

function selectShaderKey(materialType) {
  return MATERIAL_SHADER_KEYS[materialType] || "polylineColor";
}

/**
 * Returns true if the material type requires st texture coordinates.
 * The Color shader uses per-instance color, not st coords.
 * @private
 */
function materialNeedsST(materialType) {
  return (
    materialType === "PolylineArrow" ||
    materialType === "PolylineGlow" ||
    materialType === "PolylineOutline"
  );
}

// =========================================================================
// Cumulative distance computation for st.s coordinate
// =========================================================================

/**
 * Computes normalized cumulative distances along a polyline's positions.
 * Returns an array where distances[i] ∈ [0, 1] represents how far along
 * the polyline position[i] is (0 at start, 1 at end).
 * @private
 */
function computeNormalizedDistances(positions) {
  const count = positions.length;
  const distances = new Float64Array(count);
  distances[0] = 0;
  for (let i = 1; i < count; i++) {
    const prev = positions[i - 1];
    const curr = positions[i];
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    const dz = curr.z - prev.z;
    distances[i] = distances[i - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  const totalLength = distances[count - 1];
  if (totalLength > 0) {
    for (let i = 1; i < count; i++) {
      distances[i] /= totalLength;
    }
  }
  return distances;
}

// =========================================================================
// Segment data builders
// =========================================================================

/**
 * Groups polylines by material type and returns a Map of
 * materialType → { polylines, material }.
 * @private
 */
function groupByMaterialType(collection) {
  const polylines = collection._polylines;
  const length = collection._polylinesLength;
  const groups = new Map();

  for (let i = 0; i < length; i++) {
    const polyline = polylines[i];
    if (!defined(polyline) || !polyline.show) {
      continue;
    }
    const positions = polyline.positions;
    if (positions.length < 2) {
      continue;
    }

    const material = polyline.material;
    const materialType = material ? material.type : "Color";

    let group = groups.get(materialType);
    if (!defined(group)) {
      group = { polylines: [], material };
      groups.set(materialType, group);
    }
    group.polylines.push(polyline);
  }
  return groups;
}

/**
 * Build segment instance data for a group of polylines sharing one material.
 * Packs RTE-encoded positions, line width, and optional st coordinates
 * into the padding slots (startPosLow.w = sStart, endPosLow.w = sEnd).
 * @private
 */
function buildSegmentDataForGroup(polylineGroup, computeST) {
  const polylines = polylineGroup.polylines;

  // Count total segments
  let totalSegments = 0;
  for (let i = 0; i < polylines.length; i++) {
    totalSegments += polylines[i].positions.length - 1;
  }

  const segmentData = new Float32Array(totalSegments * FLOATS_PER_SEGMENT);
  let segmentCount = 0;

  for (let i = 0; i < polylines.length; i++) {
    const polyline = polylines[i];
    const positions = polyline.positions;
    const width = polyline.width || 1.0;

    // Extract color from polyline (used as instance attribute for Color shader,
    // ignored by material shaders which use uniform color instead)
    const color = polyline._color || polyline.material?.uniforms?.color;
    const r = color ? color.red : 1.0;
    const g = color ? color.green : 1.0;
    const b = color ? color.blue : 1.0;
    const a = color ? color.alpha : 1.0;

    // Compute normalized distances for st.s if needed
    let distances = null;
    if (computeST) {
      distances = computeNormalizedDistances(positions);
    }

    for (let j = 0; j < positions.length - 1; j++) {
      const offset = segmentCount * FLOATS_PER_SEGMENT;
      const start = positions[j];
      const end = positions[j + 1];

      EncodedCartesian3.fromCartesian(start, scratchEncodedStart);
      EncodedCartesian3.fromCartesian(end, scratchEncodedEnd);

      // startPosHighAndWidth — RTE high component + line width
      segmentData[offset + 0] = scratchEncodedStart.high.x;
      segmentData[offset + 1] = scratchEncodedStart.high.y;
      segmentData[offset + 2] = scratchEncodedStart.high.z;
      segmentData[offset + 3] = width;

      // startPosLow — RTE low component + sStart in .w padding
      segmentData[offset + 4] = scratchEncodedStart.low.x;
      segmentData[offset + 5] = scratchEncodedStart.low.y;
      segmentData[offset + 6] = scratchEncodedStart.low.z;
      segmentData[offset + 7] = distances ? distances[j] : 0.0;

      // endPosHighAndMiter — RTE high component + miter limit
      segmentData[offset + 8] = scratchEncodedEnd.high.x;
      segmentData[offset + 9] = scratchEncodedEnd.high.y;
      segmentData[offset + 10] = scratchEncodedEnd.high.z;
      segmentData[offset + 11] = 2.0; // miterLimit

      // endPosLow — RTE low component + sEnd in .w padding
      segmentData[offset + 12] = scratchEncodedEnd.low.x;
      segmentData[offset + 13] = scratchEncodedEnd.low.y;
      segmentData[offset + 14] = scratchEncodedEnd.low.z;
      segmentData[offset + 15] = distances ? distances[j + 1] : 0.0;

      // color — per-instance RGBA
      segmentData[offset + 16] = r;
      segmentData[offset + 17] = g;
      segmentData[offset + 18] = b;
      segmentData[offset + 19] = a;

      segmentCount++;
    }
  }

  return { segmentData, segmentCount };
}

/**
 * Builds pick-variant segment data. Same layout but @location(4) holds
 * pick color instead of display color. Each polyline gets one pick ID;
 * all its segments share that pick color.
 * @private
 */
function buildPickSegmentData(collection, context) {
  const polylines = collection._polylines;
  const length = collection._polylinesLength;

  let totalSegments = 0;
  for (let i = 0; i < length; i++) {
    const polyline = polylines[i];
    if (!defined(polyline) || !polyline.show) {
      continue;
    }
    const positions = polyline.positions;
    if (positions.length >= 2) {
      totalSegments += positions.length - 1;
    }
  }

  const segmentData = new Float32Array(totalSegments * FLOATS_PER_SEGMENT);
  let segmentCount = 0;

  for (let i = 0; i < length; i++) {
    const polyline = polylines[i];
    if (!defined(polyline) || !polyline.show) {
      continue;
    }

    const positions = polyline.positions;
    const width = polyline.width || 1.0;

    // One pick ID per polyline (all segments share it)
    if (!defined(polyline._pickId)) {
      polyline._pickId = context.createPickId(polyline);
    }
    const pc = polyline._pickId.color;

    for (let j = 0; j < positions.length - 1; j++) {
      const offset = segmentCount * FLOATS_PER_SEGMENT;
      EncodedCartesian3.fromCartesian(positions[j], scratchEncodedStart);
      EncodedCartesian3.fromCartesian(positions[j + 1], scratchEncodedEnd);

      segmentData[offset + 0] = scratchEncodedStart.high.x;
      segmentData[offset + 1] = scratchEncodedStart.high.y;
      segmentData[offset + 2] = scratchEncodedStart.high.z;
      segmentData[offset + 3] = width;
      segmentData[offset + 4] = scratchEncodedStart.low.x;
      segmentData[offset + 5] = scratchEncodedStart.low.y;
      segmentData[offset + 6] = scratchEncodedStart.low.z;
      segmentData[offset + 7] = 0.0;
      segmentData[offset + 8] = scratchEncodedEnd.high.x;
      segmentData[offset + 9] = scratchEncodedEnd.high.y;
      segmentData[offset + 10] = scratchEncodedEnd.high.z;
      segmentData[offset + 11] = 2.0;
      segmentData[offset + 12] = scratchEncodedEnd.low.x;
      segmentData[offset + 13] = scratchEncodedEnd.low.y;
      segmentData[offset + 14] = scratchEncodedEnd.low.z;
      segmentData[offset + 15] = 0.0;

      // Pick color
      segmentData[offset + 16] = pc.red;
      segmentData[offset + 17] = pc.green;
      segmentData[offset + 18] = pc.blue;
      segmentData[offset + 19] = pc.alpha;

      segmentCount++;
    }
  }

  return { segmentData, segmentCount };
}

// =========================================================================
// Vertex buffer layout — same for all material types
// =========================================================================

const SEGMENT_BUFFER_LAYOUT = {
  arrayStride: BYTES_PER_SEGMENT,
  stepMode: "instance",
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x4" },
    { shaderLocation: 1, offset: 16, format: "float32x4" },
    { shaderLocation: 2, offset: 32, format: "float32x4" },
    { shaderLocation: 3, offset: 48, format: "float32x4" },
    { shaderLocation: 4, offset: 64, format: "float32x4" },
  ],
};

// =========================================================================
// Pipeline creation
// =========================================================================

function createPolylinePipeline(
  device,
  shaderCode,
  format,
  depthFormat,
  label,
) {
  const shaderModule = device.createShaderModule({
    label: label || "Polyline shader",
    code: shaderCode,
  });

  const bindGroupLayout = device.createBindGroupLayout({
    label: `${label || "Polyline"} bind group layout`,
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
    ],
  });

  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout],
  });

  const pipeline = device.createRenderPipeline({
    label: label || "Polyline pipeline",
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: [SEGMENT_BUFFER_LAYOUT],
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
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
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: true,
      depthCompare: "less-equal",
    },
  });

  return { pipeline, bindGroupLayout };
}

/**
 * Creates a pick pipeline for polylines — no blending, depth write enabled.
 * @private
 */
function createPolylinePickPipeline(device, shaderCode, format, depthFormat) {
  const shaderModule = device.createShaderModule({
    label: "Polyline pick shader",
    code: shaderCode,
  });

  const bindGroupLayout = device.createBindGroupLayout({
    label: "Polyline pick bind group layout",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
    ],
  });

  const pipeline = device.createRenderPipeline({
    label: "Polyline pick pipeline",
    layout: device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    }),
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: [SEGMENT_BUFFER_LAYOUT],
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      targets: [{ format }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: true,
      depthCompare: "less-equal",
    },
  });

  return { pipeline, bindGroupLayout };
}

// =========================================================================
// Uniform packing — camera + material
// =========================================================================

/**
 * Packs camera/RTE uniforms into the first 28 floats of the uniform buffer.
 * Uses RTE (Relative-To-Eye) encoding: the modelView matrix has its
 * translation column zeroed, and the camera position is split into
 * high/low components. This gives sub-meter precision at planetary scale.
 * @private
 */
function packCameraUniforms(uniformData, frameState, modelMatrix) {
  const context = frameState.context;
  const uniformState = context.uniformState;
  const canvas = context.canvas;

  // mvpRelativeToEye: modelView with translation zeroed × projection
  Matrix4.multiply(uniformState.view, modelMatrix, scratchModelView);
  Matrix4.clone(scratchModelView, scratchMVRTE);
  scratchMVRTE[12] = 0.0;
  scratchMVRTE[13] = 0.0;
  scratchMVRTE[14] = 0.0;
  Matrix4.multiply(uniformState.projection, scratchMVRTE, scratchMVPRTE);
  Matrix4.pack(scratchMVPRTE, uniformData, 0);

  // Camera position split into high/low for RTE
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

  // Viewport size for screen-space line expansion
  uniformData[24] = canvas.width;
  uniformData[25] = canvas.height;
  uniformData[26] = 0.0;
  uniformData[27] = 0.0;
}

/**
 * Packs material-specific uniforms starting at float offset 28 (byte 112).
 * Each material type writes its own set of parameters.
 * @private
 */
function packMaterialUniforms(uniformData, material, materialType) {
  const o = MATERIAL_UNIFORM_OFFSET; // 28
  const uniforms = material ? material.uniforms : {};

  switch (materialType) {
    case "PolylineArrow": {
      const c = uniforms.color || { red: 1, green: 1, blue: 1, alpha: 1 };
      uniformData[o + 0] = c.red;
      uniformData[o + 1] = c.green;
      uniformData[o + 2] = c.blue;
      uniformData[o + 3] = c.alpha;
      break;
    }

    case "PolylineDash": {
      const c = uniforms.color || { red: 1, green: 1, blue: 1, alpha: 1 };
      const gc = uniforms.gapColor || { red: 0, green: 0, blue: 0, alpha: 0 };
      uniformData[o + 0] = c.red;
      uniformData[o + 1] = c.green;
      uniformData[o + 2] = c.blue;
      uniformData[o + 3] = c.alpha;
      uniformData[o + 4] = gc.red;
      uniformData[o + 5] = gc.green;
      uniformData[o + 6] = gc.blue;
      uniformData[o + 7] = gc.alpha;
      uniformData[o + 8] = uniforms.dashLength ?? 16.0;
      uniformData[o + 9] = uniforms.dashPattern ?? 255.0;
      uniformData[o + 10] = 0.0;
      uniformData[o + 11] = 0.0;
      break;
    }

    case "PolylineGlow": {
      const c = uniforms.color || { red: 1, green: 1, blue: 1, alpha: 1 };
      uniformData[o + 0] = c.red;
      uniformData[o + 1] = c.green;
      uniformData[o + 2] = c.blue;
      uniformData[o + 3] = c.alpha;
      uniformData[o + 4] = uniforms.glowPower ?? 0.25;
      uniformData[o + 5] = uniforms.taperPower ?? 1.0;
      uniformData[o + 6] = 0.0;
      uniformData[o + 7] = 0.0;
      break;
    }

    case "PolylineOutline": {
      const c = uniforms.color || { red: 1, green: 1, blue: 1, alpha: 1 };
      const oc = uniforms.outlineColor || {
        red: 0,
        green: 0,
        blue: 0,
        alpha: 1,
      };
      uniformData[o + 0] = c.red;
      uniformData[o + 1] = c.green;
      uniformData[o + 2] = c.blue;
      uniformData[o + 3] = c.alpha;
      uniformData[o + 4] = oc.red;
      uniformData[o + 5] = oc.green;
      uniformData[o + 6] = oc.blue;
      uniformData[o + 7] = oc.alpha;
      uniformData[o + 8] = uniforms.outlineWidth ?? 1.0;
      uniformData[o + 9] = 0.0;
      uniformData[o + 10] = 0.0;
      uniformData[o + 11] = 0.0;
      break;
    }

    default:
      // Color type — no material uniforms needed (color is per-instance)
      break;
  }
}

// =========================================================================
// Pipeline cache helpers
// =========================================================================

/**
 * Gets or creates a pipeline for the given material type.
 * Pipelines are cached per collection per material type.
 * @private
 */
function getOrCreatePipeline(cache, device, context, materialType) {
  if (!defined(cache.pipelines)) {
    cache.pipelines = {};
  }

  if (defined(cache.pipelines[materialType])) {
    return cache.pipelines[materialType];
  }

  const shaderKey = selectShaderKey(materialType);
  const shaderCode = getCollectionShaderSource(shaderKey);
  const format = context.presentationFormat || "bgra8unorm";
  const depthFmt = context.depthFormat || "depth24plus-stencil8";
  const label = `Polyline ${materialType}`;
  const result = createPolylinePipeline(
    device,
    shaderCode,
    format,
    depthFmt,
    label,
  );

  cache.pipelines[materialType] = result;
  return result;
}

// =========================================================================
// Main update entry point
// =========================================================================

/**
 * Updates or creates WebGPU draw commands for PolylineCollection.
 * Groups polylines by material type and creates per-type draw commands
 * with material-specific shaders and uniform data.
 */
async function updateWebGPUPolylines(collection, frameState, commandList) {
  const context = frameState.context;
  const device = context.device;
  const length = collection._polylinesLength;
  if (length === 0) {
    return;
  }

  if (!defined(collection._webgpuCache)) {
    collection._webgpuCache = {};
  }
  const cache = collection._webgpuCache;
  const modelMatrix = collection.modelMatrix || Matrix4.IDENTITY;

  // Group polylines by material type
  const groups = groupByMaterialType(collection);

  for (const [materialType, group] of groups) {
    // Get or create pipeline for this material type
    const pipelineResult = getOrCreatePipeline(
      cache,
      device,
      context,
      materialType,
    );

    // Uniform buffer (one per material type to avoid mid-pass updates)
    const uniformKey = `uniformBuffer_${materialType}`;
    if (!defined(cache[uniformKey])) {
      cache[uniformKey] = WebGPUBuffer.createUniformBuffer(
        device,
        UNIFORM_BUFFER_SIZE,
        `Polyline ${materialType} uniforms`,
      );
      cache[`uniformData_${materialType}`] = new Float32Array(
        UNIFORM_BUFFER_SIZE / 4,
      );
    }

    const uniformBuffer = cache[uniformKey];
    const uniformData = cache[`uniformData_${materialType}`];

    // Pack camera RTE uniforms (shared across all material types)
    packCameraUniforms(uniformData, frameState, modelMatrix);

    // Pack material-specific uniforms at offset 28
    packMaterialUniforms(uniformData, group.material, materialType);

    device.queue.writeBuffer(
      uniformBuffer.buffer,
      0,
      uniformData.buffer,
      0,
      UNIFORM_BUFFER_SIZE,
    );

    // Bind group
    const bgKey = `bindGroup_${materialType}`;
    if (!defined(cache[bgKey])) {
      cache[bgKey] = device.createBindGroup({
        layout: pipelineResult.bindGroupLayout,
        entries: [{ binding: 0, resource: { buffer: uniformBuffer.buffer } }],
      });
    }

    // Build segment data with st coords for material shaders
    const needsST = materialNeedsST(materialType);
    const { segmentData, segmentCount } = buildSegmentDataForGroup(
      group,
      needsST,
    );
    if (segmentCount === 0) {
      continue;
    }

    // Segment vertex buffer
    const sbKey = `segmentBuffer_${materialType}`;
    const requiredSize = segmentCount * BYTES_PER_SEGMENT;
    if (!defined(cache[sbKey]) || cache[sbKey].size < requiredSize) {
      if (defined(cache[sbKey])) {
        cache[sbKey].destroy();
      }
      cache[sbKey] = WebGPUBuffer.createVertexBuffer(
        device,
        requiredSize,
        true,
        `Polyline ${materialType} segments`,
      );
      // Recreate bind group if buffer was replaced
      cache[bgKey] = device.createBindGroup({
        layout: pipelineResult.bindGroupLayout,
        entries: [{ binding: 0, resource: { buffer: uniformBuffer.buffer } }],
      });
    }
    device.queue.writeBuffer(
      cache[sbKey].buffer,
      0,
      segmentData.buffer,
      0,
      requiredSize,
    );

    // Create draw command for render pass
    if (frameState.passes.render) {
      const cmd = new WebGPUDrawCommand({
        pipeline: pipelineResult.pipeline,
        bindGroups: [cache[bgKey]],
        vertexBuffers: [cache[sbKey]],
        vertexCount: VERTICES_PER_SEGMENT,
        instanceCount: segmentCount,
        pass: 8, // Pass.OPAQUE
        owner: collection,
        boundingVolume: collection._boundingVolume,
        modelMatrix: modelMatrix,
        cull: true,
      });
      commandList.push(cmd);
    }
  }

  // Pick pass — uses a single combined buffer with pick colors
  if (frameState.passes.pick) {
    _pushPolylinePickCommand(
      collection,
      frameState,
      device,
      cache,
      modelMatrix,
      commandList,
    );
  }
}

/**
 * Builds and pushes a polyline pick draw command.
 * Pick uses the base PolylineCollection shader (color from instance data)
 * since pick color is per-polyline, not per-material.
 * @private
 */
function _pushPolylinePickCommand(
  collection,
  frameState,
  device,
  cache,
  modelMatrix,
  commandList,
) {
  const context = frameState.context;

  if (!defined(cache.pickPipeline)) {
    const pickShader = getCollectionShaderSource("polylinePick");
    const format = context.presentationFormat || "bgra8unorm";
    const depthFmt = context.depthFormat || "depth24plus-stencil8";
    const result = createPolylinePickPipeline(
      device,
      pickShader,
      format,
      depthFmt,
    );
    cache.pickPipeline = result.pipeline;
    cache.pickBindGroupLayout = result.bindGroupLayout;
  }

  // Ensure a uniform buffer exists for pick pass
  if (!defined(cache.pickUniformBuffer)) {
    cache.pickUniformBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      UNIFORM_BUFFER_SIZE,
      "Polyline pick uniforms",
    );
    cache.pickUniformData = new Float32Array(UNIFORM_BUFFER_SIZE / 4);
  }

  // Pick pass uses the same RTE camera transform as the render pass
  packCameraUniforms(cache.pickUniformData, frameState, modelMatrix);
  device.queue.writeBuffer(
    cache.pickUniformBuffer.buffer,
    0,
    cache.pickUniformData.buffer,
    0,
    UNIFORM_BUFFER_SIZE,
  );

  if (!defined(cache.pickBindGroup)) {
    cache.pickBindGroup = device.createBindGroup({
      layout: cache.pickBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: cache.pickUniformBuffer.buffer },
        },
      ],
    });
  }

  const pickResult = buildPickSegmentData(collection, context);
  if (pickResult.segmentCount === 0) {
    return;
  }

  const pickSize = pickResult.segmentCount * BYTES_PER_SEGMENT;
  if (
    !defined(cache.pickSegmentBuffer) ||
    cache.pickSegmentBuffer.size < pickSize
  ) {
    if (defined(cache.pickSegmentBuffer)) {
      cache.pickSegmentBuffer.destroy();
    }
    cache.pickSegmentBuffer = WebGPUBuffer.createVertexBuffer(
      device,
      pickSize,
      true,
      "Polyline pick segments",
    );
  }
  device.queue.writeBuffer(
    cache.pickSegmentBuffer.buffer,
    0,
    pickResult.segmentData.buffer,
    0,
    pickSize,
  );

  cache.pickCommand = new WebGPUDrawCommand({
    pipeline: cache.pickPipeline,
    bindGroups: [cache.pickBindGroup],
    vertexBuffers: [cache.pickSegmentBuffer],
    vertexCount: VERTICES_PER_SEGMENT,
    instanceCount: pickResult.segmentCount,
    pass: 8,
    owner: collection,
    boundingVolume: collection._boundingVolume,
    modelMatrix: modelMatrix,
    cull: true,
  });

  commandList.push(cache.pickCommand);
}

function destroyWebGPUPolylineResources(collection) {
  const cache = collection._webgpuCache;
  if (!defined(cache)) {
    return;
  }

  // Destroy all segment buffers (per-material and pick)
  for (const key of Object.keys(cache)) {
    if (key.startsWith("segmentBuffer_") || key.startsWith("uniformBuffer_")) {
      if (defined(cache[key]) && typeof cache[key].destroy === "function") {
        cache[key].destroy();
      }
    }
  }
  if (defined(cache.pickSegmentBuffer)) {
    cache.pickSegmentBuffer.destroy();
  }
  if (defined(cache.pickUniformBuffer)) {
    cache.pickUniformBuffer.destroy();
  }

  collection._webgpuCache = undefined;
}

export { updateWebGPUPolylines, destroyWebGPUPolylineResources };
export default { updateWebGPUPolylines, destroyWebGPUPolylineResources };
