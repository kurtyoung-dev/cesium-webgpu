/**
 * Globe-material pipeline factory plus UBO and texture wiring. Bridges the
 * parallel WGSL fabric API (`material.wgslShaderSource` emitted by
 * `MaterialHelpers.createWGSLMethodDefinition`) into the WebGPU globe
 * renderer.
 *
 * Flow per `globe.material` instance:
 *
 *   1. **Source assembly** — concatenate a WGSL prelude (MaterialUniforms
 *      struct + uniform-name aliases for the material's uniforms) with
 *      the material's WGSL function body and the base GlobeTerrain.wgsl
 *      source. Cache the result keyed on `material.type`.
 *   2. **Module + pipeline** — create one shader module per unique
 *      material; the pipeline reuses the regular `_pipelineLayout`
 *      from {@link WebGPUGlobeSurfaceLayouts} (material slots live in
 *      Group 2 alongside water-mask / ocean-normal, so the total
 *      bind-group count stays at the WebGPU spec floor of 4).
 *   3. **Per-frame UBO pack** — pack the material's scalar/vec uniform
 *      values into the cached `GPUBuffer`. The bind group is built
 *      per-tile alongside water/ocean (see `_createWaterOceanMaterial
 *      BindGroup` on the renderer).
 *
 * Limitations:
 *   - Single-pipeline material support, i.e. one `globe.material` at a
 *     time. Switching materials invalidates the cache, so demos with
 *     toolbar-driven material changes pay a one-time rebuild cost.
 *   - Texture support limited to the two slots declared in
 *     `_bindGroupLayout2` (binding 5 / binding 7). The in-tree globe
 *     materials (ElevationRamp, SlopeRamp, AspectRamp, DiffuseMap,
 *     ElevationBand, WaterMask) all fit within this. ElevationBand uses
 *     both slots (heights, colors); others use binding 5 only.
 *   - No support for compound/composite fabric trees; only the
 *     single-material cases resolve.
 *
 * @private
 * @module WebGPUGlobeMaterial
 */
/// <reference types="@webgpu/types" />

/**
 * The subset of the Cesium Material class this module depends on. Locally
 * declared because the Cesium core types aren't exposed through the WebGPU
 * renderer's type surface; only the consumed fields are listed.
 */
interface CesiumMaterial {
  type: string;
  uniforms: Record<string, unknown>;
  wgslShaderSource: string;
  shaderSource?: string;
}

export interface MaterialPipelineHost {
  readonly _device: GPUDevice | null;
  _placeholderView: GPUTextureView | null;
  _sampler: GPUSampler | null;
}

export interface MaterialPipelineCacheEntry {
  // Combined WGSL source (material prelude + material body + base shader).
  // Kept around for diagnostics / pipeline rebuilds after device-loss.
  wgslSource: string;
  // The compiled shader module — created once per unique material.
  shaderModule: GPUShaderModule;
  // Per-uniform name → byte offset map for the material UBO. Used by
  // {@link writeMaterialUBO} to pack the JS Material.uniforms into the
  // GPU buffer each frame.
  uboLayout: Map<string, MaterialUniformSlot>;
  // Total UBO size in bytes, rounded up to a 16-byte multiple (WebGPU
  // uniform buffer requirement).
  uboSize: number;
  // Texture-uniform names this material binds, in declared order.
  // First entry binds to group(4)@binding(1)/2, second to binding(3)/4.
  textureNames: string[];
  // Reusable GPU buffer for the material UBO — recreated when the
  // material changes (different uboSize).
  ubo: GPUBuffer;
  // Per-pipeline-variant cache. Material-keyed caches still need to
  // multiplex over geometry variants (quantized vs uncompressed,
  // hasNormals, hasWebMercatorT, strideBytes, etc.) — same key shape
  // as the base pipeline cache, just on a separate per-material map.
  pipelines: Map<string, GPURenderPipeline>;
}

export interface MaterialUniformSlot {
  offset: number; // byte offset
  size: number; // byte size (4=f32, 8=vec2, 12=vec3, 16=vec4, 64=mat4)
  componentType: "f32" | "vec2" | "vec3" | "vec4" | "mat4" | "i32" | "bool";
}

