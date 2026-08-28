/// <reference types="@webgpu/types" />
/**
 * Per-frame Forward+ clustered-lighting orchestration for WebGPU scene
 * rendering.
 *
 * The orchestration:
 *
 *   1. Returns before dispatcher allocation when clustered lighting is
 *      disabled. Once enabled, it lazily constructs the dispatcher because
 *      the device is unavailable when the scene renderer is constructed.
 *   2. Converts `scene.lights` into world-space punctual and area-light lists.
 *      Per-model glTF lights remain excluded because their model-space values
 *      require each model's transform before eye-space packing.
 *   3. Ends the active canvas render pass only when enabled work must update
 *      params or issue compute commands, then resumes the default pass after
 *      dispatch. Stable empty frames leave the active pass untouched.
 *   4. Publishes the dispatcher's GPU buffer handles and a per-frame activity
 *      flag on the context so material pipelines can bind the data without
 *      threading the dispatcher through every render path.
 *
 * The host surface contains only the lazily owned dispatcher and the current
 * scaled viewport dimensions. All other inputs flow through `config`, and
 * buffer access flows through the dispatcher's public getters.
 *
 * @module WebGPUSceneRendererClusteredLighting
 */

import {
  WebGPUClusteredLightingDispatcher,
  type ClusterAreaLightInput,
  type ClusterLightingInputLight,
} from "./WebGPUClusteredLightingDispatcher.js";
import { shouldRebuildForDevice } from "./WebGPUDeviceInvalidationBus.js";
import type { WebGPURenderFrameConfig } from "./WebGPUSceneRenderer.js";

/** Buffer-handle bundle the dispatcher exposes to consumer pipelines. */
export interface ClusteredLightingBuffers {
  clusterLights: GPUBuffer;
  clusterAABBs: GPUBuffer;
  perClusterLightCount: GPUBuffer;
  perClusterLightIndices: GPUBuffer;
  params: GPUBuffer;
  // The analytic area-light LUT remains null until the dispatcher builds it
  // for the first area light. Consumers bind the placeholder LUT until then.
  // The fragment shader reads the LUT with textureLoad, so no sampler is needed.
  areaLights: GPUBuffer;
  ltcLUTView: GPUTextureView | null;
}

