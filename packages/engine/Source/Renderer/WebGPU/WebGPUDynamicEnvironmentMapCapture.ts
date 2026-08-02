/// <reference types="@webgpu/types" />
/**
 * C2-25 ENV-SCENE-CAPTURE (Batch 446) — globe slice.
 *
 * Renders the opaque globe surface into the dynamic-environment-map cube's 6
 * faces from 6 ENU cube-face cameras centered on the reflective owner, so
 * terrain reflects in water / PBR models instead of only the procedural sky.
 * Companion of `WebGPUDynamicEnvironmentMapManager` (kept separate to keep both
 * files focused + under the size budget).
 *
 * Mechanism (Approach B — generalize the CSM override-camera pass to color):
 *
 *   1. Snapshot the main camera (`uniformState.camera` proxy fields).
 *   2. For each cube face: build the ENU 90° face camera, repoint
 *      `uniformState.updateCamera(faceCamera)` (the SAME seam the WebGL shadow
 *      loop uses — the globe camera-UB packer reads view/proj/RTE EXCLUSIVELY
 *      from `uniformState`), then ask the globe renderer to build its OWN
 *      single-target capture commands for the visible tile set
 *      (`getOrCreateCaptureTileCommands`), open a render pass on
 *      `cache.faceViews[face]` (`loadOp: 'load'` to preserve the compute sky),
 *      and replay the commands.
 *   3. In a `finally`, restore the main camera via
 *      `uniformState.updateCamera(mainCamera)` — BEFORE any later frame stage
 *      reads `uniformState` — so the DP-H41 `previousViewProjection` tail AND
 *      the `_logDepthEncodeNearFar` stash never leak the face camera into the
 *      main scene's motion-vector / depth-classify decode.
 *
 * Default-OFF byte-identity: `runSceneCapture` is only reached when BOTH the
 * context flag AND the manager flag are true AND the scene is SCENE3D. OFF it
 * is never entered → no encoder/pass/submit, no `uniformState.updateCamera`,
 * no allocation.
 *
 * Tile-set fidelity (V1): reuses the MAIN-camera-selected visible tile set (the
 * CSM precedent). Faces pointing away from the main view get coarse/absent
 * tiles; back faces may show only the compute sky. Per-face quadtree
 * re-selection is explicitly deferred (DEFERRED_WORK: ENV-CAPTURE-PER-FACE-LOD).
 *
 * Face-basis convention (TOP correctness risk — verify with a colored-landmark
 * ON probe, not just a diff drop): the cube is filled + sampled in the IBL
 * reference frame (a planet-local +Y-up frame), and `faceUVToLocalDir` in
 * `ProceduralSkyCubemap.wgsl` maps (face, uv) → a direction in that local frame
 * with local +X = East, local +Y = Up (geodetic), local +Z = North. The 6
 * face cameras are built so face index == `cache.faceViews[i].baseArrayLayer`
 * == `faceUVToLocalDir` case index, looking along the world direction the cube
 * texel represents, with a screen-matched up/right so the rendered texel lands
 * exactly where the sky fill + IBL prefilter sample it back.
 *
 * @module WebGPUDynamicEnvironmentMapCapture
 */

import Cartesian3 from "../../Core/Cartesian3.js";
import Cartographic from "../../Core/Cartographic.js";
import Ellipsoid from "../../Core/Ellipsoid.js";
import Matrix4 from "../../Core/Matrix4.js";
import PerspectiveFrustum from "../../Core/PerspectiveFrustum.js";
import Transforms from "../../Core/Transforms.js";
import { updateEclipseGlobeShadowForFrameState } from "../../Scene/EclipseGlobeShadow.js";
import type { PooledDepthTarget } from "./WebGPUEnvironmentTargetPool.js";

/** Minimal env-cube cache view the capture pass reads/writes. */
export interface SceneCaptureCache {
  faceViews: GPUTextureView[];
  size: number;
  cubemapFormat?: GPUTextureFormat;
  captureDepthTexture: GPUTexture | null;
  captureDepthView: GPUTextureView | null;
  captureDepthSize: number;
  framesSinceCapture: number;
  lastCaptureCameraX: number;
  lastCaptureCameraY: number;
  lastCaptureCameraZ: number;
}

/** Minimal manager view the capture pass reads. */
export interface SceneCaptureManager {
  _position: CesiumCartesian3;
  enableSceneCapture?: boolean;
}

