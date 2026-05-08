/// <reference types="@webgpu/types" />
/**
 * CSM cast-pass dispatcher extracted from `WebGPUCSMRenderer`
 * (Batch 159 of the maintainability sweep).
 *
 * Owns the 326-LOC `renderCastPass` body: lazy per-cascade UBO + bind-
 * group allocation, RTE-encoded camera packing, per-cascade depth-bias
 * scaling, per-cascade render-pass dispatch with the shared shadow-cast
 * pipeline factory (rte24 / p12 / modelP12 / modelInstanced(SB) /
 * quantized12 / modelSkinned variants).
 *
 * The renderer's `renderCastPass` becomes a 1-line delegator. The
 * 11 host fields/methods the helper reads through `this.` are flipped
 * to `public` (with the underscore convention).
 *
 * **NEW-SHADOW-CAST-GPU-CULL-PHASE-2 (Batch 226):** per-cascade GPU
 * cull activation. Phase 1 (Batch 221) shipped per-cascade culler
 * instances + memory hygiene; Phase 2 wires the actual filter into
 * the per-cascade loop. Strategy:
 *
 *   - **Sphere-AABB cull (correctness-safe over-include).** For each
 *     cascade we feed the FrustumCull shader 6 planes of the axis-
 *     aligned cube circumscribing the cascade's bounding sphere
 *     (`sphereCenter`, `sphereRadius`). This over-includes vs a tight
 *     Gribb-Hartmann frustum (cube has corners that extend past the
 *     sphere), but correctness-safe: anything kept is potentially a
 *     valid shadow caster, and missed culls cost only overdraw, not
 *     missing shadows. Tight Gribb-Hartmann extraction is a future
 *     follow-up gated on visual verification.
 *   - Per-cascade `_cascadeCullLastResults[ci]` readback slot driven
 *     by per-cascade `WebGPUGPUCuller` instance (Batch 221).
 *   - Per-cascade hysteresis gate (`_cascadeCullActive[ci]`) at the
 *     same threshold as opaque HiZ (HI=2400, LO=1600) — shadow cast
 *     iterates the same command set as opaque so the cost profile
 *     matches.
 *   - 1-frame readback latency (same model as opaque + translucent
 *     paths). First frame at high density: dispatch only, no filter.
 *     Frame 2+: filter using prior readback.
 *   - Skipped entirely when `context.gpuCullingHint === 'never'` or
 *     when no `getGPUCullerForCascade` getter exists (back-compat).
 *
 * @module WebGPUCSMCastPass
 */

import Cartesian3 from "../../Core/Cartesian3.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import defined from "../../Core/defined.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import {
  _getOrCreateCastPipeline,
  _inferShadowLayoutKey,
  getShadowCastVariant,
} from "./WebGPUShadowMapRenderer.js";
import { CSM_CAST_UBO_SIZE, BASE_MIN_BIAS } from "./WebGPUCSMRenderer.js";
import type { CSMCastPassHost, CastCommandShape } from "./WebGPUCSMRenderer.js";

const _scratchEncodedCamera = new EncodedCartesian3();

// NEW-SHADOW-CAST-GPU-CULL-PHASE-2 (Batch 226) — hysteresis
// thresholds for the per-cascade gate. Match opaque HiZ (Batch 214)
// since shadow cast iterates the same command set; if HiZ activates,
// shadow cull should too.
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
  // dot((-1, 0, 0), P) + (cx + R) = (cx + R) - P.x  →  inside when P.x ≤ cx + R.
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

