/**
 * WebGPU Gaussian Splat Renderer
 *
 * Renders 3D Gaussian Splatting primitives. Each splat is projected from
 * a 3D Gaussian to a 2D screen-space Gaussian evaluated per-pixel.
 * Uses RTE (Relative-To-Eye) positioning for planetary-scale precision.
 *
 * @module WebGPUGaussianSplatRenderer
 */

import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import Cartesian3 from "../../Core/Cartesian3.js";
import Pass from "../Pass.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { m4Values } from "./webgpuTypeHelpers.js";
import { WebGPUOIT } from "./WebGPUOIT.js";
import type {
  WebGPURenderPipelineCache,
  WebGPURenderPipelineDescriptor,
} from "./WebGPURenderPipelineCache.js";
import {
  attachPickToColorCommand,
  buildPickPipelineDescriptor,
  destroyPickIds,
  ensurePickId,
  type SinglePickIdCache,
} from "./WebGPUPickCommandHelpers.js";

interface GaussianSplatCache {
  uniformBuffer: GPUBuffer | null;
  pipeline: GPURenderPipeline | null;
  oitPipeline: GPURenderPipeline | null;
  pickPipeline: GPURenderPipeline | null;
  // NEW-GS-CLASSIFICATION-DEPTH (Batch 176) — depth-write variant of the
  // color pipeline. Same layout / vertex / fragment / blend; only the
  // depthStencil block flips `depthWriteEnabled: true`. Populated on
  // the splat WebGPUDrawCommand as `classificationDepthPipeline` so the
  // dispatcher can swap to it when `depthForTranslucentClassification`
  // is set (Cesium3DTile.update flips that flag for splat-pass commands
  // alongside translucent commands). Splats can then participate as
  // classifier targets — clipping volumes, draped classifiers, etc.
  // pick the splat surface depth instead of the geometry behind it.
  // Without this variant the splat alpha-blend would let classifiers
  // pass through to the next-deepest opaque surface.
  depthWritePipeline: GPURenderPipeline | null;
  shaderModule: GPUShaderModule | null;
  bindGroup: GPUBindGroup | null;
  quadVertexBuffer: GPUBuffer | null;
  splatBuffer: GPUBuffer | null;
  splatCount: number;
  command: CesiumAnyDrawCommand | null;
  pickCommand: CesiumAnyDrawCommand | null;
  initialized: boolean;
  lastRevision: number;
  pipelineLayout: GPUPipelineLayout | null;
  // C-R7-RENDERER-MIGRATION (Batch 56) — see EllipsoidPrimitiveRenderer
  // for the rationale. The OIT pipeline is optional (its WGSL injection
  // can fail) and stays out of the central cache for now to preserve
  // the existing fall-through-to-null semantics. Only the color + pick
  // pipelines route through the cache.
  pipelineRequestPending: boolean;

  // Batch 171 - B.10 NEW-ADVANCED-MOTION-VECTORS (GaussianSplat).
  // Same lifecycle as PointCloud Batch 168/169 + Cloud Batch 170:
  //   - `splatData` tracks THIS frame's typed-array splat upload.
  //   - `prevSplatData` is promoted from `splatData` AFTER the
  //     velocity dispatch (PointPrimitive Batch 148 pattern).
  //   - `prevSplatBuffer` is the GPU mirror of prev positions.
  //   - `velocityPipeline` resolves through the central pipeline cache.
  // Static splat clouds have prev=curr → velocity=0 (camera-only TAA
  // fallback handles motion). For animated splats (rare; the loader
  // typically locks splat data at content load), per-splat velocity
  // is captured via the parallel buffer.
  splatData: ArrayBufferView | null;
  prevSplatData: ArrayBufferView | null;
  prevSplatBuffer: GPUBuffer | null;
  velocityPipeline: GPURenderPipeline | null;
  velocityPipelineDescriptor: WebGPURenderPipelineDescriptor | null;
  velocityPipelineRequestPending: boolean;
}