/**
 * C11-193 — minimal view of {@link WebGPUEnvironmentTargetPool} this module
 * needs. Structural so the capture pass keeps no dependency on the pool module.
 */
export interface SceneCaptureTargetPool {
  acquireDepthTarget(
    size: number,
    format: GPUTextureFormat,
    label: string,
  ): PooledDepthTarget;
  releaseDepthTarget(handle: PooledDepthTarget | null): void;
}

export const SceneCaptureResult = Object.freeze({
  FAILED: 0,
  SKY_ONLY: 1,
  SUBMITTED: 2,
  PARTIAL: 3,
} as const);

export type SceneCaptureResultValue =
  (typeof SceneCaptureResult)[keyof typeof SceneCaptureResult];

/** A single-target globe capture command (subset of `TileDrawDescriptor`). */
interface CaptureCommand {
  pipeline: GPURenderPipeline;
  bindGroups: GPUBindGroup[];
  bindGroup0DynamicOffsets?: number[];
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  indexFormat: GPUIndexFormat;
}

/** The globe renderer surface the capture pass calls into. */
interface CaptureGlobeRenderer {
  getOrCreateCaptureTileCommands(
    tile: { level: number; x: number; y: number; rectangle: unknown },
    surfaceTile: unknown,
    tileProvider: unknown,
    frameState: CesiumFrameState,
    uniformState: unknown,
    faceFormat: GPUTextureFormat,
  ): CaptureCommand[] | null;
}

/** Published per-frame by `GlobeSurfaceTileProviderRendering` (WebGPU path). */
interface SceneCaptureSources {
  frameNumber: number;
  publicationRevision: number;
  contentRevision: number;
  globeRenderer: CaptureGlobeRenderer;
  tileProvider: {
    _quadtree?: { _tilesToRender?: object[] };
    _oldVerticalExaggeration?: number;
    _oldVerticalExaggerationRelativeHeight?: number;
    _eclipseSurfaceRadius?: number;
    _eclipseSelectionRevision?: number;
    _sceneCaptureContentRevision?: number;
  };
}

/** A single-target model capture command (subset built by the model renderer). */
interface ModelCaptureCommand {
  pipeline: GPURenderPipeline;
  bindGroups: GPUBindGroup[];
  /**
   * C11-195 — the model group-0 camera layout declares `hasDynamicOffset`,
   * so this face's camera slice is addressed by offset rather than by a
   * per-record bind group. Always present for arena-built records.
   */
  bindGroup0DynamicOffsets?: number[];
  vertexBuffers: GPUBuffer[];
  indexBuffer: GPUBuffer;
  indexCount: number;
  indexFormat: GPUIndexFormat;
  instanceCount: number;
}

/**
 * C2-25 ENV-SCENE-CAPTURE (Batch 447) — published per-frame by the WebGPU model
 * feature renderer (`updateWebGPUModel`) when `context.sceneCaptureReflections`
 * is true. Carries the visible models' camera-independent draw records plus the
 * builder that turns them into per-face single-target draw descriptors. glTF +
 * 3D Tiles BOTH flow through the model renderer, so this covers both in one
 * producer.
 */
interface SceneCaptureModels {
  frameNumber: number;
  models: unknown[];
  buildCaptureCommands(
    entry: unknown,
    device: GPUDevice,
    frameState: CesiumFrameState,
    faceFormat: GPUTextureFormat,
    faceIndex: number,
  ): ModelCaptureCommand[];
}

// A ShadowMapCamera-shaped object the capture loop hands to
// `uniformState.updateCamera`. Reused across the 6 faces (and the snapshot) so
// the per-capture pack does not allocate.
interface FaceCamera {
  viewMatrix: number[];
  inverseViewMatrix: number[];
  positionWC: Cartesian3;
  directionWC: Cartesian3;
  upWC: Cartesian3;
  rightWC: Cartesian3;
  positionCartographic: Cartographic;
  frustum: PerspectiveFrustum;
}

