/**
 * @module WebGPUBindGroupReflection
 *
 * Converts naga's `validate_wgsl` reflection JSON into
 * `GPUBindGroupLayoutDescriptor`s. Closes the loop on the Naga spike:
 * with this helper, a stub consumer that translates GLSL→WGSL can
 * also auto-derive the bind group layouts required to build a
 * pipeline, without the caller having to know the source shader's
 * uniform structure up front.
 *
 * Usage:
 *
 *   import { validate_wgsl } from "…/naga-wasm/naga_wasm.js";
 *   import {
 *     parseNagaReflection,
 *     buildBindGroupLayoutDescriptors,
 *   } from "@cesium/engine";
 *
 *   const reflection = parseNagaReflection(validate_wgsl(wgslSource));
 *   const layouts = buildBindGroupLayoutDescriptors(reflection, {
 *     stage: GPUShaderStage.FRAGMENT,
 *   });
 *   // layouts[0] is group 0's descriptor, layouts[1] is group 1's, etc.
 *   const bgls = layouts.map((desc) => device.createBindGroupLayout(desc));
 *
 * The function returns one descriptor per DECLARED group (sparse
 * groups are skipped — if your shader uses group 0 and group 2, you
 * get two descriptors keyed on 0 and 2, not three with an empty 1).
 */

/// <reference types="@webgpu/types" />

/**
 * Shape of the JSON that `validate_wgsl` returns. Mirrors what
 * `packages/wasm-naga/src/lib.rs::validate_wgsl` emits. Optional
 * fields are `undefined` for bindings that don't carry the
 * corresponding WebGPU attribute (e.g. `sampleType` only exists on
 * texture + sampler bindings).
 */
export interface NagaReflection {
  entryPoints: Array<{
    name: string;
    stage: "vertex" | "fragment" | "compute" | "task" | "mesh";
  }>;
  bindings: Array<NagaBinding>;
}

export interface NagaBinding {
  name: string;
  group: number;
  binding: number;
  kind:
    | "uniform-buffer"
    | "storage-buffer"
    | "texture"
    | "sampler"
    | "storage-texture"
    | "external-texture"
    | "unknown";
  /** For textures: "float" / "unfilterable-float" / "uint" / "sint" / "depth". */
  /** For samplers: "filtering" / "non-filtering" / "comparison". */
  sampleType?: string;
  /** For textures: "1d" / "2d" / "2d-array" / "cube" / "cube-array" / "3d". */
  viewDimension?: string;
  /** For textures: true if multisampled. */
  multisampled?: boolean;
  /** For storage buffers / textures: "read" / "write" / "read_write". */
  access?: string;
  /** For uniform / storage buffers: inferred struct byte size. */
  minBindingSize?: number;
}

/**
 * Parse the JSON string `validate_wgsl` returned into a typed
 * reflection object. Throws with a clear message if the JSON is
 * malformed (shouldn't happen if naga produced it, but consumers
 * sometimes round-trip the output through external pipelines).
 */
export function parseNagaReflection(jsonText: string): NagaReflection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(
      `parseNagaReflection: input is not valid JSON — ${(e as Error).message}`,
    );
  }
  // Minimal structural validation. We don't recursively check every
  // binding field; we just check the top-level shape so callers hit
  // a clear error before they feed garbage into `buildBindGroup…`.
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as NagaReflection).entryPoints) ||
    !Array.isArray((parsed as NagaReflection).bindings)
  ) {
    throw new Error(
      "parseNagaReflection: missing top-level `entryPoints` or `bindings` arrays",
    );
  }
  return parsed as NagaReflection;
}

/**
 * Build one `GPUBindGroupLayoutDescriptor` per group declared in
 * the reflection. Options let the caller specify which shader stages
 * each entry is visible to — typically `VERTEX | FRAGMENT` or a
 * single-stage compute value.
 *
 * The map's keys are the group indices (as they appeared in the WGSL).
 * Sparse groups — e.g., shader uses group 0 and group 2 — produce
 * a two-entry map with keys 0 and 2, not a three-entry map with an
 * empty group 1. Consumers that need dense arrays should call
 * `Object.values(map)` on the filtered output.
 */