export function renderCSMCastPass(
  host: CSMCastPassHost,
  encoder: GPUCommandEncoder,
  castCommands: ReadonlyArray<unknown>,
  cameraPositionWC: { x: number; y: number; z: number },
  context?: CSMCastContext,
): void {
  if (
    !host._device ||
    !host.enabled ||
    !host._cascadeTexture ||
    host._cascadeViews.length !== host._cascadeCount ||
    castCommands.length === 0
  ) {
    return;
  }
  host._castDispatches++;

  // NEW-SHADOW-CAST-GPU-CULL-PHASE-2 (Batch 226) — lazy per-cascade
  // cull-state arrays sized to `_cascadeCount`. Re-sized when
  // `_cascadeCount` changes (rare; user toggle).
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

  // Lazy-allocate per-cascade cast UBOs the first time we cast.
  // The layout matches WebGPUShadowMapRenderer's existing UBO
  // (SHADOW_UNIFORM_SIZE = 128 bytes) so every registered cast
  // pipeline's bind-group layout is compatible without a second
  // pipeline build.
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
    // Pack: lightVP_RTE (16) + camHigh+pad (4) + camLow+pad (4) + biases (4) = 28 floats.
    // The cast shader multiplies this VP by the camera-relative position
    // (posRTE = posHigh - camHigh + posLow - camLow), so the matrix MUST
    // be the RTE-aware form, not the world-space one. See ShadowMap.wgsl.
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

    // ── Per-cascade GPU cull (Batch 226) ─────────────────────────────
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
          // Build / grow per-cascade SOA scratch + pooled
          // interleaved upload buffer (B226-N1, Batch 230 audit fix).
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
          // B226-O1 (Batch 230 audit fix) — combined SoA + interleaved
          // fill in a single loop. The interleaved buffer is the only
          // thing actually uploaded to the GPU; the SoA fields are kept
          // alongside for potential future use (debug surface, sphere-
          // sphere narrow-phase, etc.) but populated in lockstep.
          //
          // Bail-out: if any command lacks a bounding sphere, we abort
          // the cull entirely (over-include via no-cull is correct;
          // partially filled SoA would mismatch the gen and corrupt
          // the test). The early-return mirrors Batch 226's
          // `validSpheres === totalCount` invariant.
          // (`cascade` is already in scope from the outer per-frustum
          // loop at line 250.)
          const interleaved = soa.interleaved;
          let allValid = true;
          for (let i = 0; i < totalCount; i++) {
            const cmd = castCommands[i] as
              | {
                  boundingVolume?: {
                    center?: { x: number; y: number; z: number };
                    radius?: number;
                    boundingSphere?: { radius?: number };
                  };
                }
              | undefined;
            const c = cmd?.boundingVolume?.center;
            if (!c) {
              allValid = false;
              break;
            }
            const r =
              cmd?.boundingVolume?.radius ??
              cmd?.boundingVolume?.boundingSphere?.radius ??
              0;
            soa.centerX[i] = c.x;
            soa.centerY[i] = c.y;
            soa.centerZ[i] = c.z;
            soa.radius[i] = r;
            const off = i * 4;
            interleaved[off] = c.x;
            interleaved[off + 1] = c.y;
            interleaved[off + 2] = c.z;
            interleaved[off + 3] = r;
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
            filtered.length = 0;
            const flags = prev.visibilityFlags;
            for (let i = 0; i < totalCount; i++) {
              if (flags[i] === 1) filtered.push(castCommands[i]);
            }
            host._cascadeCullLastInput[ci] = totalCount;
            host._cascadeCullLastFiltered[ci] = filtered.length;
            castIter = filtered as ReadonlyArray<unknown>;
          }
        }
      }
    }

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

      // Slice 2 — accept every registered variant that the single-
      // shadow-map path knows about. The pipeline factory (shared with
      // WebGPUShadowMapRenderer via `_getOrCreateCastPipeline`) compiles
      // at first use; subsequent frames hit the per-cascade bind-group
      // cache. See SHADOW_CAST_VARIANTS in WebGPUShadowMapRenderer.js
      // for the canonical list (rte24, p12, modelP12, modelInstanced,
      // modelInstancedSB, quantized12, modelSkinned).
      const layoutKey = _inferShadowLayoutKey(cmd, vbStride);
      if (layoutKey === null) continue;

      const variant = getShadowCastVariant(layoutKey);
      if (!variant) continue;

      const pipelineEntry = _getOrCreateCastPipeline(
        host._device,
        host._sharedPipelineCache,
        layoutKey,
        vbStride,
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
      // SB). We cache shared bind groups on the CSM renderer and
      // per-command bind groups on the command (indexed by cascade).
      let bg: GPUBindGroup | undefined;
      if (!hasExtraBindings) {
        bg = host._cascadeCastBindGroups![ci].get(layoutKey);
        if (!bg) {
          bg = host._device.createBindGroup({
            label: `CSM_Cascade_${ci}_CastBG_${layoutKey}`,
            layout: pipelineEntry.bgl,
            entries: [
              {
                binding: 0,
                resource: { buffer: host._cascadeCastBuffers![ci] },
              },
            ],
          });
          host._cascadeCastBindGroups![ci].set(layoutKey, bg);
        }
      } else {
        const fields = perCommandFields ?? [];
        const extraEntries: GPUBindGroupEntry[] = [];
        let missingBinding = false;
        for (let fi = 0; fi < fields.length; fi++) {
          const field = fields[fi];
          // `field` is a runtime-provided property name from the variant's
          // `vertexBufferSourceSlots` config; indexing by string requires
          // a Record view but not the `unknown` intermediate.
          const source = (cmd as Record<string, unknown>)[field];
          const extraBinding = extraBindings![fi];
          if (!defined(source)) {
            missingBinding = true;
            break;
          }
          const raw = defined((source as { buffer?: GPUBuffer }).buffer)
            ? (source as { buffer: GPUBuffer }).buffer
            : (source as GPUBuffer);
          extraEntries.push({
            binding: extraBinding.binding,
            resource: { buffer: raw },
          });
        }
        if (missingBinding) continue;

        if (!cmd._shadowCastCSMBindGroups) {
          cmd._shadowCastCSMBindGroups = new Array(host._cascadeCount);
          cmd._shadowCastCSMBindGroupKeys = new Array(host._cascadeCount);
        }
        bg = cmd._shadowCastCSMBindGroups[ci];
        if (!bg || cmd._shadowCastCSMBindGroupKeys![ci] !== layoutKey) {
          bg = host._device.createBindGroup({
            label: `CSM_Cascade_${ci}_CastBG_${layoutKey}_cmd`,
            layout: pipelineEntry.bgl,
            entries: [
              {
                binding: 0,
                resource: { buffer: host._cascadeCastBuffers![ci] },
              },
              ...extraEntries,
            ],
          });
          cmd._shadowCastCSMBindGroups[ci] = bg;
          cmd._shadowCastCSMBindGroupKeys![ci] = layoutKey;
        }
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
            | { buffer?: GPUBuffer }
            | GPUBuffer
            | undefined;
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
        | { buffer?: GPUBuffer }
        | GPUBuffer
        | undefined;
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
}
