/**
 * @module WebGLStubBuffer
 *
 * WebGL buffer and vertex attribute method stubs for the WebGPU
 * compatibility layer. Maps buffer creation, binding, and data upload
 * to WebGPU buffer operations. Vertex attribute methods are no-ops
 * since WebGPU handles them via pipeline vertex state descriptors.
 *
 * @see WebGLCompatibilityStub (nexus)
 */

/// <reference types="@webgpu/types" />

import type { WebGLStubState, LogUsageFn } from "./WebGLStubTypes.js";

/** Opaque handle returned by `gl.createBuffer()` in the stub layer. */
interface StubBufferHandle {
  _webgpuBuffer?: GPUBuffer;
  _size?: number;
  destroy?: () => void;
}

// WebGL buffer target constants
const GL_ARRAY_BUFFER = 0x8892;
const GL_ELEMENT_ARRAY_BUFFER = 0x8893;

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
 * @param _logUsage - Debug logging function (unused — buffer ops are silent)
 * @returns Object containing all buffer/vertex-attribute stub methods
 */
export function createBufferStubs(
  state: WebGLStubState,
  _logUsage: LogUsageFn,
): Record<string, unknown> {
  return {
    // ==== Buffer methods ====

    createBuffer: () => {
      if (!state.device) return {};
      const defaultSize = 4096;
      const buffer = state.device.createBuffer({
        size: defaultSize,
        usage:
          GPUBufferUsage.VERTEX |
          GPUBufferUsage.INDEX |
          GPUBufferUsage.COPY_DST,
        label: "GL Compatibility Buffer",
      });
      return {
        _webgpuBuffer: buffer,
        _size: defaultSize,
        destroy: () => buffer.destroy(),
      };
    },

    bindBuffer: (target: number, buffer: StubBufferHandle | null) => {
      if (target === GL_ARRAY_BUFFER) {
        state.boundVertexBuffer = buffer?._webgpuBuffer || null;
      } else if (target === GL_ELEMENT_ARRAY_BUFFER) {
        state.boundIndexBuffer = buffer?._webgpuBuffer || null;
      }
    },

    deleteBuffer: (buffer: StubBufferHandle | null) => {
      if (buffer?._webgpuBuffer) {
        buffer._webgpuBuffer.destroy();
      } else if (buffer?.destroy) {
        buffer.destroy();
      }
    },

    bufferData: (
      target: number,
      data: ArrayBuffer | ArrayBufferView | number,
      _usage: number,
    ) => {
      const boundBuffer =
        target === GL_ARRAY_BUFFER
          ? state.boundVertexBuffer
          : state.boundIndexBuffer;
      if (!boundBuffer) return;
      if (typeof data === "number") return;
      const arrayBuffer =
        data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer;
      const byteOffset =
        data instanceof ArrayBuffer ? 0 : (data as ArrayBufferView).byteOffset;
      const byteLength =
        data instanceof ArrayBuffer
          ? data.byteLength
          : (data as ArrayBufferView).byteLength;
      if (!state.device) return;
      if (byteLength === 0) return;
      const alignedLength = Math.ceil(byteLength / 4) * 4;

      // Regrow buffer if incoming data exceeds current capacity
      // (applies to both padded and non-padded branches)
      let targetBuffer = boundBuffer;
      if (alignedLength > boundBuffer.size) {
        const newSize = Math.max(alignedLength, 4);
        const newBuffer = state.device.createBuffer({
          size: newSize,
          usage: boundBuffer.usage,
          label: boundBuffer.label || "GL Compatibility Buffer (regrown)",
        });
        boundBuffer.destroy();
        if (target === GL_ARRAY_BUFFER) {
          state.boundVertexBuffer = newBuffer;
        } else {
          state.boundIndexBuffer = newBuffer;
        }
        targetBuffer = newBuffer;
      }

      if (alignedLength !== byteLength) {
        const paddedArray = new Uint8Array(alignedLength);
        paddedArray.set(new Uint8Array(arrayBuffer, byteOffset, byteLength));
        state.device.queue.writeBuffer(
          targetBuffer,
          0,
          paddedArray.buffer,
          0,
          alignedLength,
        );
      } else {
        state.device.queue.writeBuffer(
          targetBuffer,
          0,
          arrayBuffer,
          byteOffset,
          byteLength,
        );
      }
    },

    bufferSubData: (
      target: number,
      offset: number,
      data: ArrayBuffer | ArrayBufferView,
    ) => {
      const boundBuffer =
        target === GL_ARRAY_BUFFER
          ? state.boundVertexBuffer
          : state.boundIndexBuffer;
      if (!boundBuffer || !state.device) return;
      const arrayBuffer =
        data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer;
      const byteOffset =
        data instanceof ArrayBuffer ? 0 : (data as ArrayBufferView).byteOffset;
      const byteLength =
        data instanceof ArrayBuffer
          ? data.byteLength
          : (data as ArrayBufferView).byteLength;
      state.device.queue.writeBuffer(
        boundBuffer,
        offset,
        arrayBuffer,
        byteOffset,
        byteLength,
      );
    },

    // ==== Vertex attribute methods (no-ops — handled by pipeline vertex state) ====
    enableVertexAttribArray: () => {},
    disableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    vertexAttribDivisor: () => {},
  };
}
