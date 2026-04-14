/**
 * WebGPU vertex array facade for managing multi-buffer interleaved vertex
 * data used by BillboardCollection, LabelCollection, and PolylineCollection.
 *
 * Mirrors the WebGL VertexArrayFacade.js pattern but uses WebGPU buffers
 * and buffer layouts instead of VAOs.
 *
 * Key differences from WebGL:
 * - No VAOs — WebGPU uses buffer layouts in the pipeline descriptor
 * - Uses queue.writeBuffer for uploads instead of bufferSubData
 * - Returns GPUBuffer references + layout descriptors for pipeline creation
 * - Supports the same writer pattern for efficient per-vertex updates
 *
 * @private
 */

import defined from "../../Core/defined.js";
import DeveloperError from "../../Core/DeveloperError.js";
import ComponentDatatype from "../../Core/ComponentDatatype.js";
import CesiumMath from "../../Core/Math.js";

/**
 * ComponentDatatype is exported as a frozen object from JS with both enum values
 * AND utility methods. TypeScript only infers the enum values, so we declare the
 * full type here to access getSizeInBytes() and createArrayBufferView().
 */
interface ComponentDatatypeFull {
  readonly BYTE: number;
  readonly UNSIGNED_BYTE: number;
  readonly SHORT: number;
  readonly UNSIGNED_SHORT: number;
  readonly INT: number;
  readonly UNSIGNED_INT: number;
  readonly FLOAT: number;
  readonly DOUBLE: number;
  getSizeInBytes(componentDatatype: number): number;
  createArrayBufferView(
    componentDatatype: number,
    buffer: ArrayBuffer,
    byteOffset?: number,
    length?: number,
  ): ArrayBufferView;
  fromTypedArray(array: ArrayBufferView): number;
  validate(componentDatatype: number): boolean;
  createTypedArray(
    componentDatatype: number,
    valuesOrLength: number | number[],
  ): ArrayBufferView;
  fromName(name: string): number;
}

const CDT = ComponentDatatype as unknown as ComponentDatatypeFull;

/**
 * WebGPU buffer usage hint (maps from WebGL BufferUsage).
 */
const BUFFER_USAGE_STATIC = 0x88e4; // STATIC_DRAW
const BUFFER_USAGE_DYNAMIC = 0x88e8; // DYNAMIC_DRAW
const BUFFER_USAGE_STREAM = 0x88e0; // STREAM_DRAW

/**
 * Attribute definition for the facade.
 */
export interface WebGPUVertexAttribute {
  /** Vertex attribute index (location) */
  index: number;
  /** Whether this attribute is enabled */
  enabled?: boolean;
  /** Number of components (1-4) */
  componentsPerAttribute: number;
  /** Data type (ComponentDatatype enum) */
  componentDatatype?: number;
  /** Whether to normalize integer data */
  normalize?: boolean;
  /** Pre-created vertex buffer (skip management) */
  vertexBuffer?: GPUBuffer;
  /** Usage hint (STATIC_DRAW, DYNAMIC_DRAW, STREAM_DRAW) */
  usage?: number;
}

/**
 * Writer function type — writes vertex data at an index.
 */
type WriterFunction = (...args: number[]) => void;

/**
 * Internal buffer tracking structure.
 */
interface ManagedBuffer {
  vertexSizeInBytes: number;
  gpuBuffer: GPUBuffer | null;
  usage: number;
  needsCommit: boolean;
  arrayBuffer: ArrayBuffer | null;
  arrayViews: ArrayView[];
}

/**
 * View into the typed array for a specific attribute.
 */
interface ArrayView {
  index: number;
  enabled: boolean;
  componentsPerAttribute: number;
  componentDatatype: number;
  normalize: boolean;
  offsetInBytes: number;
  vertexSizeInComponentType: number;
  view:
    | Float32Array
    | Uint8Array
    | Int8Array
    | Uint16Array
    | Int16Array
    | Uint32Array
    | Int32Array
    | Float64Array;
}

/**
 * Buffer layout descriptor for WebGPU pipeline creation.
 */