// Detect the component type from a Cesium uniform default value.
// Mirrors the layout decisions in `MaterialUniformBuffer` (Cesium-side).
function inferComponentType(
  value: unknown,
): MaterialUniformSlot["componentType"] {
  if (typeof value === "number") return "f32";
  if (typeof value === "boolean") return "bool";
  const v = value as {
    red?: number;
    x?: number;
    y?: number;
    z?: number;
    w?: number;
  };
  if (v && typeof v.red === "number") return "vec4"; // Color
  if (v && typeof v.w === "number") return "vec4"; // Cartesian4
  if (v && typeof v.z === "number") return "vec3"; // Cartesian3
  if (v && typeof v.y === "number") return "vec2"; // Cartesian2
  return "f32"; // fallback
}

function componentTypeSize(t: MaterialUniformSlot["componentType"]): number {
  switch (t) {
    case "f32":
    case "i32":
    case "bool":
      return 4;
    case "vec2":
      return 8;
    case "vec3":
      return 16; // vec3 in WGSL uniform takes 16 bytes (alignment)
    case "vec4":
      return 16;
    case "mat4":
      return 64;
  }
}

function componentTypeAlign(t: MaterialUniformSlot["componentType"]): number {
  switch (t) {
    case "f32":
    case "i32":
    case "bool":
      return 4;
    case "vec2":
      return 8;
    case "vec3":
    case "vec4":
    case "mat4":
      return 16;
  }
}

// Reserved uniform names that don't get packed (textures, string tokens,
// URLs, etc.). Anything matching these is excluded from the UBO and
// either handled as a texture (image/heights/colors) or ignored at
// pack time.
function isTextureUniform(name: string, value: unknown): boolean {
  if (typeof value === "string") return true;
  if (value instanceof HTMLImageElement || value instanceof HTMLCanvasElement) {
    return true;
  }
  if (typeof value === "object" && value !== null) {
    const v = value as { _isPlaceholder?: boolean; image?: unknown };
    if (v._isPlaceholder) return true;
  }
  return false;
}

// Reserved names that aren't real WGSL identifiers (channel selector
// like "rgb" or "a"). These come from the Cesium fabric and are
// referenced as string-literals inside the GLSL/WGSL component
// expressions rather than as uniforms. Skip at UBO-pack time.
function isStringTokenUniform(value: unknown): boolean {
  return (
    typeof value === "string" && !value.startsWith("http") && value.length <= 4
  );
}

/**
 * Walk a material + its sub-materials, returning a flat map of uniform
 * name → value. Sub-material uniforms get included so composite WGSL
 * fabrics (e.g., Bathymetry's `ElevationColorContour` fusing
 * `ElevationContour` + `ElevationRamp`) can resolve their nested
 * uniform references against a single aggregate UBO. Parent uniforms
 * take precedence on name collision, matching the GLSL semantics where
 * the composite's own uniform overrides any sub-material's same-named
 * one.
 */
export function aggregateCompositeUniforms(
  material: CesiumMaterial,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const subMaterials = (
    material as unknown as { materials?: Record<string, CesiumMaterial> }
  ).materials;
  if (subMaterials) {
    for (const subId of Object.keys(subMaterials)) {
      const subUniforms = aggregateCompositeUniforms(subMaterials[subId]);
      for (const [k, v] of Object.entries(subUniforms)) {
        // Skip internal back-references emitted by the MaterialUniformBuffer
        // facade (e.g., `_buffer` points back at the buffer itself).
        // These aren't real uniform values and would pollute the UBO
        // layout with a phantom field.
        if (k.startsWith("_")) continue;
        result[k] = v;
      }
    }
  }
  const ownUniforms = (
    material as unknown as { uniforms?: Record<string, unknown> }
  ).uniforms;
  if (ownUniforms) {
    for (const [k, v] of Object.entries(ownUniforms)) {
      if (k.startsWith("_")) continue;
      result[k] = v;
    }
  }
  return result;
}

/**
 * Build the WGSL prelude for a material — declares a `MaterialUniforms`
 * struct mirroring the material's uniforms, binds it at
 * `@group(2) @binding(4)`, and emits `let`-aliases at the top of
 * `czm_getMaterial` so the material's component expressions reference
 * bare uniform names just like GLSL does.
 *
 * The textures are already declared in GlobeTerrain.wgsl at
 * `@group(2) @binding(5)` (image) and `@group(2) @binding(7)`
 * (heights/colors); the prelude doesn't redeclare them.
 *
 * Returns `null` if the material has no useful uniforms, in which case
 * the caller should skip the material pipeline path.
 */
