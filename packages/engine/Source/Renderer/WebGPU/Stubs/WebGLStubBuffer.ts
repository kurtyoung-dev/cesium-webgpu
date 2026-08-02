/**
 * WebGL buffer and vertex attribute method stubs for the WebGPU
 * compatibility layer. Maps buffer creation, binding, and data upload
 * to WebGPU buffer operations. Vertex attribute methods are no-ops
 * since WebGPU handles them via pipeline vertex state descriptors.
 *
 * @see WebGLCompatibilityStub (nexus)
 * @module WebGLStubBuffer
 */

/// <reference types="@webgpu/types" />

import type {
  StubBufferDiagnostics,
  StubBufferHandle,
  StubBufferRegistry,
  WebGLStubState,
  LogUsageFn,
} from "./WebGLStubTypes.js";

// WebGL buffer target constants
const GL_ARRAY_BUFFER = 0x8892;
const GL_ELEMENT_ARRAY_BUFFER = 0x8893;
function alignToFour(size: number): number {
  return Math.ceil(size / 4) * 4;
}

function getBufferUsage(): GPUBufferUsageFlags {
  return GPUBufferUsage.VERTEX | GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST;
}

function getBoundHandle(
  state: WebGLStubState,
  target: number,
): StubBufferHandle | null {
  if (target === GL_ARRAY_BUFFER) {
    return state.boundVertexBuffer;
  }
  if (target === GL_ELEMENT_ARRAY_BUFFER) {
    return state.boundIndexBuffer;
  }
  return null;
}

function releaseCurrentBuffer(
  handle: StubBufferHandle,
  resetLogicalSize: boolean,
): void {
  const buffer = handle._webgpuBuffer;
  handle._webgpuBuffer = null;
  handle._device = null;
  if (resetLogicalSize) {
    handle._size = 0;
  }
  buffer?.destroy();
}

function createReplacementBuffer(
  handle: StubBufferHandle,
  device: GPUDevice,
  size: number,
): GPUBuffer {
  return device.createBuffer({
    size,
    usage: getBufferUsage(),
    label: handle._webgpuBuffer?.label ?? "GL Compatibility Buffer",
  });
}

function commitReplacementBuffer(
  handle: StubBufferHandle,
  device: GPUDevice,
  candidate: GPUBuffer,
  logicalSize: number,
): void {
  const oldBuffer = handle._webgpuBuffer;

  handle._webgpuBuffer = candidate;
  handle._device = device;
  handle._size = logicalSize;
  if (oldBuffer && oldBuffer !== candidate) {
    try {
      oldBuffer.destroy();
    } catch {
      // Publication is the commit point. A lost/native implementation may
      // report an error while releasing the superseded allocation, but the
      // uploaded replacement already owns the handle's authoritative tuple.
    }
  }
}

/**
 * Context-local ownership for all WebGL compatibility buffer handles.
 *
 * The registry deliberately owns handles rather than keying by GPUDevice:
 * multiple contexts can retain the same pooled device, but destroying either
 * context must release only that context's native allocations.
 */
export class WebGLStubBufferRegistry implements StubBufferRegistry {
  private readonly _handles = new Set<StubBufferHandle>();

  register(handle: StubBufferHandle): void {
    this._handles.add(handle);
  }

  unregister(handle: StubBufferHandle): void {
    this._handles.delete(handle);
  }

  invalidateDeviceGeneration(): void {
    let firstDestroyError: unknown;
    let hasDestroyError = false;
    for (const handle of this._handles) {
      // Keep the logical store size and stable handle identity. A subsequent
      // bufferData/bufferSubData call can realize it on the recovered device.
      try {
        releaseCurrentBuffer(handle, false);
      } catch (error) {
        if (!hasDestroyError) {
          firstDestroyError = error;
          hasDestroyError = true;
        }
      }
    }
    if (hasDestroyError) {
      throw firstDestroyError;
    }
  }

  destroy(): void {
    const handles = Array.from(this._handles);
    this._handles.clear();
    let firstDestroyError: unknown;
    let hasDestroyError = false;
    for (const handle of handles) {
      handle._destroyed = true;
      try {
        releaseCurrentBuffer(handle, true);
      } catch (error) {
        if (!hasDestroyError) {
          firstDestroyError = error;
          hasDestroyError = true;
        }
      }
    }
    if (hasDestroyError) {
      throw firstDestroyError;
    }
  }