export interface WebGPUVertexBufferLayout {
  /** The GPU buffer */
  buffer: GPUBuffer;
  /** Byte offset into the buffer */
  offset: number;
  /** Stride between consecutive vertices */
  arrayStride: number;
  /** Vertex or instance step mode */
  stepMode: GPUVertexStepMode;
  /** Attribute descriptors within this buffer */
  attributes: GPUVertexAttribute[];
}

class WebGPUVertexArrayFacade {
  private _device: GPUDevice;
  private _allBuffers: ManagedBuffer[];
  private _precreated: WebGPUVertexAttribute[];
  private _size: number;
  private _instanced: boolean;

  /** Per-attribute writer functions. Index matches attribute index. */
  writers: WriterFunction[];

  /**
   * @param {GPUDevice} device - The WebGPU device
   * @param {WebGPUVertexAttribute[]} attributes - Attribute definitions
   * @param {number} [sizeInVertices] - Initial vertex count
   * @param {boolean} [instanced] - Whether this is instanced data
   */
  constructor(
    device: GPUDevice,
    attributes: WebGPUVertexAttribute[],
    sizeInVertices?: number,
    instanced?: boolean,
  ) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(device)) {
      throw new DeveloperError("device is required.");
    }
    if (!attributes || attributes.length === 0) {
      throw new DeveloperError("At least one attribute is required.");
    }
    //>>includeEnd('debug');

    this._device = device;
    this._size = sizeInVertices ?? 0;
    this._instanced = instanced ?? false;

    // Validate and normalize attributes
    const attrs = WebGPUVertexArrayFacade._verifyAttributes(attributes);

    // Separate pre-created buffers from managed attributes
    const precreated: WebGPUVertexAttribute[] = [];
    const attributesByUsage: Record<number, WebGPUVertexAttribute[]> = {};

    for (const attr of attrs) {
      if (attr.vertexBuffer) {
        precreated.push(attr);
        continue;
      }
      const usage = attr.usage ?? BUFFER_USAGE_STATIC;
      if (!attributesByUsage[usage]) {
        attributesByUsage[usage] = [];
      }
      attributesByUsage[usage].push(attr);
    }

    this._precreated = precreated;

    // Sort by component size (floats first, then shorts, then bytes)
    const compare = (a: WebGPUVertexAttribute, b: WebGPUVertexAttribute) => {
      const aSize = CDT.getSizeInBytes(a.componentDatatype ?? CDT.FLOAT);
      const bSize = CDT.getSizeInBytes(b.componentDatatype ?? CDT.FLOAT);
      return bSize - aSize;
    };

    // Create managed buffers grouped by usage
    this._allBuffers = [];
    for (const usage in attributesByUsage) {
      if (attributesByUsage.hasOwnProperty(usage)) {
        const usageAttrs = attributesByUsage[usage];
        usageAttrs.sort(compare);

        const vertexSizeInBytes =
          WebGPUVertexArrayFacade._vertexSizeInBytes(usageAttrs);
        const arrayViews = WebGPUVertexArrayFacade._createArrayViews(
          usageAttrs,
          vertexSizeInBytes,
        );

        this._allBuffers.push({
          vertexSizeInBytes,
          gpuBuffer: null,
          usage: Number(usage),
          needsCommit: false,
          arrayBuffer: null,
          arrayViews,
        });
      }
    }

    this.writers = [];
    this.resize(this._size);
  }

  /**
   * Current vertex count.
   */
  get size(): number {
    return this._size;
  }

  /**
   * Validates and normalizes attribute definitions.
   */
  static _verifyAttributes(
    attributes: WebGPUVertexAttribute[],
  ): WebGPUVertexAttribute[] {
    const attrs: WebGPUVertexAttribute[] = [];
    const usedIndices = new Set<number>();

    for (let i = 0; i < attributes.length; i++) {
      const a = attributes[i];
      const attr: WebGPUVertexAttribute = {
        index: a.index ?? i,
        enabled: a.enabled ?? true,
        componentsPerAttribute: a.componentsPerAttribute,
        componentDatatype: a.componentDatatype ?? ComponentDatatype.FLOAT,
        normalize: a.normalize ?? false,
        vertexBuffer: a.vertexBuffer,
        usage: a.usage ?? BUFFER_USAGE_STATIC,
      };

      //>>includeStart('debug', pragmas.debug);
      if (attr.componentsPerAttribute < 1 || attr.componentsPerAttribute > 4) {
        throw new DeveloperError(
          "componentsPerAttribute must be between 1 and 4.",
        );
      }
      if (usedIndices.has(attr.index)) {
        throw new DeveloperError(
          `Attribute index ${attr.index} is used by more than one attribute.`,
        );
      }
      //>>includeEnd('debug');

      usedIndices.add(attr.index);
      attrs.push(attr);
    }

    return attrs;
  }

  /**
   * Calculates total vertex size in bytes for a group of attributes.
   */
  static _vertexSizeInBytes(attributes: WebGPUVertexAttribute[]): number {
    let size = 0;
    for (const attr of attributes) {
      size +=
        attr.componentsPerAttribute *
        CDT.getSizeInBytes(attr.componentDatatype ?? CDT.FLOAT);
    }

    // Align to the largest component's size
    const maxCompSize =
      attributes.length > 0
        ? CDT.getSizeInBytes(attributes[0].componentDatatype ?? CDT.FLOAT)
        : 0;

    if (maxCompSize > 0) {
      const remainder = size % maxCompSize;
      if (remainder !== 0) {
        size += maxCompSize - remainder;
      }
    }

    // WebGPU requires vertex buffer stride to be a multiple of 4
    const rem4 = size % 4;
    if (rem4 !== 0) {
      size += 4 - rem4;
    }

    return size;
  }

  /**
   * Creates typed array views into the vertex buffer for each attribute.
   */
  static _createArrayViews(
    attributes: WebGPUVertexAttribute[],
    vertexSizeInBytes: number,
  ): ArrayView[] {
    const views: ArrayView[] = [];
    let offsetInBytes = 0;

    for (const attr of attributes) {
      const compDatatype = attr.componentDatatype ?? CDT.FLOAT;
      const compSize = CDT.getSizeInBytes(compDatatype);

      views.push({
        index: attr.index,
        enabled: attr.enabled ?? true,
        componentsPerAttribute: attr.componentsPerAttribute,
        componentDatatype: compDatatype,
        normalize: attr.normalize ?? false,
        offsetInBytes,
        vertexSizeInComponentType: vertexSizeInBytes / compSize,
        view: undefined,
      });

      offsetInBytes += attr.componentsPerAttribute * compSize;
    }

    return views;
  }

  /**
   * Resizes the vertex buffers. Invalidates writers.
   */
  resize(sizeInVertices: number): void {
    this._size = sizeInVertices;
    this.writers = [];

    for (const buffer of this._allBuffers) {
      this._resizeBuffer(buffer, sizeInVertices);
      this._appendWriters(buffer);
    }
  }

  /**
   * Resizes a single managed buffer.
   */
  private _resizeBuffer(buffer: ManagedBuffer, size: number): void {
    if (buffer.vertexSizeInBytes <= 0) return;

    const newArrayBuffer = new ArrayBuffer(size * buffer.vertexSizeInBytes);

    // Copy old data
    if (buffer.arrayBuffer) {
      const dest = new Uint8Array(newArrayBuffer);
      const src = new Uint8Array(buffer.arrayBuffer);
      const copyLen = Math.min(src.length, dest.length);
      dest.set(src.subarray(0, copyLen));
    }

    // Create typed views
    for (const view of buffer.arrayViews) {
      view.view = CDT.createArrayBufferView(
        view.componentDatatype,
        newArrayBuffer,
        view.offsetInBytes,
      ) as
        | Float32Array
        | Uint8Array
        | Int8Array
        | Uint16Array
        | Int16Array
        | Uint32Array
        | Int32Array
        | Float64Array;
    }

    buffer.arrayBuffer = newArrayBuffer;
  }

  /**
   * Creates writer functions for each attribute in a buffer.
   */
  private _appendWriters(buffer: ManagedBuffer): void {
    for (const view of buffer.arrayViews) {
      const stride = view.vertexSizeInComponentType;
      const typedView = view.view;
      const comps = view.componentsPerAttribute;
      const buf = buffer;

      switch (comps) {
        case 1:
          this.writers[view.index] = function (index: number, v0: number) {
            typedView[index * stride] = v0;
            buf.needsCommit = true;
          };
          break;
        case 2:
          this.writers[view.index] = function (
            index: number,
            v0: number,
            v1: number,
          ) {
            const i = index * stride;
            typedView[i] = v0;
            typedView[i + 1] = v1;
            buf.needsCommit = true;
          };
          break;
        case 3:
          this.writers[view.index] = function (
            index: number,
            v0: number,
            v1: number,
            v2: number,
          ) {
            const i = index * stride;
            typedView[i] = v0;
            typedView[i + 1] = v1;
            typedView[i + 2] = v2;
            buf.needsCommit = true;
          };
          break;
        case 4:
          this.writers[view.index] = function (
            index: number,
            v0: number,
            v1: number,
            v2: number,
            v3: number,
          ) {
            const i = index * stride;
            typedView[i] = v0;
            typedView[i + 1] = v1;
            typedView[i + 2] = v2;
            typedView[i + 3] = v3;
            buf.needsCommit = true;
          };
          break;
      }
    }
  }

  /**
   * Commits all dirty buffers to the GPU.
   * Creates new GPU buffers if needed, or updates existing ones.
   *
   * @param {GPUBuffer} [indexBuffer] - Optional index buffer
   */
  commit(indexBuffer?: GPUBuffer): void {
    for (const buffer of this._allBuffers) {
      this._commitBuffer(buffer);
    }
  }

  /**
   * Commits a single managed buffer to the GPU.
   */
  private _commitBuffer(buffer: ManagedBuffer): boolean {
    if (!buffer.needsCommit || buffer.vertexSizeInBytes <= 0) {
      return false;
    }

    buffer.needsCommit = false;
    const requiredSize = this._size * buffer.vertexSizeInBytes;

    if (!buffer.gpuBuffer || buffer.gpuBuffer.size < requiredSize) {
      // Destroy old buffer
      if (buffer.gpuBuffer) {
        buffer.gpuBuffer.destroy();
      }

      // Create new buffer with some growth room
      const allocSize = Math.max(requiredSize, 256);
      buffer.gpuBuffer = this._device.createBuffer({
        size: allocSize,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        label: "WebGPUVertexArrayFacade_Buffer",
      });

      // Upload all data
      if (buffer.arrayBuffer && requiredSize > 0) {
        this._device.queue.writeBuffer(
          buffer.gpuBuffer,
          0,
          buffer.arrayBuffer,
          0,
          requiredSize,
        );
      }

      return true; // Created new buffer
    }

    // Update existing buffer
    if (buffer.arrayBuffer && requiredSize > 0) {
      this._device.queue.writeBuffer(
        buffer.gpuBuffer,
        0,
        buffer.arrayBuffer,
        0,
        requiredSize,
      );
    }

    return false;
  }

  /**
   * Commits a sub-range of vertices (partial update).
   */
  subCommit(offsetInVertices: number, lengthInVertices: number): void {
    //>>includeStart('debug', pragmas.debug);
    if (offsetInVertices < 0 || offsetInVertices >= this._size) {
      throw new DeveloperError("offsetInVertices out of range.");
    }
    if (offsetInVertices + lengthInVertices > this._size) {
      throw new DeveloperError("subCommit range exceeds buffer size.");
    }
    //>>includeEnd('debug');

    for (const buffer of this._allBuffers) {
      if (buffer.needsCommit && buffer.gpuBuffer && buffer.arrayBuffer) {
        const byteOffset = buffer.vertexSizeInBytes * offsetInVertices;
        const byteLength = buffer.vertexSizeInBytes * lengthInVertices;

        this._device.queue.writeBuffer(
          buffer.gpuBuffer,
          byteOffset,
          buffer.arrayBuffer,
          byteOffset,
          byteLength,
        );
      }
    }
  }

  /**
   * Marks all buffers as committed (clears dirty flags after subCommit).
   */
  endSubCommits(): void {
    for (const buffer of this._allBuffers) {
      buffer.needsCommit = false;
    }
  }

  /**
   * Gets the vertex buffer layout descriptors for pipeline creation.
   * This replaces the VAO concept from WebGL.
   */
  getBufferLayouts(): WebGPUVertexBufferLayout[] {
    const layouts: WebGPUVertexBufferLayout[] = [];

    for (const buffer of this._allBuffers) {
      if (!buffer.gpuBuffer) continue;

      const gpuAttrs: GPUVertexAttribute[] = [];
      for (const view of buffer.arrayViews) {
        if (!view.enabled) continue;
        gpuAttrs.push({
          shaderLocation: view.index,
          offset: view.offsetInBytes,
          format: this._getVertexFormat(
            view.componentDatatype,
            view.componentsPerAttribute,
            view.normalize,
          ),
        });
      }

      layouts.push({
        buffer: buffer.gpuBuffer,
        offset: 0,
        arrayStride: buffer.vertexSizeInBytes,
        stepMode: this._instanced ? "instance" : "vertex",
        attributes: gpuAttrs,
      });
    }

    // Add pre-created buffer layouts
    for (const pre of this._precreated) {
      if (!pre.vertexBuffer || !pre.enabled) continue;
      layouts.push({
        buffer: pre.vertexBuffer,
        offset: 0,
        arrayStride: 0, // Tightly packed (caller sets this)
        stepMode: this._instanced ? "instance" : "vertex",
        attributes: [
          {
            shaderLocation: pre.index,
            offset: 0,
            format: this._getVertexFormat(
              pre.componentDatatype ?? ComponentDatatype.FLOAT,
              pre.componentsPerAttribute,
              pre.normalize ?? false,
            ),
          },
        ],
      });
    }

    return layouts;
  }

  /**
   * Maps CesiumJS component data type + count to WebGPU vertex format.
   */
  private _getVertexFormat(
    componentDatatype: number,
    components: number,
    normalize: boolean,
  ): GPUVertexFormat {
    const isFloat =
      componentDatatype === ComponentDatatype.FLOAT ||
      componentDatatype === ComponentDatatype.DOUBLE;

    if (isFloat) {
      switch (components) {
        case 1:
          return "float32";
        case 2:
          return "float32x2";
        case 3:
          return "float32x3";
        case 4:
          return "float32x4";
      }
    }

    const isShort =
      componentDatatype === ComponentDatatype.SHORT ||
      componentDatatype === ComponentDatatype.UNSIGNED_SHORT;

    if (isShort) {
      const signed = componentDatatype === ComponentDatatype.SHORT;
      if (normalize) {
        switch (components) {
          case 2:
            return signed ? "snorm16x2" : "unorm16x2";
          case 4:
            return signed ? "snorm16x4" : "unorm16x4";
        }
      } else {
        switch (components) {
          case 2:
            return signed ? "sint16x2" : "uint16x2";
          case 4:
            return signed ? "sint16x4" : "uint16x4";
        }
      }
    }

    const isByte =
      componentDatatype === ComponentDatatype.BYTE ||
      componentDatatype === ComponentDatatype.UNSIGNED_BYTE;

    if (isByte) {
      const signed = componentDatatype === ComponentDatatype.BYTE;
      if (normalize) {
        switch (components) {
          case 2:
            return signed ? "snorm8x2" : "unorm8x2";
          case 4:
            return signed ? "snorm8x4" : "unorm8x4";
        }
      } else {
        switch (components) {
          case 2:
            return signed ? "sint8x2" : "uint8x2";
          case 4:
            return signed ? "sint8x4" : "uint8x4";
        }
      }
    }

    // Fallback
    return "float32x4";
  }

  /**
   * Gets the raw GPU buffers for manual pipeline setup.
   */
  getGPUBuffers(): GPUBuffer[] {
    return this._allBuffers
      .filter((b) => b.gpuBuffer !== null)
      .map((b) => b.gpuBuffer!);
  }

  /**
   * Destroys the facade and releases all GPU buffers.
   */
  destroy(): void {
    for (const buffer of this._allBuffers) {
      if (buffer.gpuBuffer) {
        buffer.gpuBuffer.destroy();
        buffer.gpuBuffer = null;
      }
      buffer.arrayBuffer = null;
    }
    this._allBuffers = [];
    this.writers = [];
  }

  /**
   * Whether the facade has been destroyed.
   */
  isDestroyed(): boolean {
    return this._allBuffers.length === 0 && this.writers.length === 0;
  }
}

export default WebGPUVertexArrayFacade;