export function buildMaterialPrelude(material: CesiumMaterial): {
  prelude: string;
  uboLayout: Map<string, MaterialUniformSlot>;
  uboSize: number;
  textureNames: string[];
} | null {
  const uniforms = aggregateCompositeUniforms(material);

  const layout = new Map<string, MaterialUniformSlot>();
  const textureNames: string[] = [];
  const fields: { name: string; type: MaterialUniformSlot["componentType"] }[] =
    [];

  for (const [name, value] of Object.entries(uniforms)) {
    if (isTextureUniform(name, value)) {
      textureNames.push(name);
      continue;
    }
    if (isStringTokenUniform(value)) {
      // Channel selectors (`"rgb"`, `"a"`) live as compile-time strings
      // in the fabric expressions. Not packable.
      continue;
    }
    const t = inferComponentType(value);
    fields.push({ name, type: t });
  }

  if (fields.length === 0 && textureNames.length === 0) return null;

  // Pack UBO fields with WGSL alignment rules.
  let offset = 0;
  for (const f of fields) {
    const align = componentTypeAlign(f.type);
    offset = Math.ceil(offset / align) * align;
    layout.set(f.name, {
      offset,
      size: componentTypeSize(f.type),
      componentType: f.type,
    });
    offset += componentTypeSize(f.type);
  }
  // Round UBO size up to 16-byte multiple.
  const uboSize = Math.max(16, Math.ceil(offset / 16) * 16);

  // Emit WGSL struct + binding + aliases.
  let prelude = "struct MaterialUniforms {\n";
  for (const f of fields) {
    const wgslType =
      f.type === "f32" || f.type === "i32" || f.type === "bool"
        ? "f32"
        : f.type === "vec2"
          ? "vec2<f32>"
          : f.type === "vec3"
            ? "vec3<f32>"
            : f.type === "vec4"
              ? "vec4<f32>"
              : "mat4x4<f32>";
    prelude += `  ${f.name}: ${wgslType},\n`;
  }
  prelude += "};\n";
  // Material UBO lives at @group(2) @binding(4) — merged into the
  // water/ocean/material group to stay within WebGPU's `maxBindGroups: 4`
  // spec floor (some implementations report exactly 4).
  prelude +=
    "@group(2) @binding(4) var<uniform> materialUniforms: MaterialUniforms;\n";

  return { prelude, uboLayout: layout, uboSize, textureNames };
}

/**
 * Rewrite the material's WGSL body to reference uniforms as
 * `materialUniforms.<name>` rather than bare `<name>`. Texture uniform
 * names (those in `textureNames`) stay bare so they pick up the WGSL
 * texture bindings declared in GlobeTerrain.wgsl.
 *
 * Whole-word match only (word boundaries via lookahead/behind) so
 * `color.rgb` becomes `materialUniforms.color.rgb` cleanly without
 * mangling `colors` or `colorTexture`.
 */
export function rewriteMaterialBody(
  body: string,
  uboLayout: Map<string, MaterialUniformSlot>,
  textureNames: string[],
): string {
  // Sort names longest-first so longer names match first, which prevents
  // `color` from rewriting `colors`.
  const names = [...uboLayout.keys()].sort((a, b) => b.length - a.length);
  // Build a single regex with alternation; word boundaries surround
  // each name. WGSL identifier chars include letters/digits/underscore.
  if (names.length === 0) return body;
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(
    `(^|[^A-Za-z0-9_.])(${escaped.join("|")})(?![A-Za-z0-9_])`,
    "g",
  );
  // Skip the rewrite for texture-name aliases — they're declared as
  // module-scope `var` bindings in the base shader, not in the UBO.
  const textureSet = new Set(textureNames);
  return body.replace(re, (_match, pre, name) => {
    if (textureSet.has(name)) return `${pre}${name}`;
    return `${pre}materialUniforms.${name}`;
  });
}

