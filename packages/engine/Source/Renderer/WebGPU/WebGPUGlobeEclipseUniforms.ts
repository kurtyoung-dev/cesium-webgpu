/// <reference types="@webgpu/types" />
/**
 * Dedicated WebGPU globe carrier for the eclipse uniforms.
 *
 * The four vectors are terrain-global for one logical View/frame. Keeping
 * them out of `CameraUniforms` avoids repacking and uploading the same
 * 64-byte payload once per tile/pass. Active payloads use the frame-owned
 * uniform ring and are memoized by the persistent View-owned shadow block;
 * inactive frames reuse one renderer-owned inert buffer without consuming a
 * ring slice.
 *
 * @module WebGPUGlobeEclipseUniforms
 */

import { writeUniformSlice } from "./WebGPUGlobeSurfaceCameraUB.js";

export const ECLIPSE_UNIFORM_FLOATS = 16;
export const ECLIPSE_UNIFORM_BYTES = ECLIPSE_UNIFORM_FLOATS * 4;

type Vec4Like = {
  x: number;
  y: number;
  z: number;
  w: number;
};

export interface EclipseGlobeShadowUniformBlock {
  revision: number;
  sunDirectionAndInvRange: Vec4Like;
  moonDirectionDeltaAndInvRange: Vec4Like;
  params: Vec4Like;
  params2: Vec4Like;
}

export interface EclipseUniformSlice {
  buffer: GPUBuffer;
  offset: number;
  size: number;
}

interface ActiveSliceMemo extends EclipseUniformSlice {
  allocationDomain: object | undefined;
  allocationWindow: number | object;
  revision: number;
}

type AllocationEpochSource = object & {
  allocationEpoch?: number;
};

type EclipseUniformContext = object & {
  uniformAllocator?: AllocationEpochSource | null;
  currentCommandEncoder?: GPUCommandEncoder | null;
  _currentCommandEncoder?: GPUCommandEncoder | null;
};

// Inert contract: body vectors zero, gate closed, composition reciprocal at
// the multiplicative identity. params2.x retains EclipseState's 5e-5
// radiometric floor and params2.y its default exposure exponent even though
// the closed gate never reads either value. Exported for focused
// layout/packing tests.
export const ECLIPSE_INERT_UNIFORM_DATA = new Float32Array([
  0.0,
  0.0,
  0.0,
  0.0,
  0.0,
  0.0,
  0.0,
  0.0,
  0.0,
  1.0,
  0.0,
  0.0,
  5.0e-5,
  1.0 / 3.0,
  0.0,
  0.0,
]);

function isFiniteVec4(value: unknown): value is Vec4Like {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const vector = value as Partial<Vec4Like>;
  return (
    typeof vector.x === "number" &&
    Number.isFinite(vector.x) &&
    typeof vector.y === "number" &&
    Number.isFinite(vector.y) &&
    typeof vector.z === "number" &&
    Number.isFinite(vector.z) &&
    typeof vector.w === "number" &&
    Number.isFinite(vector.w)
  );
}

export function isActiveEclipseUniformBlock(
  value: unknown,
): value is EclipseGlobeShadowUniformBlock {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const block = value as Partial<EclipseGlobeShadowUniformBlock>;
  const gate = block.params?.x;
  const correctionOnly = typeof gate === "number" && gate > 2.5;
  return (
    typeof block.revision === "number" &&
    Number.isFinite(block.revision) &&
    isFiniteVec4(block.sunDirectionAndInvRange) &&
    isFiniteVec4(block.moonDirectionDeltaAndInvRange) &&
    isFiniteVec4(block.params) &&
    typeof gate === "number" &&
    Number.isFinite(gate) &&
    gate > 0.5 &&
    (correctionOnly ||
      (block.sunDirectionAndInvRange.w > 0.0 &&
        block.moonDirectionDeltaAndInvRange.w > 0.0)) &&
    isFiniteVec4(block.params2)
  );
}

function writeVec4(data: Float32Array, offset: number, value: Vec4Like): void {
  data[offset] = value.x;
  data[offset + 1] = value.y;
  data[offset + 2] = value.z;
  data[offset + 3] = value.w;
}

/**
 * Pack the exact 4×vec4 WGSL payload. The function is intentionally pure so
 * specs can pin field order without constructing a GPU device.
 */
