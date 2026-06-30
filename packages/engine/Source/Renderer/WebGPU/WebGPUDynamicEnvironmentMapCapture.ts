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
  globeRenderer: CaptureGlobeRenderer;
  tileProvider: {
    _quadtree?: { _tilesToRender?: unknown[] };
  };
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
 * Run the 6-face globe scene capture into the env cube. The CALLER owns the
 * debounce (every-K-frames / camera-moved) + the sky-fill-then-capture ordering
 * — `runSceneCapture` always composites terrain over the just-filled compute sky
 * when invoked. It still self-gates on the double opt-in + SCENE3D + a published
 * visible tile set, so it is a no-op (zero GPU work) when capture is OFF.
 */
export function runSceneCapture(
  device: GPUDevice,
  cache: SceneCaptureCache,
  manager: SceneCaptureManager,
  frameState: CesiumFrameState,
): void {
  // ── Gate: double opt-in + SCENE3D ──
  const ctx = frameState.context as unknown as {
    sceneCaptureReflections?: boolean;
    _webgpuSceneCaptureSources?: SceneCaptureSources | null;
    uniformState?: {
      updateCamera(camera: unknown): void;
    };
  };
  if (
    ctx.sceneCaptureReflections !== true ||
    manager.enableSceneCapture !== true ||
    frameState.mode !== 3 /* SceneMode.SCENE3D */ ||
    !manager._position
  ) {
    return;
  }

  const sources = ctx._webgpuSceneCaptureSources;
  const tiles = sources?.tileProvider?._quadtree?._tilesToRender;
  const globeRenderer = sources?.globeRenderer;
  if (!sources || !globeRenderer || !tiles || tiles.length === 0) {
    // Globe hasn't published a visible tile set yet (first frame before
    // `globe.render`) — nothing to capture this frame.
    return;
  }

  const uniformState = ctx.uniformState;
  // Restore target: the live main camera object the scene built `uniformState`
  // from this frame (`UniformState.update` → `updateCamera(frameState.camera)`).
  // Restoring with this exact object round-trips the main-camera view / proj /
  // RTE state precisely (no snapshot approximation).
  const mainCamera = (frameState as unknown as { camera?: unknown }).camera;
  if (!uniformState || !mainCamera) {
    return;
  }

  const eye = manager._position;
  const faceFormat = cache.cubemapFormat ?? "rgba8unorm";
  const size = cache.size || 256;

  // ── Lazy transient depth target (OFF allocates nothing) ──
  if (!cache.captureDepthView || cache.captureDepthSize !== size) {
    if (cache.captureDepthTexture) {
      cache.captureDepthTexture.destroy();
    }
    cache.captureDepthTexture = device.createTexture({
      label: "DynEnvMap Capture Depth",
      size: { width: size, height: size },
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    cache.captureDepthView = cache.captureDepthTexture.createView();
    cache.captureDepthSize = size;
  }

  // Eye = the reflective owner's bounding-sphere center (NOT the scene camera).
  // Near/far span the planet surface so the 90° face frustum reaches the
  // visible terrain on the sky-facing hemisphere (back faces show only sky).
  scratchEye.x = eye.x;
  scratchEye.y = eye.y;
  scratchEye.z = eye.z;
  const radius = Cartesian3.magnitude(scratchEye);
  const near = 1.0;
  const far = radius * 2.5;

  const encoder = device.createCommandEncoder({
    label: "DynEnvMap Scene Capture",
  });

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
            allCommands.push(cmds[c]);
          }
        }
      }

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
          view: cache.captureDepthView!,
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
  }

  device.queue.submit([encoder.finish()]);
}
