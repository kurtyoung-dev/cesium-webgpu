/// <reference types="@webgpu/types" />
/**
 * CSM cast-pass dispatcher used by `WebGPUCSMRenderer`.
 *
 * Owns lazy per-cascade UBO and bind-group allocation, RTE-encoded camera
 * packing, depth-bias scaling, and render-pass dispatch through the shared
 * shadow-cast pipeline factory (`rte24`, `p12`, `modelP12`,
 * `modelInstanced(SB)`, `quantized12`, and `modelSkinned` variants).
 *
 * The renderer delegates `renderCastPass` here and exposes the required host
 * fields and methods through the underscore-public convention.
 *
 * Per-cascade GPU culling uses the following strategy:
 *
 *   - **Sphere-AABB cull (correctness-safe over-include).** Each cascade
 *     feeds the `FrustumCull` shader the six planes of the axis-aligned cube
 *     around its bounding sphere (`sphereCenter`, `sphereRadius`). This cube
 *     includes points outside a tight Gribb-Hartmann frustum, so uncertainty
 *     costs overdraw instead of missing a valid shadow caster.
 *   - A per-cascade `_cascadeCullLastResults[ci]` readback slot driven by its
 *     `WebGPUGPUCuller` instance.
 *   - A per-cascade hysteresis gate (`_cascadeCullActive[ci]`) at the same
 *     thresholds as opaque Hi-Z (high 2400, low 1600), because shadow casting
 *     iterates the same command set.
 *   - One-frame readback latency, matching the opaque and translucent paths.
 *     The first high-density frame dispatches without filtering; later frames
 *     filter with the prior readback.
 *   - Skipped entirely when `context.gpuCullingHint === 'never'` or
 *     when no `getGPUCullerForCascade` getter exists (back-compat).
 *
 * @module WebGPUCSMCastPass
 */

import Cartesian3 from "../../Core/Cartesian3.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import defined from "../../Core/defined.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import { prepareTerrainShadowCastCommandUniforms } from "./WebGPUGlobeSurfaceTileBuffers.js";
import { getOrCreateShadowCastBindGroup } from "./WebGPUShadowCastBindGroupCache.js";
import { shouldClearShadowCastTarget } from "./WebGPUShadowCastTargetState.js";
import {
  _getOrCreateCastPipeline,
  _inferShadowLayoutKey,
  getShadowCastCullMode,
  getShadowCastStripIndexFormat,
  getShadowCastTopology,
  getShadowCastVariant,
} from "./WebGPUShadowMapRenderer.js";
import { CSM_CAST_UBO_SIZE, BASE_MIN_BIAS } from "./WebGPUCSMRenderer.js";
import type { CSMCastPassHost, CastCommandShape } from "./WebGPUCSMRenderer.js";

const _scratchEncodedCamera = new EncodedCartesian3();

// Match the opaque Hi-Z hysteresis thresholds because shadow casting iterates
// the same command set and should activate culling at the same density.
const CASCADE_CULL_THRESHOLD_HI = 2400;
const CASCADE_CULL_THRESHOLD_LO = 1600;

interface GPUCullerLikeInstance {
  initialized: boolean;
  uploadBoundingSpheres: (s: Float32Array) => void;
  uploadFrustumPlanes: (p: Float32Array) => void;
  dispatch: (
    encoder: GPUCommandEncoder,
    objectCount: number,
    mode?: number,
  ) => void;
  prepareReadback: (encoder: GPUCommandEncoder, objectCount: number) => void;
  readResults: (objectCount: number) => Promise<{
    visibilityFlags: Uint32Array;
    objectCount: number;
  }>;
}

interface CSMCastContext {
  getGPUCullerForCascade?: (idx: number) => GPUCullerLikeInstance | null;
  gpuCullingHint?: "auto" | "always" | "never";
  _currentCommandEncoder?: GPUCommandEncoder | null;
}

interface CSMTerrainFrameState {
  mode?: number;
  verticalExaggeration?: number;
  verticalExaggerationRelativeHeight?: number;
  /**
   * Identifies the frame being encoded so a caster-less re-entry can be told
   * apart from a real "casters went away" transition. See
   * `WebGPUShadowCastTargetState`.
   */
  frameNumber?: number;
}

interface CommandSphereScratch {
  x: number;
  y: number;
  z: number;
  radius: number;
}

