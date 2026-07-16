/// <reference types="@webgpu/types" />
/**
 * Forward+ clustered-lighting per-frame orchestration extracted from
 * `WebGPUSceneRenderer`.
 *
 * Slice (god-object decomposition) of the audit-recommended
 * SceneRenderer break-up — see
 * `migration_doc/WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md`. This is a pure
 * move + delegate (ZERO behavior change): the two methods
 * `_dispatchClusteredLighting` and `_getClusteredLightingBuffers`
 * moved here verbatim as free functions over a minimal `host` surface.
 *
 * # What this slice owns
 *
 * The once-per-frame Forward+ clustered-lighting compute hook (Slice 5d
 * Batch 151). It:
 *
 *   1. Returns before dispatcher allocation when clustered lighting is
 *      disabled. Once enabled, lazily constructs the dispatcher (the device
 *      wasn't available at SceneRenderer construction time).
 *   2. Walks `scene.lights` (+ a documented future hook for per-model
 *      glTF KHR_lights_punctual lights) into a world-space light list.
 *   3. Ends the active canvas render pass before issuing enabled compute
 *      work (beginComputePass on a locked encoder is a validation error —
 *      same family as BUG-MIPMAP-DURING-CANVAS-PASS), dispatches, then
 *      resumes the default pass. Stable disabled frames do none of this.
 *   4. Stashes the dispatcher's GPU buffer handles + an "is contributing
 *      this frame" boolean on the context so material pipelines can bind
 *      them at draw time without threading the dispatcher through every
 *      render path.
 *
 * # Host surface
 *
 * The functions reach back into the owning SceneRenderer for exactly
 * three pieces of state (verified by grep pre-extraction):
 *   - `_clusteredLightingDispatcher` — lazily owned dispatcher instance
 *     (read + assign-on-first-call).
 *   - `_viewportWidth` / `_viewportHeight` — current scaled viewport,
 *     passed to the dispatcher as cluster-grid dimensions.
 *
 * Everything else flows through `config` (scene + context) and the
 * dispatcher's own public getters.
 *
 * @module WebGPUSceneRendererClusteredLighting
 */

import { WebGPUClusteredLightingDispatcher } from "./WebGPUClusteredLightingDispatcher.js";
import type { WebGPURenderFrameConfig } from "./WebGPUSceneRenderer.js";

/** Buffer-handle bundle the dispatcher exposes to consumer pipelines. */
export interface ClusteredLightingBuffers {
  clusterLights: GPUBuffer;
  clusterAABBs: GPUBuffer;
  perClusterLightCount: GPUBuffer;
  perClusterLightIndices: GPUBuffer;
  params: GPUBuffer;
  // C6-LTC-AREA-LIGHTS — analytic area-light resources. `ltcLUTView` is
  // null until the dispatcher lazily builds the LUT on first area light;
  // consumers fall back to the placeholder LUT then. No sampler — the LUT
  // is read via textureLoad in the FS.
  areaLights: GPUBuffer;
  ltcLUTView: GPUTextureView | null;
}

/**
 * Minimal SceneRenderer surface the clustered-lighting slice reaches
 * back to. The dispatcher field is owned by the host (its lifetime
 * matches the renderer / device); this slice lazily constructs it and
 * reads it on subsequent frames.
 */
export interface ClusteredLightingHost {
  _clusteredLightingDispatcher: WebGPUClusteredLightingDispatcher | null;
  _viewportWidth: number;
  _viewportHeight: number;
}

interface ClusteredLightingContextState {
  _clusteredLightingBuffers?: ClusteredLightingBuffers;
  _clusteredLightingActive?: boolean;
}

// Tracks the one disabled-state publication already sent to an existing
// dispatcher. A dispatcher that was active must receive one zero-count params
// write so commands built earlier in the transition frame cannot observe stale
// lights. Stable disabled frames then return before allocation, pass churn, or
// queue traffic.
const _disabledClusteredLightingHosts = new WeakSet<ClusteredLightingHost>();