const SPLAT_WGSL = `
struct VertexInput {
  @location(0) quadVertex: vec2<f32>,
  @location(1) positionHigh: vec3<f32>,
  @location(2) positionLow: vec3<f32>,
  @location(3) covA: vec3<f32>,
  @location(4) covB: vec3<f32>,
  @location(5) colorAndAlpha: vec4<f32>,
};
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) conic: vec3<f32>,
  @location(2) centerOffset: vec2<f32>,
};
struct Uniforms {
  mvpRelativeToEye: mat4x4<f32>,
  modelViewRelativeToEye: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  viewportSize: vec2<f32>,
  focalX: f32,
  focalY: f32,
  // C-R9 (Batch 31) — pick color broadcast across the whole splat cloud.
  // Splats belong to a single primitive for pick purposes (there's no
  // per-splat feature ID today), so one pickColor per primitive is
  // correct. UBO grows 176 → 192 bytes.
  pickColor: vec4<f32>,
  // AUDIT_2026_05_02 B.9 (Batch 153) — DP-H41 prev viewProjection at the
  // tail. Layout-only invariant today; consumed by future per-splat
  // motion-vector pass for animated splat clouds. UBO grows 192 → 256.
  prevViewProjection: mat4x4<f32>,
  // Batch 172 — full model matrix (no translation zeroing) so the
  // velocity VS can lift prev model-space positions to world space
  // before applying prevViewProjection. UBO grows 256 → 320.
  modelMatrix: mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let posRTE = (input.positionHigh - u.encodedCameraHigh)
             + (input.positionLow - u.encodedCameraLow);
  let clipPos = u.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);
  let t = u.modelViewRelativeToEye * vec4<f32>(posRTE, 1.0);
  let J00 = u.focalX / t.z;
  let J02 = -(u.focalX * t.x / t.z) / t.z;
  let J11 = u.focalY / t.z;
  let J12 = -(u.focalY * t.y / t.z) / t.z;
  // C-P15: rotate 3D covariance by the modelView 3x3 so splats follow
  // modelMatrix rotation/scale. Matches GLSL: R = mat3(czm_modelView).
  // The translation column of modelViewRelativeToEye is zeroed CPU-side,
  // so its 3x3 block is the pure rotation*scale we need.
  let R = mat3x3<f32>(
    u.modelViewRelativeToEye[0].xyz,
    u.modelViewRelativeToEye[1].xyz,
    u.modelViewRelativeToEye[2].xyz,
  );
  let Sigma = mat3x3<f32>(
    vec3<f32>(input.covA.x, input.covA.y, input.covA.z),
    vec3<f32>(input.covA.y, input.covB.x, input.covB.y),
    vec3<f32>(input.covA.z, input.covB.y, input.covB.z),
  );
  let SV = R * Sigma * transpose(R);
  let a = SV[0][0]; let b = SV[1][0]; let c = SV[2][0];
  let d = SV[1][1]; let e = SV[2][1]; let f = SV[2][2];
  let c00 = J00*J00*a + 2.0*J00*J02*c + J02*J02*f + 0.3;
  let c01 = J00*J11*b + J02*J11*e + J00*J12*c + J02*J12*f;
  let c11 = J11*J11*d + 2.0*J11*J12*e + J12*J12*f + 0.3;
  let det = c00*c11 - c01*c01;
  if (det <= 0.0) {
    output.position = vec4<f32>(0.0, 0.0, 2.0, 1.0);
    output.color = vec4<f32>(0.0); output.conic = vec3<f32>(0.0);
    output.centerOffset = vec2<f32>(0.0); return output;
  }
  let invDet = 1.0 / det;
  let conic = vec3<f32>(c11*invDet, -c01*invDet, c00*invDet);
  let eigenMax = 0.5*(c00+c11+sqrt((c00-c11)*(c00-c11)+4.0*c01*c01));
  let radius = ceil(3.0 * sqrt(eigenMax));
  let pixOff = input.quadVertex * radius;
  let ndcOff = pixOff / u.viewportSize * 2.0 * clipPos.w;
  var fp = clipPos;
  fp.x = fp.x + ndcOff.x; fp.y = fp.y + ndcOff.y;
  output.position = fp;
  output.color = input.colorAndAlpha;
  output.conic = conic;
  output.centerOffset = pixOff;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let off = input.centerOffset;
  let power = -0.5*(input.conic.x*off.x*off.x + input.conic.z*off.y*off.y)
              - input.conic.y*off.x*off.y;
  if (power > 0.0) { discard; }
  let alpha = min(0.99, input.color.a * exp(power));
  if (alpha < 1.0/255.0) { discard; }
  return vec4<f32>(input.color.rgb * alpha, alpha);
}

// C-R9 (Batch 31) — pick entry point. Same gaussian footprint test as
// the color pass (so pick hits only the visible splat density), but
// outputs u.pickColor unmodified. No blending on the pick pipeline so
// the readback sees byte-exact pick IDs.
@fragment
fn fragmentPickMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let off = input.centerOffset;
  let power = -0.5*(input.conic.x*off.x*off.x + input.conic.z*off.y*off.y)
              - input.conic.y*off.x*off.y;
  if (power > 0.0) { discard; }
  let alpha = min(0.99, input.color.a * exp(power));
  if (alpha < 1.0/255.0) { discard; }
  return u.pickColor;
}

// Batch 171 - B.10 NEW-ADVANCED-MOTION-VECTORS velocity emission for
// animated Gaussian splat clouds. Mirrors PointCloud Batch 168/169 +
// CloudCollection Batch 170 patterns.
//
// On the deferred entry's "sort-order indexing" wrinkle: this renderer
// uploads splat data once per revision (the splat buffer is typed-array
// content from the loader) — there is NO per-frame sort/compaction at
// this layer that would shuffle indices, so the prev buffer can use the
// stable splat ID (= buffer index) directly. If a future GPU-sort pass
// is wired in this renderer, the prev buffer would need a parallel
// permutation lookup; until then index identity holds.
struct VelocityVertexInput {
  @location(0) quadVertex: vec2<f32>,
  @location(1) positionHigh: vec3<f32>,
  @location(2) positionLow: vec3<f32>,
  @location(3) covA: vec3<f32>,
  @location(4) covB: vec3<f32>,
  @location(5) colorAndAlpha: vec4<f32>,
  // Slot 1: prev-frame instance data — only positions are read.
  @location(6) prevPositionHigh: vec3<f32>,
  @location(7) prevPositionLow: vec3<f32>,
};

struct VelocityVertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) currCenterClip: vec4<f32>,
  @location(1) prevCenterClip: vec4<f32>,
};

@vertex
fn vertexVelocityMain(input: VelocityVertexInput) -> VelocityVertexOutput {
  var output: VelocityVertexOutput;
  // Current-frame center clip via RTE (matches vertexMain).
  let posRTE = (input.positionHigh - u.encodedCameraHigh)
             + (input.positionLow - u.encodedCameraLow);
  let currCenterClip = u.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);
  // Batch 172 — Previous-frame center clip via prevVP × modelMatrix ×
  // prevModelPos. Splat positions in _splatData are model-space; the
  // current-frame VS folds the modelMatrix into mvpRelativeToEye, so
  // prev needs the explicit lift via the standalone modelMatrix
  // (added to the UBO this batch). For typical 3D-Tiles content the
  // modelMatrix is identity and the lift is a no-op; for custom
  // primitives with non-identity modelMatrix this is required for
  // correct prev-clip projection.
  let prevModelPos = vec4<f32>(
    input.prevPositionHigh + input.prevPositionLow, 1.0,
  );
  let prevWorldPos = u.modelMatrix * prevModelPos;
  let prevCenterClip = u.prevViewProjection * prevWorldPos;

  // Batch 172 — Replicate the full elliptical footprint expansion from
  // vertexMain so the velocity texture covers the SAME pixels the
  // color pass touched (within numerical precision). Pre-Batch-172 a
  // coarse 2-pixel square footprint left edge pixels of large splats
  // outside the velocity texture, falling back to camera-only TAA
  // reprojection at the splat edges of animated splats.
  let t = u.modelViewRelativeToEye * vec4<f32>(posRTE, 1.0);
  let J00 = u.focalX / t.z;
  let J02 = -(u.focalX * t.x / t.z) / t.z;
  let J11 = u.focalY / t.z;
  let J12 = -(u.focalY * t.y / t.z) / t.z;
  let R = mat3x3<f32>(
    u.modelViewRelativeToEye[0].xyz,
    u.modelViewRelativeToEye[1].xyz,
    u.modelViewRelativeToEye[2].xyz,
  );
  let Sigma = mat3x3<f32>(
    vec3<f32>(input.covA.x, input.covA.y, input.covA.z),
    vec3<f32>(input.covA.y, input.covB.x, input.covB.y),
    vec3<f32>(input.covA.z, input.covB.y, input.covB.z),
  );
  let SV = R * Sigma * transpose(R);
  let a = SV[0][0]; let b = SV[1][0]; let c = SV[2][0];
  let d = SV[1][1]; let e = SV[2][1]; let f = SV[2][2];
  let c00 = J00*J00*a + 2.0*J00*J02*c + J02*J02*f + 0.3;
  let c01 = J00*J11*b + J02*J11*e + J00*J12*c + J02*J12*f;
  let c11 = J11*J11*d + 2.0*J11*J12*e + J12*J12*f + 0.3;
  let det = c00*c11 - c01*c01;
  if (det <= 0.0) {
    // Degenerate splat — emit a behind-camera zero-coverage triangle so
    // the velocity FS never executes for this instance. Mirrors
    // vertexMain's degenerate handling.
    output.position = vec4<f32>(0.0, 0.0, 2.0, 1.0);
    output.currCenterClip = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    output.prevCenterClip = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    return output;
  }
  let eigenMax = 0.5*(c00+c11+sqrt((c00-c11)*(c00-c11)+4.0*c01*c01));
  let radius = ceil(3.0 * sqrt(eigenMax));
  let pixOff = input.quadVertex * radius;
  let ndcOff = pixOff / u.viewportSize * 2.0 * currCenterClip.w;
  var fp = currCenterClip;
  fp.x = fp.x + ndcOff.x;
  fp.y = fp.y + ndcOff.y;
  output.position = fp;
  output.currCenterClip = currCenterClip;
  output.prevCenterClip = prevCenterClip;
  return output;
}

@fragment
fn fragmentVelocityMain(input: VelocityVertexOutput) -> @location(0) vec2<f32> {
  let curW = input.currCenterClip.w;
  let prevW = input.prevCenterClip.w;
  if (curW <= 0.0 || prevW <= 0.0) {
    return vec2<f32>(0.0);
  }
  let curNdc = input.currCenterClip.xy / curW;
  let prevNdc = input.prevCenterClip.xy / prevW;
  return curNdc - prevNdc;
}
`;