/**
 * Resolve a texture-uniform value to a `GPUTextureView`. Cesium materials
 * carry texture uniforms either as Cesium WebGL `Texture` instances (the
 * core upload path) OR as the WebGPU stub placeholder (when the WebGPU
 * stub texture stack already wraps the resource). The renderer's existing
 * imagery texture cache uploads either form to a backing `GPUTexture`, so
 * this only has to pull the WebGPU view out of whichever shape arrives.
 *
 * Returns `null` when the texture isn't a recognized shape — caller binds
 * the placeholder view.
 */
export function resolveMaterialTextureView(
  value: unknown,
): GPUTextureView | null {
  if (!value || typeof value !== "object") return null;
  const v = value as {
    _webgpuTexture?: { view?: GPUTextureView };
    _webgpuReprojectedTexture?: { createView?: () => GPUTextureView };
    view?: GPUTextureView;
  };
  // The Cesium-side WebGLStubTexture stack stashes the WebGPU resource
  // under `_webgpuTexture.view`.
  if (v._webgpuTexture?.view) return v._webgpuTexture.view;
  // Imagery-reprojection path stashes a GPUTexture directly.
  if (v._webgpuReprojectedTexture?.createView) {
    return v._webgpuReprojectedTexture.createView();
  }
  if (v.view) return v.view;
  return null;
}

/**
 * Assemble the full material-augmented WGSL source: prepend the
 * material's prelude + rewritten body to the base GlobeTerrain.wgsl
 * source. Caller is responsible for running the result through the
 * preprocessor with `MATERIAL_APPLY` set.
 */
export function assembleMaterialWGSLSource(
  baseSource: string,
  prelude: string,
  rewrittenBody: string,
): string {
  // Module-scope diagnostic directive suppressing WGSL's
  // `derivative_uniformity` analysis for the whole material module. The globe
  // FS has conditional `discard` / early-return branches (clipping planes,
  // clipping polygons, cartographic-rect limit, alpha-test) that make control
  // flow non-uniform from the uniformity analyser's perspective, while some
  // globe materials (`ElevationContour`, used by the Bathymetry demo) call
  // `dpdx`/`dpdy` to compute contour-line widths. The diagnostic is a false
  // positive there: fragments that should have discarded never write their
  // derivative value to any output. A module-scope diagnostic directive has to
  // be the first non-comment line in the source.
  const diagnostic = "diagnostic(off, derivative_uniformity);\n";
  return `${diagnostic}${prelude}\n${rewrittenBody}\n${baseSource}`;
}

/**
 * Write the material's uniform values into a Float32Array slice using
 * the layout produced by {@link buildMaterialPrelude}. Returns a
 * `Uint8Array` view sized for the UBO; callers pass it directly to
 * `device.queue.writeBuffer`.
 */
export function packMaterialUBO(
  material: CesiumMaterial,
  layout: Map<string, MaterialUniformSlot>,
  uboSize: number,
): Uint8Array {
  const buf = new ArrayBuffer(uboSize);
  const f32 = new Float32Array(buf);
  // Pull from the aggregated composite-uniforms view so packs of composite
  // fabrics (Bathymetry's `ElevationColorContour`) reach the nested
  // sub-material values, not just the parent's own top-level uniforms, which
  // are typically empty in the pure-fusion case.
  const uniforms = aggregateCompositeUniforms(material);
  for (const [name, slot] of layout) {
    const v = uniforms[name];
    const baseFloat = slot.offset / 4;
    if (typeof v === "number") {
      f32[baseFloat] = v;
    } else if (typeof v === "boolean") {
      f32[baseFloat] = v ? 1.0 : 0.0;
    } else if (typeof v === "object" && v !== null) {
      const c = v as {
        red?: number;
        green?: number;
        blue?: number;
        alpha?: number;
        x?: number;
        y?: number;
        z?: number;
        w?: number;
      };
      // Color: r/g/b/a → x/y/z/w
      if (typeof c.red === "number") {
        f32[baseFloat] = c.red;
        f32[baseFloat + 1] = c.green ?? 0;
        f32[baseFloat + 2] = c.blue ?? 0;
        f32[baseFloat + 3] = c.alpha ?? 1;
      } else if (typeof c.x === "number") {
        f32[baseFloat] = c.x;
        if (typeof c.y === "number") f32[baseFloat + 1] = c.y;
        if (typeof c.z === "number") f32[baseFloat + 2] = c.z;
        if (typeof c.w === "number") f32[baseFloat + 3] = c.w;
      }
    }
  }
  return new Uint8Array(buf);
}
