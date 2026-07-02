/// <reference types="@webgpu/types" />
/**
 * WIRE-PP-LIBRARY-BUILTINS — named PostProcessStageLibrary interception.
 *
 * `PostProcessStageLibrary` builds its stages from GLSL fragment shaders,
 * so on the WebGPU backend a `scene.postProcessStages.add(
 * PostProcessStageLibrary.createBlackAndWhiteStage())` used to hit the
 * GLSL-drop warning and silently no-op. Pre-translated WGSL twins for the
 * library built-ins have existed under `Shaders/WebGPU/PostProcess/` since
 * the initial shader-port batches but nothing imported them.
 *
 * This module wires them: when the post-process configure pass
 * (`WebGPUPostProcessStageCollection`) scans the user-stage list and finds
 * a stage whose well-known `czm_*` name matches the registry below, it
 * substitutes the WGSL twin instead of dropping the stage. The stage's
 * WebGL uniforms are mapped 1:1 onto the twin's UBO each frame, and the
 * stage's `enabled` flag is honored live.
 *
 * Wired stages (WebGL name → WGSL twin):
 *   - `czm_black_and_white`      → BlackAndWhite.wgsl   (gradations)
 *   - `czm_brightness`           → Brightness.wgsl      (brightness)
 *   - `czm_night_vision`         → NightVision.wgsl     (frame-seeded noise)
 *   - `czm_depth_view`           → DepthView.wgsl       (depth grayscale)
 *   - `czm_lens_flare`           → LensFlare.wgsl       (ghosts + halo)
 *   - `czm_edge_detection_<id>`  → EdgeDetection.wgsl   (depth Sobel)
 *   - `czm_silhouette`           → EdgeDetection + Silhouette (two-pass)
 *
 * Known per-stage parity gaps (documented, not silent):
 *   - LensFlare: the WGSL twin implements the ghost + halo core but not
 *     the `dirtTexture` / `starTexture` overlays or the sun-position
 *     gating of the WebGL shader — flare geometry matches, texture
 *     detail does not.
 *   - EdgeDetection / Silhouette: the `selected` feature mask
 *     (CZM_SELECTED_FEATURE) is not supported — edges apply to the whole
 *     frame, same as WebGL with no `selected` array.
 *   - DepthView: WebGL reverses log-depth encoding (czm_readDepth);
 *     WebGPU shows the conventional device depth, so absolute gray levels
 *     differ while the near-dark/far-white shape matches.
 *
 * Default OFF: nothing constructs these stages unless the user adds a
 * matching library stage, so untouched scenes are byte-identical.
 *
 * @module WebGPULibraryPostProcessStage
 */

import BlackAndWhiteWGSL from "../../Shaders/WebGPU/PostProcess/BlackAndWhite.js";
import BrightnessWGSL from "../../Shaders/WebGPU/PostProcess/Brightness.js";
import NightVisionWGSL from "../../Shaders/WebGPU/PostProcess/NightVision.js";
import DepthViewWGSL from "../../Shaders/WebGPU/PostProcess/DepthView.js";
import LensFlareWGSL from "../../Shaders/WebGPU/PostProcess/LensFlare.js";
import EdgeDetectionWGSL from "../../Shaders/WebGPU/PostProcess/EdgeDetection.js";
import SilhouetteWGSL from "../../Shaders/WebGPU/PostProcess/Silhouette.js";
import {
  makeBindGroupLayout,
  sampler as samplerEntry,
  texture as textureEntry,
  uniformBuffer as uniformBufferEntry,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import {
  createFullscreenPipeline,
  createTexture,
  executePass,
} from "./WebGPUPostProcessEffects.js";
import type { PostProcessEffect } from "./WebGPUPostProcessEffects.js";

/** Registry key for an intercepted PostProcessStageLibrary built-in. */
export type LibraryStageKey =
  | "blackAndWhite"
  | "brightness"
  | "nightVision"
  | "depthView"
  | "lensFlare"
  | "edgeDetection"
  | "silhouette";

/**
 * Map a collection-stage name to its library key, or null when the name is
 * not an intercepted built-in. `createEdgeDetectionStage()` appends a GUID
 * to its name so more than one can be added — hence the prefix match.
 */
export function getLibraryStageKey(
  name: string | undefined,
): LibraryStageKey | null {
  if (typeof name !== "string") return null;
  switch (name) {
    case "czm_black_and_white":
      return "blackAndWhite";
    case "czm_brightness":
      return "brightness";
    case "czm_night_vision":
      return "nightVision";
    case "czm_depth_view":
      return "depthView";
    case "czm_lens_flare":
      return "lensFlare";
    case "czm_silhouette":
      return "silhouette";
    default:
      break;
  }
  if (name.startsWith("czm_edge_detection_")) return "edgeDetection";
  return null;
}

/** Per-frame context threaded from the configure pass into uniform packs. */
export interface LibraryStageFrameContext {
  frameNumber: number;
  pixelRatio: number;
  // Lens-flare czm_* frame state (computed CPU-side by the configure
  // pass's computeLensFlareFrameContext — only populated when a
  // czm_lens_flare stage is present). Absent/zero viewerDistance keeps
  // the shader in its pass-through branch, matching WebGL's
  // "disabled when not in space" gate.
  sunNDC?: readonly [number, number];
  viewerDistance?: number;
  earthNDC?: readonly [number, number];
  earthEdgeAbsX?: number;
}

// Cesium `Color` shape — the library stages carry Color uniform values.
interface ColorLike {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

function numOr(v: unknown, d: number): number {
  return typeof v === "number" && isFinite(v) ? v : d;
}

function isColorLike(v: unknown): v is ColorLike {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as ColorLike).red === "number" &&
    typeof (v as ColorLike).green === "number" &&
    typeof (v as ColorLike).blue === "number"
  );
}