interface CascadeCullBounds {
  sphereCenter: Float32Array | number[];
  sphereRadius: number;
}

const _commandSphereScratch: CommandSphereScratch = {
  x: 0,
  y: 0,
  z: 0,
  radius: 0,
};

/**
 * Build 6 axis-aligned plane equations bounding the cube
 * circumscribing a sphere at (cx,cy,cz) with radius R. Output
 * format matches `FrustumCull.wgsl`'s `FrustumPlanes`: 6 × vec4
 * where each plane is (nx, ny, nz, d) with inward-pointing normal
 * and `dot(plane.xyz, P) + plane.w > 0` for points inside the cube.
 *
 * Loose vs tight Gribb-Hartmann from the cascade VP — cube extends
 * past the sphere at corners. Correctness-safe over-include.
 */
function packCascadeCullPlanes(
  out: Float32Array,
  cx: number,
  cy: number,
  cz: number,
  R: number,
): void {
  // +X face: inward normal (-1, 0, 0); plane passes through (cx+R, *, *).
  // dot((-1, 0, 0), P) + (cx + R) = (cx + R) - P.x, so points with
  // P.x <= cx + R are inside.
  out[0] = -1;
  out[1] = 0;
  out[2] = 0;
  out[3] = cx + R;
  // -X face: inward normal (+1, 0, 0); plane passes through (cx-R).
  out[4] = 1;
  out[5] = 0;
  out[6] = 0;
  out[7] = -(cx - R);
  // +Y face
  out[8] = 0;
  out[9] = -1;
  out[10] = 0;
  out[11] = cy + R;
  // -Y face
  out[12] = 0;
  out[13] = 1;
  out[14] = 0;
  out[15] = -(cy - R);
  // +Z face
  out[16] = 0;
  out[17] = 0;
  out[18] = -1;
  out[19] = cz + R;
  // -Z face
  out[20] = 0;
  out[21] = 0;
  out[22] = 1;
  out[23] = -(cz - R);
}

const _cascadePlanesScratch = new Float32Array(24);

/**
 * Hysteresis gate: returns the new active flag.
 * - active && count <  LO → deactivate
 * - !active && count >= HI → activate
 * - otherwise hold previous state
 */
function updateCascadeGate(
  active: boolean,
  count: number,
  hi: number,
  lo: number,
): boolean {
  if (active) return count >= lo;
  return count >= hi;
}

function isFiniteF32(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isFinite(Math.fround(value))
  );
}

/**
 * Resolve a command's current conservative sphere without allocating. Values
 * that cannot form a finite, positive f32 GPU sphere fail closed: callers
 * must retain that command rather than risk a false-negative shadow cull.
 */
function readCurrentCommandSphere(
  rawCommand: unknown,
  result: CommandSphereScratch,
): boolean {
  const command = rawCommand as
    | {
        boundingVolume?: {
          center?: { x?: unknown; y?: unknown; z?: unknown };
          radius?: unknown;
          boundingSphere?: {
            center?: { x?: unknown; y?: unknown; z?: unknown };
            radius?: unknown;
          };
        };
      }
    | undefined;
  const volume = command?.boundingVolume;
  const nestedSphere = volume?.boundingSphere;
  const center = volume?.center ?? nestedSphere?.center;
  const radius = volume?.radius ?? nestedSphere?.radius;
  if (
    !center ||
    !isFiniteF32(center.x) ||
    !isFiniteF32(center.y) ||
    !isFiniteF32(center.z) ||
    !isFiniteF32(radius) ||
    !(radius > 0.0) ||
    !(Math.fround(radius) > 0.0)
  ) {
    return false;
  }

  result.x = center.x;
  result.y = center.y;
  result.z = center.z;
  result.radius = radius;
  return true;
}

/**
 * Current-frame conservative validation for a stale GPU "outside" result.
 * Returning true means the command must remain in the cast list. An invalid
 * command/cascade bound always passes through.
 */
