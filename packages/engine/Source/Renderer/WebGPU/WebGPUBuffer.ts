/**
 * @module WebGPUBuffer
 *
 * WebGPU buffer implementation for vertex, index, uniform, and storage buffers.
 * Provides efficient GPU memory management and data transfer.
 *
 * @example
 * const vertexBuffer = WebGPUBuffer.createVertexBuffer(device, vertexData);
 * const indexBuffer = WebGPUBuffer.createIndexBuffer(device, indexData);
 * const uniformBuffer = WebGPUBuffer.createUniformBuffer(device, uniformData);
 */

/// <reference types="@webgpu/types" />

import DeveloperError from "../../Core/DeveloperError.js";
import defined from "../../Core/defined.js";

/**
 * Buffer usage types
 */
export enum WebGPUBufferUsage {
  VERTEX = "vertex",
  INDEX = "index",
  UNIFORM = "uniform",
  STORAGE = "storage",
  COPY_SRC = "copy_src",
  COPY_DST = "copy_dst",
}

/**
 * Options for creating a WebGPU buffer
 */
export interface WebGPUBufferOptions {
  /**
   * The GPU device
   */
  device: GPUDevice;

  /**
   * Size in bytes
   */
  size: number;

  /**
   * Buffer usage flags
   */
  usage: GPUBufferUsageFlags;

  /**
   * Whether buffer can be mapped for reading
   */
  mappedAtCreation?: boolean;

  /**
   * Initial data (optional)
   */
  data?: ArrayBuffer | ArrayBufferView;

  /**
   * Label for debugging
   */
  label?: string;
}

/**
 * WebGPU buffer wrapper providing convenient buffer management.
 */
export class WebGPUBuffer {
  private _device: GPUDevice;
  private _buffer: GPUBuffer;
  private _size: number;
  private _usage: GPUBufferUsageFlags;
  private _isDestroyed: boolean = false;
  private _label: string;

  /**
   * Private constructor. Use static factory methods instead.
   *
   * @private
   */
  private constructor(
    device: GPUDevice,
    buffer: GPUBuffer,
    size: number,
    usage: GPUBufferUsageFlags,
    label: string = "WebGPUBuffer",
  ) {
    this._device = device;
    this._buffer = buffer;
    this._size = size;
    this._usage = usage;
    this._label = label;
  }

  /**
   * Creates a new WebGPU buffer.
   *
   * @param {WebGPUBufferOptions} options - Buffer creation options
   * @returns {WebGPUBuffer} The created buffer
   *
   * @example
   * const buffer = WebGPUBuffer.create({
   *   device: device,
   *   size: 1024,
   *   usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
   * });
   */
  static create(options: WebGPUBufferOptions): WebGPUBuffer {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(options.device)) {
      throw new DeveloperError("options.device is required.");
    }
    if (!defined(options.size) || options.size <= 0) {
      throw new DeveloperError("options.size must be greater than 0.");
    }
    //>>includeEnd('debug');

    // If data is provided, calculate aligned size to ensure buffer is large enough
    let bufferSize = options.size;
    if (defined(options.data)) {
      const dataSize =
        options.data instanceof ArrayBuffer
          ? options.data.byteLength
          : options.data.byteLength;
      // WebGPU requires writeBuffer data size to be a multiple of 4 bytes
      const alignedSize = Math.ceil(dataSize / 4) * 4;
      // Use the larger of the requested size or aligned data size
      bufferSize = Math.max(bufferSize, alignedSize);
    }

    const buffer = options.device.createBuffer({
      size: bufferSize,
      usage: options.usage,
      mappedAtCreation: options.mappedAtCreation ?? false,
      label: options.label,
    });

    // Write initial data if provided
    if (defined(options.data) && !options.mappedAtCreation) {
      let data: Uint8Array;

      if (options.data instanceof ArrayBuffer) {
        data = new Uint8Array(options.data);
      } else {
        data = new Uint8Array(
          options.data.buffer,
          options.data.byteOffset,
          options.data.byteLength,
        );
      }

      // Pad with zeros if necessary for 4-byte alignment
      const dataSize = data.byteLength;
      const alignedSize = Math.ceil(dataSize / 4) * 4;

      if (dataSize !== alignedSize) {
        const paddedData = new Uint8Array(alignedSize);
        paddedData.set(data);
        options.device.queue.writeBuffer(buffer, 0, paddedData as any);
      } else {
        options.device.queue.writeBuffer(buffer, 0, data as any);
      }
    }

