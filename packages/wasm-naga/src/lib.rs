//! # cesium-naga-wasm
//!
//! WASM wrapper around `gfx-rs/naga` for CesiumJS.
//!
//! The crate exposes two concerns through a single cdylib:
//!
//! 1. **Runtime translation** (default feature `runtime`) — converts GLSL
//!    or SPIR-V into WGSL so the WebGL compatibility stub can hand a real
//!    `createShaderModule(wgsl)` call to the browser on behalf of legacy
//!    code that calls `gl.compileShader()`. Bundled into
//!    `Source/ThirdParty/naga-wasm/` and lazy-loaded by
//!    [`WebGPUNagaTranspiler.ts`][transpiler].
//!
//! 2. **Tooling translation** (feature `tooling`) — adds MSL, HLSL, and
//!    SPIR-V outputs for the offline asset pipeline. Never shipped to
//!    browsers; built into `Tools/shader-pipeline/naga-wasm-tools/` and
//!    consumed by build scripts.
//!
//! ## Layout overview
//!
//! The exported JS API is intentionally narrow:
//!
//! ```text
//! runtime build                      tooling build (all of runtime, plus)
//! ─────────────                      ────────────────────────────────────
//! glsl_to_wgsl(src, stage)           wgsl_to_msl(src)
//! spirv_to_wgsl(bytes)               wgsl_to_hlsl(src)
//! validate_wgsl(src)  → JSON         glsl_to_spv(src, stage)
//! normalize_wgsl(src)
//! ```
//!
//! Every function returns `Result<T, JsError>` so JS callers see a real
//! `Error` with a human-readable message. We don't try to round-trip
//! structured naga diagnostics to JS — their public format isn't stable
//! across naga versions and reshaping them each upgrade is more churn
//! than it's worth.
//!
//! [transpiler]: ../../engine/Source/Renderer/WebGPU/WebGPUNagaTranspiler.ts

#![cfg(target_arch = "wasm32")]

use wasm_bindgen::prelude::*;

// Brought in unconditionally because every feature path needs the module +
// validator types. Naga's crate-level feature flags ensure that backends
// we didn't enable don't bring their code into the binary.
use naga::valid::{Capabilities, ValidationFlags, Validator};

// ────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ────────────────────────────────────────────────────────────────────────────

/// Translate `"vertex"`, `"fragment"`, or `"compute"` into the GLSL frontend's
/// shader-stage enum. Accepts the same stage strings the JS side hands us
/// from `gl.VERTEX_SHADER` / `gl.FRAGMENT_SHADER` / the spike's stage hint.
#[cfg(any(feature = "glsl-in", feature = "spv-out"))]
fn parse_stage(stage: &str) -> Result<naga::ShaderStage, JsError> {
    match stage {
        "vertex" | "VERTEX" => Ok(naga::ShaderStage::Vertex),
        "fragment" | "FRAGMENT" => Ok(naga::ShaderStage::Fragment),
        "compute" | "COMPUTE" => Ok(naga::ShaderStage::Compute),
        other => Err(JsError::new(&format!(
            "unknown shader stage '{other}' (expected 'vertex', 'fragment', or 'compute')"
        ))),
    }
}

/// Run a parsed module through naga's validator and return its module info.
/// Both the WGSL and SPIR-V backends require a validated module — skipping
/// this step is the most common cause of silent-output bugs in naga
/// pipelines, so we always run it.
fn validate(module: &naga::Module) -> Result<naga::valid::ModuleInfo, JsError> {
    Validator::new(ValidationFlags::all(), Capabilities::all())
        .validate(module)
        .map_err(|e| JsError::new(&format!("naga validation failed: {e:?}")))
}

// ────────────────────────────────────────────────────────────────────────────
// Runtime exports — used by the browser-side compileShader stub
// ────────────────────────────────────────────────────────────────────────────