const scratchEncoded = { high: new Cartesian3(), low: new Cartesian3() };
const scratchMVP = new Matrix4();
const scratchMV = new Matrix4();

function createQuadVB(device: GPUDevice): GPUBuffer {
  const v = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
  const buf = device.createBuffer({
    size: v.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buf, 0, v);
  return buf;
}

// Vertex buffer layout shared by the color, OIT, and pick pipelines.
// Defined once so the cache-key signature in `WebGPURenderPipelineCache`
// (which hashes the full `vertex.buffers[]` shape) lines up across all
// three descriptors when the cache routes them.
const SPLAT_VERTEX_BUFFERS: GPUVertexBufferLayout[] = [
  {
    arrayStride: 8,
    stepMode: "vertex" as GPUVertexStepMode,
    attributes: [
      {
        shaderLocation: 0,
        offset: 0,
        format: "float32x2" as GPUVertexFormat,
      },
    ],
  },
  {
    arrayStride: 64,
    stepMode: "instance" as GPUVertexStepMode,
    attributes: [
      {
        shaderLocation: 1,
        offset: 0,
        format: "float32x3" as GPUVertexFormat,
      },
      {
        shaderLocation: 2,
        offset: 12,
        format: "float32x3" as GPUVertexFormat,
      },
      {
        shaderLocation: 3,
        offset: 24,
        format: "float32x3" as GPUVertexFormat,
      },
      {
        shaderLocation: 4,
        offset: 36,
        format: "float32x3" as GPUVertexFormat,
      },
      {
        shaderLocation: 5,
        offset: 48,
        format: "float32x4" as GPUVertexFormat,
      },
    ],
  },
];

interface SplatPipelineResources {
  shaderModule: GPUShaderModule;
  oitShaderModule: GPUShaderModule | null;
  bgl: GPUBindGroupLayout;
  layout: GPUPipelineLayout;
  colorDescriptor: WebGPURenderPipelineDescriptor;
  oitDescriptor: WebGPURenderPipelineDescriptor | null;
  pickDescriptor: WebGPURenderPipelineDescriptor;
  // NEW-GS-CLASSIFICATION-DEPTH (Batch 176). Same as colorDescriptor
  // but with `depthWriteEnabled: true`. Routed through the central
  // pipeline cache the same way the color descriptor is.
  depthWriteDescriptor: WebGPURenderPipelineDescriptor;
}

/**
 * Build the synchronous resources (shader modules, BGL, pipeline layout)
 * and the descriptor objects passed to `WebGPURenderPipelineCache`.
 *
 * C-R7-RENDERER-MIGRATION (Batch 56). Two splat primitives with identical
 * material settings now share a single `GPURenderPipeline` per variant
 * (color + OIT + pick) instead of materializing six pipelines for two
 * primitives.
 */
function buildSplatPipelineResources(
  device: GPUDevice,
  format: GPUTextureFormat,
): SplatPipelineResources {
  const sm = device.createShaderModule({ code: SPLAT_WGSL });
  const bgl = makeBindGroupLayout(device, "GaussianSplat BGL", [
    uniformBuffer(0, Stage.VERTEX_FRAGMENT),
  ]);
  // Instance stride: posHigh(12) + posLow(12) + covA(12) + covB(12) + color(16) = 64 bytes
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });

  const colorDescriptor: WebGPURenderPipelineDescriptor = {
    name: "GaussianSplat color pipeline",
    layout,
    vertex: {
      module: sm,
      entryPoint: "vertexMain",
      buffers: SPLAT_VERTEX_BUFFERS,
    },
    fragment: {
      module: sm,
      entryPoint: "fragmentMain",
      targets: [
        {
          format,
          blend: {
            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: false,
      // less-equal for planetary-scale precision robustness.
      depthCompare: "less-equal",
    },
  };

  // GS-WSR: OIT pipeline variant for weighted-sum rendering. WGSL injection
  // can fail (returns null), in which case OIT support is skipped — same
  // semantics as the pre-cache path.
  let oitShaderModule: GPUShaderModule | null = null;
  let oitDescriptor: WebGPURenderPipelineDescriptor | null = null;
  try {
    const oitCode = WebGPUOIT.injectOITOutput(SPLAT_WGSL, "fragmentMain");
    oitShaderModule = device.createShaderModule({
      label: "GaussianSplat-OIT-GS-WSR",
      code: oitCode,
    });
    oitDescriptor = {
      name: "GaussianSplat-OIT-Pipeline",
      layout,
      vertex: {
        module: oitShaderModule,
        entryPoint: "vertexMain",
        buffers: SPLAT_VERTEX_BUFFERS,
      },
      fragment: {
        module: oitShaderModule,
        entryPoint: "fragmentMain",
        targets: WebGPUOIT.OIT_TARGETS,
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: false,
        // less-equal for planetary-scale precision robustness.
        depthCompare: "less-equal",
      },
    };
  } catch (e) {
    // OIT variant creation is non-fatal — falls back to standard alpha blending
  }

  // C-R9 (Batch 31 / refactored Batch 59) — pick descriptor derived from
  // the color descriptor via {@link buildPickPipelineDescriptor}. Same
  // layout + VS + depthStencil shape; fragment entry swapped to
  // `fragmentPickMain` and blend stripped so pick colors reach the FBO
  // unmodified. `forceDepthWriteEnabled: false` preserves the historical
  // setting (splats are translucent — neither color nor pick path writes
  // depth so the OIT pass behind them stays correct).
  const pickDescriptor: WebGPURenderPipelineDescriptor =
    buildPickPipelineDescriptor(colorDescriptor, "fragmentPickMain", {
      name: "GaussianSplat pick pipeline",
      forceDepthWriteEnabled: false,
    });

  // NEW-GS-CLASSIFICATION-DEPTH (Batch 176) — depth-write variant of the
  // color pipeline. Same module / layout / vertex / fragment / blend as
  // the color pipeline; the only delta is `depthWriteEnabled: true` so
  // the splat surface populates the scene-FB depth attachment when this
  // variant is bound. The splat command's `classificationDepthPipeline`
  // points here; `WebGPUDrawCommand.execute` swaps to it when
  // `depthForTranslucentClassification` is set on the command (mirrors
  // Batch 79's translucent-classification mechanism for Models).
  const depthWriteDescriptor: WebGPURenderPipelineDescriptor = {
    ...colorDescriptor,
    name: "GaussianSplat depth-write pipeline",
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: true,
      depthCompare: "less-equal",
    },
  };

  return {
    shaderModule: sm,
    oitShaderModule,
    bgl,
    layout,
    colorDescriptor,
    oitDescriptor,
    pickDescriptor,
    depthWriteDescriptor,
  };
}

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

/**
 * Resolve the color, OIT, and pick pipelines through the central pipeline
 * cache. Returns true once the color + pick pipelines are ready
 * (OIT is best-effort — null OIT is a valid steady-state result so it
 * never blocks the ready signal).
 */
function tryResolveSplatPipelines(
  device: GPUDevice,
  pipelineCache: WebGPURenderPipelineCache | null | undefined,
  resources: SplatPipelineResources,
  cache: GaussianSplatCache,
): boolean {
  if (cache.pipeline && cache.pickPipeline) {
    return true;
  }

  if (pipelineCache) {
    const colorSync = pipelineCache.getPipelineSync(resources.colorDescriptor);
    const pickSync = pipelineCache.getPipelineSync(resources.pickDescriptor);
    const oitSync = resources.oitDescriptor
      ? pipelineCache.getPipelineSync(resources.oitDescriptor)
      : null;
    // NEW-GS-CLASSIFICATION-DEPTH (Batch 176) — resolve the depth-write
    // variant alongside color/pick. Cache miss is non-fatal: the color
    // path still works without it; only the classification-depth swap
    // becomes a no-op until the variant lands.
    const depthWriteSync = pipelineCache.getPipelineSync(
      resources.depthWriteDescriptor,
    );
    if (colorSync && pickSync) {
      cache.pipeline = colorSync;
      cache.pickPipeline = pickSync;
      cache.oitPipeline = oitSync ?? null;
      cache.depthWritePipeline = depthWriteSync ?? null;
      cache.pipelineRequestPending = false;
      return true;
    }
    if (!cache.pipelineRequestPending) {
      cache.pipelineRequestPending = true;
      const work: Promise<unknown>[] = [
        pipelineCache.getPipeline(resources.colorDescriptor).then((p) => {
          cache.pipeline = p;
        }),
        pipelineCache.getPipeline(resources.pickDescriptor).then((p) => {
          cache.pickPipeline = p;
        }),
        pipelineCache
          .getPipeline(resources.depthWriteDescriptor)
          .then((p) => {
            cache.depthWritePipeline = p;
          })
          .catch(() => {
            // Depth-write variant failure is non-fatal — the color path
            // still works without it; classification-depth swap becomes
            // a no-op (matches pre-Batch-176 behavior).
            cache.depthWritePipeline = null;
          }),
      ];
      if (resources.oitDescriptor) {
        work.push(
          pipelineCache
            .getPipeline(resources.oitDescriptor)
            .then((p) => {
              cache.oitPipeline = p;
            })
            .catch(() => {
              // OIT failure is non-fatal — the color pass still works.
              cache.oitPipeline = null;
            }),
        );
      }
      Promise.all(work)
        .then(() => {
          cache.pipelineRequestPending = false;
        })
        .catch(() => {
          cache.pipelineRequestPending = false;
        });
    }
    return false;
  }

  // Fallback: no central cache. Mirror the historical synchronous path.
  cache.pipeline = device.createRenderPipeline(
    descriptorToGPU(resources.colorDescriptor),
  );
  cache.pickPipeline = device.createRenderPipeline(
    descriptorToGPU(resources.pickDescriptor),
  );
  // NEW-GS-CLASSIFICATION-DEPTH (Batch 176).
  cache.depthWritePipeline = device.createRenderPipeline(
    descriptorToGPU(resources.depthWriteDescriptor),
  );
  if (resources.oitDescriptor) {
    try {
      cache.oitPipeline = device.createRenderPipeline(
        descriptorToGPU(resources.oitDescriptor),
      );
    } catch {
      cache.oitPipeline = null;
    }
  }
  return true;
}

function updateWebGPUGaussianSplats(
  primitive: CesiumObjectWithWebGPUCache,
  frameState: CesiumFrameState,
): void {
  const context = frameState.context;
  const device: GPUDevice = context.device;
  const commandList = frameState.commandList;

  if (!primitive.show) {
    return;
  }

  if (!primitive._webgpuCache) {
    primitive._webgpuCache = {
      uniformBuffer: null,
      pipeline: null,
      oitPipeline: null,
      pickPipeline: null,
      // NEW-GS-CLASSIFICATION-DEPTH (Batch 176) — populated alongside
      // the color pipeline by `tryResolveSplatPipelines`.
      depthWritePipeline: null,
      shaderModule: null,
      bindGroup: null,
      quadVertexBuffer: null,
      splatBuffer: null,
      splatCount: 0,
      command: null,
      pickCommand: null,
      initialized: false,
      lastRevision: -1,
      pipelineLayout: null,
      pipelineRequestPending: false,
      // Batch 171 - velocity slots (lazy, allocated when TAA is on).
      splatData: null,
      prevSplatData: null,
      prevSplatBuffer: null,
      velocityPipeline: null,
      velocityPipelineDescriptor: null,
      velocityPipelineRequestPending: false,
    } as GaussianSplatCache;
  }

  const cache = primitive._webgpuCache as GaussianSplatCache;
  // Batch 110 — splats draw into scene FB; use scenePipelineFormat.
  const canvasFormat: GPUTextureFormat =
    (
      context as unknown as {
        scenePipelineFormat?: GPUTextureFormat;
      }
    ).scenePipelineFormat ??
    (navigator.gpu.getPreferredCanvasFormat() as GPUTextureFormat);
  // Batch 110 — invalidate pipeline resources on scene format change.
  const sceneGen =
    (context as unknown as { _scenePipelineFormatGeneration?: number })
      ._scenePipelineFormatGeneration ?? 0;
  if (
    cache.initialized &&
    (cache as unknown as { _pipelineFormatGeneration?: number })
      ._pipelineFormatGeneration !== sceneGen
  ) {
    (
      cache as GaussianSplatCache & {
        _pipelineResources?: SplatPipelineResources;
      }
    )._pipelineResources = undefined;
    // Batch 171 - same pre-existing pattern as Ground{Primitive,Polyline}
    // and PointCloud: cached pipeline objects + draw commands hold
    // pointers to old-format pipelines after the resources reset; the
    // resolver early-returns on the truthy slot check and leaves stale-
    // format pipelines bound. WebGPU then rejects the next draw because
    // the bound pipeline's color target format doesn't match the active
    // attachment. Clear them all so the resolver re-runs against the
    // new format.
    cache.pipeline = null;
    cache.oitPipeline = null;
    cache.pickPipeline = null;
    // NEW-GS-CLASSIFICATION-DEPTH (Batch 176) — Batch 179 follow-up.
    // Audit found this slot was missed in the format-invalidation
    // sweep: stale depth-write pipeline retains the OLD presentation
    // format, and `WebGPUDrawCommand.execute`'s classification swap
    // would fail validation against the active attachment. Clears
    // alongside the other pipelines so the resolver re-runs against
    // the new format.
    cache.depthWritePipeline = null;
    cache.pipelineRequestPending = false;
    cache.command = null;
    cache.pickCommand = null;
    cache.velocityPipeline = null;
    cache.velocityPipelineDescriptor = null;
    cache.velocityPipelineRequestPending = false;
    (
      cache as unknown as { _pipelineFormatGeneration?: number }
    )._pipelineFormatGeneration = sceneGen;
  }

  // C-R7-RENDERER-MIGRATION (Batch 56) — sidecar holds the resources we
  // built once and re-use across frames while the cache materializes
  // pipelines asynchronously.
  let resources = (
    cache as GaussianSplatCache & {
      _pipelineResources?: SplatPipelineResources;
    }
  )._pipelineResources;

  if (!cache.initialized) {
    // C-R9 (Batch 31) — UBO grew 176 → 192 bytes to include pickColor
    // (floats 44-47 at offset 176).
    // AUDIT_2026_05_02 B.9 (Batch 153) — UBO grew 192 → 256 bytes to
    // include prev viewProjection (floats 48-63 at offset 192).
    // Batch 172 — UBO grew 256 → 320 bytes to include the model matrix
    // (floats 64-79 at offset 256). Used by the velocity VS to lift
    // prev model-space positions to world space before applying
    // prevViewProjection. Necessary for correct velocity when
    // `primitive.modelMatrix` is non-identity (typical 3D-Tiles
    // GaussianSplat content has identity, but custom primitives don't).
    cache.uniformBuffer = device.createBuffer({
      size: 320,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    resources = buildSplatPipelineResources(device, canvasFormat);
    (
      cache as GaussianSplatCache & {
        _pipelineResources?: SplatPipelineResources;
      }
    )._pipelineResources = resources;
    cache.shaderModule = resources.shaderModule;
    cache.pipelineLayout = resources.layout;
    cache.bindGroup = device.createBindGroup({
      layout: resources.bgl,
      entries: [{ binding: 0, resource: { buffer: cache.uniformBuffer } }],
    });
    cache.quadVertexBuffer = createQuadVB(device);

    // Create placeholder splat buffer (will be replaced when data loads)
    cache.splatBuffer = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.VERTEX,
    });
    cache.splatCount = 0;
    cache.initialized = true;
  }

  // Resolve the color + OIT + pick pipelines via the central cache.
  // Skip drawing this frame if pipelines aren't ready yet.
  const ctxAny = context as unknown as {
    webgpuPipelineCache?: WebGPURenderPipelineCache | null;
  };
  if (
    !tryResolveSplatPipelines(
      device,
      ctxAny.webgpuPipelineCache ?? null,
      resources!,
      cache,
    )
  ) {
    return;
  }

  // Check if splat data has been uploaded
  const splatData =
    primitive._splatData || primitive._renderResources?.splatBuffer;
  const revision = primitive._splatCount ?? 0;
  if (revision !== cache.lastRevision && splatData) {
    if (cache.splatBuffer) {
      cache.splatBuffer.destroy();
    }
    cache.splatBuffer = device.createBuffer({
      size: splatData.byteLength || 64,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    if (splatData.byteLength > 0) {
      device.queue.writeBuffer(cache.splatBuffer, 0, splatData);
    }
    cache.splatCount = revision;
    cache.lastRevision = revision;
    cache.command = null;
    // Batch 171 - track THIS frame's splat data so the velocity helper
    // can promote it to `prevSplatData` AFTER its dispatch. Reference
    // to the same typed array — the loader owns the storage.
    cache.splatData = splatData;
  }

  if (cache.splatCount === 0) {
    return;
  }

  // Pack uniforms.
  //
  // RTE: zero the translation column of MV *before* multiplying by
  // projection. Zeroing after the multiply wipes out projection's P23
  // depth-mapping term, producing incorrect NDC depth and breaking
  // depth testing at planetary scale.
  const us = context.uniformState;
  const mm = primitive.modelMatrix ?? Matrix4.IDENTITY;
  Matrix4.multiply(us.view, mm, scratchMV);
  scratchMV[12] = 0;
  scratchMV[13] = 0;
  scratchMV[14] = 0;
  Matrix4.multiply(us.projection, scratchMV, scratchMVP);
  const mv = m4Values(scratchMV);
  const mvp = m4Values(scratchMVP);

  const camWorld = us.cameraPosition;
  const invM = Matrix4.inverse(mm, new Matrix4());
  const camM = Matrix4.multiplyByPoint(invM, camWorld, new Cartesian3());
  EncodedCartesian3.fromCartesian(camM, scratchEncoded);

  const data = new Float32Array(40);
  for (let i = 0; i < 16; i++) {
    data[i] = mvp[i];
  }
  for (let i = 0; i < 16; i++) {
    data[16 + i] = mv[i];
  }
  data[32] = scratchEncoded.high.x;
  data[33] = scratchEncoded.high.y;
  data[34] = scratchEncoded.high.z;
  data[35] = 0;
  data[36] = scratchEncoded.low.x;
  data[37] = scratchEncoded.low.y;
  data[38] = scratchEncoded.low.z;
  data[39] = 0;

  // Viewport + focal length derived from the perspective projection matrix.
  // For a standard perspective: P[0][0] = 1/(aspect*tan(fov/2)),
  // P[1][1] = 1/tan(fov/2). Pixel-space focal = P[i][i] * (viewportDim/2).
  const vpData = new Float32Array(4);
  const viewportW =
    context.drawingBufferWidth || context._canvas?.width || 1920;
  const viewportH =
    context.drawingBufferHeight || context._canvas?.height || 1080;
  const proj = m4Values(us.projection);
  vpData[0] = viewportW;
  vpData[1] = viewportH;
  vpData[2] = proj[0] * (viewportW * 0.5); // focal X (pixels)
  vpData[3] = proj[5] * (viewportH * 0.5); // focal Y (pixels)
  device.queue.writeBuffer(cache.uniformBuffer!, 0, data);
  device.queue.writeBuffer(cache.uniformBuffer!, 160, vpData);

  // C-R9 (Batch 31 / refactored Batch 59) — pick ID lifecycle delegated to
  // {@link ensurePickId}. Pick IDs are per-primitive, not per-splat; the
  // whole splat cloud reports the same owner when clicked. UBO write at
  // offset 176 below stays per-renderer because the layout differs from
  // every other pick consumer.
  const passes = frameState.passes;
  const allowAllocate = !!(passes && (passes.pick || passes.render));
  const pickState = primitive as unknown as SinglePickIdCache;
  const pickId = ensurePickId(
    primitive as unknown as import("../GraphicsContext.js").PickTarget,
    context,
    pickState,
    { allowAllocate },
  );
  const pickColor = pickId?.color;
  if (pickColor) {
    const pickData = new Float32Array(4);
    pickData[0] = pickColor.red ?? 0;
    pickData[1] = pickColor.green ?? 0;
    pickData[2] = pickColor.blue ?? 0;
    pickData[3] = pickColor.alpha ?? 0;
    device.queue.writeBuffer(cache.uniformBuffer!, 176, pickData);
  }

  // AUDIT_2026_05_02 B.9 (Batch 153) — DP-H41 prev viewProjection at byte
  // offset 192 (float 48). UniformState swaps `_previousViewProjection`
  // at the END of `update()` AFTER returning the prior frame's value, so
  // on frame N this slot holds frame N-1's VP. First frame falls through
  // to identity.
  const prevVPData = new Float32Array(16);
  const prevVP = (us as { previousViewProjection?: Matrix4 })
    .previousViewProjection;
  if (prevVP) {
    Matrix4.pack(prevVP, prevVPData, 0);
  } else {
    prevVPData[0] = 1;
    prevVPData[5] = 1;
    prevVPData[10] = 1;
    prevVPData[15] = 1;
  }
  device.queue.writeBuffer(cache.uniformBuffer!, 192, prevVPData);

  // Batch 172 — model matrix at byte offset 256 (float 64). Used by the
  // velocity VS to lift prev model-space positions to world space
  // before applying prevViewProjection. CPU passes the primitive's
  // modelMatrix directly (no translation zeroing — the prev path needs
  // the full transform, not the RTE-zeroed one used for currVP).
  const modelMatrixData = new Float32Array(16);
  Matrix4.pack(mm, modelMatrixData, 0);
  device.queue.writeBuffer(cache.uniformBuffer!, 256, modelMatrixData);

  if (!cache.command) {
    const cmd = new WebGPUDrawCommand({
      pipeline: cache.pipeline,
      bindGroups: [cache.bindGroup],
      vertexBuffers: [cache.quadVertexBuffer, cache.splatBuffer],
      vertexCount: 6,
      instanceCount: cache.splatCount,
      pass: Pass.GAUSSIAN_SPLATS,
      owner:
        primitive as unknown as import("./WebGPUDrawCommand.js").WebGPUCommandOwner,
      // NEW-GS-CLASSIFICATION-DEPTH (Batch 176) — depth-write variant
      // for translucent-classification swap. Cesium3DTile.update flips
      // `depthForTranslucentClassification` for splat-pass commands so
      // the dispatcher swaps to this variant (writes depth to the
      // scene-FB) when a classifier needs to clip against the splat
      // surface. Without the variant, splats stay alpha-blended without
      // depth-write and classifiers pass through to whatever lies
      // behind. May be null when the central pipeline cache hasn't
      // resolved the variant yet — the dispatcher tolerates that.
      classificationDepthPipeline: cache.depthWritePipeline ?? undefined,
    });
    // GS-WSR: attach OIT pipeline variant for weighted-sum rendering
    if (cache.oitPipeline) {
      cmd._oitPipeline = cache.oitPipeline;
    }
    // Store shader code for dynamic OIT variant creation via scene renderer
    cmd._shaderCode = SPLAT_WGSL;
    cache.command = cmd;
  } else if (
    cache.depthWritePipeline &&
    !cache.command.classificationDepthPipeline
  ) {
    // NEW-GS-CLASSIFICATION-DEPTH (Batch 176) — central-pipeline-cache
    // resolution races the command construction. If the depth-write
    // variant landed AFTER the command was first built (a frame later
    // than the color pipeline), patch it on so the dispatcher can swap
    // when needed. Cheap reference write; runs at most once per cache.
    cache.command.classificationDepthPipeline = cache.depthWritePipeline;
  }

  // C-R9 (Batch 31) — pick command. Same VS + splat buffer as the color
  // command; different pipeline (pickPipeline) that routes through the
  // `fragmentPickMain` entry point to emit u.pickColor. Wired onto the
  // color command's derivedCommands so the Batch 29 dispatcher routes
  // to it on pick passes.
  if (pickColor) {
    if (!cache.pickCommand) {
      cache.pickCommand = new WebGPUDrawCommand({
        pipeline: cache.pickPipeline!,
        bindGroups: [cache.bindGroup],
        vertexBuffers: [cache.quadVertexBuffer, cache.splatBuffer],
        vertexCount: 6,
        instanceCount: cache.splatCount,
        pass: Pass.GAUSSIAN_SPLATS,
        owner:
          primitive as unknown as import("./WebGPUDrawCommand.js").WebGPUCommandOwner,
        pickOnly: true,
      });
    }
    attachPickToColorCommand(
      cache.command as CesiumAnyDrawCommand,
      cache.pickCommand,
    );
  }

  // Batch 171 - B.10 NEW-ADVANCED-MOTION-VECTORS attach. Maintain a
  // one-frame-lagged prev mirror of the splat buffer.
  attachSplatVelocityCommand(device, context, frameState, cache);

  commandList.push(cache.command);
}

/**
 * Batch 171 - upload prev splat positions, build (or fetch) the
 * velocity pipeline, attach `velocityCommand` to the cache's color
 * command. Mirrors PointCloud Batch 168/169 + Cloud Batch 170.
 *
 * Falls into the GPU self-copy branch on:
 *   1. First frame ever — `prevSplatData` is null. Velocity = 0
 *      (no continuous "previous" exists).
 *   2. Splat-count change across revisions — prev byteLength
 *      mismatches the required size; emit velocity = 0 for the
 *      transition (no continuous index correspondence).
 *
 * @private
 */
function attachSplatVelocityCommand(
  device: GPUDevice,
  context: CesiumGraphicsContext,
  frameState: CesiumFrameState,
  cache: GaussianSplatCache,
): void {
  const taaEnabledThisFrame =
    (frameState as { scene?: { taaEnabled?: boolean } }).scene?.taaEnabled ===
    true;
  if (!taaEnabledThisFrame && !cache.prevSplatBuffer) {
    if (cache.command) {
      (cache.command as { velocityCommand?: unknown }).velocityCommand =
        undefined;
    }
    return;
  }
  if (!cache.splatBuffer || cache.splatCount === 0) {
    return;
  }

  const requiredBytes = cache.splatCount * 64;
  if (!cache.prevSplatBuffer || cache.prevSplatBuffer.size < requiredBytes) {
    if (cache.prevSplatBuffer) {
      cache.prevSplatBuffer.destroy();
    }
    cache.prevSplatBuffer = device.createBuffer({
      label: "GaussianSplat prev splats",
      size: requiredBytes,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  }

  const prevSrc = cache.prevSplatData;
  if (prevSrc && prevSrc.byteLength >= requiredBytes) {
    device.queue.writeBuffer(
      cache.prevSplatBuffer,
      0,
      prevSrc.buffer,
      prevSrc.byteOffset,
      requiredBytes,
    );
  } else {
    const encoder = device.createCommandEncoder({
      label: "GaussianSplat prev seed",
    });
    encoder.copyBufferToBuffer(
      cache.splatBuffer,
      0,
      cache.prevSplatBuffer,
      0,
      requiredBytes,
    );
    device.queue.submit([encoder.finish()]);
  }

  // Lazy velocity pipeline build. Reuses the color BGL since the
  // velocity VS reads from the same uniform buffer.
  if (
    !cache.velocityPipelineDescriptor &&
    cache.shaderModule &&
    cache.pipelineLayout
  ) {
    cache.velocityPipelineDescriptor = {
      name: "GaussianSplat velocity pipeline",
      layout: cache.pipelineLayout,
      vertex: {
        module: cache.shaderModule,
        entryPoint: "vertexVelocityMain",
        buffers: [
          {
            arrayStride: 8,
            stepMode: "vertex" as GPUVertexStepMode,
            attributes: [
              {
                shaderLocation: 0,
                offset: 0,
                format: "float32x2" as GPUVertexFormat,
              },
            ],
          },
          {
            // Curr instance buffer (same 64-byte stride as the color
            // pipeline; velocity VS reads locations 1-5).
            arrayStride: 64,
            stepMode: "instance" as GPUVertexStepMode,
            attributes: [
              {
                shaderLocation: 1,
                offset: 0,
                format: "float32x3" as GPUVertexFormat,
              },
              {
                shaderLocation: 2,
                offset: 12,
                format: "float32x3" as GPUVertexFormat,
              },
              {
                shaderLocation: 3,
                offset: 24,
                format: "float32x3" as GPUVertexFormat,
              },
              {
                shaderLocation: 4,
                offset: 36,
                format: "float32x3" as GPUVertexFormat,
              },
              {
                shaderLocation: 5,
                offset: 48,
                format: "float32x4" as GPUVertexFormat,
              },
            ],
          },
          {
            // Prev splat buffer — same 64-byte stride; only positions
            // (locations 6/7) are read by the velocity VS.
            arrayStride: 64,
            stepMode: "instance" as GPUVertexStepMode,
            attributes: [
              {
                shaderLocation: 6,
                offset: 0,
                format: "float32x3" as GPUVertexFormat,
              },
              {
                shaderLocation: 7,
                offset: 12,
                format: "float32x3" as GPUVertexFormat,
              },
            ],
          },
        ],
      },
      fragment: {
        module: cache.shaderModule,
        entryPoint: "fragmentVelocityMain",
        targets: [{ format: "rg16float" as GPUTextureFormat }],
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: false,
        depthCompare: "less-equal",
      },
    };
  }
  if (
    !cache.velocityPipeline &&
    cache.velocityPipelineDescriptor &&
    !cache.velocityPipelineRequestPending
  ) {
    const ctxAny = context as unknown as {
      webgpuPipelineCache?: WebGPURenderPipelineCache | null;
    };
    const pipelineCache = ctxAny.webgpuPipelineCache ?? null;
    if (pipelineCache) {
      const sync = pipelineCache.getPipelineSync(
        cache.velocityPipelineDescriptor,
      );
      if (sync) {
        cache.velocityPipeline = sync;
      } else {
        cache.velocityPipelineRequestPending = true;
        pipelineCache
          .getPipeline(cache.velocityPipelineDescriptor)
          .then((p) => {
            cache.velocityPipeline = p;
            cache.velocityPipelineRequestPending = false;
          })
          .catch(() => {
            cache.velocityPipelineRequestPending = false;
          });
      }
    } else {
      const desc = cache.velocityPipelineDescriptor;
      cache.velocityPipeline = device.createRenderPipeline({
        label: desc.name,
        layout: desc.layout ?? "auto",
        vertex: {
          module: desc.vertex.module,
          entryPoint: desc.vertex.entryPoint,
          buffers: desc.vertex.buffers,
        },
        fragment: desc.fragment
          ? {
              module: desc.fragment.module,
              entryPoint: desc.fragment.entryPoint,
              targets: desc.fragment.targets,
            }
          : undefined,
        primitive: desc.primitive,
        depthStencil: desc.depthStencil,
      });
    }
  }

  if (
    cache.command &&
    cache.velocityPipeline &&
    cache.prevSplatBuffer &&
    cache.quadVertexBuffer &&
    cache.splatBuffer
  ) {
    (cache.command as { velocityCommand?: unknown }).velocityCommand =
      new WebGPUDrawCommand({
        pipeline: cache.velocityPipeline,
        bindGroups: [cache.bindGroup],
        vertexBuffers: [
          cache.quadVertexBuffer,
          cache.splatBuffer,
          cache.prevSplatBuffer,
        ],
        vertexCount: 6,
        instanceCount: cache.splatCount,
        pass: Pass.GAUSSIAN_SPLATS,
      });
  } else if (cache.command) {
    (cache.command as { velocityCommand?: unknown }).velocityCommand =
      undefined;
  }

  if (cache.splatData) {
    cache.prevSplatData = cache.splatData;
  }
}

function destroyWebGPUGaussianSplatResources(
  primitive: CesiumObjectWithWebGPUCache,
): void {
  const cache = primitive._webgpuCache as GaussianSplatCache | undefined;
  if (!cache) {
    return;
  }
  cache.uniformBuffer?.destroy();
  cache.quadVertexBuffer?.destroy();
  cache.splatBuffer?.destroy();
  // Batch 171 - release the velocity-path GPU buffer.
  cache.prevSplatBuffer?.destroy();

  // C-R9 (Batch 31 / refactored Batch 59) — release pick ID.
  destroyPickIds(primitive as unknown as SinglePickIdCache);

  primitive._webgpuCache = undefined;
}

// Alias for scene file import compatibility
const updateWebGPUGaussianSplatPrimitive = updateWebGPUGaussianSplats;
const destroyWebGPUGaussianSplatPrimitiveResources =
  destroyWebGPUGaussianSplatResources;

export {
  updateWebGPUGaussianSplats,
  updateWebGPUGaussianSplatPrimitive,
  destroyWebGPUGaussianSplatResources,
  destroyWebGPUGaussianSplatPrimitiveResources,
};
export default {
  updateWebGPUGaussianSplats,
  updateWebGPUGaussianSplatPrimitive,
  destroyWebGPUGaussianSplatResources,
  destroyWebGPUGaussianSplatPrimitiveResources,
};