type LibraryBindingKind = "color" | "depth" | "edge" | "sampler" | "uniform";

interface LibraryPassSpec {
  label: string;
  wgsl: string;
  /** Binding index i in @group(0) maps to bindings[i]. */
  bindings: readonly LibraryBindingKind[];
  /** UBO float count (0 = no uniform buffer). */
  uniformFloatCount: number;
  /** Pack the collection-stage uniforms into the UBO floats. */
  pack?: (
    uniforms: Record<string, unknown>,
    out: Float32Array,
    width: number,
    height: number,
    frame: LibraryStageFrameContext,
  ) => void;
  /** Render target: the stage output or the silhouette edge intermediate. */
  target: "output" | "edge";
  /** Pass requires the scene depth view (skip stage when unavailable). */
  needsDepth: boolean;
}

// Shared by the standalone edge-detection stage and the silhouette
// composite's first pass. UBO layout mirrors EdgeDetection.wgsl:
// floats 0-3 = params (padx, pady, length, unused), 4-7 = edge color.
function packEdgeUniforms(
  uniforms: Record<string, unknown>,
  out: Float32Array,
  width: number,
  height: number,
  frame: LibraryStageFrameContext,
): void {
  out[0] = frame.pixelRatio / Math.max(width, 1);
  out[1] = frame.pixelRatio / Math.max(height, 1);
  out[2] = numOr(uniforms.length, 0.25);
  out[3] = 0.0;
  const color = uniforms.color;
  if (isColorLike(color)) {
    out[4] = color.red;
    out[5] = color.green;
    out[6] = color.blue;
    out[7] = numOr(color.alpha, 1.0);
  } else {
    // WebGL default: Color.BLACK (alpha 1).
    out[4] = 0.0;
    out[5] = 0.0;
    out[6] = 0.0;
    out[7] = 1.0;
  }
}