/// Compile GLSL source to WGSL.
///
/// `stage` must be one of `"vertex"`, `"fragment"`, or `"compute"` — naga's
/// GLSL frontend is stage-aware because GLSL's entry point is always `main`
/// and the builtin variables it sees depend on the pipeline stage.
///
/// Caveat: naga's GLSL frontend is documented as supporting "GLSL 440+ and
/// Vulkan semantics only." WebGL GLSL ES 3.00 shaders may need a
/// preprocessor pass (precision qualifier rewriting, sampler type
/// normalisation) before feeding them in. The spike's reflection pass
/// will surface the specifics once we run a real Cesium shader through it.
#[cfg(all(feature = "glsl-in", feature = "wgsl-out"))]
#[wasm_bindgen]
pub fn glsl_to_wgsl(source: &str, stage: &str) -> Result<String, JsError> {
    let shader_stage = parse_stage(stage)?;
    let options = naga::front::glsl::Options::from(shader_stage);
    let mut parser = naga::front::glsl::Frontend::default();

    // Some naga glsl-in errors carry source locations that only make
    // sense if we include the original source in the diagnostic. We
    // capture it into the error message rather than require the JS side
    // to replay.
    let module = parser
        .parse(&options, source)
        .map_err(|errs| JsError::new(&format!("GLSL parse: {errs:?}")))?;
    let info = validate(&module)?;

    naga::back::wgsl::write_string(
        &module,
        &info,
        naga::back::wgsl::WriterFlags::empty(),
    )
    .map_err(|e| JsError::new(&format!("WGSL emit: {e:?}")))
}

/// Compile a SPIR-V byte buffer to WGSL.
///
/// Expects the standard SPIR-V magic number (`0x07230203`). No stage
/// parameter is needed — SPIR-V carries its own entry-point metadata.
#[cfg(all(feature = "spv-in", feature = "wgsl-out"))]
#[wasm_bindgen]
pub fn spirv_to_wgsl(bytes: &[u8]) -> Result<String, JsError> {
    // SPIR-V is a stream of u32 words. The input arrives as `&[u8]` from JS
    // because wasm-bindgen doesn't expose a direct Uint32Array binding that
    // matches a wasm slice cleanly. We rebuild the u32 view here, which
    // costs one `Vec<u32>` allocation per call — fine for the "rare
    // shader translation" use case.
    if bytes.len() % 4 != 0 {
        return Err(JsError::new(&format!(
            "SPIR-V byte length must be a multiple of 4 (got {} bytes)",
            bytes.len()
        )));
    }
    let mut words = Vec::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
        // naga expects native-endian u32s. SPIR-V is little-endian on the
        // wire — same as wasm32 — so this is a no-op byte cast in practice
        // but using `from_le_bytes` makes the intent explicit.
        words.push(u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }

    let options = naga::front::spv::Options::default();
    let module = naga::front::spv::parse_u8_slice(bytes, &options)
        .map_err(|e| JsError::new(&format!("SPIR-V parse: {e:?}")))?;
    // `words` is held just for its length sanity check above; we don't
    // actually need it once parse_u8_slice has succeeded. Drop to make
    // lifetimes explicit.
    drop(words);

    let info = validate(&module)?;
    naga::back::wgsl::write_string(
        &module,
        &info,
        naga::back::wgsl::WriterFlags::empty(),
    )
    .map_err(|e| JsError::new(&format!("WGSL emit: {e:?}")))
}

