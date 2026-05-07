/// <reference types="@webgpu/types" />
/**
 * NEW-POSTPROCESS-USER-WGSL — user-supplied WGSL post-process stages.
 *
 * `Scene.postProcessStages.add(...)` lets users insert custom shader
 * effects. On WebGL, GLSL is supported. On WebGPU (Batch 198 first slice),
 * stages with a `wgslFragmentShader: string` uniform are compiled +
 * chained into the post-process pipeline.
 *
 * **Batch 204 second slice:** named-uniform schema + multi-pass support.
 *
 * # Convention for user shaders
 *
 * The user provides a WGSL fragment shader as `stage.uniforms
 * .wgslFragmentShader: string`. The shader MUST declare:
 *
 *   - `@group(0) @binding(0) var sourceTexture: texture_2d<f32>;`
 *   - `@group(0) @binding(1) var sourceSampler: sampler;`
 *   - `@group(0) @binding(2) var<uniform> uniforms: UserUniforms;`
 *     where `struct UserUniforms { values: array<vec4<f32>, 4> };`
 *     (16 packed floats = 4 vec4s = 64 bytes UBO)
 *   - Entry point named `fragmentMain` returning
 *     `@location(0) vec4<f32>`.
 *
 * The vertex stage is provided by the framework — a fullscreen triangle.
 * User shaders only write the fragment.
 *
 * # Uniform schema (Batch 204)
 *
 * Two packing modes:
 *
 * 1. **Schema-driven (preferred)** — the user provides a
 *    `wgslUniformSchema: UniformSchema` uniform alongside
 *    `wgslFragmentShader`. Each entry maps a name to a `(type, offset)`
 *    pair; `_packUniforms` writes the value at the byte offset based on
 *    the type's width (1/2/3/4 floats). Lets the user shader address
 *    uniforms by name (e.g., `uniforms.values[0].x` is the float at
 *    offset 0; `uniforms.values[1].xy` is the vec2 at offset 16, etc.)
 *    and lets the JS provider pass `[1, 0.5, 0.2]` arrays for vec3/4.
 *
 * 2. **Iteration-order (Batch 198 fallback)** — when no schema is
 *    provided, numeric uniforms are packed into floats 0..N in
 *    iteration order. Backwards-compatible with Batch 198 user stages.
 *
 * # Multi-pass (Batch 204)
 *
 * The user can set `wgslNumberOfPasses: number` (default 1) on the
 * stage. The framework runs the SAME pipeline N times in sequence,
 * ping-ponging between two intermediate textures. The current pass
 * index is packed into UBO offset 60 (last float of the 16-float UBO,
 * reserved for framework use); the user shader can read it as
 * `uniforms.values[3].w` and adapt per-pass behavior (e.g., separable
 * Gaussian blur runs horizontal pass at index 0, vertical at index 1).
 *
 * @module WebGPUUserPostProcessStage
 */

/**
 * Batch 204 — named-uniform schema. Each entry maps a uniform name to
 * a (type, offset-in-bytes) pair within the 64-byte UBO. Offsets must
 * respect WGSL alignment rules:
 *   - float: 4-byte aligned, occupies 4 bytes
 *   - vec2: 8-byte aligned, occupies 8 bytes
 *   - vec3 / vec4: 16-byte aligned, occupies 16 bytes (vec3 also 16
 *     because WGSL packs vec3 as vec4 with implicit padding)
 *
 * The framework reserves the last 4 bytes (offset 60) for the per-pass
 * pass-index float — schema entries must not write to offset 60.
 */
export type UniformType = "float" | "vec2" | "vec3" | "vec4";
export interface UniformSchemaEntry {
  type: UniformType;
  offset: number;
}
export type UniformSchema = Record<string, UniformSchemaEntry>;
const PASS_INDEX_OFFSET = 60; // float at offset 60, last slot in 64-byte UBO

// B204-N1 (Batch 205) — bytes actually WRITTEN by `_packUniforms` for
// each schema type. Used by the collision check to decide if a schema
// entry overlaps `PASS_INDEX_OFFSET`. Note vec3 only writes 3 floats
// (12 bytes) here even though WGSL aligns vec3 to a 16-byte slot — the
// collision is about JS writes clobbering the pass-index slot, not
// WGSL layout. So vec3 declared at offset 48 (writes [48..60)) is safe;
// vec4 at offset 48 (writes [48..64)) collides with [60..64).
const SCHEMA_TYPE_BYTES: Record<UniformType, number> = {
  float: 4,
  vec2: 8,
  vec3: 12,
  vec4: 16,
};

