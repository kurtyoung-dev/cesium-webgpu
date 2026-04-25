/**
 * WebGPU Ellipsoid Primitive Renderer
 *
 * Renders ray-marched ellipsoid primitives using WebGPU. Each ellipsoid
 * is rendered as a screen-space quad with a fragment shader that performs
 * analytical ray-ellipsoid intersection for pixel-perfect rendering.
 * Uses RTE (Relative-To-Eye) positioning for planetary-scale precision.
 *
 * @module WebGPUEllipsoidPrimitiveRenderer
 */

import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import Cartesian3 from "../../Core/Cartesian3.js";
import Pass from "../Pass.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import { m4Values, gpuData } from "./webgpuTypeHelpers.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import type {
  WebGPURenderPipelineCache,
  WebGPURenderPipelineDescriptor,
} from "./WebGPURenderPipelineCache.js";

interface EllipsoidCache {
  uniformBuffer: GPUBuffer | null;
  ellipsoidUniformBuffer: GPUBuffer | null;
  pipeline: GPURenderPipeline | null;
  pickPipeline: GPURenderPipeline | null;
  shaderModule: GPUShaderModule | null;
  bindGroup0: GPUBindGroup | null;
  bindGroup1: GPUBindGroup | null;
  vertexBuffer: GPUBuffer | null;
  indexBuffer: GPUBuffer | null;
  command: CesiumAnyDrawCommand | null;
  pickCommand: CesiumAnyDrawCommand | null;
  initialized: boolean;
  // C-R7-RENDERER-MIGRATION (Batch 56) — once pipeline-cache routing is
  // engaged the color + pick pipelines arrive asynchronously via
  // `WebGPURenderPipelineCache.getPipeline()`. We track whether the
  // request is already in flight so subsequent frames don't re-issue it,
  // and skip drawing on frames where the pipelines aren't materialized
  // yet (matches `getPipelineSync()` returning undefined).
  pipelineRequestPending: boolean;
}