export function buildBindGroupLayoutDescriptors(
  reflection: NagaReflection,
  options?: {
    /** Shader-stage bitmask applied to every entry. Default: VERTEX | FRAGMENT | COMPUTE. */
    visibility?: GPUShaderStageFlags;
    /** Label prefix for generated descriptors. Appended with `" group N"`. */
    labelPrefix?: string;
  },
): Map<number, GPUBindGroupLayoutDescriptor> {
  const visibility =
    options?.visibility ??
    GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE;
  const labelPrefix = options?.labelPrefix ?? "NagaReflection";

  // Bucket entries by group number. WebGPU requires one BGL per
  // group, and groups are independent — entries in group 0 don't
  // affect group 1's layout at all.
  const byGroup = new Map<number, GPUBindGroupLayoutEntry[]>();
  for (const b of reflection.bindings) {
    if (b.kind === "unknown") {
      // Naga couldn't classify this binding (mesh-shader-only types
      // on WebGPU that doesn't support them, etc.). Skip rather than
      // emit an invalid entry that `createBindGroupLayout` will
      // reject cryptically.
      continue;
    }
    const entry = bindingToLayoutEntry(b, visibility);
    if (!entry) continue;
    const list = byGroup.get(b.group);
    if (list) {
      list.push(entry);
    } else {
      byGroup.set(b.group, [entry]);
    }
  }

  // Produce one descriptor per group. Sort entries by binding index
  // for stable output — WebGPU doesn't require sorted entries, but
  // snapshot tests and diff-based review tools are easier to read.
  const result = new Map<number, GPUBindGroupLayoutDescriptor>();
  for (const [group, entries] of byGroup) {
    entries.sort((a, b) => a.binding - b.binding);
    result.set(group, {
      label: `${labelPrefix} group ${group}`,
      entries,
    });
  }
  return result;
}

/**
 * Translate one reflection binding into a WebGPU layout entry.
 * Returns `null` if the binding's `kind` is unrecognized — the
 * caller filters these out to avoid an invalid descriptor.
 */
function bindingToLayoutEntry(
  b: NagaBinding,
  visibility: GPUShaderStageFlags,
): GPUBindGroupLayoutEntry | null {
  const entry: GPUBindGroupLayoutEntry = {
    binding: b.binding,
    visibility,
  };

  switch (b.kind) {
    case "uniform-buffer":
      entry.buffer = {
        type: "uniform",
        // minBindingSize helps WebGPU reject mismatched bindings at
        // pipeline-creation time. Defaults to undefined (no check)
        // when naga couldn't infer a fixed size — typically for
        // structs containing runtime-sized arrays.
        ...(b.minBindingSize !== undefined && b.minBindingSize > 0
          ? { minBindingSize: b.minBindingSize }
          : {}),
      };
      break;
    case "storage-buffer":
      entry.buffer = {
        type:
          b.access === "read_write"
            ? "storage"
            : b.access === "write"
              ? "storage"
              : "read-only-storage",
        ...(b.minBindingSize !== undefined && b.minBindingSize > 0
          ? { minBindingSize: b.minBindingSize }
          : {}),
      };
      break;
    case "texture":
      entry.texture = {
        sampleType: mapSampleType(b.sampleType),
        viewDimension: mapViewDimension(b.viewDimension),
        multisampled: b.multisampled ?? false,
      };
      break;
    case "storage-texture":
      entry.storageTexture = {
        // The WGSL declaration carries a format but naga's reflection
        // doesn't surface it through this minimal JSON yet. `rgba8unorm`
        // is the safest default for most Cesium use cases; consumers
        // that need specific formats should override after calling
        // this builder or add format to the reflection Rust side.
        format: "rgba8unorm",
        access:
          b.access === "read_write"
            ? "read-write"
            : b.access === "write"
              ? "write-only"
              : "read-only",
        viewDimension: mapViewDimension(b.viewDimension),
      };
      break;
    case "sampler":
      entry.sampler = {
        type: mapSamplerType(b.sampleType),
      };
      break;
    case "external-texture":
      // Gated on the "external_texture" WebGPU feature; the descriptor
      // is empty-object shaped. No `sampleType` / `viewDimension`.
      entry.externalTexture = {};
      break;
    default:
      return null;
  }
  return entry;
}