// B205-N1 (Batch 213) — WGSL alignment requirements per type. The
// shader-side struct layout follows these rules; if the JS-declared
// offset doesn't match, the JS pack writes data the shader interprets
// at the WRONG offset (silent miscompare — the shader reads garbage,
// the visual result is wrong but no error is thrown).
//   - float: 4-byte aligned, occupies 4 bytes
//   - vec2:  8-byte aligned, occupies 8 bytes
//   - vec3:  16-byte aligned (WGSL pads vec3 to 16), occupies 12 bytes
//           in our pack but the shader reads from a 16-byte slot
//   - vec4:  16-byte aligned, occupies 16 bytes
const SCHEMA_TYPE_ALIGNS: Record<UniformType, number> = {
  float: 4,
  vec2: 8,
  vec3: 16,
  vec4: 16,
};

import type { PostProcessEffect } from "./WebGPUPostProcessEffects.js";

const FULLSCREEN_VS_WGSL = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  var uvs = array<vec2<f32>, 3>(
    vec2<f32>(0.0, 1.0),
    vec2<f32>(2.0, 1.0),
    vec2<f32>(0.0, -1.0),
  );
  var out: VertexOutput;
  out.position = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
  out.uv = uvs[vertexIndex];
  return out;
}
`;

const USER_UNIFORM_FLOAT_COUNT = 16;

export class WebGPUUserPostProcessStage implements PostProcessEffect {
  readonly name: string;
  enabled = true;

  private _device: GPUDevice | null = null;
  private _width = 0;
  private _height = 0;
  private _format: GPUTextureFormat = "rgba8unorm";

  private _pipeline: GPURenderPipeline | null = null;
  private _bindGroupLayout: GPUBindGroupLayout | null = null;
  private _uniformBuffer: GPUBuffer | null = null;
  // Batch 204 multi-pass — TWO intermediate textures for ping-pong.
  // Single-pass stages use only `_intermediateTextureA`. Multi-pass
  // stages alternate A/B with each `numberOfPasses` iteration. The
  // execute() return view always points at the LAST written texture
  // so the caller's chain reads the final pass result.
  private _intermediateTextureA: GPUTexture | null = null;
  private _intermediateTextureB: GPUTexture | null = null;
  private _intermediateViewA: GPUTextureView | null = null;
  private _intermediateViewB: GPUTextureView | null = null;

  // The user's WGSL fragment shader source.
  private readonly _fragmentSource: string;
  // Uniform values map. With schema: vec3/vec4 keys may be number[].
  // Without schema: all values are number (iteration-order packing).
  private readonly _uniformValues: Record<string, number | number[]>;
  // Batch 204 — named-uniform schema. Optional; falls back to
  // iteration-order packing for backwards compat with Batch 198 users.
  private readonly _schema: UniformSchema | undefined;
  // Batch 204 — number of passes; default 1 (single-pass).
  private readonly _numberOfPasses: number;

  constructor(
    name: string,
    fragmentSource: string,
    uniformValues: Record<string, number | number[]>,
    schema?: UniformSchema,
    numberOfPasses?: number,
  ) {
    this.name = name;
    this._fragmentSource = fragmentSource;
    this._uniformValues = uniformValues;
    this._schema = schema;
    // Clamp numberOfPasses to a sane range. 1 is single-pass; >32
    // is almost certainly a user error (Gaussian blurs typically
    // run 1-4 passes). Hard-cap at 32 to prevent runaway loops.
    this._numberOfPasses = Math.max(1, Math.min(32, numberOfPasses ?? 1));
    // B205-N1 (Batch 213) — schema alignment validation. Catches
    // misaligned offsets at construction time so users see one warn
    // per stage instead of silent shader miscompare. Range-overlap
    // with PASS_INDEX_OFFSET is left to per-frame `_packUniforms`
    // because that's also where bounds-out-of-UBO is caught.
    if (schema) this._validateSchema(schema);
  }

  private _validateSchema(schema: UniformSchema): void {
    //>>includeStart('debug', pragmas.debug);
    for (const key in schema) {
      const entry = schema[key];
      const align = SCHEMA_TYPE_ALIGNS[entry.type];
      if (entry.offset % align !== 0) {
        console.warn(
          `[WebGPU:UserPostProcessStage:${this.name}] Schema entry ` +
            `'${key}' (${entry.type} @ offset ${entry.offset}) violates ` +
            `WGSL alignment (must be a multiple of ${align}). The JS ` +
            `pack will write to byte ${entry.offset} but the shader ` +
            `will read from byte ${
              Math.ceil(entry.offset / align) * align
            } — values will mismatch silently. Move the entry to a ` +
            `${align}-byte boundary.`,
        );
      }
    }
    //>>includeEnd('debug');
  }

  initialize(
    device: GPUDevice,
    width: number,
    height: number,
    format: GPUTextureFormat,
  ): void {
    this._device = device;
    this._width = width;
    this._height = height;
    this._format = format;

    // Concatenate the fixed VS with the user's FS into one shader
    // module so a single pipeline drives the stage. The user FS must
    // declare the bindings + `fragmentMain` entry per the convention
    // documented at the top of the file.
    const wgsl = FULLSCREEN_VS_WGSL + "\n" + this._fragmentSource;

    let module: GPUShaderModule;
    try {
      module = device.createShaderModule({
        label: `UserPostProcessStage[${this.name}] module`,
        code: wgsl,
      });
    } catch (e) {
      console.error(
        `[CesiumJS:WebGPU] User PostProcessStage "${this.name}" WGSL ` +
          `compilation failed:`,
        e,
      );
      this.enabled = false;
      return;
    }

    this._bindGroupLayout = device.createBindGroupLayout({
      label: `UserPostProcessStage[${this.name}] BGL`,
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      label: `UserPostProcessStage[${this.name}] layout`,
      bindGroupLayouts: [this._bindGroupLayout],
    });

    this._pipeline = device.createRenderPipeline({
      label: `UserPostProcessStage[${this.name}] pipeline`,
      layout: pipelineLayout,
      vertex: { module, entryPoint: "vertexMain" },
      fragment: {
        module,
        entryPoint: "fragmentMain",
        targets: [{ format }],
      },
      primitive: { topology: "triangle-list" },
    });

    this._uniformBuffer = device.createBuffer({
      label: `UserPostProcessStage[${this.name}] UBO`,
      size: USER_UNIFORM_FLOAT_COUNT * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._allocateIntermediate(width, height);
  }

  resize(width: number, height: number): void {
    if (this._width === width && this._height === height) return;
    this._width = width;
    this._height = height;
    this._allocateIntermediate(width, height);
  }

  execute(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    _depthView: GPUTextureView | null,
    sampler: GPUSampler,
  ): GPUTextureView {
    if (!this._pipeline || !this._intermediateViewA || !this._device) {
      // Init failure or intermediate not allocated — fall through with
      // the source view unchanged so the chain doesn't break.
      return sourceView;
    }

    // Batch 204 multi-pass — for `numberOfPasses > 1`, ping-pong
    // between A and B intermediates: pass 0 reads sourceView, writes
    // A; pass 1 reads A, writes B; pass 2 reads B, writes A; etc.
    // Final return view is whichever was written last.
    let currentSource = sourceView;
    let lastWrittenView: GPUTextureView = this._intermediateViewA;
    for (let passIdx = 0; passIdx < this._numberOfPasses; passIdx++) {
      // Pack uniforms each pass — pass-index slot updates per-iteration
      // so the user shader can branch on pass number (e.g., separable
      // blur runs horizontal at index 0, vertical at index 1).
      this._packUniforms(passIdx);

      // Pick destination view: alternate A/B for multi-pass, A only
      // for single-pass. We write to the texture NOT being read from.
      // Single-pass case (numberOfPasses === 1): always write to A.
      const writeToA = passIdx % 2 === 0;
      const targetView = writeToA
        ? this._intermediateViewA
        : (this._intermediateViewB ?? this._intermediateViewA);
      lastWrittenView = targetView;

      this._dispatchOnePass(encoder, currentSource, sampler, targetView);

      // Next pass reads what we just wrote.
      currentSource = targetView;
    }

    return lastWrittenView;
  }

  private _dispatchOnePass(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    sampler: GPUSampler,
    targetView: GPUTextureView,
  ): void {
    const bindGroup = this._device!.createBindGroup({
      label: `UserPostProcessStage[${this.name}] BG`,
      layout: this._bindGroupLayout!,
      entries: [
        { binding: 0, resource: sourceView },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: this._uniformBuffer! } },
      ],
    });

    const pass = encoder.beginRenderPass({
      label: `UserPostProcessStage[${this.name}] pass`,
      colorAttachments: [
        {
          view: targetView,
          loadOp: "clear" as GPULoadOp,
          storeOp: "store" as GPUStoreOp,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    pass.setPipeline(this._pipeline!);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  destroy(): void {
    this._intermediateTextureA?.destroy();
    this._intermediateTextureB?.destroy();
    this._uniformBuffer?.destroy();
    this._pipeline = null;
    this._bindGroupLayout = null;
    this._uniformBuffer = null;
    this._intermediateTextureA = null;
    this._intermediateTextureB = null;
    this._intermediateViewA = null;
    this._intermediateViewB = null;
    this._device = null;
  }

  // ── private ──

  private _allocateIntermediate(width: number, height: number): void {
    if (!this._device) return;
    this._intermediateTextureA?.destroy();
    this._intermediateTextureB?.destroy();
    const w = Math.max(width, 1);
    const h = Math.max(height, 1);
    const usage =
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this._intermediateTextureA = this._device.createTexture({
      label: `UserPostProcessStage[${this.name}] intermediate-A`,
      size: [w, h],
      format: this._format,
      usage,
    });
    this._intermediateViewA = this._intermediateTextureA.createView();
    // Batch 204 — only allocate B when multi-pass is active. Saves
    // VRAM for the common single-pass case (most user stages won't
    // use multi-pass).
    if (this._numberOfPasses > 1) {
      this._intermediateTextureB = this._device.createTexture({
        label: `UserPostProcessStage[${this.name}] intermediate-B`,
        size: [w, h],
        format: this._format,
        usage,
      });
      this._intermediateViewB = this._intermediateTextureB.createView();
    } else {
      this._intermediateTextureB = null;
      this._intermediateViewB = null;
    }
  }

  /**
   * Batch 204 — pack uniforms per-pass. Schema-driven mode writes by
   * named offset + type; iteration-order mode (Batch 198 fallback)
   * writes scalars to floats 0..N. The pass index is always written to
   * `PASS_INDEX_OFFSET` (offset 60) regardless of mode — schema users
   * read it as `uniforms.values[3].w`; iteration-order users get it
   * at the same physical slot as long as their uniforms don't pack
   * past float index 14.
   */
  private _packUniforms(passIndex: number): void {
    if (!this._device || !this._uniformBuffer) return;
    const buf = new Float32Array(USER_UNIFORM_FLOAT_COUNT);
    if (this._schema) {
      // Schema-driven: write each uniform at its declared offset.
      for (const key in this._schema) {
        const entry = this._schema[key];
        const value = this._uniformValues[key];
        if (value === undefined) continue;
        // B204-N1 (Batch 205) — PASS_INDEX_OFFSET is reserved for the
        // framework. Detect range overlap, not just an exact-offset
        // match: a vec4 declared at offset 48 spans bytes [48..64) and
        // its .w component would silently be clobbered by the pass
        // index write at byte 60. Same shape for vec3@52, vec2@56,
        // float@60, plus any out-of-range offset >=64. Skip + warn so
        // the schema author can move the entry to a safe offset.
        const entrySize = SCHEMA_TYPE_BYTES[entry.type];
        if (
          entry.offset + entrySize > PASS_INDEX_OFFSET ||
          entry.offset + entrySize > USER_UNIFORM_FLOAT_COUNT * 4
        ) {
          //>>includeStart('debug', pragmas.debug);
          console.warn(
            `[WebGPU:UserPostProcessStage] Schema entry '${key}' (` +
              `${entry.type} @ offset ${entry.offset}) collides with ` +
              `the reserved PASS_INDEX_OFFSET (${PASS_INDEX_OFFSET}) ` +
              `or exceeds the ${USER_UNIFORM_FLOAT_COUNT * 4}-byte UBO. ` +
              `Move it to an earlier offset; entry skipped.`,
          );
          //>>includeEnd('debug');
          continue;
        }
        const floatIdx = entry.offset / 4;
        switch (entry.type) {
          case "float":
            if (typeof value === "number") buf[floatIdx] = value;
            break;
          case "vec2":
            if (Array.isArray(value) && value.length >= 2) {
              buf[floatIdx] = value[0];
              buf[floatIdx + 1] = value[1];
            }
            break;
          case "vec3":
            if (Array.isArray(value) && value.length >= 3) {
              buf[floatIdx] = value[0];
              buf[floatIdx + 1] = value[1];
              buf[floatIdx + 2] = value[2];
            }
            break;
          case "vec4":
            if (Array.isArray(value) && value.length >= 4) {
              buf[floatIdx] = value[0];
              buf[floatIdx + 1] = value[1];
              buf[floatIdx + 2] = value[2];
              buf[floatIdx + 3] = value[3];
            }
            break;
        }
      }
    } else {
      // Iteration-order fallback (Batch 198 backwards-compat path).
      let i = 0;
      for (const key in this._uniformValues) {
        if (i >= USER_UNIFORM_FLOAT_COUNT - 1) break;
        const v = this._uniformValues[key];
        if (typeof v === "number") {
          buf[i++] = v;
        }
      }
    }
    // Pass index always at the reserved slot (last float of the UBO).
    buf[PASS_INDEX_OFFSET / 4] = passIndex;
    this._device.queue.writeBuffer(this._uniformBuffer, 0, buf.buffer);
  }
}