  getDiagnostics(): StubBufferDiagnostics {
    let logicalStoreCount = 0;
    let logicalStoreBytes = 0;
    let liveBufferCount = 0;
    let liveBufferBytes = 0;
    for (const handle of this._handles) {
      if (handle._size > 0) {
        logicalStoreCount++;
        logicalStoreBytes += handle._size;
      }
      const buffer = handle._webgpuBuffer;
      if (buffer) {
        liveBufferCount++;
        liveBufferBytes += buffer.size;
      }
    }

    return Object.freeze({
      registeredHandleCount: this._handles.size,
      logicalStoreCount,
      logicalStoreBytes,
      liveBufferCount,
      liveBufferBytes,
    });
  }
}

/**
 * WebGL buffer-related constants.
 */
export const BUFFER_CONSTANTS = Object.freeze({
  ARRAY_BUFFER: GL_ARRAY_BUFFER,
  ELEMENT_ARRAY_BUFFER: GL_ELEMENT_ARRAY_BUFFER,
  STATIC_DRAW: 0x88e4,
  DYNAMIC_DRAW: 0x88e8,
  STREAM_DRAW: 0x88e0,
});

/**
 * Creates buffer and vertex attribute stub methods.
 *
 * @param state - Shared mutable state from WebGPUContext
 * @param logUsage - Debug logging function for unsupported buffer operations
 * @returns Object containing all buffer/vertex-attribute stub methods
 */
