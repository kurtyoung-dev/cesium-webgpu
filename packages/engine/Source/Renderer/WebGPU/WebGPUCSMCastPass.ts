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

export function renderCSMCastPass(
  host: CSMCastPassHost,
  encoder: GPUCommandEncoder,
  castCommands: ReadonlyArray<unknown>,
  cameraPositionWC: { x: number; y: number; z: number },
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

    for (const rawCmd of castCommands) {
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