const LIBRARY_STAGE_SPECS: Record<LibraryStageKey, readonly LibraryPassSpec[]> =
  {
    blackAndWhite: [
      {
        label: "BlackAndWhite",
        wgsl: BlackAndWhiteWGSL,
        bindings: ["color", "sampler", "uniform"],
        uniformFloatCount: 4,
        pack: (u, out) => {
          out[0] = numOr(u.gradations, 5.0);
        },
        target: "output",
        needsDepth: false,
      },
    ],
    brightness: [
      {
        label: "Brightness",
        wgsl: BrightnessWGSL,
        bindings: ["color", "sampler", "uniform"],
        uniformFloatCount: 4,
        pack: (u, out) => {
          out[0] = numOr(u.brightness, 0.5);
        },
        target: "output",
        needsDepth: false,
      },
    ],
    nightVision: [
      {
        label: "NightVision",
        wgsl: NightVisionWGSL,
        bindings: ["color", "sampler", "uniform"],
        uniformFloatCount: 4,
        pack: (_u, out, _w, _h, frame) => {
          out[0] = frame.frameNumber;
        },
        target: "output",
        needsDepth: false,
      },
    ],
    depthView: [
      {
        label: "DepthView",
        wgsl: DepthViewWGSL,
        bindings: ["depth", "sampler"],
        uniformFloatCount: 0,
        target: "output",
        needsDepth: true,
      },
    ],
    lensFlare: [
      {
        label: "LensFlare",
        wgsl: LensFlareWGSL,
        // LensFlareUniforms: 4× vec4 — see LensFlare.wgsl header.
        bindings: ["color", "sampler", "uniform"],
        uniformFloatCount: 16,
        pack: (u, out, w, h, frame) => {
          // params0: intensity, ghostDispersal, haloWidth, distortion.
          out[0] = numOr(u.intensity, 2.0);
          out[1] = numOr(u.ghostDispersal, 0.4);
          out[2] = numOr(u.haloWidth, 0.4);
          out[3] = numOr(u.distortion, 10.0);
          // params1: sun NDC, viewer distance (space gate).
          out[4] = frame.sunNDC?.[0] ?? 0.0;
          out[5] = frame.sunNDC?.[1] ?? 0.0;
          out[6] = frame.viewerDistance ?? 0.0;
          out[7] = 0.0;
          // params2: pixelSize (czm_pixelRatio / viewport wh), earth NDC.
          out[8] = frame.pixelRatio / Math.max(w, 1);
          out[9] = frame.pixelRatio / Math.max(h, 1);
          out[10] = frame.earthNDC?.[0] ?? 0.0;
          out[11] = frame.earthNDC?.[1] ?? 0.0;
          // params3: |earth-edge NDC x|, viewport size.
          out[12] = frame.earthEdgeAbsX ?? 0.0;
          out[13] = w;
          out[14] = h;
          out[15] = 0.0;
        },
        target: "output",
        needsDepth: false,
      },
    ],
    edgeDetection: [
      {
        label: "EdgeDetection",
        wgsl: EdgeDetectionWGSL,
        bindings: ["depth", "sampler", "uniform"],
        uniformFloatCount: 8,
        pack: packEdgeUniforms,
        target: "output",
        needsDepth: true,
      },
    ],
    silhouette: [
      // Pass 1: depth-Sobel edge detection into the edge intermediate.
      {
        label: "SilhouetteEdge",
        wgsl: EdgeDetectionWGSL,
        bindings: ["depth", "sampler", "uniform"],
        uniformFloatCount: 8,
        pack: packEdgeUniforms,
        target: "edge",
        needsDepth: true,
      },
      // Pass 2: composite scene + edge overlay (Silhouette.glsl twin).
      {
        label: "SilhouetteComposite",
        wgsl: SilhouetteWGSL,
        bindings: ["color", "edge", "sampler"],
        uniformFloatCount: 0,
        target: "output",
        needsDepth: false,
      },
    ],
  };

interface LibraryPassRuntime {
  spec: LibraryPassSpec;
  pipeline: GPURenderPipeline;
  bindGroupLayout: GPUBindGroupLayout;
  uniformBuffer: GPUBuffer | null;
  uniformData: Float32Array;
}

/**
 * One intercepted library stage. Implements the same
 * {@link PostProcessEffect} contract the multi-pass effects use so the
 * pipeline can chain it with the standard
 * `execute(encoder, source, depth, sampler) → view` shape.
 */
export class WebGPULibraryPostProcessStage implements PostProcessEffect {
  /** The collection stage's name (e.g. `czm_black_and_white`). */
  readonly name: string;
  readonly key: LibraryStageKey;
  enabled = true;

  private _device: GPUDevice | null = null;
  private _width = 0;
  private _height = 0;
  private _format: GPUTextureFormat = "bgra8unorm";
  private _passes: LibraryPassRuntime[] = [];
  private _outputTexture: GPUTexture | null = null;
  private _outputView: GPUTextureView | null = null;
  // Silhouette-only: the edge-detection intermediate.
  private _edgeTexture: GPUTexture | null = null;
  private _edgeView: GPUTextureView | null = null;

  // Live uniform values from the collection stage (synced per frame by
  // the configure pass) + the frame context for czm_frameNumber /
  // czm_pixelRatio equivalents.
  private _uniformValues: Record<string, unknown> = {};
  private _frame: LibraryStageFrameContext = { frameNumber: 0, pixelRatio: 1 };

  constructor(name: string, key: LibraryStageKey) {
    this.name = name;
    this.key = key;
  }

  /** Per-frame sync from the collection stage's `uniforms` object. */
  setUniformValues(values: Record<string, unknown>): void {
    this._uniformValues = values;
  }

  /** Per-frame czm_* equivalents (frameNumber, pixelRatio, sun/earth state). */
  setFrameContext(frame: LibraryStageFrameContext): void {
    this._frame = frame;
  }

