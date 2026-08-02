/// <reference types="@webgpu/types" />
/**
 * WebGPU Snap Framebuffer — the compact RG32Uint target behind
 * {@link Scene#snap}.
 *
 * UP144-SNAP-WEBGPU (Campaign 11 row C11-212). WebGPU twin of upstream's
 * `Scene/SnapFramebuffer.js`, which the v1.144 merge left WebGL-only: on WebGPU
 * `Scene.snap()` rendered an empty framebuffer and resolved `undefined` because
 * `SceneRenderer.executeCommand`'s alternate-renderer early-return precedes the
 * snap branch and `Scene.updateDerivedCommands` returns early for WebGPU
 * commands.
 *
 * ## Payload
 *
 * One RG32Uint pixel per fragment, written by `ModelPBRComplete.wgsl`'s
 * `fragmentSnapMain` (see {@link decodeSnapHits} for the reader):
 *
 * | Word | Meaning                                                            |
 * | ---- | ------------------------------------------------------------------ |
 * | R    | exact uint32 pick key repacked from the RGBA8 pick color           |
 * | G    | positive f32 eye-depth bits, with bit 31 reserved for isEdge       |
 *
 * The internal transport differs from upstream WebGL's RGBA32F target, but
 * decode produces the same hit envelope, so `Snapping.selectBestHit` and
 * `Snapping.snapHitToWorld` consume both backends without a branch.
 *
 * ## Two-phase render
 *
 * WebGL runs ONE snap pass: commands with a `snapId` render their snap-derived
 * shader, and snapless commands (globe, primitives, collections) render their
 * DEPTH-ONLY derived command so they still occlude. WebGPU cannot express that
 * in one pass: a pipeline's color-target formats are validated against the
 * render pass's attachments at draw time, so an RGBA8 pick pipeline dispatched
 * into an RG32Uint pass invalidates the entire command buffer (the FORK-34
 * failure mode) — and building a snap-format depth-only twin of every pick
 * producer in the fleet would be a fleet-wide rewrite.
 *
 * So this framebuffer publishes TWO color attachments over ONE shared depth
 * attachment, and `WebGPUSceneRendererPickPass` runs each frustum slice twice:
 *
 *   1. **Occluder phase** — color = `_occluderTexture` (the ordinary
 *      `pickPipelineFormat` target), depth = `_depthTexture` (cleared). The
 *      UNMODIFIED pick fleet renders here, exactly as during `scene.pick`.
 *      Its color output is discarded; what matters is the depth every pick
 *      producer writes. This is the WebGPU occluder fleet realized with
 *      pipelines that already exist; commands with neither a native pick nor
 *      snap-occluder variant remain an explicit future coverage extension.
 *   2. **Payload phase** — color = `_snapTexture` (RG32Uint), depth =
 *      `_depthTexture` loaded, not cleared. Before a nearer frustum draws its
 *      payload, one query-scissored fullscreen triangle writes zero wherever
 *      the current slice established depth. This erases a farther payload when
 *      the nearer winner is snapless. Only commands carrying a snap variant
 *      then draw, testing `less-equal` against the depth the occluder phase
 *      established. A model behind terrain therefore fails the depth test and
 *      cannot leave a stale farther hit behind.
 *
 * The extra full-viewport RGBA8 attachment is the price of that reuse. Its
 * color is never consumed, so snap occluder passes discard its store while
 * retaining the shared depth/stencil attachment for the payload phase. It is
 * allocated lazily with the rest of this object — `View.snapFramebuffer` stays
 * `undefined` until the first `Scene.snap()` call, so applications that never
 * snap pay nothing.
 *
 * ## Readback
 *
 * WebGPU has no synchronous texture readback, so `end()` records the copy on
 * the active pick mini-frame encoder, starts mapping only after that encoder is
 * submitted, and returns the most recent COMPLETED readback for the same
 * logical region and attachment generation when the rendered camera/frustum is
 * unchanged. A nearby moving-cursor query may consume the most recent
 * completed, overlapping query for at most eight snap calls and eight rendered
 * scene frames, preventing normal readback latency from starving continuous
 * hover without allowing a payload to survive unbounded scene animation.
 * Camera or projection motion returns cold until a readback from that view
 * completes.
 * Pixels are always published and consumed atomically with the immutable
 * camera/view snapshot that rendered them. A cold or non-overlapping query
 * returns `[]` until a relevant readback completes.
 * {@link WebGPUSnapFramebuffer#endAsync} records its copy on the active snap
 * frame encoder; the caller must then end that frame before awaiting it.
 *
 * @private
 */

import BoundingRectangle from "../../Core/BoundingRectangle.js";
import { getWebGPUPickColorFormat } from "./WebGPUPickFramebuffer.js";
import {
  alignedSnapBytesPerRow,
  decodeSnapHits,
  SNAP_CHANNELS,
  SNAP_PAYLOAD_FORMAT,
  unpackSnapPixels,
  type SnapReadbackRegion,
  type WebGPUSnapHit,
} from "./WebGPUSnapPayload.js";