function mapSampleType(raw: string | undefined): GPUTextureSampleType {
  switch (raw) {
    case "float":
      return "float";
    case "unfilterable-float":
      return "unfilterable-float";
    case "depth":
      return "depth";
    case "uint":
      return "uint";
    case "sint":
      return "sint";
    default:
      return "float";
  }
}

function mapViewDimension(raw: string | undefined): GPUTextureViewDimension {
  switch (raw) {
    case "1d":
      return "1d";
    case "2d":
      return "2d";
    case "2d-array":
      return "2d-array";
    case "cube":
      return "cube";
    case "cube-array":
      return "cube-array";
    case "3d":
      return "3d";
    default:
      return "2d";
  }
}

function mapSamplerType(raw: string | undefined): GPUSamplerBindingType {
  switch (raw) {
    case "comparison":
      return "comparison";
    case "non-filtering":
      return "non-filtering";
    default:
      return "filtering";
  }
}

// ─── Program-level BGL auto-derive ──────────────────────────────────
//
// Downstream consumers of the WebGL compatibility stub don't deal with
// raw naga JSON — they get a program object back from `gl.linkProgram`
// and an engine-shape `ShaderReflection` for each stage. This helper
// turns those two reflections into ready-to-bind `GPUBindGroupLayout`
// objects on a specific device, doing the stage-visibility merge that
// WebGL/WGSL's linkage model hides from the caller.
//
// Typical pipeline-builder call:
//
//   const compiled = await getCompiledShaderForProgram(program);
//   if (!compiled) throw new Error("link failed");
//   const bgls = buildBindGroupLayoutsFromProgram({
//     device,
//     vertex:   compiled.vertexReflection,
//     fragment: compiled.fragmentReflection,
//   });
//   // bgls is Map<groupIndex, GPUBindGroupLayout>
//
// Rationale for doing the merge here (not in each call site):
//   - The same binding appears in BOTH stage reflections when it's
//     used by both (uniform buffers usually, sometimes textures).
//     WebGPU layouts take a single `visibility` bitmask per entry,
//     not one entry per stage — so we OR them together.
//   - Bindings only used by one stage get that stage's bit alone;
//     the other's is zero. WebGPU forbids entries with visibility=0,
//     so the default falls back to VERTEX|FRAGMENT if neither
//     reflection had the binding (shouldn't happen, belt-and-braces).

/**
 * ShaderReflection shape used by the program-level helper. Matches
 * the interface exported from `WebGPUShaderTranslator.ts` but
 * re-declared here to avoid a circular import (this module is
 * reached through the reflection helpers, and the translator types
 * are in turn re-exported through the stub nexus).
 */
interface ProgramStageReflection {
  stage: "vertex" | "fragment" | "compute" | "task" | "mesh";
  uniformBuffers: ReadonlyArray<{
    group: number;
    binding: number;
    name: string;
    sizeBytes: number;
  }>;
  textures: ReadonlyArray<{
    group: number;
    binding: number;
    name: string;
    viewDimension: GPUTextureViewDimension;
    sampleType: "float" | "unfilterable-float" | "depth" | "sint" | "uint";
    multisampled: boolean;
  }>;
  samplers: ReadonlyArray<{
    group: number;
    binding: number;
    name: string;
    type: GPUSamplerBindingType;
  }>;
}

export interface BuildBindGroupLayoutsFromProgramOptions {
  /** GPUDevice the returned layouts are created on. Required. */
  device: GPUDevice;
  /** Vertex-stage reflection from the compiled program. */
  vertex: ProgramStageReflection;
  /** Fragment-stage reflection from the compiled program. */
  fragment?: ProgramStageReflection;
  /** Optional compute-stage reflection (compute pipelines). */
  compute?: ProgramStageReflection;
  /** Label prefix — appended with ` group N`. Default: "Program". */
  labelPrefix?: string;
}

/**
 * Build + create `GPUBindGroupLayout` objects for every group referenced
 * by any of the provided stage reflections. Stage visibility is
 * merged (OR-ed) across stages per-binding so a uniform used by both
 * vertex + fragment gets `VERTEX | FRAGMENT` on its layout entry.
 *
 * Returns a map keyed by group index. Sparse groups remain sparse
 * (if the shaders only declare groups 0 and 2, the map has two keys).
 *
 * @param options See type
 * @returns Map of group index → GPUBindGroupLayout (ready to bind)
 */