// Inline WGSL for ray-marched ellipsoid
const ELLIPSOID_WGSL = `
struct CameraUniforms {
  modelViewProjectionRelativeToEye: mat4x4<f32>,
  modelViewRelativeToEye: mat4x4<f32>,
  encodedCameraPositionMCHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraPositionMCLow: vec3<f32>,
  _pad1: f32,
  viewportSize: vec2<f32>,
  _pad2: f32,
  _pad3: f32,
  // DP-H41 (Batch 27) — previous frame's viewProjection for
  // TAA / motion-vector reprojection. Sourced from
  // UniformState._previousViewProjection (f32 mat4).
  previousViewProjection: mat4x4<f32>,
};

struct EllipsoidUniforms {
  radii: vec3<f32>,
  _pad0: f32,
  oneOverRadiiSq: vec3<f32>,
  _pad1: f32,
  color: vec4<f32>,
  centerHigh: vec3<f32>,
  _pad2: f32,
  centerLow: vec3<f32>,
  _pad3: f32,
  // C-R9 (Batch 30) — pick color output for the pick FBO. Always written
  // but only read by the fragmentPickMain entry point.
  pickColor: vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> ellipsoid: EllipsoidUniforms;

struct VertexInput {
  @location(0) position: vec2<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) eyeDirection: vec3<f32>,
  @location(1) ellipsoidCenter: vec3<f32>,
};

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4<f32>(input.position, 0.0, 1.0);
  let centerRTE = (ellipsoid.centerHigh - camera.encodedCameraPositionMCHigh)
                + (ellipsoid.centerLow - camera.encodedCameraPositionMCLow);
  let centerEye = (camera.modelViewRelativeToEye * vec4<f32>(centerRTE, 1.0)).xyz;
  output.ellipsoidCenter = centerEye;
  let aspectRatio = camera.viewportSize.x / camera.viewportSize.y;
  output.eyeDirection = vec3<f32>(input.position.x * aspectRatio, input.position.y, -1.0);
  return output;
}

fn intersectEllipsoid(
  rayOrigin: vec3<f32>, rayDir: vec3<f32>,
  center: vec3<f32>, oneOverRadiiSq: vec3<f32>
) -> vec2<f32> {
  let oc = rayOrigin - center;
  let sqrtOORS = sqrt(oneOverRadiiSq);
  let ocScaled = oc * sqrtOORS;
  let dirScaled = rayDir * sqrtOORS;
  let a = dot(dirScaled, dirScaled);
  let b = 2.0 * dot(dirScaled, ocScaled);
  let c = dot(ocScaled, ocScaled) - 1.0;
  let disc = b * b - 4.0 * a * c;
  if (disc < 0.0) { return vec2<f32>(-1.0, -1.0); }
  let sd = sqrt(disc);
  return vec2<f32>((-b - sd) / (2.0 * a), (-b + sd) / (2.0 * a));
}

@fragment
fn fragmentMain(
  @builtin(position) fragPos: vec4<f32>,
  @location(0) eyeDirection: vec3<f32>,
  @location(1) ellipsoidCenter: vec3<f32>,
) -> @location(0) vec4<f32> {
  let rayDir = normalize(eyeDirection);
  let t = intersectEllipsoid(vec3<f32>(0.0), rayDir, ellipsoidCenter, ellipsoid.oneOverRadiiSq);
  if (t.x < 0.0 && t.y < 0.0) { discard; }
  var tHit = t.x;
  if (tHit < 0.0) { tHit = t.y; }
  if (tHit < 0.0) { discard; }
  let hit = rayDir * tHit;
  let n = normalize((hit - ellipsoidCenter) * ellipsoid.oneOverRadiiSq);
  let lightDir = normalize(vec3<f32>(0.5, 1.0, 0.3));
  let NdotL = max(dot(n, lightDir), 0.0);
  let col = ellipsoid.color.rgb * (0.3 + 0.7 * NdotL);
  return vec4<f32>(col, ellipsoid.color.a);
}

// C-R9 (Batch 30) — pick entry point. Same ray-ellipsoid intersection +
// discard as the color pass, but outputs the pick color instead of the
// lit material. The pick FBO readback maps this color back to the
// {primitive, id} target registered at creation time.
@fragment
fn fragmentPickMain(
  @builtin(position) fragPos: vec4<f32>,
  @location(0) eyeDirection: vec3<f32>,
  @location(1) ellipsoidCenter: vec3<f32>,
) -> @location(0) vec4<f32> {
  let rayDir = normalize(eyeDirection);
  let t = intersectEllipsoid(vec3<f32>(0.0), rayDir, ellipsoidCenter, ellipsoid.oneOverRadiiSq);
  if (t.x < 0.0 && t.y < 0.0) { discard; }
  var tHit = t.x;
  if (tHit < 0.0) { tHit = t.y; }
  if (tHit < 0.0) { discard; }
  return ellipsoid.pickColor;
}
`;

// Scratch objects for RTE encoding
const scratchEncodedPosition = {
  high: new Cartesian3(),
  low: new Cartesian3(),
};
const scratchMVP = new Matrix4();
const scratchMV = new Matrix4();