  initialize(
    device: GPUDevice,
    width: number,
    height: number,
    format: GPUTextureFormat,
  ): void {
    this._device = device;
    this._width = Math.max(width, 1);
    this._height = Math.max(height, 1);
    this._format = format;

    const specs = LIBRARY_STAGE_SPECS[this.key];
    this._passes = [];
    for (const spec of specs) {
      const entries: GPUBindGroupLayoutEntry[] = [];
      for (let i = 0; i < spec.bindings.length; i++) {
        const kind = spec.bindings[i];
        if (kind === "sampler") {
          entries.push(samplerEntry(i, Stage.FRAGMENT));
        } else if (kind === "uniform") {
          entries.push(uniformBufferEntry(i, Stage.FRAGMENT));
        } else {
          // color / depth / edge all bind as sampled 2D float textures —
          // the depth input is the pipeline's sampleable scene-depth copy
          // (same convention as the DoF / GodRay effects).
          entries.push(textureEntry(i, Stage.FRAGMENT));
        }
      }
      const bindGroupLayout = makeBindGroupLayout(
        device,
        `LibraryPP-${spec.label}-BGL`,
        entries,
      );
      let pipeline: GPURenderPipeline;
      try {
        pipeline = createFullscreenPipeline(
          device,
          `LibraryPP-${spec.label}`,
          spec.wgsl,
          format,
          bindGroupLayout,
        );
      } catch (e) {
        // Real error — a library twin failing to compile means the stage
        // the user explicitly enabled produces no output. Permanent log.
        console.error(
          `[CesiumJS:WebGPU] Library post-process stage "${this.name}" ` +
            `(${spec.label}) pipeline creation failed:`,
          e,
        );
        this.enabled = false;
        this._passes = [];
        return;
      }
      let uniformBuffer: GPUBuffer | null = null;
      if (spec.uniformFloatCount > 0) {
        uniformBuffer = device.createBuffer({
          label: `LibraryPP-${spec.label}-UBO`,
          size: Math.max(spec.uniformFloatCount * 4, 16),
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
      }
      this._passes.push({
        spec,
        pipeline,
        bindGroupLayout,
        uniformBuffer,
        uniformData: new Float32Array(spec.uniformFloatCount),
      });
    }

    this._allocateTextures();
  }

  resize(width: number, height: number): void {
    const w = Math.max(width, 1);
    const h = Math.max(height, 1);
    if (w === this._width && h === this._height) return;
    this._width = w;
    this._height = h;
    this._allocateTextures();
  }

  execute(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    depthView: GPUTextureView | null,
    sampler: GPUSampler,
  ): GPUTextureView {
    if (!this._device || this._passes.length === 0 || !this._outputView) {
      return sourceView;
    }
    // Depth-dependent stages pass through untouched when the sampleable
    // depth copy isn't available yet (same policy as DoF / GodRay).
    if (this._passes.some((p) => p.spec.needsDepth) && !depthView) {
      return sourceView;
    }

    for (const pass of this._passes) {
      const spec = pass.spec;
      if (pass.uniformBuffer && spec.pack) {
        spec.pack(
          this._uniformValues,
          pass.uniformData,
          this._width,
          this._height,
          this._frame,
        );
        this._device.queue.writeBuffer(
          pass.uniformBuffer,
          0,
          pass.uniformData as Float32Array<ArrayBuffer>,
        );
      }

      const entries: GPUBindGroupEntry[] = [];
      for (let i = 0; i < spec.bindings.length; i++) {
        const kind = spec.bindings[i];
        let resource: GPUBindingResource;
        if (kind === "color") {
          resource = sourceView;
        } else if (kind === "depth") {
          resource = depthView!;
        } else if (kind === "edge") {
          resource = this._edgeView!;
        } else if (kind === "sampler") {
          resource = sampler;
        } else {
          resource = { buffer: pass.uniformBuffer! };
        }
        entries.push({ binding: i, resource });
      }
      const bindGroup = this._device.createBindGroup({
        label: `LibraryPP-${spec.label}-BG`,
        layout: pass.bindGroupLayout,
        entries,
      });

      const targetView =
        spec.target === "edge" ? this._edgeView! : this._outputView;
      executePass(
        encoder,
        `LibraryPP-${spec.label}`,
        pass.pipeline,
        bindGroup,
        targetView,
      );
    }

    return this._outputView;
  }

  destroy(): void {
    this._outputTexture?.destroy();
    this._edgeTexture?.destroy();
    for (const pass of this._passes) {
      pass.uniformBuffer?.destroy();
    }
    this._passes = [];
    this._outputTexture = null;
    this._outputView = null;
    this._edgeTexture = null;
    this._edgeView = null;
    this._device = null;
  }

  private _allocateTextures(): void {
    if (!this._device) return;
    this._outputTexture?.destroy();
    this._edgeTexture?.destroy();
    this._outputTexture = createTexture(
      this._device,
      `LibraryPP-${this.key}-output`,
      this._width,
      this._height,
      this._format,
    );
    this._outputView = this._outputTexture.createView();
    const needsEdge = this._passes.some((p) => p.spec.target === "edge");
    if (needsEdge) {
      this._edgeTexture = createTexture(
        this._device,
        `LibraryPP-${this.key}-edge`,
        this._width,
        this._height,
        this._format,
      );
      this._edgeView = this._edgeTexture.createView();
    } else {
      this._edgeTexture = null;
      this._edgeView = null;
    }
  }
}

export default WebGPULibraryPostProcessStage;