export function buildBindGroupLayoutsFromProgram(
  options: BuildBindGroupLayoutsFromProgramOptions,
): Map<number, GPUBindGroupLayout> {
  const { device, vertex, fragment, compute, labelPrefix } = options;
  const prefix = labelPrefix ?? "Program";

  // Walk every binding across all provided stages and bucket by
  // (group, binding). We accumulate stage visibility as we go so a
  // binding used by both stages ends up with both bits set.
  type PartialEntry = {
    entry: GPUBindGroupLayoutEntry;
    visibility: GPUShaderStageFlags;
  };
  /** Map<group, Map<binding, PartialEntry>> */
  const byGroup = new Map<number, Map<number, PartialEntry>>();

  const addStage = (
    reflection: ProgramStageReflection | undefined,
    stageBit: GPUShaderStageFlags,
  ) => {
    if (!reflection) return;
    // Uniform buffers
    for (const ub of reflection.uniformBuffers) {
      upsert(byGroup, ub.group, ub.binding, stageBit, (vis) => ({
        binding: ub.binding,
        visibility: vis,
        buffer: {
          type: "uniform",
          ...(ub.sizeBytes > 0 ? { minBindingSize: ub.sizeBytes } : {}),
        },
      }));
    }
    // Textures
    for (const tex of reflection.textures) {
      upsert(byGroup, tex.group, tex.binding, stageBit, (vis) => ({
        binding: tex.binding,
        visibility: vis,
        texture: {
          sampleType: tex.sampleType,
          viewDimension: tex.viewDimension,
          multisampled: tex.multisampled,
        },
      }));
    }
    // Samplers
    for (const s of reflection.samplers) {
      upsert(byGroup, s.group, s.binding, stageBit, (vis) => ({
        binding: s.binding,
        visibility: vis,
        sampler: { type: s.type },
      }));
    }
  };

  addStage(vertex, GPUShaderStage.VERTEX);
  addStage(fragment, GPUShaderStage.FRAGMENT);
  addStage(compute, GPUShaderStage.COMPUTE);

  // Materialize into real GPUBindGroupLayout objects, one per group.
  const out = new Map<number, GPUBindGroupLayout>();
  for (const [group, bindings] of byGroup) {
    const entries: GPUBindGroupLayoutEntry[] = [];
    // Sort by binding index so the emitted layout is stable across runs.
    const sortedBindings = Array.from(bindings.entries()).sort(
      (a, b) => a[0] - b[0],
    );
    for (const [, partial] of sortedBindings) {
      // Flatten the accumulated visibility into the entry. `entry`
      // was built once per (group, binding) slot; we update its
      // visibility to the final OR-ed value.
      partial.entry.visibility = partial.visibility;
      entries.push(partial.entry);
    }
    out.set(
      group,
      device.createBindGroupLayout({
        label: `${prefix} group ${group}`,
        entries,
      }),
    );
  }
  return out;
}

/**
 * Upsert helper: ensure there's a PartialEntry slot at `(group, binding)`,
 * OR in the new stage's visibility bit, and create the entry on first
 * insertion via the `build` callback. The callback receives the current
 * accumulated visibility so it can stash it inside the entry on creation.
 */
function upsert(
  byGroup: Map<
    number,
    Map<
      number,
      {
        entry: GPUBindGroupLayoutEntry;
        visibility: GPUShaderStageFlags;
      }
    >
  >,
  group: number,
  binding: number,
  stageBit: GPUShaderStageFlags,
  build: (visibility: GPUShaderStageFlags) => GPUBindGroupLayoutEntry,
): void {
  let groupMap = byGroup.get(group);
  if (!groupMap) {
    groupMap = new Map();
    byGroup.set(group, groupMap);
  }
  const existing = groupMap.get(binding);
  if (existing) {
    // Same binding already saw another stage — just OR the visibility.
    // We intentionally DON'T re-check that the shapes (buffer/texture/
    // sampler) agree between stages: WebGPU's validator will reject
    // mismatched definitions at `createBindGroupLayout` time with a
    // clear error that points at the conflict, which beats hand-
    // rolling the diagnostic here.
    existing.visibility |= stageBit;
    return;
  }
  const entry = build(stageBit);
  groupMap.set(binding, {
    entry,
    visibility: stageBit,
  });
}