function createQuadGeometry(device: GPUDevice): {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
} {
  const vertices = new Float32Array([
    -1.0, -1.0, 1.0, -1.0, 1.0, 1.0, -1.0, 1.0,
  ]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);

  const vertexBuffer = device.createBuffer({
    size: vertices.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, gpuData(vertices));

  const indexBuffer = device.createBuffer({
    size: indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(indexBuffer, 0, gpuData(indices));

  return { vertexBuffer, indexBuffer };
}

// Vertex buffer layout shared by the color + pick pipelines. Defined once
// here so the cache-key signature in `WebGPURenderPipelineCache` (which
// hashes the full `vertex.buffers[]` shape) matches across both descriptor
// requests — otherwise the cache would treat them as different layouts.
const ELLIPSOID_VERTEX_BUFFERS: GPUVertexBufferLayout[] = [
  {
    arrayStride: 8,
    attributes: [
      {
        shaderLocation: 0,
        offset: 0,
        format: "float32x2" as GPUVertexFormat,
      },
    ],
  },
];

interface EllipsoidPipelineResources {
  shaderModule: GPUShaderModule;
  bindGroupLayout0: GPUBindGroupLayout;
  bindGroupLayout1: GPUBindGroupLayout;
  pipelineLayout: GPUPipelineLayout;
  colorDescriptor: WebGPURenderPipelineDescriptor;
  pickDescriptor: WebGPURenderPipelineDescriptor;
}

/**
 * Build the synchronous resources (shader module, BGLs, pipeline layout)
 * and the descriptor objects passed to `WebGPURenderPipelineCache`.
 * The cache materializes the actual `GPURenderPipeline` objects asynchronously.
 *
 * C-R7-RENDERER-MIGRATION (Batch 56). Previously this function called
 * `device.createRenderPipeline()` twice — once per primitive instance
 * regardless of whether two ellipsoids shared identical pipeline state.
 * Routing through the central cache means two ellipsoids with identical
 * descriptors share a single `GPURenderPipeline`.
 */
function buildEllipsoidPipelineResources(
  device: GPUDevice,
  canvasFormat: GPUTextureFormat,
): EllipsoidPipelineResources {
  const shaderModule = device.createShaderModule({ code: ELLIPSOID_WGSL });

  const bindGroupLayout0 = makeBindGroupLayout(
    device,
    "EllipsoidPrimitive BGL 0",
    [uniformBuffer(0, Stage.VERTEX_FRAGMENT)],
  );

  const bindGroupLayout1 = makeBindGroupLayout(
    device,
    "EllipsoidPrimitive BGL 1",
    [uniformBuffer(0, Stage.VERTEX_FRAGMENT)],
  );

  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout0, bindGroupLayout1],
  });

  const colorDescriptor: WebGPURenderPipelineDescriptor = {
    name: "EllipsoidPrimitive color pipeline",
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: ELLIPSOID_VERTEX_BUFFERS,
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      targets: [
        {
          format: canvasFormat,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: true,
      // less-equal for planetary-scale precision robustness.
      depthCompare: "less-equal",
    },
  };

  // C-R9 (Batch 30) — pick pipeline. Same layout, same vertex stage, same
  // depth behaviour, but the fragment entry emits the pickColor directly
  // (no blending — pick colors MUST be written unmodified into the FBO
  // so the readback maps them 1:1 back to the registered object).
  const pickDescriptor: WebGPURenderPipelineDescriptor = {
    name: "EllipsoidPrimitive pick pipeline",
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: ELLIPSOID_VERTEX_BUFFERS,
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentPickMain",
      targets: [{ format: canvasFormat }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: true,
      depthCompare: "less-equal",
    },
  };

  return {
    shaderModule,
    bindGroupLayout0,
    bindGroupLayout1,
    pipelineLayout,
    colorDescriptor,
    pickDescriptor,
  };
}

/**
 * Resolve the color + pick pipelines through the central pipeline cache.
 * If the cache is unavailable (WebGL context, or device not yet present),
 * falls back to direct `device.createRenderPipeline*Async()` so behavior
 * remains unchanged.
 *
 * Returns synchronously when both pipelines are already cached; otherwise
 * kicks off async creation and returns null so the caller can skip the
 * frame and try again next tick.
 */
function tryResolveEllipsoidPipelines(
  device: GPUDevice,
  pipelineCache: WebGPURenderPipelineCache | null | undefined,
  resources: EllipsoidPipelineResources,
  cache: EllipsoidCache,
): boolean {
  // Already resolved — nothing to do.
  if (cache.pipeline && cache.pickPipeline) {
    return true;
  }

  if (pipelineCache) {
    const colorSync = pipelineCache.getPipelineSync(resources.colorDescriptor);
    const pickSync = pipelineCache.getPipelineSync(resources.pickDescriptor);
    if (colorSync && pickSync) {
      cache.pipeline = colorSync;
      cache.pickPipeline = pickSync;
      cache.pipelineRequestPending = false;
      return true;
    }
    if (!cache.pipelineRequestPending) {
      cache.pipelineRequestPending = true;
      Promise.all([
        pipelineCache.getPipeline(resources.colorDescriptor),
        pipelineCache.getPipeline(resources.pickDescriptor),
      ])
        .then(([color, pick]) => {
          cache.pipeline = color;
          cache.pickPipeline = pick;
          cache.pipelineRequestPending = false;
        })
        .catch(() => {
          // Errors already logged by the cache; clear the in-flight flag
          // so the next frame retries.
          cache.pipelineRequestPending = false;
        });
    }
    return false;
  }

  // Fallback: no central cache (e.g. WebGL-backed graphics context). Mirror
  // the historical synchronous path so behavior matches pre-migration.
  cache.pipeline = device.createRenderPipeline(
    descriptorToGPU(resources.colorDescriptor),
  );
  cache.pickPipeline = device.createRenderPipeline(
    descriptorToGPU(resources.pickDescriptor),
  );
  return true;
}

/**
 * Convert our cache-friendly descriptor back into the WebGPU descriptor
 * shape for the fallback path. Only used when `pipelineCache` is null —
 * i.e. when we couldn't route through the central cache.
 */
function descriptorToGPU(
  d: WebGPURenderPipelineDescriptor,
): GPURenderPipelineDescriptor {
  return {
    label: d.name,
    layout: d.layout ?? "auto",
    vertex: {
      module: d.vertex.module,
      entryPoint: d.vertex.entryPoint,
      buffers: d.vertex.buffers,
    },
    fragment: d.fragment
      ? {
          module: d.fragment.module,
          entryPoint: d.fragment.entryPoint,
          targets: d.fragment.targets,
        }
      : undefined,
    primitive: d.primitive,
    depthStencil: d.depthStencil,
    multisample: d.multisample,
  };
}

function packCameraUniforms(
  uniformState: CesiumUniformState,
  modelMatrix: Matrix4 | CesiumMatrix4,
  viewportWidth: number,
  viewportHeight: number,
): Float32Array {
  // 240 bytes = 60 floats: mvpRTE(16) + mvRTE(16) + camHigh(3+1) + camLow(3+1)
  //   + viewport(2+2 pad) + previousViewProjection(16) [DP-H41, Batch 27]
  const data = new Float32Array(60);
  const view = uniformState.view;
  const projection = uniformState.projection;

  // RTE: zero the translation column of MV *before* multiplying by
  // projection. Zeroing after the multiply wipes out projection's P23
  // depth-mapping term, producing incorrect NDC depth. See
  // `UniformStateComputations.cleanModelViewProjectionRelativeToEye`.
  Matrix4.multiply(view, modelMatrix, scratchMV);
  scratchMV[12] = 0;
  scratchMV[13] = 0;
  scratchMV[14] = 0;
  Matrix4.multiply(projection, scratchMV, scratchMVP);
  const mv = m4Values(scratchMV);
  const mvp = m4Values(scratchMVP);

  // MVP relative to eye
  for (let i = 0; i < 16; i++) {
    data[i] = mvp[i];
  }
  // ModelView relative to eye
  for (let i = 0; i < 16; i++) {
    data[16 + i] = mv[i];
  }

  // Encoded camera position in model coordinates
  const invModel = Matrix4.inverse(modelMatrix, new Matrix4());
  const camWorld = uniformState.cameraPosition;
  const camModel = Matrix4.multiplyByPoint(
    invModel,
    camWorld,
    new Cartesian3(),
  );
  EncodedCartesian3.fromCartesian(camModel, scratchEncodedPosition);
  data[32] = scratchEncodedPosition.high.x;
  data[33] = scratchEncodedPosition.high.y;
  data[34] = scratchEncodedPosition.high.z;
  data[35] = 0; // pad
  data[36] = scratchEncodedPosition.low.x;
  data[37] = scratchEncodedPosition.low.y;
  data[38] = scratchEncodedPosition.low.z;
  data[39] = 0; // pad

  // viewportSize at offset 160 (float index 40)
  data[40] = viewportWidth;
  data[41] = viewportHeight;
  data[42] = 0; // _pad2
  data[43] = 0; // _pad3

  // DP-H41 (Batch 27) — previousViewProjection at slots 44..59 for
  // TAA / motion-vector reprojection. `UniformState.update()` caches
  // last frame's viewProjection before overwriting the current state.
  const prevVP = uniformState.previousViewProjection;
  if (prevVP) {
    const prev = m4Values(prevVP);
    for (let i = 0; i < 16; i++) data[44 + i] = prev[i];
  } else {
    data[44] = 1;
    data[45] = 0;
    data[46] = 0;
    data[47] = 0;
    data[48] = 0;
    data[49] = 1;
    data[50] = 0;
    data[51] = 0;
    data[52] = 0;
    data[53] = 0;
    data[54] = 1;
    data[55] = 0;
    data[56] = 0;
    data[57] = 0;
    data[58] = 0;
    data[59] = 1;
  }
  return data;
}

// 112 bytes = 28 floats: radii(4) + oneOverRadiiSq(4) + color(4)
// + centerHigh(4) + centerLow(4) + pickColor(4) [C-R9, Batch 30]
const ELLIPSOID_UBO_BYTES = 112;
const ELLIPSOID_UBO_FLOATS = ELLIPSOID_UBO_BYTES / 4;

function packEllipsoidUniforms(
  primitive: CesiumObjectWithWebGPUCache,
  pickColor: { red: number; green: number; blue: number; alpha: number } | null,
): Float32Array {
  const data = new Float32Array(ELLIPSOID_UBO_FLOATS);
  const radii = primitive.radii;
  data[0] = radii.x;
  data[1] = radii.y;
  data[2] = radii.z;
  data[3] = 0;

  const oors = primitive._oneOverEllipsoidRadiiSquared;
  data[4] = oors.x;
  data[5] = oors.y;
  data[6] = oors.z;
  data[7] = 0;

  // Color from material or default
  const color = primitive.material?.uniforms?.color;
  if (color) {
    data[8] = color.red ?? color.x ?? 1.0;
    data[9] = color.green ?? color.y ?? 1.0;
    data[10] = color.blue ?? color.z ?? 1.0;
    data[11] = color.alpha ?? color.w ?? 1.0;
  } else {
    data[8] = 1.0;
    data[9] = 1.0;
    data[10] = 1.0;
    data[11] = 1.0;
  }

  // Encode center position (from modelMatrix translation).
  const modelMatrix = primitive.modelMatrix ?? Matrix4.IDENTITY;
  const center = Matrix4.getTranslation(modelMatrix, new Cartesian3());
  EncodedCartesian3.fromCartesian(center, scratchEncodedPosition);
  data[12] = scratchEncodedPosition.high.x;
  data[13] = scratchEncodedPosition.high.y;
  data[14] = scratchEncodedPosition.high.z;
  data[15] = 0;
  data[16] = scratchEncodedPosition.low.x;
  data[17] = scratchEncodedPosition.low.y;
  data[18] = scratchEncodedPosition.low.z;
  data[19] = 0;

  // C-R9 (Batch 30) — pick color slot. Zero when the primitive hasn't
  // been pick-registered yet; the pick pass skips the draw in that
  // case, so the zero alpha reaching the pick FBO is benign.
  if (pickColor) {
    data[20] = pickColor.red;
    data[21] = pickColor.green;
    data[22] = pickColor.blue;
    data[23] = pickColor.alpha;
  } else {
    data[20] = 0;
    data[21] = 0;
    data[22] = 0;
    data[23] = 0;
  }

  return data;
}

/**
 * Update WebGPU ellipsoid primitive resources and issue draw commands.
 */
function updateWebGPUEllipsoidPrimitive(
  primitive: CesiumObjectWithWebGPUCache,
  frameState: CesiumFrameState,
): void {
  const context = frameState.context;
  const device: GPUDevice = context.device;
  const commandList = frameState.commandList;

  if (!primitive.show) {
    return;
  }

  // Compute oneOverEllipsoidRadiiSquared if needed
  const radii = primitive.radii;
  if (radii) {
    const oors = primitive._oneOverEllipsoidRadiiSquared;
    if (!oors || oors.x === 0) {
      primitive._oneOverEllipsoidRadiiSquared = new Cartesian3(
        1.0 / (radii.x * radii.x),
        1.0 / (radii.y * radii.y),
        1.0 / (radii.z * radii.z),
      );
    }
  }

  if (!primitive._webgpuCache) {
    primitive._webgpuCache = {
      uniformBuffer: null,
      ellipsoidUniformBuffer: null,
      pipeline: null,
      pickPipeline: null,
      shaderModule: null,
      bindGroup0: null,
      bindGroup1: null,
      vertexBuffer: null,
      indexBuffer: null,
      command: null,
      pickCommand: null,
      initialized: false,
      pipelineRequestPending: false,
    } as EllipsoidCache;
  }

  const cache = primitive._webgpuCache as EllipsoidCache;
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();

  // C-R7-RENDERER-MIGRATION (Batch 56) — route pipeline creation through
  // the central WebGPURenderPipelineCache. Held on a sidecar so we can
  // re-resolve every frame until both pipelines materialize.
  let resources = (
    cache as EllipsoidCache & {
      _pipelineResources?: EllipsoidPipelineResources;
    }
  )._pipelineResources;

  // One-time initialization of CPU-side resources (buffers, BGLs, shader,
  // pipeline-layout, bind groups, and the quad geometry). The pipelines
  // themselves are resolved separately via the central cache below.
  if (!cache.initialized) {
    // Camera UBO: 60 floats × 4 = 240 bytes (mvpRTE + mvRTE + camHigh/Low +
    //   viewport + previousViewProjection [DP-H41, Batch 27])
    cache.uniformBuffer = device.createBuffer({
      size: 240,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Ellipsoid UBO: 28 floats × 4 = 112 bytes (radii + oneOverRadiiSq +
    //   color + center + pickColor [C-R9, Batch 30])
    cache.ellipsoidUniformBuffer = device.createBuffer({
      size: ELLIPSOID_UBO_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    resources = buildEllipsoidPipelineResources(device, canvasFormat);
    (
      cache as EllipsoidCache & {
        _pipelineResources?: EllipsoidPipelineResources;
      }
    )._pipelineResources = resources;
    cache.shaderModule = resources.shaderModule;

    // Create bind groups
    cache.bindGroup0 = device.createBindGroup({
      layout: resources.bindGroupLayout0,
      entries: [{ binding: 0, resource: { buffer: cache.uniformBuffer } }],
    });
    cache.bindGroup1 = device.createBindGroup({
      layout: resources.bindGroupLayout1,
      entries: [
        { binding: 0, resource: { buffer: cache.ellipsoidUniformBuffer } },
      ],
    });

    // Create quad geometry
    const geom = createQuadGeometry(device);
    cache.vertexBuffer = geom.vertexBuffer;
    cache.indexBuffer = geom.indexBuffer;

    cache.initialized = true;
  }

  // Resolve the color + pick pipelines via the central cache. On first
  // frame this kicks off async creation and returns false; subsequent
  // frames pick up the cached pipeline synchronously and return true.
  // We `return` early on the not-yet-ready frames so we don't enqueue
  // a draw command with a null pipeline.
  const ctxAny = context as unknown as {
    webgpuPipelineCache?: WebGPURenderPipelineCache | null;
  };
  if (
    !tryResolveEllipsoidPipelines(
      device,
      ctxAny.webgpuPipelineCache ?? null,
      resources!,
      cache,
    )
  ) {
    return;
  }

  // Per-frame uniform updates
  const uniformState = context.uniformState;
  const modelMatrix = primitive.modelMatrix ?? Matrix4.IDENTITY;

  const viewportWidth = context.drawingBufferWidth || 1;
  const viewportHeight = context.drawingBufferHeight || 1;
  const cameraData = packCameraUniforms(
    uniformState,
    modelMatrix,
    viewportWidth,
    viewportHeight,
  );
  device.queue.writeBuffer(cache.uniformBuffer!, 0, gpuData(cameraData));

  // C-R9 (Batch 30) — ensure a pick ID is registered with the context
  // when the primitive hasn't been pick-bound yet or its `id` changed.
  // Mirrors the WebGL path in `Scene/EllipsoidPrimitive.js` lines 377-387.
  const passes = frameState.passes;
  if (passes && (passes.pick || passes.render)) {
    const primId = primitive.id;
    const pickState = primitive as unknown as {
      _pickId?: { color: CesiumColor; destroy(): void };
      _pickIdLastId?: unknown;
    };
    if (!pickState._pickId || pickState._pickIdLastId !== primId) {
      if (pickState._pickId) {
        pickState._pickId.destroy();
      }
      pickState._pickId = context.createPickId(
        { primitive: primitive, id: primId },
        "primitive",
      );
      pickState._pickIdLastId = primId;
    }
  }

  const pickColor = (
    primitive as unknown as { _pickId?: { color: CesiumColor } }
  )._pickId?.color;
  const ellipsoidData = packEllipsoidUniforms(primitive, pickColor ?? null);
  device.queue.writeBuffer(
    cache.ellipsoidUniformBuffer!,
    0,
    gpuData(ellipsoidData),
  );

  // C-R1 (Batch 35) — forward any WebGL-style renderState set by
  // Scene/EllipsoidPrimitive.js onto the emitted WebGPUDrawCommand so
  // `applyPerEncoderState` (Batch 30) runs stencilRef / blendConstant /
  // viewport / scissor before the draw. Refreshed every frame so a
  // material translucent-state change picks up on the next frame
  // without needing to invalidate the command.
  const primitiveRS = (primitive as unknown as { _rs?: unknown })._rs;

  // Color command (normal render pass)
  if (!cache.command) {
    cache.command = new WebGPUDrawCommand({
      pipeline: cache.pipeline,
      bindGroups: [cache.bindGroup0, cache.bindGroup1],
      vertexBuffers: [cache.vertexBuffer],
      indexBuffer: cache.indexBuffer,
      indexCount: 6,
      pass: Pass.OPAQUE,
    });
  }
  // Keep renderState in sync each frame — catches primitive.material
  // translucent-toggle cases where `_rs` rebuilds between frames. The
  // WebGL-shape `renderState` is passed through as an opaque object and
  // consumed by `applyPerEncoderState` in `WebGPUDrawCommand.execute`.
  if (primitiveRS) {
    (cache.command as CesiumAnyDrawCommand).renderState =
      primitiveRS as CesiumAnyDrawCommand["renderState"];
  }

  commandList.push(cache.command);

  // C-R9 (Batch 30) — pick command. Emitted unconditionally alongside the
  // color command so the scene-renderer's `_executePickBatch` finds it
  // during pick passes. Commands tagged with pass=OPAQUE already flow
  // into the pick pass through `Pass.OPAQUE` walk in `_executePickPass`;
  // no separate pick-only pass bucket is needed on WebGPU because the
  // pick FBO render pass reuses the same opaque command list.
  if (pickColor) {
    if (!cache.pickCommand) {
      cache.pickCommand = new WebGPUDrawCommand({
        pipeline: cache.pickPipeline!,
        bindGroups: [cache.bindGroup0, cache.bindGroup1],
        vertexBuffers: [cache.vertexBuffer],
        indexBuffer: cache.indexBuffer,
        indexCount: 6,
        pass: Pass.OPAQUE,
        pickOnly: true,
      });
    }
    // Wire the pick command onto the color command's derivedCommands so
    // `selectCommandVariant` (Batch 29) routes to it during pick passes.
    (cache.command as CesiumAnyDrawCommand).derivedCommands = {
      ...((cache.command as CesiumAnyDrawCommand).derivedCommands ?? {}),
      picking: { pickCommand: cache.pickCommand },
    };
  }
}

/**
 * Destroy WebGPU ellipsoid primitive resources.
 */
function destroyWebGPUEllipsoidPrimitiveResources(
  primitive: CesiumObjectWithWebGPUCache,
): void {
  const cache = primitive._webgpuCache as EllipsoidCache | undefined;
  if (!cache) {
    return;
  }

  cache.uniformBuffer?.destroy();
  cache.ellipsoidUniformBuffer?.destroy();
  cache.vertexBuffer?.destroy();
  cache.indexBuffer?.destroy();

  // C-R9 (Batch 30) — tear down the pick ID so its slot in the pick
  // registry is reclaimed and the next primitive instance gets a fresh
  // color. No-op if the primitive never entered a pick pass.
  const pickState = primitive as unknown as {
    _pickId?: { destroy(): void };
    _pickIdLastId?: unknown;
  };
  pickState._pickId?.destroy();
  pickState._pickId = undefined;
  pickState._pickIdLastId = undefined;

  primitive._webgpuCache = undefined;
}

export {
  updateWebGPUEllipsoidPrimitive,
  destroyWebGPUEllipsoidPrimitiveResources,
};
export default {
  updateWebGPUEllipsoidPrimitive,
  destroyWebGPUEllipsoidPrimitiveResources,
};