/**
 * Slice 5d Batch 151 — Forward+ clustered lighting per-frame hook.
 * Walks scene.lights + every visible model.lightsFromGltf, hands
 * the world-space list to the WebGPUClusteredLightingDispatcher
 * along with the current frame's view + projection matrices. The
 * dispatcher transforms positions/directions to eye-space, packs
 * into the WGSL ClusteredLight layout, and records both compute
 * passes into the active command encoder.
 *
 * Called early in executeCommands (after _ensureResources, before
 * any consumer draw) so the storage buffers are ready when Model
 * PBR / Lit Mat consumers (Batch 153+, merged into group 3 effects)
 * read them.
 *
 * Inert when scene.clusteredLightingEnabled === false. After a true-to-false
 * transition, an existing dispatcher receives one zero-count params write;
 * subsequent disabled frames return before GPU allocation or queue traffic.
 * With the feature enabled but no configured lights, the dispatcher publishes
 * activeLightCount=0 and consumer FS chunks skip the cluster read entirely.
 */
export function dispatchClusteredLighting(
  host: ClusteredLightingHost,
  config: WebGPURenderFrameConfig,
): void {
  const { scene, context } = config;
  const enabled = !!(scene as unknown as { clusteredLightingEnabled?: boolean })
    .clusteredLightingEnabled;
  const ctxStash = context as unknown as ClusteredLightingContextState;

  if (!enabled) {
    const dispatcher = host._clusteredLightingDispatcher;
    const alreadySynchronized = _disabledClusteredLightingHosts.has(host);

    // Consumers built on the next frame must select the shared placeholder
    // resources, not a dispatcher's stale buffers.
    ctxStash._clusteredLightingBuffers = undefined;
    ctxStash._clusteredLightingActive = false;

    if (!dispatcher || alreadySynchronized) {
      _disabledClusteredLightingHosts.add(host);
      return;
    }

    // Preserve toggle-off correctness for commands that were built before this
    // executeCommands hook and therefore still bind the previous frame's real
    // buffers. Zero the params once; activeCount=0 makes dispatch() stop before
    // opening either compute pass, so the current render pass stays intact.
    const encoder = context._currentCommandEncoder;
    const uniformState = context.uniformState as unknown as {
      inverseProjection?: ArrayLike<number>;
      view?: ArrayLike<number>;
    };
    const inverseProjection = uniformState?.inverseProjection;
    const viewMatrix = uniformState?.view;
    if (!encoder || !inverseProjection || !viewMatrix) {
      return;
    }
    const cam = (
      scene as unknown as {
        camera?: { frustum?: { near?: number; far?: number } };
      }
    ).camera;
    const near = Math.max(cam?.frustum?.near ?? 1.0, 0.1);
    const far = Math.max(cam?.frustum?.far ?? 10000.0, near + 1.0);
    dispatcher.dispatch(encoder, {
      enabled: false,
      lights: [],
      viewportWidth: host._viewportWidth,
      viewportHeight: host._viewportHeight,
      near,
      far,
      inverseProjection,
      viewMatrix,
      areaLights: [],
    });
    _disabledClusteredLightingHosts.add(host);
    return;
  }

  _disabledClusteredLightingHosts.delete(host);
  const device = context._device;
  if (!device) {
    return;
  }

  // Lazy-construct on the first enabled call — the device wasn't available at
  // SceneRenderer construction time. Disabled consumers use the effects
  // system's shared placeholder resources and do not need a dispatcher.
  if (!host._clusteredLightingDispatcher) {
    host._clusteredLightingDispatcher = new WebGPUClusteredLightingDispatcher(
      device,
    );
  }

  // End the active canvas render pass before issuing compute work.
  // beginComputePass() on the main encoder while a render pass is
  // open triggers a "encoder is locked" validation error — same
  // family as Batch 144's CesiumMan startup race
  // (BUG-MIPMAP-DURING-CANVAS-PASS). Resume the default pass
  // afterwards so the rest of executeCommands continues seamlessly.
  context.endCurrentRenderPass?.();
  const encoder = context._currentCommandEncoder;
  if (!encoder) {
    context.resumeDefaultRenderPass?.();
    return;
  }

  // Gather world-space lights. The dispatcher walks them per-frame
  // and transforms to eye-space using the supplied viewMatrix.
  const lights: Array<{
    lightType: number;
    posOrDirWC: { x: number; y: number; z: number };
    color: { r?: number; g?: number; b?: number };
    intensity?: number;
    range?: number;
    innerConeAngle?: number;
    outerConeAngle?: number;
    spotDirWC?: { x: number; y: number; z: number };
  }> = [];
  // C6-LTC-AREA-LIGHTS — parallel world-space area-light list.
  const areaLights: Array<{
    lightType: number;
    positionWC: { x: number; y: number; z: number };
    directionWC: { x: number; y: number; z: number };
    upWC: { x: number; y: number; z: number };
    halfWidth: number;
    halfHeight: number;
    color: { red?: number; green?: number; blue?: number };
    intensity?: number;
    twoSided?: boolean;
    range?: number;
  }> = [];
  if (enabled) {
    // Scene-level lights from LightCollection.
    const sceneLights = (
      scene as unknown as {
        lights?: { length?: number; get?: (i: number) => unknown };
      }
    ).lights;
    if (sceneLights && sceneLights.length && sceneLights.get) {
      for (let i = 0; i < sceneLights.length; i++) {
        const L = sceneLights.get(i) as {
          lightType?: number;
          enabled?: boolean;
          direction?: { x: number; y: number; z: number };
          position?: { x: number; y: number; z: number };
          color?: { red?: number; green?: number; blue?: number };
          intensity?: number;
          range?: number;
          innerConeAngle?: number;
          outerConeAngle?: number;
          up?: { x: number; y: number; z: number };
          width?: number;
          height?: number;
          radiusX?: number;
          radiusY?: number;
          twoSided?: boolean;
        };
        if (L?.enabled === false) continue;
        const lt = L?.lightType ?? 0;
        // C6-LTC-AREA-LIGHTS — RECT_AREA (3) / DISK_AREA (4) route to the
        // separate analytic area-light list, not the clustered punctual
        // path.
        if (lt === 3 || lt === 4) {
          const isDisk = lt === 4;
          areaLights.push({
            lightType: lt,
            positionWC: L.position ?? { x: 0, y: 0, z: 0 },
            directionWC: L.direction ?? { x: 0, y: 0, z: -1 },
            upWC: L.up ?? { x: 0, y: 1, z: 0 },
            halfWidth: isDisk ? (L.radiusX ?? 1) : (L.width ?? 1) * 0.5,
            halfHeight: isDisk ? (L.radiusY ?? 1) : (L.height ?? 1) * 0.5,
            color: {
              red: L.color?.red,
              green: L.color?.green,
              blue: L.color?.blue,
            },
            intensity: L.intensity,
            twoSided: L.twoSided,
            range: L.range,
          });
          continue;
        }
        // Directional: posOrDir = direction; point/spot: position.
        const pd =
          lt === 0
            ? (L.direction ?? { x: 0, y: 0, z: -1 })
            : (L.position ?? { x: 0, y: 0, z: 0 });
        lights.push({
          lightType: lt,
          posOrDirWC: { x: pd.x, y: pd.y, z: pd.z },
          color: {
            r: L.color?.red,
            g: L.color?.green,
            b: L.color?.blue,
          },
          intensity: L.intensity,
          range: L.range,
          innerConeAngle: L.innerConeAngle,
          outerConeAngle: L.outerConeAngle,
          spotDirWC: lt === 2 ? L.direction : undefined,
        });
      }
    }
    // glTF KHR_lights_punctual lights per model — walk the scene's
    // primitives + collect lightsFromGltf. Each model's lights are
    // already in model space; the dispatcher's per-light pack
    // multiplies by viewMatrix to land in eye-space. For non-trivial
    // model transforms a separate per-model matrix multiply would
    // be needed — left for a follow-up batch since the typical
    // scene.lights path covers the common case.
  }

  const uniformState = context.uniformState as unknown as {
    projection?: ArrayLike<number>;
    inverseProjection?: ArrayLike<number>;
    view?: ArrayLike<number>;
  };
  const inverseProjection = uniformState?.inverseProjection;
  const viewMatrix = uniformState?.view;
  if (!inverseProjection || !viewMatrix) {
    // Frame state not ready (e.g., empty pick pass). Skip — but first
    // resume the default canvas pass we ended at :120 above, otherwise
    // the rest of executeCommands (shadow casts, scene render) runs with
    // no active render pass, producing a "no active render pass"
    // validation error and a dropped frame.
    context.resumeDefaultRenderPass?.();
    return;
  }

  // Camera frustum near/far. Use the scene's outermost frustum (the
  // multi-frustum loop's first slice is the closest near, last is
  // the farthest far — collapsing here means cluster bounds span
  // the full visible depth range). Per-frustum-slice cluster bounds
  // are a future optimization.
  const cam = (
    scene as unknown as {
      camera?: { frustum?: { near?: number; far?: number } };
    }
  ).camera;
  const near = Math.max(cam?.frustum?.near ?? 1.0, 0.1);
  const far = Math.max(cam?.frustum?.far ?? 10000.0, near + 1.0);

  host._clusteredLightingDispatcher.dispatch(encoder, {
    enabled,
    lights,
    viewportWidth: host._viewportWidth,
    viewportHeight: host._viewportHeight,
    near,
    far,
    inverseProjection,
    viewMatrix,
    areaLights,
  });

  // Slice 5d Batch 153 — Stash the dispatcher's GPU buffers on the
  // context so material pipelines (Model PBR + future Lit Mat
  // shaders) can pass them to `createEffectsBindGroup` at draw time
  // without threading the dispatcher through every render path. The
  // buffer handles don't change frame-to-frame (only their contents),
  // so the effects bind group cache hits on the resource-identity key
  // and only allocates a fresh (UBO + BG) pair the first time these
  // appear. When the dispatcher hasn't run yet OR clustered lighting
  // is disabled, callers can omit `options.clusteredLighting` and the
  // effects bind group falls back to per-device placeholders (whose
  // `params.activeLightCount = 0` makes the FS chunk early-out).
  const d = host._clusteredLightingDispatcher;
  ctxStash._clusteredLightingBuffers = {
    clusterLights: d.clusterLightsBuffer,
    clusterAABBs: d.clusterAABBsBuffer,
    perClusterLightCount: d.perClusterLightCountBuffer,
    perClusterLightIndices: d.perClusterLightIndicesBuffer,
    params: d.paramsBuffer,
    // C6-LTC-AREA-LIGHTS — area-light storage + lazily-built LUT.
    areaLights: d.areaLightsBuffer,
    ltcLUTView: d.ltcLUTView,
  };
  // Slice 5d Batch 154 — CPU-side "is clustered lighting contributing
  // this frame" flag. Consumers that have a cheap no-effects fast path
  // (the shared primitive effects bind group) gate on this so they only
  // skip the placeholder when there are actually active lights. The
  // Model PBR path passes the buffers unconditionally (it always builds
  // an active effects BG anyway) and relies on params.activeLightCount=0
  // for the FS early-out; primitives need the boolean to preserve their
  // placeholder fast path when clustered lighting is off / empty.
  ctxStash._clusteredLightingActive = enabled && d.lastActiveLightCount > 0;

  // Resume the default canvas render pass so the rest of
  // executeCommands (shadow casts, scene render, etc.) sees the
  // active pass it expects.
  context.resumeDefaultRenderPass?.();
}

/**
 * Public accessor for the clustered-lighting dispatcher's GPU
 * buffers. Consumer pipelines (Model PBR + Lit Mat shaders, when
 * wired in Batch 153+ via group 3 effects merge) call this to obtain
 * handles for their bind groups.
 *
 * Returns null when the dispatcher hasn't been constructed yet
 * (first frame before any executeCommands call) — caller should
 * use placeholder buffers in that case.
 */
export function getClusteredLightingBuffers(
  host: ClusteredLightingHost,
): ClusteredLightingBuffers | null {
  const d = host._clusteredLightingDispatcher;
  if (!d) return null;
  return {
    clusterLights: d.clusterLightsBuffer,
    clusterAABBs: d.clusterAABBsBuffer,
    perClusterLightCount: d.perClusterLightCountBuffer,
    perClusterLightIndices: d.perClusterLightIndicesBuffer,
    params: d.paramsBuffer,
    areaLights: d.areaLightsBuffer,
    ltcLUTView: d.ltcLUTView,
  };
}