// ── Local face basis (IBL reference frame, +Y up) ──
// Per face: [forward, up, right] in the cube's local frame. Derived directly
// from `faceUVToLocalDir` (ProceduralSkyCubemap.wgsl): forward = the face's
// center direction (s=t=0); right = +∂s; up = −∂t (so screen-up maps to
// decreasing texel-v, matching WebGPU's top-left framebuffer origin). Face
// index == cube layer == faceUvToDirection case index.
const LOCAL_FACE_BASIS: ReadonlyArray<{
  fwd: readonly [number, number, number];
  up: readonly [number, number, number];
  right: readonly [number, number, number];
}> = [
  // +X (East)
  { fwd: [1, 0, 0], up: [0, 1, 0], right: [0, 0, -1] },
  // -X (West)
  { fwd: [-1, 0, 0], up: [0, 1, 0], right: [0, 0, 1] },
  // +Y (Up / zenith)
  { fwd: [0, 1, 0], up: [0, 0, -1], right: [1, 0, 0] },
  // -Y (Down / nadir)
  { fwd: [0, -1, 0], up: [0, 0, 1], right: [1, 0, 0] },
  // +Z (North)
  { fwd: [0, 0, 1], up: [0, 1, 0], right: [1, 0, 0] },
  // -Z (South)
  { fwd: [0, 0, -1], up: [0, 1, 0], right: [-1, 0, 0] },
];

// Scratch ENU columns (East / North / Up) — reused per face.
const enuMatrix = new Matrix4();
const enuEast = new Cartesian3();
const enuNorth = new Cartesian3();
const enuUp = new Cartesian3();
const scratchEye = new Cartesian3();

/**
 * Transform a local (+Y-up reference-frame) vector to world via the ENU basis:
 *   world = v.x·East + v.y·Up + v.z·North
 * (local X = East, local Y = Up, local Z = North — matching the sky fill's
 * `dot(sunWC, enuX/enuZ/enuY)` mapping).
 */
function localToWorld(
  v: readonly [number, number, number],
  result: Cartesian3,
): Cartesian3 {
  result.x = v[0] * enuEast.x + v[1] * enuUp.x + v[2] * enuNorth.x;
  result.y = v[0] * enuEast.y + v[1] * enuUp.y + v[2] * enuNorth.y;
  result.z = v[0] * enuEast.z + v[1] * enuUp.z + v[2] * enuNorth.z;
  return Cartesian3.normalize(result, result);
}

/**
 * Populate `out` with the ENU 90° cube-face camera for `face` at world eye
 * `eyeWC`. The ENU columns are taken from `eastNorthUpToFixedFrame(eyeWC)`;
 * `localToWorld` rotates the precomputed local face basis into world space.
 */
export function buildCubeFaceCamera(
  out: FaceCamera,
  eyeWC: CesiumCartesian3,
  face: number,
  near: number,
  far: number,
): void {
  scratchEye.x = eyeWC.x;
  scratchEye.y = eyeWC.y;
  scratchEye.z = eyeWC.z;
  Transforms.eastNorthUpToFixedFrame(scratchEye, Ellipsoid.WGS84, enuMatrix);
  // Read the basis columns directly from the column-major Matrix4 (avoids the
  // Cartesian4 result-type of `getColumn`). Column 0 = East (indices 0..2),
  // column 1 = North (4..6), column 2 = Up (8..10). Re-normalize to drop the
  // (near-1) basis-column scale.
  const m = enuMatrix as unknown as number[];
  enuEast.x = m[0];
  enuEast.y = m[1];
  enuEast.z = m[2];
  enuNorth.x = m[4];
  enuNorth.y = m[5];
  enuNorth.z = m[6];
  enuUp.x = m[8];
  enuUp.y = m[9];
  enuUp.z = m[10];
  Cartesian3.normalize(enuEast, enuEast);
  Cartesian3.normalize(enuNorth, enuNorth);
  Cartesian3.normalize(enuUp, enuUp);

  const basis = LOCAL_FACE_BASIS[face];
  localToWorld(basis.fwd, out.directionWC);
  localToWorld(basis.up, out.upWC);
  localToWorld(basis.right, out.rightWC);

  out.positionWC.x = eyeWC.x;
  out.positionWC.y = eyeWC.y;
  out.positionWC.z = eyeWC.z;

  Ellipsoid.WGS84.cartesianToCartographic(
    out.positionWC,
    out.positionCartographic,
  );

  out.frustum.fov = Math.PI / 2.0;
  out.frustum.aspectRatio = 1.0;
  out.frustum.near = near;
  out.frustum.far = far;

  Matrix4.computeView(
    out.positionWC,
    out.directionWC,
    out.upWC,
    out.rightWC,
    out.viewMatrix as unknown as Matrix4,
  );
  Matrix4.inverse(
    out.viewMatrix as unknown as Matrix4,
    out.inverseViewMatrix as unknown as Matrix4,
  );
}