/// Parse and validate WGSL source. Returns a JSON blob describing the
/// discovered entry points, bindings, and push-constant layout. When
/// validation fails the rejection message is the thrown `Error.message`.
///
/// Downstream pipeline builders can use the returned JSON to auto-derive
/// `GPUBindGroupLayoutDescriptor`s from the shader's declared bindings —
/// the main reason the spike exists in the first place, since the WebGL
/// stub path doesn't know the WebGPU layouts upfront.
#[cfg(feature = "wgsl-in")]
#[wasm_bindgen]
pub fn validate_wgsl(source: &str) -> Result<String, JsError> {
    let module = naga::front::wgsl::parse_str(source)
        .map_err(|e| JsError::new(&format!("WGSL parse: {e}")))?;
    let info = validate(&module)?;

    // The reflection blob is intentionally minimal for v1: entry point
    // names + stages, and one entry per global variable with its
    // group/binding pair. Full type information is a follow-up — it
    // requires reshaping naga's `TypeInner` enum into something JSON-able,
    // which is mechanical but large. Downstream pipeline builders mostly
    // just need the binding map to build a BGL from.
    let mut out = String::from("{\"entryPoints\":[");
    for (i, ep) in module.entry_points.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        // Naga 27 added Task + Mesh stages for mesh shaders. We surface
        // them as their own strings so the JS side can at least see them
        // (WebGPU doesn't support mesh shaders yet, so any consumer that
        // receives these in reflection output has a bug upstream, but
        // swallowing them silently would be worse).
        let stage = match ep.stage {
            naga::ShaderStage::Vertex => "vertex",
            naga::ShaderStage::Fragment => "fragment",
            naga::ShaderStage::Compute => "compute",
            naga::ShaderStage::Task => "task",
            naga::ShaderStage::Mesh => "mesh",
        };
        out.push_str(&format!(
            "{{\"name\":{:?},\"stage\":\"{stage}\"}}",
            ep.name
        ));
    }
    out.push_str("],\"bindings\":[");
    let mut first = true;
    for (_handle, var) in module.global_variables.iter() {
        if let Some(binding) = &var.binding {
            if !first {
                out.push(',');
            }
            first = false;
            let name = var.name.as_deref().unwrap_or("<anonymous>");
            let binding_kind = classify_binding(&module, var);
            out.push_str(&format!(
                "{{\"name\":{name:?},\"group\":{},\"binding\":{},\"kind\":{:?}",
                binding.group, binding.binding, binding_kind.kind,
            ));
            if let Some(sample_type) = binding_kind.sample_type {
                out.push_str(&format!(",\"sampleType\":{sample_type:?}"));
            }
            if let Some(view_dim) = binding_kind.view_dimension {
                out.push_str(&format!(",\"viewDimension\":{view_dim:?}"));
            }
            if let Some(multisampled) = binding_kind.multisampled {
                out.push_str(&format!(",\"multisampled\":{multisampled}"));
            }
            if let Some(access) = binding_kind.storage_access {
                out.push_str(&format!(",\"access\":{access:?}"));
            }
            if let Some(min_size) = binding_kind.min_binding_size {
                out.push_str(&format!(",\"minBindingSize\":{min_size}"));
            }
            out.push('}');
        }
    }
    out.push_str("]}");
    // Suppress the "might need this for info" lint — we construct the
    // validator's result but only use it for error surfacing above.
    let _ = info;
    Ok(out)
}

/// Classification result for one WGSL global binding. Field names
/// mirror the WebGPU `GPUBindGroupLayoutEntry` shape so JS callers can
/// dump the JSON straight into a `GPUBindGroupLayoutDescriptor.entries`
/// element with minimal reshaping.
#[cfg(feature = "wgsl-in")]
struct BindingKind {
    /// One of: "uniform-buffer", "storage-buffer", "texture", "sampler",
    /// "storage-texture", "external-texture", "unknown"
    kind: &'static str,
    /// For texture bindings: "float" / "unfilterable-float" / "uint" /
    /// "sint" / "depth". Absent for non-texture bindings.
    sample_type: Option<&'static str>,
    /// For texture bindings: "1d" / "2d" / "2d-array" / "cube" /
    /// "cube-array" / "3d". Absent for non-texture bindings.
    view_dimension: Option<&'static str>,
    /// For texture bindings: true if multisampled.
    multisampled: Option<bool>,
    /// For storage buffers / storage textures: "read" / "write" /
    /// "read_write".
    storage_access: Option<&'static str>,
    /// For uniform / storage buffers: minimum byte size naga inferred
    /// from the declared struct layout. Lets the JS caller set
    /// `buffer.minBindingSize` on the layout entry, which the WebGPU
    /// validator uses to reject mismatched bindings at pipeline
    /// creation time.
    min_binding_size: Option<u64>,
}