function currentSphereMayIntersectCascadeAABB(
  rawCommand: unknown,
  cascade: CascadeCullBounds,
): boolean {
  if (!readCurrentCommandSphere(rawCommand, _commandSphereScratch)) {
    return true;
  }

  const center = cascade?.sphereCenter;
  const radius = cascade?.sphereRadius;
  const cx = center?.[0];
  const cy = center?.[1];
  const cz = center?.[2];
  if (
    !isFiniteF32(cx) ||
    !isFiniteF32(cy) ||
    !isFiniteF32(cz) ||
    !isFiniteF32(radius) ||
    !(radius > 0.0) ||
    !(Math.fround(radius) > 0.0)
  ) {
    return true;
  }

  const sphere = _commandSphereScratch;
  return !(
    sphere.x + sphere.radius < cx - radius ||
    sphere.x - sphere.radius > cx + radius ||
    sphere.y + sphere.radius < cy - radius ||
    sphere.y - sphere.radius > cy + radius ||
    sphere.z + sphere.radius < cz - radius ||
    sphere.z - sphere.radius > cz + radius
  );
}

/**
 * Apply one-frame-late GPU visibility flags without allowing stale identity,
 * ordering, or camera/cascade state to remove a current caster incorrectly.
 * A zero flag is honored only when the CURRENT command sphere is definitely
 * outside the CURRENT cascade AABB. All other values conservatively retain.
 *
 * Exported for focused correctness specs.
 */
export function filterCSMCastCommandsConservatively(
  castCommands: ReadonlyArray<unknown>,
  visibilityFlags: Uint32Array,
  cascade: CascadeCullBounds,
  result: unknown[],
): unknown[] {
  result.length = 0;
  for (let i = 0; i < castCommands.length; i++) {
    if (
      visibilityFlags[i] !== 0 ||
      currentSphereMayIntersectCascadeAABB(castCommands[i], cascade)
    ) {
      result.push(castCommands[i]);
    }
  }
  return result;
}

/**
 * Update and publish the renderer-owned terrain globals block. Both terrain
 * layouts require the same binding-2 resource; stamping happens once before
 * the cascade loop so every per-command bind-group lookup sees it.
 *
 * Exported for focused layout/publication specs.
 */
export function prepareCSMTerrainGlobals(
  host: Pick<
    CSMCastPassHost,
    "_device" | "_terrainGlobalsUB" | "_terrainGlobalsData"
  >,
  castCommands: ReadonlyArray<unknown>,
  frameState?: CSMTerrainFrameState,
): boolean {
  const terrainGlobals = host._terrainGlobalsUB;
  const device = host._device;
  if (!device || !terrainGlobals || terrainGlobals.isDestroyed) {
    return false;
  }

  let hasTerrainCaster = false;
  for (let i = 0; i < castCommands.length; i++) {
    const command = castCommands[i] as
      | {
          _shadowCastLayout?: string;
          _shadowCastTerrainGlobalsUB?: WebGPUBuffer;
        }
      | undefined;
    const layout = command?._shadowCastLayout;
    if (layout === "quantized12" || layout === "terrainUncompressed") {
      command!._shadowCastTerrainGlobalsUB = terrainGlobals;
      hasTerrainCaster = true;
    }
  }
  if (!hasTerrainCaster) {
    return false;
  }

  const data = host._terrainGlobalsData;
  const sceneMode = frameState?.mode ?? 3;
  data[0] = sceneMode >= 3 ? (frameState?.verticalExaggeration ?? 1.0) : 1.0;
  data[1] = frameState?.verticalExaggerationRelativeHeight ?? 0.0;
  data[2] = sceneMode;
  data[3] = 0.0;
  // Avoid WebGPUBuffer.write(), which constructs a Uint8Array view on every
  // call. This path runs once per active CSM frame, so publish the existing
  // typed-array storage directly through the queue's source-buffer overload.
  device.queue.writeBuffer(
    terrainGlobals.buffer,
    0,
    data.buffer,
    data.byteOffset,
    data.byteLength,
  );
  return true;
}