function makeFaceCamera(): FaceCamera {
  return {
    viewMatrix: new Array(16).fill(0),
    inverseViewMatrix: new Array(16).fill(0),
    positionWC: new Cartesian3(),
    directionWC: new Cartesian3(),
    upWC: new Cartesian3(),
    rightWC: new Cartesian3(),
    positionCartographic: new Cartographic(),
    frustum: new PerspectiveFrustum(),
  };
}

const faceCameraScratch = makeFaceCamera();

/**
 * Whether the current frame has a published globe renderer and at least one
 * selected tile that scene capture can replay.
 *
 * The manager uses this preflight only for its periodic/movement refresh
 * trigger. A newly created/recovered cache still performs one bounded attempt
 * before publication, then requests one follow-up frame.
 */
export function hasRenderableSceneCaptureSources(
  frameState: CesiumFrameState,
): boolean {
  if (frameState.globeVisible === false) {
    return false;
  }

  const sources = (
    frameState.context as unknown as {
      _webgpuSceneCaptureSources?: SceneCaptureSources | null;
    }
  )._webgpuSceneCaptureSources;
  const tiles = sources?.tileProvider?._quadtree?._tilesToRender;
  const frameNumber = frameState.frameNumber;
  const sourcesAreCurrent =
    sources !== undefined &&
    sources !== null &&
    (sources.frameNumber === frameNumber ||
      sources.frameNumber === frameNumber - 1) &&
    sources.contentRevision ===
      (sources.tileProvider._sceneCaptureContentRevision ?? 0);
  return Boolean(
    sourcesAreCurrent &&
    sources.globeRenderer &&
    tiles !== undefined &&
    tiles.length > 0,
  );
}

/**
 * Return the revision of a renderable source publication, or `-1` while the
 * globe producer is absent/stale. The revision advances only when publication
 * resumes after a gap, switches renderer/provider, or publishes changed
 * selected resources, so the manager can force exactly one capture on the
 * requested follow-up frame.
 */
export function getRenderableSceneCaptureSourceRevision(
  frameState: CesiumFrameState,
): number {
  if (!hasRenderableSceneCaptureSources(frameState)) {
    return -1;
  }

  const sources = (
    frameState.context as unknown as {
      _webgpuSceneCaptureSources?: SceneCaptureSources | null;
    }
  )._webgpuSceneCaptureSources;
  return sources?.publicationRevision ?? -1;
}

function getCurrentSceneCaptureModels(
  frameState: CesiumFrameState,
): SceneCaptureModels | null {
  const models = (
    frameState.context as unknown as {
      _webgpuSceneCaptureModels?: SceneCaptureModels | null;
    }
  )._webgpuSceneCaptureModels;
  const frameNumber = frameState.frameNumber;
  if (
    !models ||
    (models.frameNumber !== frameNumber &&
      models.frameNumber !== frameNumber - 1) ||
    !models.models ||
    models.models.length === 0 ||
    typeof models.buildCaptureCommands !== "function"
  ) {
    return null;
  }
  return models;
}

/**
 * Run the 6-face globe scene capture into the env cube. The CALLER owns the
 * debounce (every-K-frames / camera-moved) + the sky-fill-then-capture ordering
 * — `runSceneCapture` composites the requested globe/model sources over the
 * just-filled compute sky. It still self-gates on the double opt-in + SCENE3D;
 * a hidden globe may intentionally run the model-only path.
 *
 * When `commandEncoder` is supplied, capture records into that encoder and
 * leaves final submission to the caller. The result still reports `SUBMITTED`
 * for a complete recorded composite because the manager submits synchronously
 * before committing debounce state.
 *
 * @returns A result that distinguishes a complete recorded/submitted capture,
 *   an intentional sky-only state, and a missing/partial replay. Only
 *   `SUBMITTED` is a complete scene composite for debounce bookkeeping.
 */
