import Color from "../Core/Color.js";
import Cartesian2 from "../Core/Cartesian2.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Cartesian4 from "../Core/Cartesian4.js";
import defined from "../Core/defined.js";

/**
 * Packed Float32Array-backed storage for material uniform values.
 *
 * Mirrors the plain-object `material.uniforms` into typed-array-backed
 * storage that supports:
 *   - Zero-copy GPU upload via {@link MaterialUniformBuffer#getGPUData}
 *   - Dirty tracking (skip GPU writes when nothing changed)
 *   - HDR-capable float storage (values can exceed 1.0)
 *   - Stable public Color, Cartesian, matrix, and texture values
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
    this._uniformNames = Array.from(this._layout.keys());
    this._totalFloats = layout.totalFloats;
    this._data = new Float32Array(layout.totalFloats);
    this._textures = {};
    this._uniforms = templateUniforms;
    this._dirty = true;
    this._version = 1;

    // Populate initial values from the template.
    for (const name in templateUniforms) {
      if (!Object.prototype.hasOwnProperty.call(templateUniforms, name)) {
        continue;
      }
      this._writeValue(name, templateUniforms[name]);
    }

    // Keep the initial state dirty so every backend consumer performs its
    // first upload even when all packed values happen to be zero.
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

      // Do NOT pre-pad after vec3. In WGSL a vec3<f32> has size 12 bytes
      // (3 floats) with alignment 16 — the trailing 4 bytes (1 float) are
      // available to the NEXT field if that field's alignment allows
      // (e.g., an f32 can fit at byte 12 after a vec3 at byte 0). The
      // next-field alignment computation at the top of this loop handles
      // the padding correctly for vec2/vec3/vec4 followers; only f32
      // followers are affected, and they SHOULD use the tail slot. An
      // earlier `offset += 1` after vec3 over-padded and broke any
      // `{ vec3, f32, ... }` struct (e.g. Material.NormalMapType's
      // `channels` + `strength` pair).
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
  static _classifyUniform(name, value) {
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
      // Channel uniforms (AlphaMap/BumpMap/SpecularMap `channel`, NormalMap/
      // EmissionMap/DiffuseMap `channels`) are r/g/b/a shorthand strings —
      // upstream CesiumJS bakes them into the fabric GLSL at assembly time.
      // The WebGPU path packs them as numeric indices so the WGSL shader
      // can swizzle at runtime without re-generating a shader variant per
      // channel. Mapping: r=0, g=1, b=2, a=3. Empty channels string falls
      // back to texture classification.
      if (name === "channel" && MaterialUniformBuffer._isChannelString(value)) {
        return { type: "channelIndex", size: 1, isTexture: false };
      }
      if (
        name === "channels" &&
        MaterialUniformBuffer._isChannelString(value) &&
        value.length >= 1 &&
        value.length <= 4
      ) {
        // `channels: "rgb"` → vec3; `channels: "rgba"` → vec4; shorter
        // strings pad the remaining components with 0 (.r). Size drives
        // WGSL alignment so shaders must declare a matching vec3/vec4.
        return {
          type: value.length >= 4 ? "channelsVec4" : "channelsVec3",
          size: value.length >= 4 ? 4 : 3,
          isTexture: false,
        };
      }
      // Texture path or unrecognized string — stored separately.
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
      // Batch 139 — GLSL-synthetic ivec3 (the `<image>Dimensions` auto-
      // uniform that upstream Cesium adds whenever the GLSL source
      // references `imageDimensions` — see MaterialHelpers.createUniform
      // sampler2D branch). WebGPU shaders query texture dimensions via
      // textureDimensions() instead, so the WGSL struct doesn't declare
      // a matching field. Pre-Batch-139 the ivec3 got auto-classified as
      // a vec2 (object with x/y), padded the front of the UB by 8 bytes,
      // and silently shifted every subsequent field's offset — channel
      // / strength / repeat all read garbage. Treating it as a texture
      // skips it from the packed float buffer entirely. WebGL is
      // unaffected — it reads imageDimensions via the _uniforms function
      // accessor, not the packed buffer.
      if (value.type === "ivec3") {
        return { type: "ivec3_glsl_only", size: 0, isTexture: true };
      }
      // Object with x/y boolean fields (e.g., Fade's fadeDirection)
      if (typeof value.x === "boolean") {
        return { type: "boolVec2", size: 2, isTexture: false };
      }
      // Object with x/y/z/w numeric fields — treat as vec
      const keys = Object.keys(value);
      if (keys.includes("x") && keys.includes("y")) {
        if (keys.includes("w")) {
          return { type: "vec4", size: 4, isTexture: false };
        }
        if (keys.includes("z")) {
          return { type: "vec3", size: 3, isTexture: false };
        }
        return { type: "vec2", size: 2, isTexture: false };
      }
      // Image element
      if (
        (typeof HTMLImageElement !== "undefined" &&
          value instanceof HTMLImageElement) ||
        (typeof HTMLCanvasElement !== "undefined" &&
          value instanceof HTMLCanvasElement) ||
        (typeof ImageBitmap !== "undefined" && value instanceof ImageBitmap)
      ) {
        return { type: "sampler2D", size: 0, isTexture: true };
      }
    }
    // Unknown — store as texture reference (won't pack into float array)
    return { type: "unknown", size: 0, isTexture: true };
  }

  /**
   * True when `s` is a 1-4 character string of r/g/b/a (case-insensitive).
   * Matches fabric channel shorthand (`"a"`, `"rgb"`, `"rgba"`, etc.).
   * @private
   */
  static _isChannelString(s) {
    if (typeof s !== "string" || s.length === 0 || s.length > 4) {
      return false;
    }
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c !== "r" && c !== "g" && c !== "b" && c !== "a") {
        const lower = c.toLowerCase();
        if (lower !== "r" && lower !== "g" && lower !== "b" && lower !== "a") {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Map a single channel char → index. r=0, g=1, b=2, a=3. Case-insensitive.
   * Unrecognized chars default to 0 (r) to keep the shader on a valid
   * swizzle component.
   * @private
   */
  static _channelCharToIndex(c) {
    switch (c.toLowerCase()) {
      case "r":
        return 0;
      case "g":
        return 1;
      case "b":
        return 2;
      case "a":
        return 3;
      default:
        return 0;
    }
  }

  static _writeFloat(data, index, value) {
    const packedValue = Math.fround(value);
    const currentValue = data[index];
    if (
      currentValue === packedValue ||
      (Number.isNaN(currentValue) && Number.isNaN(packedValue))
    ) {
      return false;
    }

    data[index] = packedValue;
    return true;
  }

  /**
   * Write a value into the backing store.
   * @param {string} name Uniform name
   * @param {*} value The value to write
   * @private
   */
  _writeValue(name, value) {
    const entry = this._layout.get(name);
    if (!entry) {
      return false;
    }

    if (entry.offset === -1) {
      if (this._textures[name] === value) {
        return false;
      }
      this._textures[name] = value;
      return true;
    }

    const d = this._data;
    const o = entry.offset;
    let changed = false;

    // Channel-string uniforms: `channel: "a"` → write index; `channels: "rgb"`
    // → write (0,1,2) into a vec3/vec4 slot. Must come BEFORE the generic
    // `typeof value === "string"` fallthrough below.
    if (entry.type === "channelIndex" && typeof value === "string") {
      return MaterialUniformBuffer._writeFloat(
        d,
        o,
        MaterialUniformBuffer._channelCharToIndex(value[0] ?? "r"),
      );
    }
    if (
      (entry.type === "channelsVec3" || entry.type === "channelsVec4") &&
      typeof value === "string"
    ) {
      const count = entry.size;
      for (let i = 0; i < count; i++) {
        const ch = value[i] ?? "r";
        changed =
          MaterialUniformBuffer._writeFloat(
            d,
            o + i,
            MaterialUniformBuffer._channelCharToIndex(ch),
          ) || changed;
      }
      return changed;
    }

    if (value instanceof Color) {
      changed = MaterialUniformBuffer._writeFloat(d, o, value.red) || changed;
      changed =
        MaterialUniformBuffer._writeFloat(d, o + 1, value.green) || changed;
      changed =
        MaterialUniformBuffer._writeFloat(d, o + 2, value.blue) || changed;
      changed =
        MaterialUniformBuffer._writeFloat(d, o + 3, value.alpha) || changed;
    } else if (value instanceof Cartesian4) {
      changed = MaterialUniformBuffer._writeFloat(d, o, value.x) || changed;
      changed = MaterialUniformBuffer._writeFloat(d, o + 1, value.y) || changed;
      changed = MaterialUniformBuffer._writeFloat(d, o + 2, value.z) || changed;
      changed = MaterialUniformBuffer._writeFloat(d, o + 3, value.w) || changed;
    } else if (value instanceof Cartesian3) {
      changed = MaterialUniformBuffer._writeFloat(d, o, value.x) || changed;
      changed = MaterialUniformBuffer._writeFloat(d, o + 1, value.y) || changed;
      changed = MaterialUniformBuffer._writeFloat(d, o + 2, value.z) || changed;
    } else if (value instanceof Cartesian2) {
      changed = MaterialUniformBuffer._writeFloat(d, o, value.x) || changed;
      changed = MaterialUniformBuffer._writeFloat(d, o + 1, value.y) || changed;
    } else if (typeof value === "number") {
      changed = MaterialUniformBuffer._writeFloat(d, o, value) || changed;
    } else if (typeof value === "boolean") {
      changed =
        MaterialUniformBuffer._writeFloat(d, o, value ? 1.0 : 0.0) || changed;
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length && i < entry.size; i++) {
        changed =
          MaterialUniformBuffer._writeFloat(d, o + i, value[i]) || changed;
      }
    } else if (typeof value === "object" && value !== null) {
      // Boolean vec (fadeDirection: { x: true, y: true })
      if (typeof value.x === "boolean") {
        changed =
          MaterialUniformBuffer._writeFloat(d, o, value.x ? 1.0 : 0.0) ||
          changed;
        if (entry.size > 1) {
          changed =
            MaterialUniformBuffer._writeFloat(d, o + 1, value.y ? 1.0 : 0.0) ||
            changed;
        }
      } else {
        // Generic x/y/z/w object
        if (defined(value.x)) {
          changed = MaterialUniformBuffer._writeFloat(d, o, value.x) || changed;
        }
        if (defined(value.y) && entry.size > 1) {
          changed =
            MaterialUniformBuffer._writeFloat(d, o + 1, value.y) || changed;
        }
        if (defined(value.z) && entry.size > 2) {
          changed =
            MaterialUniformBuffer._writeFloat(d, o + 2, value.z) || changed;
        }
        if (defined(value.w) && entry.size > 3) {
          changed =
            MaterialUniformBuffer._writeFloat(d, o + 3, value.w) || changed;
        }
      }
    }

    return changed;
  }

  _syncValues() {
    let changed = false;
    const names = this._uniformNames;
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      changed = this._writeValue(name, this._uniforms[name]) || changed;
    }

    if (changed) {
      this._dirty = true;
      this._version++;
    }
  }

  /**
   * Read the stable public value associated with a packed uniform.
   *
   * @param {string} name Uniform name
   * @returns {Color|Cartesian2|Cartesian3|Cartesian4|number|boolean|*}
   */
  _readValue(name) {
    return this._layout.has(name) ? this._uniforms[name] : undefined;
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
    this._syncValues();
    return this._data;
  }

  /**
   * Whether any uniform value has changed since the last
   * {@link MaterialUniformBuffer#clearDirty} call.
   * @type {boolean}
   * @readonly
   */
  get isDirty() {
    this._syncValues();
    return this._dirty;
  }

  /**
   * Monotonically increasing packed-value version. Consumers can retain their
   * own uploaded version instead of clearing shared material state.
   * @type {number}
   * @readonly
   */
  get version() {
    this._syncValues();
    return this._version;
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
    this._syncValues();
    return this._textures;
  }

  /**
   * Returns the original public uniforms object retained by this mirror.
   * @returns {object} The stable public uniforms object.
   */
  createFacade() {
    return this._uniforms;
  }
}

export default MaterialUniformBuffer;