export function renderCSMCastPass(
  host: CSMCastPassHost,
  encoder: GPUCommandEncoder,
  castCommands: ReadonlyArray<unknown>,
  cameraPositionWC: { x: number; y: number; z: number },
  frameState?: CSMTerrainFrameState,
  context?: CSMCastContext,
): void {
  if (
    !host._device ||
    !host.enabled ||
    !host._cascadeTexture ||
    host._cascadeViews.length !== host._cascadeCount
  ) {
    return;
  }
  if (castCommands.length === 0) {
    if (
      !shouldClearShadowCastTarget(
        host._shadowContentState,
        host._shadowContentFrame,
        frameState?.frameNumber,
      )
    ) {
      return;
    }
    for (let ci = 0; ci < host._cascadeCount; ci++) {
      const pass = encoder.beginRenderPass({
        label: `CSM cascade ${ci} clear-only`,
        colorAttachments: [],
        depthStencilAttachment: {
          view: host._cascadeViews[ci],
          depthClearValue: 1.0,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      });
      pass.end();
    }
    host._shadowContentState = "empty";
    return;
  }
  host._castDispatches++;

  prepareCSMTerrainGlobals(host, castCommands, frameState);

  // Size the lazy per-cascade cull state to the selected cascade count.
  if (host._cascadeCullActive.length !== host._cascadeCount) {
    host._cascadeCullActive = new Array(host._cascadeCount).fill(false);
    host._cascadeCullLastResults = new Array(host._cascadeCount).fill(null);
    host._cascadeCullSoA = new Array(host._cascadeCount).fill(null);
    host._cascadeCullFilterPool = new Array(host._cascadeCount)
      .fill(null)
      .map((): unknown[] => []);
    host._cascadeCullLastInput = new Array(host._cascadeCount).fill(0);
    host._cascadeCullLastFiltered = new Array(host._cascadeCount).fill(0);
  }
  // Reset per-frame stats accumulators (host._castDispatches already
  // bumped above so this is the first action of a new frame for our
  // counters).
  for (let i = 0; i < host._cascadeCount; i++) {
    host._cascadeCullLastInput[i] = 0;
    host._cascadeCullLastFiltered[i] = 0;
  }

  const cullEnabled =
    !!context &&
    context.gpuCullingHint !== "never" &&
    typeof context.getGPUCullerForCascade === "function";
  const totalCount = castCommands.length;

  // Allocate per-cascade cast UBOs lazily. Their layout matches the 128-byte
  // `WebGPUShadowMapRenderer` UBO, so every registered cast pipeline has a
  // compatible bind-group layout without another pipeline build.
  if (!host._cascadeCastBuffers) {
    host._cascadeCastBuffers = [];
    host._cascadeCastBufferData = [];
    host._cascadeCastBindGroups = [];
    for (let i = 0; i < host._cascadeCount; i++) {
      const buf = WebGPUBuffer.createUniformBuffer(
        host._device,
        CSM_CAST_UBO_SIZE,
        `CSM_Cascade_${i}_CastUBO`,
      );
      host._cascadeCastBuffers.push(buf.buffer);
      host._cascadeCastBufferData.push(new Float32Array(CSM_CAST_UBO_SIZE / 4));
      host._cascadeCastBindGroups.push(new Map());
    }
  }

  // A per-renderer cache object that the shared cast-pipeline factory
  // stashes its compiled pipelines on. Using a fresh object (not
  // `shadowMap._webgpuCache`) keeps CSM pipeline state separate from
  // the single-shadow-map path, so flipping the scene toggle doesn't
  // cross-contaminate caches.
  if (!host._sharedPipelineCache) {
    host._sharedPipelineCache = {
      castPipelines: new Map<
        string,
        {
          pipeline: GPURenderPipeline;
          bgl: GPUBindGroupLayout;
          cacheKey: string;
        }
      >(),
    };
  }

  // RTE-encoded camera (same as single-shadow-map path).
  const enc = _scratchEncodedCamera;
  enc.high = enc.high ?? new Cartesian3();
  enc.low = enc.low ?? new Cartesian3();
  EncodedCartesian3.fromCartesian(
    new Cartesian3(cameraPositionWC.x, cameraPositionWC.y, cameraPositionWC.z),
    enc,
  );

  const refRadius = Math.max(1.0, host._cascades[0].sphereRadius);
  for (let ci = 0; ci < host._cascadeCount; ci++) {
    const cascade = host._cascades[ci];
    const data = host._cascadeCastBufferData![ci];
    // Pack 28 floats: 16 light-VP values, two padded camera vectors, and four
    // bias values.
    // The cast shader multiplies this VP by the camera-relative position
    // (posRTE = posHigh - camHigh + posLow - camLow), so the matrix must use
    // the RTE-aware form instead of the world-space form. See ShadowMap.wgsl.
    for (let k = 0; k < 16; k++) {
      data[k] = cascade.viewProjectionRTE[k];
    }
    data[16] = enc.high.x;
    data[17] = enc.high.y;
    data[18] = enc.high.z;
    data[19] = 0;
    data[20] = enc.low.x;
    data[21] = enc.low.y;
    data[22] = enc.low.z;
    data[23] = 0;
    // Per-cascade depth bias scales with cascade extent. Tight cascade
    // 0 gets BASE_MIN_BIAS; larger cascades scale proportionally so the
    // ortho-projected NDC bias tracks world-space distance uniformly.
    const scale = Math.max(1.0, cascade.sphereRadius / refRadius);
    data[24] = BASE_MIN_BIAS * scale;
    data[25] = 0.0; // normalBias (reserved — slope bias lives receive-side)
    data[26] = 0;
    data[27] = 0;
    host._device.queue.writeBuffer(
      host._cascadeCastBuffers![ci],
      0,
      data.buffer,
      data.byteOffset,
      CSM_CAST_UBO_SIZE,
    );

    // Per-cascade GPU culling.
    // Update the gate, dispatch this frame, and pick the filtered
    // cast list (using prior-frame readback) before the draw loop.
    // No-op when `cullEnabled` is false.
    let castIter: ReadonlyArray<unknown> = castCommands;
    if (cullEnabled) {
      const wasActive = host._cascadeCullActive[ci];
      const nowActive = updateCascadeGate(
        wasActive,
        totalCount,
        CASCADE_CULL_THRESHOLD_HI,
        CASCADE_CULL_THRESHOLD_LO,
      );
      host._cascadeCullActive[ci] = nowActive;

      if (nowActive) {
        const culler = context!.getGPUCullerForCascade!(ci);
        if (culler && culler.initialized) {
          // Build or grow per-cascade SoA scratch storage and the pooled
          // interleaved upload buffer.
          let soa = host._cascadeCullSoA[ci];
          if (!soa || soa.capacity < totalCount) {
            const cap = Math.max(totalCount, soa?.capacity ?? 0);
            soa = {
              centerX: new Float32Array(cap),
              centerY: new Float32Array(cap),
              centerZ: new Float32Array(cap),
              radius: new Float32Array(cap),
              capacity: cap,
              interleaved: new Float32Array(cap * 4),
            };
            host._cascadeCullSoA[ci] = soa;
          }
          // Fill the SoA and interleaved representations in one loop. Only
          // the interleaved buffer is uploaded; the SoA fields remain a
          // CPU-readable copy of the same sphere set and stay in lockstep.
          //
          // Bail-out: if any command lacks a bounding sphere, we abort
          // the cull entirely. No cull is a correctness-safe over-include;
          // partially filled storage would mismatch the command generation
          // and corrupt the visibility test. `cascade` comes from the outer
          // per-frustum loop.
          const interleaved = soa.interleaved;
          let allValid = true;
          for (let i = 0; i < totalCount; i++) {
            if (
              !readCurrentCommandSphere(castCommands[i], _commandSphereScratch)
            ) {
              allValid = false;
              break;
            }
            const sphere = _commandSphereScratch;
            soa.centerX[i] = sphere.x;
            soa.centerY[i] = sphere.y;
            soa.centerZ[i] = sphere.z;
            soa.radius[i] = sphere.radius;
            const off = i * 4;
            interleaved[off] = sphere.x;
            interleaved[off + 1] = sphere.y;
            interleaved[off + 2] = sphere.z;
            interleaved[off + 3] = sphere.radius;
          }

          if (allValid) {
            // Build the cascade's sphere-AABB cull planes.
            const sc = cascade.sphereCenter;
            packCascadeCullPlanes(
              _cascadePlanesScratch,
              sc[0] as number,
              sc[1] as number,
              sc[2] as number,
              cascade.sphereRadius,
            );

            // The interleaved pool is sized to `cap * 4`; pass a
            // SUBARRAY view so the unused tail isn't uploaded.
            culler.uploadBoundingSpheres(
              interleaved.subarray(0, totalCount * 4),
            );
            culler.uploadFrustumPlanes(_cascadePlanesScratch);
            culler.dispatch(encoder, totalCount, 0);
            host._cascadeCullDispatches++;
            culler.prepareReadback(encoder, totalCount);
            const cascadeIdx = ci;
            culler
              .readResults(totalCount)
              .then((r) => {
                host._cascadeCullLastResults[cascadeIdx] = r;
              })
              .catch(() => {
                /* readback failure → leave prior result in place */
              });
          }

          // Filter using prior-frame readback when count matches.
          const prev = host._cascadeCullLastResults[ci];
          if (prev && prev.visibilityFlags && prev.objectCount === totalCount) {
            const filtered = host._cascadeCullFilterPool[ci];
            filterCSMCastCommandsConservatively(
              castCommands,
              prev.visibilityFlags,
              cascade,
              filtered,
            );
            host._cascadeCullLastInput[ci] = totalCount;
            host._cascadeCullLastFiltered[ci] = filtered.length;
            castIter = filtered as ReadonlyArray<unknown>;
          }
        }
      }
    }

    // The filtered list is the exact demand set for this cascade. The first
    // cascade's realization is reused by later cascades and future frames.
    prepareTerrainShadowCastCommandUniforms(host._device, castIter);

    const pass = encoder.beginRenderPass({
      label: `CSM_Cascade_${ci}_CastPass`,
      colorAttachments: [],
      depthStencilAttachment: {
        view: host._cascadeViews[ci],
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });

    for (const rawCmd of castIter) {
      const cmd = rawCmd as CastCommandShape;
      if (!cmd) continue;

      // Resolve vertex buffer + stride, matching the single-shadow-
      // map cast-pass resolution. Same shape + same fallbacks.
      //
      // `vertexBuffers[0]` is either a wrapper `{buffer, arrayStride}`
      // or a bare `GPUBuffer`. Type it as the union up front so the
      // branches narrow without repeated inline casts.
      type VbSlot = GPUBuffer | { buffer?: GPUBuffer; arrayStride?: number };
      let vb: GPUBuffer | undefined;
      let vbStride: number | undefined;
      if (cmd.vertexBuffers && cmd.vertexBuffers.length > 0) {
        const first = cmd.vertexBuffers[0] as VbSlot;
        if ("buffer" in first && first.buffer) {
          vb = first.buffer;
          vbStride = first.arrayStride ?? cmd.vertexStride;
        } else {
          vb = first as GPUBuffer;
          vbStride = cmd.vertexStride;
        }
      } else if (cmd._vertexBuffer) {
        const vbRef = cmd._vertexBuffer as { buffer?: GPUBuffer };
        vb = defined(vbRef.buffer)
          ? vbRef.buffer
          : (cmd._vertexBuffer as GPUBuffer);
        vbStride = cmd._vertexStride ?? cmd.vertexStride;
      } else if (cmd.vertexBuffer) {
        const vbRef = cmd.vertexBuffer as { buffer?: GPUBuffer };
        vb = defined(vbRef.buffer)
          ? vbRef.buffer
          : (cmd.vertexBuffer as GPUBuffer);
        vbStride = cmd.vertexStride;
      } else {
        continue;
      }
      if (!vb) continue;

      // Accept every variant registered by the single-shadow-map path. The
      // `_getOrCreateCastPipeline` factory compiles at first use; subsequent
      // frames use the persistent resource-owner bind-group cache.
      // `SHADOW_CAST_VARIANTS` in `WebGPUShadowMapRenderer.js` is canonical.
      const layoutKey = _inferShadowLayoutKey(cmd, vbStride);
      if (layoutKey === null) continue;

      const variant = getShadowCastVariant(layoutKey);
      if (!variant) continue;

      const pipelineEntry = _getOrCreateCastPipeline(
        host._device,
        host._sharedPipelineCache,
        layoutKey,
        vbStride,
        getShadowCastTopology(cmd),
        getShadowCastCullMode(cmd),
        // CSM shares the cast pipeline factory with the single shadow map, so
        // it must pass the same complete topology axis.
        getShadowCastStripIndexFormat(cmd),
      );
      if (!pipelineEntry) continue;

      const extraBindings = (
        variant as {
          extraBindings?: GPUBindGroupLayoutEntry[];
        }
      ).extraBindings;
      const perCommandFields = (
        variant as {
          perCommandBindingFields?: string[];
        }
      ).perCommandBindingFields;
      const hasExtraBindings =
        Array.isArray(extraBindings) && extraBindings.length > 0;

      // Binding 0 is always the per-cascade cast UBO. Variants with
      // `extraBindings` add per-command buffers at bindings 1..n
      // (modelP12: modelMatrix UB; modelInstancedSB: modelMatrix UB +
      // instancing SB; modelSkinned: modelMatrix UB + joint-matrices
      // SB). Shared groups live on the CSM renderer; resource-specific
      // groups live on the command's stable cache owner.
      let bg: GPUBindGroup | undefined;
      if (!hasExtraBindings) {
        // The factory creates an explicit BGL for each baked pipeline tuple.
        // Key by that complete tuple, not just the vertex-layout name, so a
        // line/triangle, cull-mode, or stride variant never reuses a group
        // created against a sibling pipeline's layout object.
        bg = host._cascadeCastBindGroups![ci].get(pipelineEntry.cacheKey);
        if (!bg) {
          bg = host._device.createBindGroup({
            label: `CSM_Cascade_${ci}_CastBG_${pipelineEntry.cacheKey}`,
            layout: pipelineEntry.bgl,
            entries: [
              {
                binding: 0,
                resource: { buffer: host._cascadeCastBuffers![ci] },
              },
            ],
          });
          host._cascadeCastBindGroups![ci].set(pipelineEntry.cacheKey, bg);
        }
      } else {
        const fields = perCommandFields ?? [];
        const cacheHost = cmd._shadowCastBindGroupCacheHost ?? cmd;
        bg = getOrCreateShadowCastBindGroup(
          host._device,
          cacheHost,
          `CSM_Cascade_${ci}_CastBG_${layoutKey}_cmd`,
          pipelineEntry.bgl,
          host._cascadeCastBuffers![ci],
          extraBindings!,
          fields,
          cmd,
        );
        if (!defined(bg)) continue;
      }

      pass.setPipeline(pipelineEntry.pipeline);
      pass.setBindGroup(0, bg);

      // Multi-VB variants (modelSkinned pulls pos + joints + weights
      // from slots 0/5/6 of the model's 7-buffer layout) declare
      // `vertexBufferSourceSlots`; single-VB variants (rte24, p12,
      // modelP12, modelInstancedSB, quantized12) fall through to the
      // default slot-0 bind. The classic `modelInstanced` variant
      // takes a secondary VB via `_shadowCastInstanceVB`.
      const sourceSlots = (
        variant as {
          vertexBufferSourceSlots?: number[];
        }
      ).vertexBufferSourceSlots;
      if (sourceSlots && sourceSlots.length > 1) {
        let allResolved = true;
        for (let slotIdx = 0; slotIdx < sourceSlots.length; slotIdx++) {
          const src = sourceSlots[slotIdx];
          const srcEntry = cmd.vertexBuffers?.[src] as
            { buffer?: GPUBuffer } | GPUBuffer | undefined;
          if (!defined(srcEntry)) {
            allResolved = false;
            break;
          }
          const rawVb = defined((srcEntry as { buffer?: GPUBuffer }).buffer)
            ? (srcEntry as { buffer: GPUBuffer }).buffer
            : (srcEntry as GPUBuffer);
          pass.setVertexBuffer(slotIdx, rawVb);
        }
        if (!allResolved) continue;
      } else {
        pass.setVertexBuffer(0, vb);
        if (layoutKey === "modelInstanced") {
          const instSrc =
            cmd._shadowCastInstanceVB ??
            (cmd.vertexBuffers && cmd.vertexBuffers[1]);
          if (!defined(instSrc)) continue;
          const rawInstVb = defined((instSrc as { buffer?: GPUBuffer }).buffer)
            ? (instSrc as { buffer: GPUBuffer }).buffer
            : (instSrc as GPUBuffer);
          pass.setVertexBuffer(1, rawInstVb);
        }
      }

      const ibRef = (cmd.indexBuffer ?? cmd._indexBuffer) as
        { buffer?: GPUBuffer } | GPUBuffer | undefined;
      if (ibRef) {
        const ib =
          (ibRef as { buffer?: GPUBuffer }).buffer ?? (ibRef as GPUBuffer);
        const fmt: GPUIndexFormat =
          cmd.indexFormat ?? cmd._indexFormat ?? "uint16";
        const count = cmd.indexCount ?? cmd._indexCount ?? 0;
        pass.setIndexBuffer(ib, fmt);
        pass.drawIndexed(count, cmd.instanceCount ?? 1);
      } else {
        const count = cmd.vertexCount ?? cmd._vertexCount ?? 0;
        pass.draw(count, cmd.instanceCount ?? 1);
      }
    }

    pass.end();
  }
  host._shadowContentState = "casters";
  host._shadowContentFrame = frameState?.frameNumber;
}