export function runSceneCapture(
  device: GPUDevice,
  cache: SceneCaptureCache,
  manager: SceneCaptureManager,
  frameState: CesiumFrameState,
  includeGlobe = true,
  commandEncoder?: GPUCommandEncoder,
  targetPool?: SceneCaptureTargetPool | null,
): SceneCaptureResultValue {
  // ── Gate: double opt-in + SCENE3D ──
  const ctx = frameState.context as unknown as {
    sceneCaptureReflections?: boolean;
    _webgpuSceneCaptureSources?: SceneCaptureSources | null;
    _webgpuSceneCaptureModels?: SceneCaptureModels | null;
    uniformState?: {
      updateCamera(camera: unknown): void;
    };
    flushPendingUniformUploads?: () => void;
    flushPendingTextureMipJobs?: () => void;
  };
  if (
    ctx.sceneCaptureReflections !== true ||
    manager.enableSceneCapture !== true ||
    frameState.mode !== 3 /* SceneMode.SCENE3D */ ||
    !manager._position
  ) {
    return SceneCaptureResult.FAILED;
  }

  const sources = includeGlobe ? ctx._webgpuSceneCaptureSources : null;
  const tiles = sources?.tileProvider?._quadtree?._tilesToRender;
  const globeRenderer = sources?.globeRenderer;
  if (
    includeGlobe &&
    (!hasRenderableSceneCaptureSources(frameState) ||
      !sources ||
      !globeRenderer ||
      !tiles)
  ) {
    // Globe hasn't published a visible tile set yet (first frame before
    // `globe.render`, including the first recovered frame) — nothing to
    // capture this frame. The producer owns the one-shot publication wake; the
    // manager records no successful debounce state for this miss.
    return SceneCaptureResult.FAILED;
  }

  const captureModels = getCurrentSceneCaptureModels(frameState);
  if (!includeGlobe && !captureModels) {
    return SceneCaptureResult.SKY_ONLY;
  }

  const uniformState = ctx.uniformState;
  // Restore target: the live main camera object the scene built `uniformState`
  // from this frame (`UniformState.update` → `updateCamera(frameState.camera)`).
  // Restoring with this exact object round-trips the main-camera view / proj /
  // RTE state precisely (no snapshot approximation).
  const mainCamera = (frameState as unknown as { camera?: unknown }).camera;
  if (!uniformState || !mainCamera) {
    return SceneCaptureResult.FAILED;
  }

  // The retained source array is mutable and belongs to the previous globe
  // selection. Refine the one View-owned S5 block against those exact meshes
  // before any face command snapshots it. If exaggeration changed since the
  // list was produced, retain the conservative coarse result instead.
  if (sources && tiles) {
    const tileProvider = sources.tileProvider;
    const retainedBoundsCurrent =
      tileProvider._oldVerticalExaggeration ===
        frameState.verticalExaggeration &&
      tileProvider._oldVerticalExaggerationRelativeHeight ===
        frameState.verticalExaggerationRelativeHeight;
    updateEclipseGlobeShadowForFrameState(
      frameState,
      retainedBoundsCurrent ? tileProvider._eclipseSurfaceRadius : undefined,
      retainedBoundsCurrent ? tiles : undefined,
      retainedBoundsCurrent
        ? tileProvider._eclipseSelectionRevision
        : undefined,
    );
  }

  const eye = manager._position;
  const faceFormat = cache.cubemapFormat ?? "rgba8unorm";
  const size = cache.size || 256;

  // Eye = the reflective owner's bounding-sphere center (NOT the scene camera).
  // Near/far span the planet surface so the 90° face frustum reaches the
  // visible terrain on the sky-facing hemisphere (back faces show only sky).
  scratchEye.x = eye.x;
  scratchEye.y = eye.y;
  scratchEye.z = eye.z;
  const radius = Cartesian3.magnitude(scratchEye);
  const near = 1.0;
  const far = radius * 2.5;

  // C2-25 ENV-SCENE-CAPTURE (Batch 447) — model / 3D-Tiles capture sources
  // published by the WebGPU model FR last frame (frame-stable refs). When
  // capture is OFF the model FR never publishes (byte-identical), so this is
  // null and the model replay below is skipped — globe-only capture (Batch 446)
  // is unchanged.
  const ownsEncoder = commandEncoder === undefined;
  let encoder: GPUCommandEncoder | null = commandEncoder ?? null;
  let globeDrawCount = 0;
  let modelDrawCount = 0;
  // C11-193 — borrowed depth target for this replay. Non-null only when the
  // context pool is available; the manager-local fallback below is unchanged so
  // standalone/spec callers keep the historical lifetime.
  let pooledDepth: PooledDepthTarget | null = null;

  try {
    for (let face = 0; face < 6; face++) {
      const faceView = cache.faceViews[face];
      if (!faceView) {
        continue;
      }
      buildCubeFaceCamera(faceCameraScratch, eye, face, near, far);
      uniformState.updateCamera(faceCameraScratch);

      // Build this face's globe commands AFTER repointing uniformState so the
      // camera-UB packer bakes the FACE-camera RTE matrices.
      const allCommands: CaptureCommand[] = [];
      if (includeGlobe && sources && tiles && globeRenderer) {
        for (let t = 0; t < tiles.length; t++) {
          const tile = tiles[t] as {
            level: number;
            x: number;
            y: number;
            rectangle: unknown;
            data?: unknown;
          };
          if (!tile || !tile.data) {
            continue;
          }
          const cmds = globeRenderer.getOrCreateCaptureTileCommands(
            tile,
            tile.data,
            sources.tileProvider,
            frameState,
            uniformState,
            faceFormat,
          );
          if (cmds) {
            for (let c = 0; c < cmds.length; c++) {
              if (cmds[c].indexCount > 0) {
                allCommands.push(cmds[c]);
              }
            }
          }
        }
      }

      // C2-25 (Batch 447) — build this face's MODEL / 3D-Tiles commands AFTER
      // repointing uniformState (so the per-face camera UB bakes the FACE-camera
      // RTE eye via the ring allocator). Replayed AFTER the globe in the SAME
      // pass on the shared depth target: globe depth-writes first, models
      // depth-test+write over it (model occludes globe, globe occludes sky).
      const modelCommands: ModelCaptureCommand[] = [];
      if (captureModels) {
        const pubModels = captureModels.models;
        for (let m = 0; m < pubModels.length; m++) {
          const cmds = captureModels.buildCaptureCommands(
            pubModels[m],
            device,
            frameState,
            faceFormat,
            face,
          );
          for (let c = 0; c < cmds.length; c++) {
            if (cmds[c].indexCount > 0 && cmds[c].instanceCount > 0) {
              modelCommands.push(cmds[c]);
            }
          }
        }
      }

      if (allCommands.length === 0 && modelCommands.length === 0) {
        continue;
      }

      // Allocate the transient target and encoder only after at least one real
      // indexed draw exists. An empty replay must not submit six empty passes
      // or report a successful scene composite.
      //
      // C11-193 — this target is `depthStoreOp: "discard"` and every face pass
      // clears it, so it has no cross-refresh contents worth owning per manager.
      // When the context pool is available, borrow one context-wide target for
      // the whole replay and give it back in the `finally` below; several
      // managers then share a single `size x size` depth allocation.
      if (pooledDepth === null && targetPool) {
        pooledDepth = targetPool.acquireDepthTarget(
          size,
          "depth24plus",
          "DynEnvMap Capture Depth",
        );
        // A manager that previously owned a private target must release it, or
        // it would sit resident for the rest of the manager's life alongside
        // the pooled one.
        if (cache.captureDepthTexture) {
          cache.captureDepthTexture.destroy();
          cache.captureDepthTexture = null;
          cache.captureDepthView = null;
          cache.captureDepthSize = 0;
        }
      }
      if (
        pooledDepth === null &&
        (!cache.captureDepthView || cache.captureDepthSize !== size)
      ) {
        cache.captureDepthTexture?.destroy();
        cache.captureDepthTexture = device.createTexture({
          label: "DynEnvMap Capture Depth",
          size: { width: size, height: size },
          format: "depth24plus",
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        cache.captureDepthView = cache.captureDepthTexture.createView();
        cache.captureDepthSize = size;
      }
      const depthView = pooledDepth?.view ?? cache.captureDepthView;
      if (!depthView) {
        // Permanent null-target guard: opening a depth-stencil attachment with
        // a null view invalidates the whole command buffer, which would take
        // the frame's scene passes down with it.
        console.error(
          "[CesiumJS:webgpu] DynEnvMap scene capture has no depth target view; skipping face.",
        );
        continue;
      }
      encoder ??= device.createCommandEncoder({
        label: "DynEnvMap Scene Capture",
      });

      // Open the per-face pass on the cube face (loadOp 'load' preserves the
      // compute sky the globe composites OVER); globe writes LINEAR.
      const pass = encoder.beginRenderPass({
        label: `DynEnvMap Capture Face ${face}`,
        colorAttachments: [
          {
            view: faceView,
            loadOp: "load",
            storeOp: "store",
          },
        ],
        depthStencilAttachment: {
          view: depthView,
          depthClearValue: 1.0,
          depthLoadOp: "clear",
          depthStoreOp: "discard",
        },
      });

      for (let i = 0; i < allCommands.length; i++) {
        const cmd = allCommands[i];
        pass.setPipeline(cmd.pipeline);
        for (let bg = 0; bg < cmd.bindGroups.length; bg++) {
          if (bg === 0 && cmd.bindGroup0DynamicOffsets !== undefined) {
            pass.setBindGroup(
              0,
              cmd.bindGroups[0],
              cmd.bindGroup0DynamicOffsets,
            );
          } else {
            pass.setBindGroup(bg, cmd.bindGroups[bg]);
          }
        }
        pass.setVertexBuffer(0, cmd.vertexBuffer);
        pass.setIndexBuffer(cmd.indexBuffer, cmd.indexFormat);
        pass.drawIndexed(cmd.indexCount);
        globeDrawCount++;
      }

      // C2-25 (Batch 447) — replay the MODEL / 3D-Tiles commands AFTER the globe
      // so the shared depth buffer occludes correctly (model over globe, globe
      // over sky). Each model command carries its own 4 bind groups
      // (neutral-IBL material + instance + effects, plus the shared group-0
      // camera arena page) and full vertex buffer list. C11-195 — group 0 is
      // now a dynamic-offset binding: the per-face, per-record camera slice
      // is selected by `bindGroup0DynamicOffsets`, so it MUST be forwarded or
      // every record would read the same (wrong) block.
      for (let i = 0; i < modelCommands.length; i++) {
        const cmd = modelCommands[i];
        pass.setPipeline(cmd.pipeline);
        for (let bg = 0; bg < cmd.bindGroups.length; bg++) {
          if (bg === 0 && cmd.bindGroup0DynamicOffsets !== undefined) {
            pass.setBindGroup(
              0,
              cmd.bindGroups[0],
              cmd.bindGroup0DynamicOffsets,
            );
          } else {
            pass.setBindGroup(bg, cmd.bindGroups[bg]);
          }
        }
        for (let vb = 0; vb < cmd.vertexBuffers.length; vb++) {
          pass.setVertexBuffer(vb, cmd.vertexBuffers[vb]);
        }
        pass.setIndexBuffer(cmd.indexBuffer, cmd.indexFormat);
        pass.drawIndexed(cmd.indexCount, cmd.instanceCount);
        modelDrawCount++;
      }
      pass.end();
    }
  } finally {
    // Restore the main camera BEFORE any later frame stage reads uniformState.
    // Restoring with the LIVE main camera object reproduces the exact
    // main-camera view / proj / frustum (its projectionMatrix getter recomputes
    // from its own unchanged fov/aspect/near/far). Covers the DP-H41
    // previousViewProjection tail AND the _logDepthEncodeNearFar stash; a throw
    // mid-loop must not leak the face camera into the main scene.
    uniformState.updateCamera(mainCamera);
    // C11-193 — give the borrowed depth target back on EVERY exit, including a
    // throw. Release is not destroy: the pool retains the texture, so the
    // commands recorded against it above stay valid until they are submitted
    // (and the pool's idle trim refuses to destroy anything used this frame).
    if (pooledDepth !== null && targetPool) {
      targetPool.releaseDepthTarget(pooledDepth);
      pooledDepth = null;
    }
  }

  if (!encoder || globeDrawCount + modelDrawCount === 0) {
    return includeGlobe
      ? SceneCaptureResult.FAILED
      : SceneCaptureResult.SKY_ONLY;
  }

  // Camera/tile/S5 payloads above were staged in the frame-owned uniform ring,
  // whose normal flush is endFrame — too late for either a private capture
  // submit or the manager-owned refresh submit. Flush those queue writes first,
  // then imagery mip jobs, so queue order is uniforms → mips → capture passes.
  // Multiple managers may flush incrementally; the ring uploader tracks the
  // already-flushed prefix.
  ctx.flushPendingUniformUploads?.();
  ctx.flushPendingTextureMipJobs?.();
  if (ownsEncoder) {
    device.queue.submit([encoder.finish()]);
  }
  if (includeGlobe && globeDrawCount === 0) {
    return SceneCaptureResult.PARTIAL;
  }
  return SceneCaptureResult.SUBMITTED;
}