/**
 * Minimal SceneRenderer surface used by clustered-lighting orchestration. The
 * dispatcher field is owned by the host because its lifetime matches the
 * renderer and device; this module constructs it lazily and reads it on
 * subsequent frames.
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

// Dispatch copies these entries into its own reusable storage before returning,
// so sequential frame hooks can share the temporary input arrays safely.
const _clusteredLightingLightsScratch: ClusterLightingInputLight[] = [];
const _clusteredLightingAreaLightsScratch: ClusterAreaLightInput[] = [];

// Keep the published bundle stable so resource-identity caches only observe
// changes to the buffer contents or the lazily-created LUT view.
const _clusteredLightingBufferStashes = new WeakMap<
  WebGPUClusteredLightingDispatcher,
  ClusteredLightingBuffers
>();

function getClusteredLightingBufferStash(
  dispatcher: WebGPUClusteredLightingDispatcher,
): ClusteredLightingBuffers {
  let buffers = _clusteredLightingBufferStashes.get(dispatcher);
  if (!buffers) {
    buffers = {
      clusterLights: dispatcher.clusterLightsBuffer,
      clusterAABBs: dispatcher.clusterAABBsBuffer,
      perClusterLightCount: dispatcher.perClusterLightCountBuffer,
      perClusterLightIndices: dispatcher.perClusterLightIndicesBuffer,
      params: dispatcher.paramsBuffer,
      areaLights: dispatcher.areaLightsBuffer,
      ltcLUTView: dispatcher.ltcLUTView,
    };
    _clusteredLightingBufferStashes.set(dispatcher, buffers);
  }
  buffers.ltcLUTView = dispatcher.ltcLUTView;
  return buffers;
}

/**
 * Dispatches Forward+ clustered lighting for the current frame. Scene-level
 * lights and the current view and projection data are passed to the dispatcher,
 * which transforms positions and directions to eye space, packs the WGSL
 * `ClusteredLight` layout, and records both compute passes on the active command
 * encoder.
 *
 * This runs after resource setup and before consumer draws so the storage
 * buffers are ready for model and lit-material pipelines.
 *
 * When `scene.clusteredLightingEnabled` is false, a dispatcher that was active
 * receives one zero-count parameter write; subsequent disabled frames return
 * before GPU allocation or queue traffic. When the feature is enabled without
 * configured lights, repeated frames return before pass churn or queue traffic.
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
  // A device-loss recovery reuses the SceneRenderer, so a dispatcher left over
  // from the previous device is still referenced here and would pass a
  // presence-only check while holding dead pipelines and buffers.
  const cachedDispatcher = host._clusteredLightingDispatcher;
  if (cachedDispatcher && shouldRebuildForDevice(cachedDispatcher, device)) {
    host._clusteredLightingDispatcher = null;
    try {
      cachedDispatcher.destroy();
    } catch {
      // A lost device can reject native teardown; the replacement still builds.
    }
  }
  if (!host._clusteredLightingDispatcher) {
    host._clusteredLightingDispatcher = new WebGPUClusteredLightingDispatcher(
      device,
    );
  }

  const dispatcher = host._clusteredLightingDispatcher;

  // Gather world-space lights. The dispatcher walks them per-frame
  // and transforms to eye-space using the supplied viewMatrix.
  const lights = _clusteredLightingLightsScratch;
  lights.length = 0;
  // Area lights use a parallel world-space list for analytic evaluation.
  const areaLights = _clusteredLightingAreaLightsScratch;
  areaLights.length = 0;
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
        // Rectangle and disk lights use the separate analytic area-light list
        // instead of the clustered punctual-light path.
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
    // Per-model `KHR_lights_punctual` lights are not appended here because
    // their positions and directions are in model space. Supporting them
    // requires applying each model's transform before the dispatcher applies
    // the view transform. Scene-level lights cover the current path.
  }

  if (
    lights.length === 0 &&
    areaLights.length === 0 &&
    dispatcher.paramsAreAllZero
  ) {
    ctxStash._clusteredLightingBuffers =
      getClusteredLightingBufferStash(dispatcher);
    ctxStash._clusteredLightingActive = false;
    return;
  }

  // End the active canvas render pass before issuing compute work. Beginning a
  // compute pass while a render pass is open locks the encoder and fails
  // validation. Resume the default pass afterward so command execution can
  // continue with the render pass it expects.
  context.endCurrentRenderPass?.();
  const encoder = context._currentCommandEncoder;
  if (!encoder) {
    context.resumeDefaultRenderPass?.();
    return;
  }

  const uniformState = context.uniformState as unknown as {
    projection?: ArrayLike<number>;
    inverseProjection?: ArrayLike<number>;
    view?: ArrayLike<number>;
  };
  const inverseProjection = uniformState?.inverseProjection;
  const viewMatrix = uniformState?.view;
  if (!inverseProjection || !viewMatrix) {
    // Frame state can be unavailable for an empty pick pass. Resume the default
    // canvas pass before returning; otherwise shadow and scene commands run
    // without an active render pass, fail validation, and drop the frame.
    context.resumeDefaultRenderPass?.();
    return;
  }

  // Use the scene's outermost frustum: the first multi-frustum slice has the
  // closest near plane and the last has the farthest far plane, so the cluster
  // bounds span the full visible depth range. Per-slice cluster bounds would
  // reduce that range but are not computed here.
  const cam = (
    scene as unknown as {
      camera?: { frustum?: { near?: number; far?: number } };
    }
  ).camera;
  const near = Math.max(cam?.frustum?.near ?? 1.0, 0.1);
  const far = Math.max(cam?.frustum?.far ?? 10000.0, near + 1.0);

  dispatcher.dispatch(encoder, {
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

  // Publish stable buffer handles on the context so material pipelines can
  // pass them to `createEffectsBindGroup` without threading the dispatcher
  // through every render path. Only the contents change between frames, so the
  // effects bind-group cache can reuse its resource-identity entry. Before the
  // dispatcher runs, or while lighting is disabled, callers omit the option and
  // bind per-device placeholders whose zero active-light count skips the
  // fragment-shader cluster work.
  const d = dispatcher;
  ctxStash._clusteredLightingBuffers = getClusteredLightingBufferStash(d);
  // This flag lets consumers with a no-effects fast path avoid replacing their
  // shared placeholder unless lights actually contribute. Model PBR always
  // builds an active effects bind group and relies on a zero active-light count
  // for the fragment-shader early return; primitives need the boolean to retain
  // their placeholder path when clustered lighting is disabled or empty.
  ctxStash._clusteredLightingActive = enabled && d.lastActiveLightCount > 0;

  // Resume the default canvas render pass so the rest of
  // executeCommands (shadow casts, scene render, etc.) sees the
  // active pass it expects.
  context.resumeDefaultRenderPass?.();
}

/**
 * Returns the clustered-lighting dispatcher's GPU buffers for consumer bind
 * groups. Returns null before the dispatcher is constructed, in which case the
 * caller must bind placeholder resources.
 */
export function getClusteredLightingBuffers(
  host: ClusteredLightingHost,
): ClusteredLightingBuffers | null {
  const d = host._clusteredLightingDispatcher;
  if (!d) return null;
  return getClusteredLightingBufferStash(d);
}
