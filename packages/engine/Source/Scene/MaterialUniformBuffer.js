import Color from "../Core/Color.js";
import Cartesian2 from "../Core/Cartesian2.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Cartesian4 from "../Core/Cartesian4.js";
import defined from "../Core/defined.js";

/**
 * Packed Float32Array-backed storage for material uniform values.
 *
 * Replaces the plain-object `material.uniforms` with a typed-array-backed
 * store that supports:
 *   - Zero-copy GPU upload via {@link MaterialUniformBuffer#getGPUData}
 *   - Dirty tracking (skip GPU writes when nothing changed)
 *   - HDR-capable float storage (values can exceed 1.0)
 *   - Backward-compatible property access via defineProperty getters/setters
 *
 * Texture references (sampler2D, samplerCube) live in a separate Map since
 * they can't be packed into a Float32Array.
 *
 * @alias MaterialUniformBuffer
 * @constructor
 * @private
 *
 * @param {object} templateUniforms The default uniform values from the
 *   material's fabric template (e.g., `{ color: new Color(1,0,0,1), repeat: new Cartesian2(1,1) }`).
 */
class MaterialUniformBuffer {
  constructor(templateUniforms) {
    const layout = MaterialUniformBuffer._buildLayout(templateUniforms);
    this._layout = layout.entries;
    this._totalFloats = layout.totalFloats;
    this._data = new Float32Array(layout.totalFloats);
    this._textures = {};
    this._dirty = true;

    // Pre-allocate scratch objects for zero-alloc reads. One per
    // vector/color uniform, keyed by uniform name. Created lazily on
    // first get — most reads go through the WebGPU zero-copy path and
    // never touch these.
    this._scratch = {};

    // Populate initial values from the template.
    for (const name in templateUniforms) {
      if (!Object.prototype.hasOwnProperty.call(templateUniforms, name)) {
        continue;
      }
      this._writeValue(name, templateUniforms[name]);
    }

    // Mark clean after initial population — the first GPU upload will
    // see dirty=true from the constructor assignment above.
    // Actually keep dirty=true so the first frame uploads.
  }

  /**
   * Auto-generate a uniform layout from template values. Each numeric
   * uniform gets a contiguous range of floats in the backing array.
   * Texture uniforms are recorded with offset=-1 (stored separately).
   *
   * @param {object} templateUniforms
   * @returns {{ entries: Map<string, {type: string, offset: number, size: number}>, totalFloats: number }}
   * @private
   */
  static _buildLayout(templateUniforms) {
    const entries = new Map();
    let offset = 0;

    for (const name in templateUniforms) {
      if (!Object.prototype.hasOwnProperty.call(templateUniforms, name)) {
        continue;
      }
      const value = templateUniforms[name];
      const info = MaterialUniformBuffer._classifyUniform(name, value);

      if (info.isTexture) {
        entries.set(name, { type: info.type, offset: -1, size: 0 });
        continue;
      }

      // WGSL uniform struct alignment rules (measured in floats, each 4 bytes):
      //   f32          → align to 1 float  (4 bytes)
      //   vec2<f32>    → align to 2 floats (8 bytes)
      //   vec3<f32>    → align to 4 floats (16 bytes) — same as vec4
      //   vec4<f32>    → align to 4 floats (16 bytes)
      //   mat4x4<f32>  → align to 4 floats (16 bytes)
      //
      // This ensures the packed Float32Array can be uploaded directly as a
      // GPU uniform buffer and the WGSL struct reads correct values at
      // each field offset. The padding floats between fields are never
      // written or read — they're dead space required by the hardware.
      let alignmentFloats;
      if (info.size >= 3) {
        // vec3, vec4, mat4 → align to 4 floats (16 bytes)
        alignmentFloats = 4;
      } else if (info.size === 2) {
        // vec2 → align to 2 floats (8 bytes)
        alignmentFloats = 2;
      } else {
        // f32, bool → align to 1 float (4 bytes) — always satisfied
        alignmentFloats = 1;
      }
      offset = Math.ceil(offset / alignmentFloats) * alignmentFloats;

      entries.set(name, { type: info.type, offset, size: info.size });
      offset += info.size;

      // vec3 occupies 3 floats but its WGSL size is 4 floats (the trailing
      // float is implicit padding before the next field). Advance past it.
      if (info.size === 3) {
        offset += 1;
      }
    }

    // Round total up to 4-float (16-byte) boundary — WebGPU requires
    // uniform buffer bindings to be multiples of 16 bytes.
    const totalFloats = Math.ceil(offset / 4) * 4;
    return { entries, totalFloats };
  }