/** Flat immutable camera/frustum/viewport snapshot owned by Snapping.js. */
export interface SnapViewProvenance {
  readonly sceneFrameNumber: number;
  readonly windowX: number;
  readonly windowY: number;
  /** Exact CSS/window coordinate of the integer drawing-buffer sample center. */
  readonly sampleWindowX?: number;
  readonly sampleWindowY?: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly drawingBufferWidth: number;
  readonly drawingBufferHeight: number;
  readonly viewportX: number;
  readonly viewportY: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly positionX: number;
  readonly positionY: number;
  readonly positionZ: number;
  readonly directionX: number;
  readonly directionY: number;
  readonly directionZ: number;
  readonly rightX: number;
  readonly rightY: number;
  readonly rightZ: number;
  readonly upX: number;
  readonly upY: number;
  readonly upZ: number;
  readonly perspective: boolean;
  readonly fovy: number;
  readonly aspectRatio: number;
  readonly near: number;
  readonly far: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly sceneMode: number;
  readonly mapMode2D: number;
  readonly wrapLongitude: boolean;
  readonly maxCoordinateX: number;
}

export interface SnapFramebufferEndResult {
  hits: WebGPUSnapHit[];
  view: SnapViewProvenance;
}

interface PublishedSnapReadback {
  readonly pixels: Uint32Array;
  readonly region: SnapReadbackRegion;
  readonly attachmentGeneration: number;
  readonly requestSequence: number;
  readonly querySequence: number;
  readonly view: SnapViewProvenance;
}

// A mismatched completed query is useful only while its aperture still
// overlaps the current cursor and its request is recent. Bound both snap-call
// age and rendered-scene-frame age: query count alone would let a payload
// survive arbitrarily many animation/tile/model frames when snap() is idle.
// Eight frames/calls covers ordinary 1-3 frame map latency with margin without
// turning the cache into long-lived scene state.
const MAX_PRIOR_QUERY_AGE = 8;
const MAX_PRIOR_SCENE_FRAME_AGE = 8;
// A partially overlapping aperture cannot prove what lies in its missing
// stripe. Keep hover reuse to small cursor motion; a large-but-nonempty overlap
// (for example 1/25 columns) must return cold instead of presenting an
// incomplete candidate set as current.
const MAX_PRIOR_CURSOR_DELTA_PIXELS = 2;

// A single no-bind-group pipeline repairs the far-to-near payload accumulator.
// Render-pass clears ignore the query scissor, so clearing the RG32Uint
// attachment between slices would erase unrelated pixels and 2D wrap segments.
// Instead this triangle writes zero only where the current slice's loaded depth
// differs from its 1.0 clear value. The payload pass has already installed the
// exact query viewport/scissor before invoking it, so the draw costs only the
// aperture (25x25 pixels by default), not the full attachment.
const SNAP_PAYLOAD_COVERAGE_RESET_WGSL = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  let positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  var output: VertexOutput;
  output.position = vec4<f32>(positions[vertexIndex], 1.0, 1.0);
  return output;
}