    return new WebGPUBuffer(
      options.device,
      buffer,
      bufferSize,
      options.usage,
      options.label ?? "WebGPUBuffer",
    );
  }

  /**
   * Creates a vertex buffer.
   *
   * @param {GPUDevice} device - The GPU device
   * @param {ArrayBuffer | ArrayBufferView} data - Vertex data
   * @param {string} [label] - Optional label for debugging
   * @returns {WebGPUBuffer} The vertex buffer
   *
   * @example
   * const vertices = new Float32Array([...]);
   * const buffer = WebGPUBuffer.createVertexBuffer(device, vertices);
   */
  static createVertexBuffer(
    device: GPUDevice,
    data: ArrayBuffer | ArrayBufferView,
    label?: string,
  ): WebGPUBuffer {
    const size =
      data instanceof ArrayBuffer ? data.byteLength : data.byteLength;

    return WebGPUBuffer.create({
      device,
      size,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      data,
      label: label ?? "VertexBuffer",
    });
  }

  /**
   * Creates an index buffer.
   *
   * @param {GPUDevice} device - The GPU device
   * @param {ArrayBuffer | ArrayBufferView} data - Index data
   * @param {string} [label] - Optional label for debugging
   * @returns {WebGPUBuffer} The index buffer
   *
   * @example
   * const indices = new Uint16Array([...]);
   * const buffer = WebGPUBuffer.createIndexBuffer(device, indices);
   */
  static createIndexBuffer(
    device: GPUDevice,
    data: ArrayBuffer | ArrayBufferView,
    label?: string,
  ): WebGPUBuffer {
    const size =
      data instanceof ArrayBuffer ? data.byteLength : data.byteLength;

    return WebGPUBuffer.create({
      device,
      size,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      data,
      label: label ?? "IndexBuffer",
    });
  }

  /**
   * Creates a uniform buffer.
   *
   * @param {GPUDevice} device - The GPU device
   * @param {number} size - Size in bytes (must be multiple of 256)
   * @param {ArrayBuffer | ArrayBufferView} [data] - Initial uniform data
   * @param {string} [label] - Optional label for debugging
   * @returns {WebGPUBuffer} The uniform buffer
   *
   * @example
   * const uniformData = new Float32Array([...]);
   * const buffer = WebGPUBuffer.createUniformBuffer(device, 256, uniformData);
   */
  static createUniformBuffer(
    device: GPUDevice,
    size: number,
    data?: ArrayBuffer | ArrayBufferView,
    label?: string,
  ): WebGPUBuffer {
    // Align size to 256 bytes (uniform buffer alignment requirement)
    const alignedSize = Math.ceil(size / 256) * 256;

    return WebGPUBuffer.create({
      device,
      size: alignedSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      data,
      label: label ?? "UniformBuffer",
    });
  }

  /**
   * Creates a storage buffer.
   *
   * @param {GPUDevice} device - The GPU device
   * @param {number} size - Size in bytes
   * @param {ArrayBuffer | ArrayBufferView} [data] - Initial storage data
   * @param {boolean} [readable] - Whether buffer is readable from shaders
   * @param {string} [label] - Optional label for debugging
   * @returns {WebGPUBuffer} The storage buffer
   *
   * @example
   * const storageData = new Float32Array([...]);
   * const buffer = WebGPUBuffer.createStorageBuffer(device, 1024, storageData);
   */
  static createStorageBuffer(
    device: GPUDevice,
    size: number,
    data?: ArrayBuffer | ArrayBufferView,
    readable: boolean = true,
    label?: string,
  ): WebGPUBuffer {
    let usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    if (readable) {
      usage |= GPUBufferUsage.COPY_SRC;
    }

    return WebGPUBuffer.create({
      device,
      size,
      usage,
      data,
      label: label ?? "StorageBuffer",
    });
  }

  /**
   * Gets the underlying GPUBuffer.
   */
  get buffer(): GPUBuffer {
    return this._buffer;
  }

  /**
   * Gets the buffer size in bytes.
   */
  get size(): number {
    return this._size;
  }

  /**
   * Gets the buffer usage flags.
   */
  get usage(): GPUBufferUsageFlags {
    return this._usage;
  }

  /**
   * Gets the buffer label.
   */
  get label(): string {
    return this._label;
  }

  /**
   * Whether the buffer has been destroyed.
   */
  get isDestroyed(): boolean {
    return this._isDestroyed;
  }

  /**
   * Writes data to the buffer.
   *
   * @param {ArrayBuffer | ArrayBufferView} data - Data to write
   * @param {number} [offset=0] - Offset in bytes
   *
   * @example
   * buffer.write(new Float32Array([1, 2, 3, 4]));
   * buffer.write(data, 256); // Write at offset 256
   */
  write(data: ArrayBuffer | ArrayBufferView, offset: number = 0): void {
    //>>includeStart('debug', pragmas.debug);
    if (this._isDestroyed) {
      throw new DeveloperError("Buffer has been destroyed.");
    }
    //>>includeEnd('debug');

    const arrayData =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

    this._device.queue.writeBuffer(this._buffer, offset, arrayData as any);
  }

  /**
   * Copies data from another buffer.
   *
   * @param {GPUCommandEncoder} encoder - Command encoder for the copy
   * @param {WebGPUBuffer} source - Source buffer
   * @param {number} [sourceOffset=0] - Source offset in bytes
   * @param {number} [destinationOffset=0] - Destination offset in bytes
   * @param {number} [size] - Size to copy (defaults to source size)
   */
  copyFrom(
    encoder: GPUCommandEncoder,
    source: WebGPUBuffer,
    sourceOffset: number = 0,
    destinationOffset: number = 0,
    size?: number,
  ): void {
    //>>includeStart('debug', pragmas.debug);
    if (this._isDestroyed) {
      throw new DeveloperError("Buffer has been destroyed.");
    }
    if (source.isDestroyed) {
      throw new DeveloperError("Source buffer has been destroyed.");
    }
    //>>includeEnd('debug');

    const copySize = size ?? source.size;
    encoder.copyBufferToBuffer(
      source.buffer,
      sourceOffset,
      this._buffer,
      destinationOffset,
      copySize,
    );
  }

  /**
   * Destroys the buffer and frees GPU resources.
   */
  destroy(): void {
    if (this._isDestroyed) {
      return;
    }

    this._buffer.destroy();
    this._isDestroyed = true;
  }
}

export default WebGPUBuffer;