  /**
   * Classify a uniform value into a type with a known float count.
   * @private
   */
  static _classifyUniform(_name, value) {
    if (value instanceof Color) {
      return { type: "vec4", size: 4, isTexture: false };
    }
    if (value instanceof Cartesian4) {
      return { type: "vec4", size: 4, isTexture: false };
    }
    if (value instanceof Cartesian3) {
      return { type: "vec3", size: 3, isTexture: false };
    }
    if (value instanceof Cartesian2) {
      return { type: "vec2", size: 2, isTexture: false };
    }
    if (typeof value === "number") {
      return { type: "float", size: 1, isTexture: false };
    }
    if (typeof value === "boolean") {
      return { type: "bool", size: 1, isTexture: false };
    }
    if (typeof value === "string") {
      // Texture path or channel string
      return { type: "sampler2D", size: 0, isTexture: true };
    }
    if (typeof value === "object" && value !== null) {
      // Could be a Resource (texture), an object with x/y (Cartesian-like),
      // or an array (matrix).
      if (
        typeof value.fetchArrayBuffer === "function" ||
        typeof value.url === "string"
      ) {
        // Resource — texture reference
        return { type: "sampler2D", size: 0, isTexture: true };
      }
      if (Array.isArray(value)) {
        // Matrix packed as array
        return { type: "matrix", size: value.length, isTexture: false };
      }
      // Object with x/y boolean fields (e.g., Fade's fadeDirection)
      if (typeof value.x === "boolean") {
        return { type: "boolVec2", size: 2, isTexture: false };
      }
      // Object with x/y/z/w numeric fields — treat as vec
      const keys = Object.keys(value);
      if (keys.includes("x") && keys.includes("y")) {
        if (keys.includes("w")) return { type: "vec4", size: 4, isTexture: false };
        if (keys.includes("z")) return { type: "vec3", size: 3, isTexture: false };
        return { type: "vec2", size: 2, isTexture: false };
      }
      // Image element
      if (
        (typeof HTMLImageElement !== "undefined" && value instanceof HTMLImageElement) ||
        (typeof HTMLCanvasElement !== "undefined" && value instanceof HTMLCanvasElement) ||
        (typeof ImageBitmap !== "undefined" && value instanceof ImageBitmap)
      ) {
        return { type: "sampler2D", size: 0, isTexture: true };
      }
    }
    // Unknown — store as texture reference (won't pack into float array)
    return { type: "unknown", size: 0, isTexture: true };
  }

  /**
   * Write a value into the backing store.
   * @param {string} name Uniform name
   * @param {*} value The value to write
   * @private
   */
  _writeValue(name, value) {
    const entry = this._layout.get(name);
    if (!entry) return;

    if (entry.offset === -1) {
      // Texture reference — store separately
      this._textures[name] = value;
      this._dirty = true;
      return;
    }

    const d = this._data;
    const o = entry.offset;

    if (value instanceof Color) {
      d[o] = value.red;
      d[o + 1] = value.green;
      d[o + 2] = value.blue;
      d[o + 3] = value.alpha;
    } else if (value instanceof Cartesian4) {
      d[o] = value.x;
      d[o + 1] = value.y;
      d[o + 2] = value.z;
      d[o + 3] = value.w;
    } else if (value instanceof Cartesian3) {
      d[o] = value.x;
      d[o + 1] = value.y;
      d[o + 2] = value.z;
    } else if (value instanceof Cartesian2) {
      d[o] = value.x;
      d[o + 1] = value.y;
    } else if (typeof value === "number") {
      d[o] = value;
    } else if (typeof value === "boolean") {
      d[o] = value ? 1.0 : 0.0;
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length && i < entry.size; i++) {
        d[o + i] = value[i];
      }
    } else if (typeof value === "object" && value !== null) {
      // Boolean vec (fadeDirection: { x: true, y: true })
      if (typeof value.x === "boolean") {
        d[o] = value.x ? 1.0 : 0.0;
        if (entry.size > 1) d[o + 1] = value.y ? 1.0 : 0.0;
      } else {
        // Generic x/y/z/w object
        if (defined(value.x)) d[o] = value.x;
        if (defined(value.y) && entry.size > 1) d[o + 1] = value.y;
        if (defined(value.z) && entry.size > 2) d[o + 2] = value.z;
        if (defined(value.w) && entry.size > 3) d[o + 3] = value.w;
      }
    }