export function createBufferStubs(state: WebGLStubState, logUsage: LogUsageFn) {
  return {
    // ==== Buffer methods ====

    createBuffer: (): StubBufferHandle => {
      const handle: StubBufferHandle = {
        _webgpuBuffer: null,
        _size: 0,
        _device: null,
        _destroyed: false,
        destroy() {
          if (handle._destroyed) return;
          handle._destroyed = true;
          state.bufferRegistry.unregister(handle);
          releaseCurrentBuffer(handle, true);
        },
      };
      state.bufferRegistry.register(handle);
      return handle;
    },

    bindBuffer: (target: number, buffer: StubBufferHandle | null) => {
      if (target === GL_ARRAY_BUFFER) {
        state.boundVertexBuffer = buffer?._destroyed ? null : buffer;
      } else if (target === GL_ELEMENT_ARRAY_BUFFER) {
        state.boundIndexBuffer = buffer?._destroyed ? null : buffer;
      }
    },

    deleteBuffer: (buffer: StubBufferHandle | null) => {
      if (!buffer) return;
      if (state.boundVertexBuffer === buffer) {
        state.boundVertexBuffer = null;
      }
      if (state.boundIndexBuffer === buffer) {
        state.boundIndexBuffer = null;
      }
      buffer.destroy();
    },

    bufferData: (
      target: number,
      data: ArrayBuffer | ArrayBufferView | number,
      _usage: number,
    ) => {
      const handle = getBoundHandle(state, target);
      if (!handle || handle._destroyed) return;

      const byteLength = typeof data === "number" ? data : data.byteLength;
      if (!Number.isSafeInteger(byteLength) || byteLength < 0) return;
      if (byteLength === 0) {
        releaseCurrentBuffer(handle, true);
        return;
      }

      const alignedLength = alignToFour(byteLength);
      if (!Number.isSafeInteger(alignedLength)) return;

      if (state.allocateCompatibilityBuffers === false) {
        // The native feature renderers retain the authoritative CPU payload
        // and perform their own format-specific upload. Keeping a second copy
        // here would add both an unused GPUBuffer and an unused queue write.
        // Record only the WebGL store size needed by legacy Buffer/VA metadata;
        // deliberately do not retain the payload on the compatibility handle.
        releaseCurrentBuffer(handle, false);
        handle._size = byteLength;
        return;
      }

      if (!state.device) return;

      const needsReplacement =
        !handle._webgpuBuffer ||
        handle._device !== state.device ||
        alignedLength > handle._webgpuBuffer.size;
      const arrayBuffer =
        typeof data === "number"
          ? null
          : data instanceof ArrayBuffer
            ? data
            : (data as ArrayBufferView).buffer;
      const byteOffset =
        typeof data === "number" || data instanceof ArrayBuffer
          ? 0
          : (data as ArrayBufferView).byteOffset;
      let uploadData: ArrayBufferLike | null = arrayBuffer;
      let uploadSize = byteLength;
      if (arrayBuffer && alignedLength !== byteLength) {
        const paddedArray = new Uint8Array(alignedLength);
        paddedArray.set(new Uint8Array(arrayBuffer, byteOffset, byteLength));
        uploadData = paddedArray.buffer;
        uploadSize = alignedLength;
      }

      if (needsReplacement) {
        const candidate = createReplacementBuffer(
          handle,
          state.device,
          alignedLength,
        );
        try {
          if (uploadData) {
            state.device.queue.writeBuffer(
              candidate,
              0,
              uploadData,
              uploadData === arrayBuffer ? byteOffset : 0,
              uploadSize,
            );
          }
        } catch (error) {
          try {
            candidate.destroy();
          } catch {
            // Preserve the upload failure. The candidate was never published.
          }
          throw error;
        }
        commitReplacementBuffer(handle, state.device, candidate, byteLength);
        return;
      }

      if (uploadData) {
        state.device.queue.writeBuffer(
          handle._webgpuBuffer,
          0,
          uploadData,
          uploadData === arrayBuffer ? byteOffset : 0,
          uploadSize,
        );
      }
      // Commit the logical WebGL store size only after a synchronous upload
      // has succeeded. A validation/device-loss throw leaves it unchanged.
      handle._size = byteLength;
    },

    bufferSubData: (
      target: number,
      offset: number,
      data: ArrayBuffer | ArrayBufferView,
    ) => {
      const handle = getBoundHandle(state, target);
      if (!handle || handle._destroyed) return;
      const arrayBuffer =
        data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer;
      const byteOffset =
        data instanceof ArrayBuffer ? 0 : (data as ArrayBufferView).byteOffset;
      const byteLength =
        data instanceof ArrayBuffer
          ? data.byteLength
          : (data as ArrayBufferView).byteLength;
      if (
        offset < 0 ||
        offset % 4 !== 0 ||
        byteLength % 4 !== 0 ||
        byteLength === 0 ||
        offset + byteLength > handle._size
      ) {
        logUsage(
          "bufferSubData",
          "write must be 4-byte aligned and remain within the buffer store",
        );
        return;
      }

      // Metadata-only stores intentionally have no CPU shadow copy. The
      // owning native renderer updates its own resource from its authoritative
      // data, so compatibility sub-writes have nothing to realize or upload.
      if (state.allocateCompatibilityBuffers === false) return;
      if (!state.device) return;

      const needsReplacement =
        !handle._webgpuBuffer || handle._device !== state.device;
      if (needsReplacement) {
        const candidate = createReplacementBuffer(
          handle,
          state.device,
          alignToFour(handle._size),
        );
        try {
          state.device.queue.writeBuffer(
            candidate,
            offset,
            arrayBuffer,
            byteOffset,
            byteLength,
          );
        } catch (error) {
          try {
            candidate.destroy();
          } catch {
            // Preserve the upload failure. The candidate was never published.
          }
          throw error;
        }
        commitReplacementBuffer(handle, state.device, candidate, handle._size);
        return;
      }

      state.device.queue.writeBuffer(
        handle._webgpuBuffer,
        offset,
        arrayBuffer,
        byteOffset,
        byteLength,
      );
    },

    /** Release native allocations while preserving recoverable handles. */
    invalidateCompatibilityBufferHandles: () => {
      state.bufferRegistry.invalidateDeviceGeneration();
    },

    /** Final context teardown: destroy resources and unregister all handles. */
    destroyCompatibilityBufferHandles: () => {
      state.boundVertexBuffer = null;
      state.boundIndexBuffer = null;
      state.bufferRegistry.destroy();
    },

    /** Allocation telemetry used by the fork's browser performance probes. */
    getCompatibilityBufferDiagnostics: (): StubBufferDiagnostics =>
      state.bufferRegistry.getDiagnostics(),

    // ==== Vertex attribute methods (no-ops — handled by pipeline vertex state) ====
    enableVertexAttribArray: () => {},
    disableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    vertexAttribDivisor: () => {},
  };
}
