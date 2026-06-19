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
 *   1. Lazy-constructs the `WebGPUClusteredLightingDispatcher` on first
 *      call (the device wasn't available at SceneRenderer construction
 *      time). Constructed even when disabled so consumer pipelines can
 *      bind the placeholder buffers without runtime branching.
 *   2. Walks `scene.lights` (+ a documented future hook for per-model
 *      glTF KHR_lights_punctual lights) into a world-space light list.
 *   3. Ends the active canvas render pass before issuing compute work
 *      (beginComputePass on a locked encoder is a validation error —
 *      same family as BUG-MIPMAP-DURING-CANVAS-PASS), dispatches, then
 *      resumes the default pass.
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
 * Inert when scene.clusteredLightingEnabled === false OR zero
 * lights are configured — the dispatcher returns activeLightCount=0
 * and consumer FS chunks gate on that value to skip the cluster
 * read entirely.
 */
export function dispatchClusteredLighting(
  host: ClusteredLightingHost,
  config: WebGPURenderFrameConfig,
): void {
  const { scene, context } = config;
  const enabled = !!(scene as unknown as { clusteredLightingEnabled?: boolean })
    .clusteredLightingEnabled;
  const device = context._device;
  if (!device) {
    return;
  }

  // Lazy-construct on first call — the device wasn't available at
  // SceneRenderer construction time. Construct even when disabled
  // so consumer pipelines (Batch 153+, merged into group 3 effects)
  // can bind the placeholder buffers without runtime branching on
  // whether the dispatcher exists.
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
        };
        if (L?.enabled === false) continue;
        const lt = L?.lightType ?? 0;
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
  const ctxStash = context as unknown as {
    _clusteredLightingBuffers?: ClusteredLightingBuffers;
    _clusteredLightingActive?: boolean;
  };
  ctxStash._clusteredLightingBuffers = {
    clusterLights: d.clusterLightsBuffer,
    clusterAABBs: d.clusterAABBsBuffer,
    perClusterLightCount: d.perClusterLightCountBuffer,
    perClusterLightIndices: d.perClusterLightIndicesBuffer,
    params: d.paramsBuffer,
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
  };
}