/// Inspect a global variable's address space + type to derive a
/// WebGPU-shaped binding descriptor. Delegates to naga's type info
/// for the heavy lifting — we just translate the Rust enums into
/// JSON-friendly strings.
#[cfg(feature = "wgsl-in")]
fn classify_binding(
    module: &naga::Module,
    var: &naga::GlobalVariable,
) -> BindingKind {
    use naga::{AddressSpace, ImageClass, ImageDimension, TypeInner};

    let ty = &module.types[var.ty];
    let inner = &ty.inner;

    match var.space {
        AddressSpace::Uniform => BindingKind {
            kind: "uniform-buffer",
            sample_type: None,
            view_dimension: None,
            multisampled: None,
            storage_access: None,
            min_binding_size: struct_size(module, inner),
        },
        AddressSpace::Storage { access } => {
            let access_str = if access.contains(naga::StorageAccess::LOAD)
                && access.contains(naga::StorageAccess::STORE)
            {
                "read_write"
            } else if access.contains(naga::StorageAccess::STORE) {
                "write"
            } else {
                "read"
            };
            BindingKind {
                kind: "storage-buffer",
                sample_type: None,
                view_dimension: None,
                multisampled: None,
                storage_access: Some(access_str),
                min_binding_size: struct_size(module, inner),
            }
        }
        AddressSpace::Handle => match inner {
            TypeInner::Image {
                dim,
                arrayed,
                class,
            } => {
                let view_dim = dimension_str(*dim, *arrayed);
                match class {
                    ImageClass::Sampled { kind, multi } => BindingKind {
                        kind: "texture",
                        sample_type: Some(sample_type_str(*kind)),
                        view_dimension: Some(view_dim),
                        multisampled: Some(*multi),
                        storage_access: None,
                        min_binding_size: None,
                    },
                    ImageClass::Depth { multi } => BindingKind {
                        kind: "texture",
                        sample_type: Some("depth"),
                        view_dimension: Some(view_dim),
                        multisampled: Some(*multi),
                        storage_access: None,
                        min_binding_size: None,
                    },
                    ImageClass::Storage { access, .. } => {
                        let access_str = if access.contains(naga::StorageAccess::LOAD)
                            && access.contains(naga::StorageAccess::STORE)
                        {
                            "read_write"
                        } else if access.contains(naga::StorageAccess::STORE) {
                            "write"
                        } else {
                            "read"
                        };
                        BindingKind {
                            kind: "storage-texture",
                            sample_type: None,
                            view_dimension: Some(view_dim),
                            multisampled: None,
                            storage_access: Some(access_str),
                            min_binding_size: None,
                        }
                    }
                    // External textures (WebGPU external_texture feature
                    // — used for <video> + HTMLCanvasElement sources).
                    // Naga 27 added this variant; WebGPU exposes it as
                    // its own layout-entry type.
                    ImageClass::External => BindingKind {
                        kind: "external-texture",
                        sample_type: None,
                        view_dimension: None,
                        multisampled: None,
                        storage_access: None,
                        min_binding_size: None,
                    },
                }
            }
            TypeInner::Sampler { comparison } => BindingKind {
                kind: "sampler",
                // "comparison" is the WebGPU sampler type name when the
                // sampler was declared with comparison semantics;
                // otherwise "filtering" is the safe default.
                sample_type: Some(if *comparison { "comparison" } else { "filtering" }),
                view_dimension: None,
                multisampled: None,
                storage_access: None,
                min_binding_size: None,
            },
            _ => BindingKind {
                kind: "unknown",
                sample_type: None,
                view_dimension: None,
                multisampled: None,
                storage_access: None,
                min_binding_size: None,
            },
        },
        _ => BindingKind {
            kind: "unknown",
            sample_type: None,
            view_dimension: None,
            multisampled: None,
            storage_access: None,
            min_binding_size: None,
        },
    }
}

/// Best-effort size lookup for a struct type. Returns None when naga's
/// type info doesn't carry a fixed size (runtime-sized arrays mostly).
/// The JS side treats None as "skip minBindingSize" which is what the
/// WebGPU validator expects for variable-length storage arrays.
#[cfg(feature = "wgsl-in")]
fn struct_size(_module: &naga::Module, inner: &naga::TypeInner) -> Option<u64> {
    match inner {
        naga::TypeInner::Struct { span, .. } => Some(u64::from(*span)),
        _ => None,
    }
}

#[cfg(feature = "wgsl-in")]
fn dimension_str(dim: naga::ImageDimension, arrayed: bool) -> &'static str {
    use naga::ImageDimension as D;
    match (dim, arrayed) {
        (D::D1, false) => "1d",
        (D::D1, true) => "1d-array",
        (D::D2, false) => "2d",
        (D::D2, true) => "2d-array",
        (D::D3, _) => "3d",
        (D::Cube, false) => "cube",
        (D::Cube, true) => "cube-array",
    }
}

#[cfg(feature = "wgsl-in")]
fn sample_type_str(kind: naga::ScalarKind) -> &'static str {
    match kind {
        naga::ScalarKind::Float => "float",
        naga::ScalarKind::Uint => "uint",
        naga::ScalarKind::Sint => "sint",
        // AbstractInt / AbstractFloat / Bool can't actually be texture
        // sample kinds, but the enum is exhaustive so we fall through
        // to the safest WebGPU default.
        _ => "unfilterable-float",
    }
}