    this._dirty = true;
  }

  /**
   * Read a value from the backing store. Returns either a scratch
   * Color/Cartesian or a scalar, depending on the uniform type.
   *
   * @param {string} name Uniform name
   * @returns {Color|Cartesian2|Cartesian3|Cartesian4|number|boolean|*}
   */
  _readValue(name) {
    const entry = this._layout.get(name);
    if (!entry) return undefined;

    if (entry.offset === -1) {
      return this._textures[name];
    }

    const d = this._data;
    const o = entry.offset;

    switch (entry.type) {
      case "vec4": {
        let s = this._scratch[name];
        if (!s) {
          s = new Color();
          this._scratch[name] = s;
        }
        s.red = d[o];
        s.green = d[o + 1];
        s.blue = d[o + 2];
        s.alpha = d[o + 3];
        return s;
      }
      case "vec3": {
        let s = this._scratch[name];
        if (!s) {
          s = new Cartesian3();
          this._scratch[name] = s;
        }
        s.x = d[o];
        s.y = d[o + 1];
        s.z = d[o + 2];
        return s;
      }
      case "vec2": {
        let s = this._scratch[name];
        if (!s) {
          s = new Cartesian2();
          this._scratch[name] = s;
        }
        s.x = d[o];
        s.y = d[o + 1];
        return s;
      }
      case "float":
        return d[o];
      case "bool":
        return d[o] > 0.5;
      case "boolVec2":
        return { x: d[o] > 0.5, y: d[o + 1] > 0.5 };
      case "matrix": {
        const arr = new Array(entry.size);
        for (let i = 0; i < entry.size; i++) {
          arr[i] = d[o + i];
        }
        return arr;
      }
      default:
        return undefined;
    }
  }

  /**
   * The packed GPU-ready data. This is the Float32Array that can be
   * uploaded directly via `device.queue.writeBuffer()` without any
   * per-property iteration.
   *
   * @type {Float32Array}
   * @readonly
   */
  get gpuData() {
    return this._data;
  }

  /**
   * Whether any uniform value has changed since the last
   * {@link MaterialUniformBuffer#clearDirty} call.
   * @type {boolean}
   * @readonly
   */
  get isDirty() {
    return this._dirty;
  }

  /**
   * Mark the buffer as clean after a GPU upload.
   */
  clearDirty() {
    this._dirty = false;
  }

  /**
   * Total number of floats in the packed buffer.
   * @type {number}
   * @readonly
   */
  get totalFloats() {
    return this._totalFloats;
  }

  /**
   * The layout map: uniform name → { type, offset, size }.
   * @type {Map<string, {type: string, offset: number, size: number}>}
   * @readonly
   */
  get layout() {
    return this._layout;
  }

  /**
   * Texture references (not in the Float32Array).
   * @type {Object<string, *>}
   * @readonly
   */
  get textures() {
    return this._textures;
  }

  /**
   * Create a backward-compatible `uniforms` proxy object that
   * exposes named getters/setters backed by this buffer. Existing code
   * that does `material.uniforms.color = new Color(...)` or
   * `material.uniforms.color.alpha` will continue to work.
   *
   * The returned object also exposes `_buffer` for direct access and
   * `hasOwnProperty` support for uniform enumeration.
   *
   * @returns {object} An object with defineProperty getters/setters
   */
  createFacade() {
    const buffer = this;
    const facade = {
      _buffer: buffer,
    };

    for (const [name, entry] of this._layout) {
      const isNumeric = entry.offset !== -1;
      Object.defineProperty(facade, name, {
        get() {
          return buffer._readValue(name);
        },
        set(value) {
          buffer._writeValue(name, value);
        },
        enumerable: true,
        configurable: true,
      });

      // For Color/Cartesian uniforms, the read returns a scratch object.
      // If the caller mutates it (e.g., `uniforms.color.red = 0.5`),
      // the mutation goes into the scratch but NOT back into the buffer.
      // This matches how the current system works: mutating the returned
      // Color object also doesn't trigger any dirty flag. The caller must
      // re-assign: `uniforms.color = uniforms.color` to trigger the set.
      //
      // For the common CesiumJS pattern of reading uniforms in
      // `translucent` callbacks: `material.uniforms.color.alpha < 1.0`,
      // the scratch read is correct and zero-alloc.
      void isNumeric;
    }

    return facade;
  }
}

export default MaterialUniformBuffer;