export function packEclipseUniforms(
  block: EclipseGlobeShadowUniformBlock,
  result: Float32Array = new Float32Array(ECLIPSE_UNIFORM_FLOATS),
): Float32Array {
  if (result.length < ECLIPSE_UNIFORM_FLOATS) {
    throw new RangeError(
      `Eclipse uniform destination needs ${ECLIPSE_UNIFORM_FLOATS} floats.`,
    );
  }
  writeVec4(result, 0, block.sunDirectionAndInvRange);
  writeVec4(result, 4, block.moonDirectionDeltaAndInvRange);
  writeVec4(result, 8, block.params);
  writeVec4(result, 12, block.params2);
  return result;
}

/**
 * Renderer-owned lifetime manager for the dedicated group-0/binding-2 UBO.
 */
export class WebGPUGlobeEclipseUniforms {
  private _inertBuffer: GPUBuffer | null = null;
  private _inertSlice: EclipseUniformSlice | null = null;
  private _scratch = new Float32Array(ECLIPSE_UNIFORM_FLOATS);
  private _activeSlices = new WeakMap<object, ActiveSliceMemo>();

  initialize(device: GPUDevice): void {
    if (this._inertBuffer !== null) {
      return;
    }
    const buffer = device.createBuffer({
      label: "Globe eclipse inert UB",
      size: ECLIPSE_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, ECLIPSE_INERT_UNIFORM_DATA);
    this._inertBuffer = buffer;
    this._inertSlice = {
      buffer,
      offset: 0,
      size: ECLIPSE_UNIFORM_BYTES,
    };
  }

  prepare(
    device: GPUDevice,
    frameState: CesiumFrameState,
  ): EclipseUniformSlice {
    if (this._inertSlice === null) {
      this.initialize(device);
    }

    const block = (
      frameState as CesiumFrameState & {
        eclipseGlobeShadow?: unknown;
      }
    ).eclipseGlobeShadow;
    // Hot-path first gate: ordinary frames inspect one scalar and return the
    // stable inert slice. Do not validate all 16 fields or touch the WeakMap
    // until the CPU explicitly opens S5.
    const gate =
      typeof block === "object" && block !== null
        ? (block as { params?: { x?: unknown } }).params?.x
        : undefined;
    if (typeof gate !== "number" || gate <= 0.5) {
      return this._inertSlice!;
    }

    const context = frameState.context as EclipseUniformContext | undefined;
    const allocator = context?.uniformAllocator ?? undefined;
    // WebGPU pick mini-frames advance/recycle the uniform ring independently
    // of Cesium's logical frameNumber. A memo keyed only on frameNumber can
    // therefore point at bytes overwritten by camera/tile allocations after
    // a page wrap. Production allocators expose a monotonic epoch for every
    // allocation window. Lightweight integrations without that API may use
    // the current command encoder's identity as a safe window boundary.
    // There is deliberately no frameNumber fallback: standalone pick
    // mini-frames can recycle ring bytes without advancing that counter.
    const commandEncoder =
      context?.currentCommandEncoder ?? context?._currentCommandEncoder;
    const allocationWindow =
      typeof allocator?.allocationEpoch === "number"
        ? allocator.allocationEpoch
        : commandEncoder;
    const allocationDomain = allocator ?? context;
    const revision = (block as { revision?: unknown }).revision;
    const memo = this._activeSlices.get(block);
    if (
      memo !== undefined &&
      allocationWindow !== undefined &&
      allocationWindow !== null &&
      memo.allocationDomain === allocationDomain &&
      memo.allocationWindow === allocationWindow &&
      memo.revision === revision
    ) {
      return memo;
    }

    // Full validation runs once on an active cache miss, never per tile/pass.
    if (!isActiveEclipseUniformBlock(block)) {
      return this._inertSlice!;
    }

    const activeRevision = block.revision;
    packEclipseUniforms(block, this._scratch);
    const allocation = writeUniformSlice(
      device,
      frameState,
      this._scratch,
      ECLIPSE_UNIFORM_BYTES,
      "Globe eclipse UB",
    );
    const nextMemo: ActiveSliceMemo = {
      ...allocation,
      allocationDomain,
      // Without an allocator epoch or command encoder, use a fresh object so
      // the next call cannot reuse a slice whose lifetime is unknowable.
      allocationWindow: allocationWindow ?? {},
      revision: activeRevision,
    };
    this._activeSlices.set(block, nextMemo);
    return nextMemo;
  }

  destroy(): void {
    this._inertBuffer?.destroy();
    this._inertBuffer = null;
    this._inertSlice = null;
    // WeakMap has no clear(); replacing it releases every memoized allocation
    // descriptor without retaining View-owned shadow blocks.
    this._activeSlices = new WeakMap<object, ActiveSliceMemo>();
  }
}

export default WebGPUGlobeEclipseUniforms;