/// Roundtrip WGSL through naga's `wgsl-in`/`wgsl-out` pipeline. Acts as a
/// light minifier (drops comments, normalises formatting) and a
/// validation gate — anything naga's frontend rejects is rejected here.
///
/// Useful as a build-time sanity check on hand-written WGSL and on Slang's
/// WGSL output. Not expected to preserve original formatting.
#[cfg(all(feature = "wgsl-in", feature = "wgsl-out"))]
#[wasm_bindgen]
pub fn normalize_wgsl(source: &str) -> Result<String, JsError> {
    let module = naga::front::wgsl::parse_str(source)
        .map_err(|e| JsError::new(&format!("WGSL parse: {e}")))?;
    let info = validate(&module)?;
    naga::back::wgsl::write_string(
        &module,
        &info,
        naga::back::wgsl::WriterFlags::empty(),
    )
    .map_err(|e| JsError::new(&format!("WGSL emit: {e:?}")))
}

// ────────────────────────────────────────────────────────────────────────────
// Tooling-only exports — offline content pipeline
// ────────────────────────────────────────────────────────────────────────────
//
// Gated behind `msl-out` / `hlsl-out` / `spv-out` features so the runtime
// build never pulls these backends into the binary. Build with
// `wasm-pack build --features tooling` to enable.

/// Emit Metal Shading Language from a WGSL source.
#[cfg(all(feature = "wgsl-in", feature = "msl-out"))]
#[wasm_bindgen]
pub fn wgsl_to_msl(source: &str) -> Result<String, JsError> {
    let module = naga::front::wgsl::parse_str(source)
        .map_err(|e| JsError::new(&format!("WGSL parse: {e}")))?;
    let info = validate(&module)?;

    // Default MSL writer options target Apple Silicon / Metal 3. If we
    // ever ship this output into production, we'll want to parameterise
    // the Metal version + family — but that's a tooling-pipeline knob,
    // not a runtime one.
    let options = naga::back::msl::Options::default();
    let pipeline = naga::back::msl::PipelineOptions::default();
    let (msl, _info) = naga::back::msl::write_string(&module, &info, &options, &pipeline)
        .map_err(|e| JsError::new(&format!("MSL emit: {e:?}")))?;
    Ok(msl)
}

/// Emit HLSL (Shader Model 5.0+) from a WGSL source.
#[cfg(all(feature = "wgsl-in", feature = "hlsl-out"))]
#[wasm_bindgen]
pub fn wgsl_to_hlsl(source: &str) -> Result<String, JsError> {
    let module = naga::front::wgsl::parse_str(source)
        .map_err(|e| JsError::new(&format!("WGSL parse: {e}")))?;
    let info = validate(&module)?;

    let options = naga::back::hlsl::Options::default();
    let pipeline_options = naga::back::hlsl::PipelineOptions::default();
    let mut out = String::new();
    let mut writer =
        naga::back::hlsl::Writer::new(&mut out, &options, &pipeline_options);
    writer
        .write(&module, &info, None)
        .map_err(|e| JsError::new(&format!("HLSL emit: {e:?}")))?;
    Ok(out)
}

/// Compile GLSL source to SPIR-V bytes. Used by the asset pipeline to
/// generate platform-neutral intermediate shaders that can then flow back
/// through `spirv_to_wgsl` (runtime) for validation, or be shipped direct
/// to Vulkan-targeted consumers.
#[cfg(all(feature = "glsl-in", feature = "spv-out"))]
#[wasm_bindgen]
pub fn glsl_to_spv(source: &str, stage: &str) -> Result<Box<[u8]>, JsError> {
    let shader_stage = parse_stage(stage)?;
    let options = naga::front::glsl::Options::from(shader_stage);
    let mut parser = naga::front::glsl::Frontend::default();
    let module = parser
        .parse(&options, source)
        .map_err(|errs| JsError::new(&format!("GLSL parse: {errs:?}")))?;
    let info = validate(&module)?;

    let mut options = naga::back::spv::Options::default();
    // Default SPIR-V version is 1.0 to maximise runtime compatibility.
    // Adjust per the pipeline's consumer if needed.
    options.lang_version = (1, 0);
    let pipeline = naga::back::spv::PipelineOptions {
        shader_stage,
        entry_point: "main".into(),
    };
    let words = naga::back::spv::write_vec(&module, &info, &options, Some(&pipeline))
        .map_err(|e| JsError::new(&format!("SPIR-V emit: {e:?}")))?;

    // Re-pack the u32 stream as little-endian bytes so JS can treat the
    // result as a Uint8Array. SPIR-V on disk / on the wire is always LE.
    let mut bytes = Vec::with_capacity(words.len() * 4);
    for w in words {
        bytes.extend_from_slice(&w.to_le_bytes());
    }
    Ok(bytes.into_boxed_slice())
}