@fragment
fn fragmentMain() -> @location(0) vec2<u32> {
  return vec2<u32>(0u);
}
`;

/** Return the visit rank of an integer offset in upstream's square spiral. */
function snapSpiralRank(hit: WebGPUSnapHit): number {
  const x = hit.x;
  const y = hit.y;
  const ring = Math.max(Math.abs(x), Math.abs(y));
  if (ring === 0) {
    return 0;
  }

  const beforeRing = (2 * ring - 1) ** 2;
  let ringOffset: number;
  if (x === ring && y >= -(ring - 1)) {
    ringOffset = y + ring - 1;
  } else if (y === ring) {
    ringOffset = 2 * ring + (ring - 1 - x);
  } else if (x === -ring) {
    ringOffset = 4 * ring + (ring - 1 - y);
  } else {
    ringOffset = 6 * ring + (x + ring - 1);
  }
  return beforeRing + ringOffset;
}

function compareSnapSpiralRank(
  left: WebGPUSnapHit,
  right: WebGPUSnapHit,
): number {
  return snapSpiralRank(left) - snapSpiralRank(right);
}

export class WebGPUSnapFramebuffer {
  private _context: CesiumGraphicsContext;
  private _device: GPUDevice | null = null;
  private _isDestroyed: boolean = false;

  // Attachments. `_occluderTexture` receives the ordinary pick fleet's color
  // output during the occluder phase and is never read back; `_snapTexture` is
  // the RG32Uint payload the readback decodes; `_depthTexture` is shared by both
  // phases and is what carries occlusion from phase 1 into phase 2.
  private _occluderTexture: GPUTexture | null = null;
  private _snapTexture: GPUTexture | null = null;
  private _depthTexture: GPUTexture | null = null;
  private _occluderView: GPUTextureView | null = null;
  private _snapView: GPUTextureView | null = null;
  private _depthView: GPUTextureView | null = null;
  private _occluderFormat: GPUTextureFormat = "rgba8unorm";
  private _width: number = 0;
  private _height: number = 0;

  // Lazily materialized only when a snap query has prior payload to preserve.
  // Exact device identity is part of the reuse key: a replacement device can
  // never receive a pipeline created by the lost device.
  private _coverageResetDevice: GPUDevice | null = null;
  private _coverageResetPipeline: GPURenderPipeline | null = null;
  private _coverageResetCallback: (renderPass: GPURenderPassEncoder) => void;

  // Device-generation lifecycle, mirroring WebGPUPickFramebuffer: a device
  // change invalidates every GPU object and every cached readback, and the
  // generation counter is what lets an in-flight `mapAsync` recognize that its
  // bytes belong to a destroyed attachment.
  private _attachmentDevice: GPUDevice | null = null;
  private _attachmentGeneration: number = 0;

  private _passState: CesiumPassState;

  // Logical query geometry (top-down attachment coordinates).
  private _snapOriginX: number = 0;
  private _snapOriginTopY: number = 0;
  private _snapWidth: number = 1;
  private _snapHeight: number = 1;
  private _copyOriginX: number = 0;
  private _copyOriginTopY: number = 0;
  private _copyWidth: number = 1;
  private _copyHeight: number = 1;
  private _copyOffsetX: number = 0;
  private _copyOffsetY: number = 0;

  // Synchronous-readback cache (see the class docstring's Readback section).
  private _lastReadback: PublishedSnapReadback | null = null;
  private _readbackInFlight: boolean = false;
  private _nextReadbackSequence: number = 0;
  private _nextQuerySequence: number = 0;
  private _stagingBuffer: GPUBuffer | null = null;
  private _stagingBufferSize: number = 0;
  private _stagingBufferDevice: GPUDevice | null = null;
  private _coldSnapWarned: boolean = false;

  constructor(context: CesiumGraphicsContext) {
    this._context = context;
    this._device = context._device ?? null;

    // Latch only the public/debug "ever used" diagnostic. Command
    // materialization is gated by the current `frameState.passes.snap`, so one
    // historical snap does not tax every later color frame. This object is
    // still constructed before `pickBegin` rebuilds commands for the first
    // snap mini-frame.
    const snapContext = this._context as CesiumGraphicsContext & {
      _snapEnabled?: boolean;
    };
    snapContext._snapEnabled = true;

    // One stable callback for every begin(); avoid allocating a closure on each
    // hover query when publishing the framebuffer facade below.
    this._coverageResetCallback = (renderPass) => {
      this._resetAccumulatedPayloadCoverage(renderPass);
    };

    this._passState = {
      context: context,
      framebuffer: undefined,
      blendingEnabled: false,
      scissorTest: {
        enabled: true,
        rectangle: new BoundingRectangle(),
      },
      viewport: new BoundingRectangle(),
    };
  }

  /**
   * Begin a snapping pass: allocate/resize the attachments and publish them on
   * the pass state so `WebGPUSceneRendererPickPass` can find them.
   *
   * Signature-compatible with `SnapFramebuffer.begin` and
   * `WebGPUPickFramebuffer.begin` — `Picking.pickBegin` calls all three
   * interchangeably.
   */
  begin(
    screenSpaceRectangle: CesiumBoundingRectangle,
    viewport: CesiumBoundingRectangle,
  ): CesiumPassState {
    // Start the off-screen mini-frame before any command rebuild, for the same
    // reason WebGPUPickFramebuffer.begin does: feature renderers allocate
    // uniform-ring slices during the scene update that follows.
    const snapFrameContext = this._context as CesiumGraphicsContext & {
      beginPickFrame?: () => void;
    };
    snapFrameContext.beginPickFrame?.();

    const device = this._context._device;
    if (!device) {
      return this._passState;
    }
    const deviceChanged = device !== this._attachmentDevice;
    this._device = device;
    if (deviceChanged) {
      this._coverageResetPipeline = null;
      this._coverageResetDevice = null;
    }

    const rawWidth = viewport?.width;
    const rawHeight = viewport?.height;
    const width =
      typeof rawWidth === "number" && rawWidth > 0 ? Math.floor(rawWidth) : 1;
    const height =
      typeof rawHeight === "number" && rawHeight > 0
        ? Math.floor(rawHeight)
        : 1;

    BoundingRectangle.clone(
      screenSpaceRectangle,
      this._passState.scissorTest.rectangle,
    );

    // Cesium supplies a GL-style bottom-origin y; WebGPU scissors and texture
    // copies are top-origin. Same conversion (and same deliberate refusal to
    // shift the logical origin at a canvas edge) as WebGPUPickFramebuffer.
    const snapWidth = Math.max(
      1,
      Math.min(width, Math.floor(screenSpaceRectangle.width ?? 1)),
    );
    const snapHeight = Math.max(
      1,
      Math.min(height, Math.floor(screenSpaceRectangle.height ?? 1)),
    );
    const glOriginX = Math.floor(screenSpaceRectangle.x ?? 0);
    const glOriginY = Math.floor(screenSpaceRectangle.y ?? 0);
    this._snapOriginX = glOriginX;
    this._snapOriginTopY = height - glOriginY - snapHeight;
    this._snapWidth = snapWidth;
    this._snapHeight = snapHeight;

    const copyRight = Math.max(
      0,
      Math.min(width, this._snapOriginX + snapWidth),
    );
    const copyBottom = Math.max(
      0,
      Math.min(height, this._snapOriginTopY + snapHeight),
    );
    this._copyOriginX = Math.max(0, Math.min(width, this._snapOriginX));
    this._copyOriginTopY = Math.max(0, Math.min(height, this._snapOriginTopY));
    this._copyWidth = Math.max(0, copyRight - this._copyOriginX);
    this._copyHeight = Math.max(0, copyBottom - this._copyOriginTopY);
    this._copyOffsetX = this._copyOriginX - this._snapOriginX;
    this._copyOffsetY = this._copyOriginTopY - this._snapOriginTopY;

    // The occluder attachment MUST match the pick pipelines' canonical target
    // format for the same reason the pick FBO's does (FORK-34).
    const occluderFormat = getWebGPUPickColorFormat(this._context);

    if (
      width !== this._width ||
      height !== this._height ||
      occluderFormat !== this._occluderFormat ||
      deviceChanged
    ) {
      this._destroyTextures();
      this._occluderFormat = occluderFormat;

      this._occluderTexture = device.createTexture({
        label: "Snap occluder color texture",
        size: [width, height],
        format: occluderFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this._snapTexture = device.createTexture({
        label: "Snap payload texture",
        size: [width, height],
        format: SNAP_PAYLOAD_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      this._depthTexture = device.createTexture({
        label: "Snap depth texture",
        size: [width, height],
        format: "depth24plus-stencil8",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });

      this._occluderView = this._occluderTexture.createView();
      this._snapView = this._snapTexture.createView();
      this._depthView = this._depthTexture.createView();

      this._width = width;
      this._height = height;
      this._attachmentDevice = device;
      this._attachmentGeneration++;
    }

    // `_isWebGPUPickFBO` is set alongside `_isWebGPUSnapFBO` on purpose: the
    // occluder phase IS the ordinary pick pass, and every downstream consumer
    // that checks for a WebGPU pick FBO (the pass executor's guard, the
    // classification-depth negotiation) must accept this object. The snap
    // marker is what upgrades the pass executor to the two-phase schedule.
    this._passState.framebuffer = {
      _isWebGPUPickFBO: true,
      _isWebGPUSnapFBO: true,
      colorTexture: this._occluderTexture,
      depthTexture: this._depthTexture,
      colorView: this._occluderView ?? undefined,
      depthView: this._depthView ?? undefined,
      snapColorView: this._snapView ?? undefined,
      snapColorFormat: SNAP_PAYLOAD_FORMAT,
      resetSnapPayloadCoverage: this._coverageResetCallback,
      width: this._width,
      height: this._height,
      pickScissor: {
        x: this._copyOriginX,
        y: this._copyOriginTopY,
        width: this._copyWidth,
        height: this._copyHeight,
      },
    } as CesiumOpaqueFramebuffer;

    this._passState.viewport.width = width;
    this._passState.viewport.height = height;

    return this._passState;
  }

  /**
   * Erase accumulated farther-slice payload wherever this slice has an
   * occluder. This runs inside the already-open payload render pass, after its
   * query scissor is installed and before any current-slice snap draw.
   */
  private _resetAccumulatedPayloadCoverage(
    renderPass: GPURenderPassEncoder,
  ): void {
    const device = this._device;
    if (!device) {
      return;
    }

    if (
      this._coverageResetPipeline === null ||
      this._coverageResetDevice !== device
    ) {
      const module = device.createShaderModule({
        label: "Snap payload coverage reset shader",
        code: SNAP_PAYLOAD_COVERAGE_RESET_WGSL,
      });
      this._coverageResetPipeline = device.createRenderPipeline({
        label: "Snap payload coverage reset pipeline",
        layout: "auto",
        vertex: {
          module,
          entryPoint: "vertexMain",
        },
        fragment: {
          module,
          entryPoint: "fragmentMain",
          targets: [{ format: SNAP_PAYLOAD_FORMAT }],
        },
        primitive: { topology: "triangle-list" },
        depthStencil: {
          format: "depth24plus-stencil8",
          depthWriteEnabled: false,
          depthCompare: "not-equal",
        },
      });
      this._coverageResetDevice = device;
    }

    renderPass.setPipeline(this._coverageResetPipeline);
    renderPass.draw(3);
  }

  private _captureReadbackRegion(): SnapReadbackRegion {
    return {
      logicalOriginX: this._snapOriginX,
      logicalOriginTopY: this._snapOriginTopY,
      logicalWidth: this._snapWidth,
      logicalHeight: this._snapHeight,
      copyOriginX: this._copyOriginX,
      copyOriginTopY: this._copyOriginTopY,
      copyWidth: this._copyWidth,
      copyHeight: this._copyHeight,
      copyOffsetX: this._copyOffsetX,
      copyOffsetY: this._copyOffsetY,
      attachmentGeneration: this._attachmentGeneration,
    };
  }

  private _readbackRegionsEqual(
    left: SnapReadbackRegion | null,
    right: SnapReadbackRegion,
  ): boolean {
    return (
      left !== null &&
      left.logicalOriginX === right.logicalOriginX &&
      left.logicalOriginTopY === right.logicalOriginTopY &&
      left.logicalWidth === right.logicalWidth &&
      left.logicalHeight === right.logicalHeight &&
      left.copyOriginX === right.copyOriginX &&
      left.copyOriginTopY === right.copyOriginTopY &&
      left.copyWidth === right.copyWidth &&
      left.copyHeight === right.copyHeight &&
      left.copyOffsetX === right.copyOffsetX &&
      left.copyOffsetY === right.copyOffsetY &&
      left.attachmentGeneration === right.attachmentGeneration
    );
  }

  /**
   * Cached bytes are meaningful under a later cursor only when the camera and
   * projection that produced them are unchanged. Cursor coordinates are
   * intentionally excluded: region overlap handles bounded cursor movement.
   * Strict scalar equality is conservative—any camera/frustum/resize change
   * returns cold rather than presenting an old-view point as current.
   */
  private _readbackViewsEquivalent(
    left: SnapViewProvenance,
    right: SnapViewProvenance,
  ): boolean {
    return (
      left.canvasWidth === right.canvasWidth &&
      left.canvasHeight === right.canvasHeight &&
      left.drawingBufferWidth === right.drawingBufferWidth &&
      left.drawingBufferHeight === right.drawingBufferHeight &&
      left.viewportX === right.viewportX &&
      left.viewportY === right.viewportY &&
      left.viewportWidth === right.viewportWidth &&
      left.viewportHeight === right.viewportHeight &&
      left.positionX === right.positionX &&
      left.positionY === right.positionY &&
      left.positionZ === right.positionZ &&
      left.directionX === right.directionX &&
      left.directionY === right.directionY &&
      left.directionZ === right.directionZ &&
      left.rightX === right.rightX &&
      left.rightY === right.rightY &&
      left.rightZ === right.rightZ &&
      left.upX === right.upX &&
      left.upY === right.upY &&
      left.upZ === right.upZ &&
      left.perspective === right.perspective &&
      left.fovy === right.fovy &&
      left.aspectRatio === right.aspectRatio &&
      left.near === right.near &&
      left.far === right.far &&
      left.left === right.left &&
      left.right === right.right &&
      left.top === right.top &&
      left.bottom === right.bottom &&
      left.sceneMode === right.sceneMode &&
      left.mapMode2D === right.mapMode2D &&
      left.wrapLongitude === right.wrapLongitude &&
      left.maxCoordinateX === right.maxCoordinateX
    );
  }

  /**
   * Decide whether a completed payload is still relevant to the current sync
   * query. Exact query geometry remains reusable; a moving cursor may consume
   * only a recent payload whose logical aperture overlaps the current one.
   * Its frozen rendered view must equal the current camera/projection; only the
   * cursor is then remapped explicitly by `_decodeForCurrentQuery`.
   */
  private _readbackIsRelevant(
    readback: PublishedSnapReadback,
    currentRegion: SnapReadbackRegion,
    currentQuerySequence: number,
    currentView: SnapViewProvenance,
  ): boolean {
    if (
      readback.attachmentGeneration !== currentRegion.attachmentGeneration ||
      !this._readbackViewsEquivalent(readback.view, currentView) ||
      currentQuerySequence < readback.querySequence ||
      currentQuerySequence - readback.querySequence > MAX_PRIOR_QUERY_AGE ||
      currentView.sceneFrameNumber < readback.view.sceneFrameNumber ||
      currentView.sceneFrameNumber - readback.view.sceneFrameNumber >
        MAX_PRIOR_SCENE_FRAME_AGE
    ) {
      return false;
    }
    if (this._readbackRegionsEqual(readback.region, currentRegion)) {
      return true;
    }

    const prior = readback.region;
    const priorCenterX =
      prior.logicalOriginX + Math.floor(prior.logicalWidth * 0.5);
    const priorCenterY =
      prior.logicalOriginTopY + Math.floor(prior.logicalHeight * 0.5);
    const currentCenterX =
      currentRegion.logicalOriginX +
      Math.floor(currentRegion.logicalWidth * 0.5);
    const currentCenterY =
      currentRegion.logicalOriginTopY +
      Math.floor(currentRegion.logicalHeight * 0.5);
    return (
      Math.abs(priorCenterX - currentCenterX) <=
        MAX_PRIOR_CURSOR_DELTA_PIXELS &&
      Math.abs(priorCenterY - currentCenterY) <=
        MAX_PRIOR_CURSOR_DELTA_PIXELS &&
      prior.logicalOriginX <
        currentRegion.logicalOriginX + currentRegion.logicalWidth &&
      currentRegion.logicalOriginX <
        prior.logicalOriginX + prior.logicalWidth &&
      prior.logicalOriginTopY <
        currentRegion.logicalOriginTopY + currentRegion.logicalHeight &&
      currentRegion.logicalOriginTopY <
        prior.logicalOriginTopY + prior.logicalHeight
    );
  }

  /**
   * Decode a completed aperture into the CURRENT query's cursor coordinates.
   * Overlap eligibility alone is not enough: candidates outside the current
   * aperture must be discarded, and the survivors must regain current-center
   * spiral order before renderer-neutral hit arbitration runs.
   */
  private _decodeForCurrentQuery(
    readback: PublishedSnapReadback,
    currentRegion: SnapReadbackRegion,
  ): WebGPUSnapHit[] {
    const prior = readback.region;
    const hits = decodeSnapHits(
      this._context,
      readback.pixels,
      prior.logicalWidth,
      prior.logicalHeight,
    );
    // Exact-region decode already arrives in the canonical outward spiral.
    // Avoid mutating every hit and invoking Array.sort on stationary hover.
    if (this._readbackRegionsEqual(prior, currentRegion)) {
      return hits;
    }

    const priorCenterX =
      prior.logicalOriginX + Math.floor(prior.logicalWidth * 0.5);
    const priorCenterY =
      prior.logicalOriginTopY + Math.floor(prior.logicalHeight * 0.5);
    const currentHalfWidth = Math.floor(currentRegion.logicalWidth * 0.5);
    const currentHalfHeight = Math.floor(currentRegion.logicalHeight * 0.5);
    const currentCenterX = currentRegion.logicalOriginX + currentHalfWidth;
    const currentCenterY = currentRegion.logicalOriginTopY + currentHalfHeight;
    const deltaX = priorCenterX - currentCenterX;
    const deltaY = priorCenterY - currentCenterY;
    const minX = -currentHalfWidth;
    const maxX = currentRegion.logicalWidth - currentHalfWidth - 1;
    const minY = -currentHalfHeight;
    const maxY = currentRegion.logicalHeight - currentHalfHeight - 1;

    let writeIndex = 0;
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      hit.x += deltaX;
      hit.y += deltaY;
      if (hit.x < minX || hit.x > maxX || hit.y < minY || hit.y > maxY) {
        continue;
      }
      hits[writeIndex++] = hit;
    }
    hits.length = writeIndex;
    hits.sort(compareSnapSpiralRank);
    return hits;
  }

  private _publishReadbackCache(
    pixels: Uint32Array,
    region: SnapReadbackRegion,
    requestSequence: number,
    requestDevice: GPUDevice,
    snapTexture: GPUTexture,
    view: SnapViewProvenance,
    querySequence: number,
  ): void {
    if (
      this._isDestroyed ||
      this._device !== requestDevice ||
      this._attachmentDevice !== requestDevice ||
      this._snapTexture !== snapTexture ||
      this._attachmentGeneration !== region.attachmentGeneration ||
      requestSequence < (this._lastReadback?.requestSequence ?? -1)
    ) {
      return;
    }
    this._lastReadback = Object.freeze({
      pixels,
      region,
      attachmentGeneration: region.attachmentGeneration,
      requestSequence,
      querySequence,
      view,
    });
  }

  /**
   * End the snapping pass and return the decoded hits.
   *
   * Signature-compatible with `SnapFramebuffer.end`. It returns the most
   * recent completed relevant payload described in the class Readback section;
   * a cold or non-overlapping snap returns `[]`.
   */
  end(
    screenSpaceRectangle: CesiumBoundingRectangle,
    view: SnapViewProvenance,
  ): SnapFramebufferEndResult {
    void screenSpaceRectangle;
    if (!this._device || !this._snapTexture) {
      return { hits: [], view };
    }

    const region = this._captureReadbackRegion();
    const querySequence = this._nextQuerySequence++;
    this._startReadback(region, view, querySequence);

    const readback = this._lastReadback;
    if (
      readback &&
      this._readbackIsRelevant(readback, region, querySequence, view)
    ) {
      return {
        hits: this._decodeForCurrentQuery(readback, region),
        view,
      };
    }

    // Cold/non-overlapping snap. Permanent, latched: an application developer
    // whose first `Scene.snap()` came back undefined needs to know this is the
    // WebGPU readback contract, not a missing feature.
    if (!this._coldSnapWarned) {
      this._coldSnapWarned = true;
      console.warn(
        "[CesiumJS:WebGPU] Scene.snap() has no completed readback near this " +
          "query yet because WebGPU reads the snap buffer asynchronously. " +
          "Subsequent stationary or nearby continuous-hover calls consume " +
          "the most recent completed relevant query.",
      );
    }
    return { hits: [], view };
  }

  /**
   * Record an ordered readback on the active snap-frame encoder. Callers must
   * invoke this method before `pickEnd`, then end the frame before awaiting the
   * returned promise. This preserves render -> copy submission order without a
   * private `queue.submit`.
   */
  endAsync(
    screenSpaceRectangle: CesiumBoundingRectangle,
    view?: SnapViewProvenance,
  ): Promise<WebGPUSnapHit[]> {
    void screenSpaceRectangle;
    const device = this._device;
    const snapTexture = this._snapTexture;
    if (!device || !snapTexture) {
      return Promise.resolve([]);
    }

    const region = this._captureReadbackRegion();
    const requestSequence = this._nextReadbackSequence++;
    const querySequence = this._nextQuerySequence++;

    // A query entirely outside the attachment still has a well-defined result:
    // every pixel is the clear key, which decodes to no hits.
    if (region.copyWidth === 0 || region.copyHeight === 0) {
      const pixels = new Uint32Array(
        region.logicalWidth * region.logicalHeight * SNAP_CHANNELS,
      );
      if (view) {
        this._publishReadbackCache(
          pixels,
          region,
          requestSequence,
          device,
          snapTexture,
          view,
          querySequence,
        );
      }
      return Promise.resolve([]);
    }

    const bytesPerRow = alignedSnapBytesPerRow(region.copyWidth);
    const bufferSize = bytesPerRow * region.copyHeight;
    const frameContext = this._context as CesiumGraphicsContext & {
      currentCommandEncoder?: GPUCommandEncoder | null;
      enqueueAfterFrameSubmit?: (
        callback: (submitted: boolean) => void,
      ) => boolean;
    };
    const encoder = frameContext.currentCommandEncoder;
    if (
      !encoder ||
      typeof frameContext.enqueueAfterFrameSubmit !== "function"
    ) {
      return Promise.resolve([]);
    }

    let stagingBuffer: GPUBuffer;
    try {
      stagingBuffer = device.createBuffer({
        label: "Snap async staging buffer",
        size: bufferSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      encoder.copyTextureToBuffer(
        {
          texture: snapTexture,
          origin: [region.copyOriginX, region.copyOriginTopY, 0],
        },
        {
          buffer: stagingBuffer,
          bytesPerRow,
          rowsPerImage: region.copyHeight,
        },
        [region.copyWidth, region.copyHeight],
      );
    } catch (error) {
      stagingBuffer?.destroy();
      return Promise.reject(error);
    }

    return new Promise<WebGPUSnapHit[]>((resolve, reject) => {
      const accepted = frameContext.enqueueAfterFrameSubmit?.((submitted) => {
        if (!submitted) {
          stagingBuffer.destroy();
          resolve([]);
          return;
        }

        let mapped = false;
        const cleanup = () => {
          if (mapped) {
            try {
              stagingBuffer.unmap();
            } catch {
              // Device loss may destroy a mapped buffer before cleanup.
            }
          }
          stagingBuffer.destroy();
        };
        stagingBuffer.mapAsync(GPUMapMode.READ).then(
          () => {
            mapped = true;
            try {
              if (this._isDestroyed) {
                cleanup();
                resolve([]);
                return;
              }
              const mappedData = new Uint32Array(
                stagingBuffer.getMappedRange(),
              );
              const pixels = unpackSnapPixels(mappedData, bytesPerRow, region);
              if (view) {
                this._publishReadbackCache(
                  pixels,
                  region,
                  requestSequence,
                  device,
                  snapTexture,
                  view,
                  querySequence,
                );
              }
              const hits = decodeSnapHits(
                this._context,
                pixels,
                region.logicalWidth,
                region.logicalHeight,
              );
              cleanup();
              resolve(hits);
            } catch (error) {
              cleanup();
              reject(error);
            }
          },
          (error) => {
            cleanup();
            reject(error);
          },
        );
      });
      if (!accepted) {
        stagingBuffer.destroy();
        resolve([]);
      }
    });
  }

  /**
   * Return the persistent staging buffer used by the synchronous path. A
   * mapping-pending buffer cannot be replaced; the current request is skipped
   * and the next one retries once the map resolves.
   */
  private _ensureSyncStagingBuffer(bufferSize: number): GPUBuffer | null {
    const device = this._device;
    if (!device || !(bufferSize > 0)) {
      return null;
    }
    if (
      this._stagingBuffer &&
      this._stagingBufferDevice === device &&
      this._stagingBufferSize === bufferSize
    ) {
      return this._stagingBuffer;
    }
    if (this._readbackInFlight) {
      return null;
    }
    const replacement = device.createBuffer({
      label: "Snap sync staging buffer",
      size: bufferSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const previous = this._stagingBuffer;
    this._stagingBuffer = replacement;
    this._stagingBufferSize = bufferSize;
    this._stagingBufferDevice = device;
    previous?.destroy();
    return replacement;
  }

  /**
   * Arm an ordered readback whose result a later synchronous `end()` can
   * consume when its query remains relevant.
   */
  private _startReadback(
    region: SnapReadbackRegion,
    view: SnapViewProvenance,
    querySequence: number,
  ): void {
    const device = this._device;
    const snapTexture = this._snapTexture;
    if (!device || !snapTexture) {
      return;
    }
    // Submitting a copy into a mapping-pending buffer throws
    // "Buffer used in submit while mapped".
    if (this._readbackInFlight) {
      return;
    }

    const requestSequence = this._nextReadbackSequence++;
    if (region.copyWidth === 0 || region.copyHeight === 0) {
      this._publishReadbackCache(
        new Uint32Array(
          region.logicalWidth * region.logicalHeight * SNAP_CHANNELS,
        ),
        region,
        requestSequence,
        device,
        snapTexture,
        view,
        querySequence,
      );
      return;
    }

    const bytesPerRow = alignedSnapBytesPerRow(region.copyWidth);
    const stagingBuffer = this._ensureSyncStagingBuffer(
      bytesPerRow * region.copyHeight,
    );
    if (!stagingBuffer) {
      return;
    }

    const frameContext = this._context as CesiumGraphicsContext & {
      currentCommandEncoder?: GPUCommandEncoder | null;
      enqueueAfterFrameSubmit?: (
        callback: (submitted: boolean) => void,
      ) => boolean;
    };
    const encoder = frameContext.currentCommandEncoder;
    if (
      !encoder ||
      typeof frameContext.enqueueAfterFrameSubmit !== "function"
    ) {
      return;
    }
    encoder.copyTextureToBuffer(
      {
        texture: snapTexture,
        origin: [region.copyOriginX, region.copyOriginTopY, 0],
      },
      {
        buffer: stagingBuffer,
        bytesPerRow,
        rowsPerImage: region.copyHeight,
      },
      [region.copyWidth, region.copyHeight],
    );

    this._readbackInFlight = true;
    const accepted = frameContext.enqueueAfterFrameSubmit((submitted) => {
      if (!submitted) {
        this._readbackInFlight = false;
        return;
      }
      stagingBuffer
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          try {
            if (
              this._isDestroyed ||
              this._stagingBuffer !== stagingBuffer ||
              this._stagingBufferDevice !== device ||
              this._device !== device ||
              this._snapTexture !== snapTexture
            ) {
              // The attachment/device generation changed while the copy was in
              // flight; its bytes must not warm the cache for the replacement.
              return;
            }
            const mappedData = new Uint32Array(stagingBuffer.getMappedRange());
            const pixels = unpackSnapPixels(mappedData, bytesPerRow, region);
            this._publishReadbackCache(
              pixels,
              region,
              requestSequence,
              device,
              snapTexture,
              view,
              querySequence,
            );
          } finally {
            try {
              stagingBuffer.unmap();
            } catch {
              // A destroyed buffer cannot be unmapped; teardown already owns it.
            }
            this._readbackInFlight = false;
          }
        })
        .catch(() => {
          this._readbackInFlight = false;
        });
    });
    if (!accepted) {
      this._readbackInFlight = false;
    }
  }

  private _destroyTextures(): void {
    this._occluderTexture?.destroy();
    this._snapTexture?.destroy();
    this._depthTexture?.destroy();
    this._occluderTexture = null;
    this._snapTexture = null;
    this._depthTexture = null;
    this._occluderView = null;
    this._snapView = null;
    this._depthView = null;
    this._attachmentDevice = null;
    // Cached bytes belong to the destroyed payload target and cannot be decoded
    // as the first result of its replacement.
    this._lastReadback = null;
  }

  isDestroyed(): boolean {
    return this._isDestroyed;
  }

  destroy(): void {
    this._isDestroyed = true;
    this._destroyTextures();
    if (this._stagingBuffer) {
      this._stagingBuffer.destroy();
      this._stagingBuffer = null;
    }
    this._stagingBufferSize = 0;
    this._stagingBufferDevice = null;
    this._readbackInFlight = false;
    this._coverageResetPipeline = null;
    this._coverageResetDevice = null;
  }
}

export default WebGPUSnapFramebuffer;
