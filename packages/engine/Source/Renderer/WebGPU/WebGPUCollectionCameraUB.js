/**
 * Per-frustum camera uniform-buffer resolver for collection feature
 * renderers (PointPrimitive, Billboard, Label, Polyline, Cloud).
 *
 * ---------------------------------------------------------------------------
 * Per-frustum collection camera uniforms
 * ---------------------------------------------------------------------------
 *
 * THE PROBLEM. A collection FR packs its camera uniform buffer ONCE per
 * frame (at `update()` time) from `uniformState.projection` / `.view`, then
 * builds ONE `WebGPUDrawCommand` whose `mvpRelativeToEye` is baked from that
 * single projection. The WebGPU multi-frustum loop
 * (`WebGPUSceneRendererFrustumLoop`) re-executes that SAME command once per
 * depth slice the command's bounding volume overlaps. Between slices the loop
 * calls `_updateFrustumUniforms(...)` → `uniformState.updateFrustum(...)`,
 * which recomputes `uniformState.projection` (and `.inverseProjection`,
 * `.currentFrustum`) for THAT slice's near/far. The command, however, still
 * carries the single baked MVP — so every slice but the one that happened to
 * match the bake projection renders with the wrong depth-range / clip math.
 * In SCENE2D and COLUMBUS_VIEW (where the orthographic / planar projection
 * differs sharply per band and clip-z must land in WebGPU's [0,1]) this puts
 * the geometry out of clip range and the collection vanishes — the all-zero
 * 2D/CV state `probe-collections-2dcv-morph.mjs` reports.
 *
 * Mirror the GroundPrimitive per-slice resolver in
 * `WebGPUGroundPrimitiveRenderer`: give the
 * collection's draw command a `bindGroupResolvers[i]` closure for the camera
 * group. At DRAW time — inside `WebGPUDrawCommand.execute()`, after the loop
 * has already refreshed `uniformState.projection` for the current slice — the
 * resolver reads `uniformState._currentSliceIndex`, repacks the camera UB for
 * THAT slice into a DISTINCT per-slice GPU buffer (one buffer per slice index;
 * `writeBuffer` is unordered vs the encoder so the slices must not share a
 * buffer), and returns the matching per-slice bind group. Returning `null`
 * falls back to the static `bindGroups[i]` baked at update time (slice 0 /
 * single-frustum / first-frame), preserving the single-frustum behavior.
 *
 * Each slice draws through its own buffer. In 3D the resolver copies the
 * full-frustum snapshot; projected modes may opt into draw-time repacking so
 * each band uses its live projection and relative-to-eye encoding.
 *
 * USAGE. A collection cache creates one instance and asks it for a resolver:
 *
 *   if (!cache.cameraUB) cache.cameraUB = new WebGPUCollectionCameraUB(device, "Point");
 *   const resolver = cache.cameraUB.makeResolver({
 *     bufferSize: UNIFORM_BUFFER_SIZE,        // bytes
 *     bindGroupLayout: cache.bindGroupLayout, // group-0 layout
 *     pack: (data) => packUniforms(data, frameState, modelMatrix),
 *     // extra group-0 entries beyond binding 0 (atlas tex/sampler, depth, ...)
 *     extraEntries: [{ binding: 1, resource: atlasView }, ...],
 *   });
 *   // then on the command:
 *   bindGroups: [cache.bindGroup],
 *   bindGroupResolvers: [resolver],
 *
 * The static `cache.bindGroup` (slice-0 bake) stays as the fallback. For FRs
 * whose camera UB lives in a dedicated group at a non-zero command-group index
 * (none today — all collections put it at group 0), pass `groupIndex` to align
 * the resolver array.
 *
 * @private
 * @module WebGPUCollectionCameraUB
 */
import defined from "../../Core/defined.js";
import WebGPUBuffer from "./WebGPUBuffer.js";

/**
 * Packs the camera UB into the shared CPU scratch.
 *
 * @callback WebGPUCollectionCameraUBPack
 * @param {Float32Array} data
 * @returns {void}
 * @private
 */

/**
 * Resolves the per-slice bind group for one draw.
 *
 * @callback WebGPUCollectionCameraUBResolver
 * @returns {GPUBindGroup|null} `null` to fall back to the static bind group
 *   when the slice index is unavailable.
 * @private
 */

/**
 * Owns a per-collection pool of per-slice camera UB buffers + bind groups.
 * Buffers/bind groups are created lazily on first sight of a slice index and
 * reused across frames. The CPU scratch `Float32Array` is shared across slices
 * (each slice repacks it just before its `writeBuffer`).
 *
 * @private
 */
class WebGPUCollectionCameraUB {
  /**
   * @param {GPUDevice} device
   * @param {string} label - Short collection name for buffer/bind-group labels.
   */
  constructor(device, label) {
    this._device = device;
    this._label = label || "Collection";
    // sliceIndex → { buffer: WebGPUBuffer, bindGroup: GPUBindGroup }
    this._slices = new Map();
    // Shared CPU scratch — sized on first makeResolver call.
    this._scratch = null;
    this._scratchFloats = 0;
    // Identity tokens for the current resolver generation; when any of these
    // rotate (texture views recreated per-frame, layout swapped, buffer size
    // changed) the cached per-slice bind groups are stale and get rebuilt.
    this._gen = 0;
    this._layout = null;
    this._bufferBytes = 0;
    this._extraKey = "";
  }

  /**
   * Produce a `bindGroupResolvers[i]` closure for this frame. Call once per
   * `update()`; the returned function is stored on the command and invoked per
   * draw (per slice) by `WebGPUDrawCommand.execute()`.
   *
   * @param {object} opts
   * @param {number} opts.bufferSize - Camera UB size in bytes.
   * @param {GPUBindGroupLayout} opts.bindGroupLayout - The group's layout.
   * @param {WebGPUCollectionCameraUBPack} opts.pack - Packs the camera UB.
   *   Invoked ONCE here (at update time) to capture the frame's reference
   *   snapshot — the SAME full-camera-frustum bake the static bind group
   *   holds. Reads `uniformState.projection`/`.view`/encode frustum. When
   *   `repackPerSlice` is set this same closure is ALSO re-invoked at draw
   *   time per slice, so it must read live `uniformState` (it does).
   * @param {Array<{binding: number, resource: object}>} [opts.extraEntries] -
   *   group-0 entries beyond the camera buffer (binding 0): atlas texture +
   *   sampler, globe-depth view + sampler, noise texture, etc.
   * @param {number} [opts.cameraBinding=0] - Binding slot of the camera UB.
   * @param {boolean} [opts.repackPerSlice=false] - When true, the resolver
   *   RE-INVOKES `pack(scratch)` at DRAW time — after the frustum loop's
   *   `_updateFrustumUniforms(...)` has recomputed
   *   `uniformState.projection` for THIS slice's near/far using the owning
   *   context's WebGPU clip-space convention — so each slice's
   *   `mvpRelativeToEye` is baked against the LIVE slice projection instead
   *   of the stale update-time snapshot.
   *
   *   WHY this is the 2D/CV fix. A collection FR packs its MVP at `update()`
   *   from `uniformState.projection`, which at that point is still the
   *   previous full-frustum projection (the loop recomputes the context-owned
   *   projection only DURING render, after FR update). In SCENE2D a
   *   orthographic depth-range mismatch is catastrophic: a point at the map
   *   surface lands at NDC z ≈ 7.3 (WebGL range) instead of ≈ 0.026 (WebGPU
   *   range) and is clipped out — the all-zero 2D state. In COLUMBUS_VIEW the
   *   bake uses the FULL camera frustum (far ~1e10) so the geometry pins to
   *   NDC z ≈ 0.99999993 (the far plane) and loses to the globe under
   *   `less-equal`; the per-band slice projection (far ~1e8) restores a
   *   correct in-range z. SCENE3D perspective + log-depth's clip-z clamp
   *   already keeps the single bake correct in all slices, so 3D leaves
   *   `repackPerSlice` FALSE and stays byte-identical (no regression).
   * @returns {WebGPUCollectionCameraUBResolver} Resolver; returns `null` to
   *   fall back to the static bind group when the slice index is unavailable.
   */
  makeResolver(opts) {
    const bufferSize = opts.bufferSize;
    const layout = opts.bindGroupLayout;
    const pack = opts.pack;
    const extraEntries = opts.extraEntries;
    const cameraBinding = opts.cameraBinding ?? 0;
    const repackPerSlice = opts.repackPerSlice === true;

    // Resize / (re)allocate the shared scratch when the layout grows.
    const floats = bufferSize / 4;
    if (!this._scratch || this._scratchFloats < floats) {
      this._scratch = new Float32Array(floats);
      this._scratchFloats = floats;
    }

    // ---------------------------------------------------------------------
    // CRITICAL — capture the frame's reference snapshot HERE, at update time,
    // NOT lazily at draw time inside the resolver.
    //
    // Collections — like the globe (see WebGPUSceneRendererFrustumLoop
    // L162-171) — bake their MVP against the FULL camera frustum at scene-update
    // and replay unchanged across every depth slice. Log-depth's
    // `csm_updatePositionDepth` clip-z clamp makes that single bake correct in
    // all slices. The multi-frustum loop SLICES `uniformState.projection` to a
    // per-band near/far (~5e5) between slices, so re-reading `uniformState`
    // INSIDE the resolver (at draw time) would pack each slice with the wrong
    // narrow projection — which clips far geometry out of the near slices and
    // vanishes the collection (the observed bb=0/pt=0 far-camera regression).
    //
    // Pack once here, matching the static bake. Unless `repackPerSlice` is set,
    // the resolver merely copies that snapshot into each slice's own buffer.
    // This keeps 3D byte-identical while projected modes can repack after their
    // band projection changes.
    // ---------------------------------------------------------------------
    pack(this._scratch);
    this._snapshotBytes = bufferSize;

    // Bump the generation token when any identity input rotates so stale
    // per-slice bind groups (built over last frame's texture views or a
    // different layout) are discarded. Texture views are recreated every
    // frame on globe scenes, so a cheap structural key over the extra
    // entries' resources detects that without deep comparison. The snapshot
    // changes every frame, so per-slice buffers are re-uploaded every frame
    // regardless; only the BIND GROUPS are cached across frames.
    const extraKey = WebGPUCollectionCameraUB._keyForExtras(extraEntries);
    if (
      this._layout !== layout ||
      this._bufferBytes !== bufferSize ||
      this._extraKey !== extraKey
    ) {
      this._gen++;
      this._layout = layout;
      this._bufferBytes = bufferSize;
      this._extraKey = extraKey;
      // Drop cached bind groups (buffers stay — they're identity-stable);
      // they'll be rebuilt against the new layout / texture views on demand.
      for (const slot of this._slices.values()) {
        slot.bindGroup = undefined;
        slot.gen = -1;
      }
    }

    // Each frame's resolver writes are tracked so a slice buffer is uploaded
    // at most once per frame (a command re-executed in the same slice within
    // one frame — shouldn't happen, but cheap to guard).
    this._frameToken = (this._frameToken | 0) + 1;

    const self = this;
    return function resolveCameraBindGroup() {
      // The frustum loop publishes the active slice index on the SHARED
      // uniformState (NOT the renderer's config.context — a different object
      // under the GraphicsContext abstraction).
      const us = self._uniformState;
      if (!defined(us)) {
        return null;
      }
      const idx = us._currentSliceIndex | 0;
      const slot = self._ensureSlot(
        idx,
        bufferSize,
        layout,
        cameraBinding,
        extraEntries,
      );
      if (!defined(slot)) {
        return null;
      }
      // Upload THIS frame's reference snapshot into the slice's OWN buffer —
      // distinct buffers per slice because `device.queue.writeBuffer` ordering
      // vs the command encoder is not guaranteed; sharing one buffer would
      // race adjacent slices. Guarded to one upload per slice per frame.
      if (slot.frameToken !== self._frameToken) {
        slot.frameToken = self._frameToken;
        // In 2D/CV/MORPHING, re-pack against the live per-slice projection that
        // the frustum loop just established (WebGPU depth range + this slice's
        // near/far), overwriting the stale update-time snapshot. In 3D the
        // flag is off so the snapshot is uploaded verbatim (byte-identical to
        // the snapshot-only path). The repack reads `uniformState` through the
        // `pack` closure, which closes over the live `frameState`.
        if (repackPerSlice) {
          pack(self._scratch);
        }
        self._device.queue.writeBuffer(
          slot.buffer.buffer,
          0,
          self._scratch.buffer,
          0,
          bufferSize,
        );
        //>>includeStart('debug', pragmas.debug);
        // Per-slice-write diagnostic.
        // Throttled summary so multi-frustum scenes show DISTINCT slice
        // indices written to DISTINCT buffers. Body pragma-stripped.
        self._diagRecordWrite(idx);
        //>>includeEnd('debug');
      }
      return slot.bindGroup;
    };
  }

  /**
   * Bind the shared `uniformState` the resolver reads `_currentSliceIndex`
   * from. Called once per `update()` alongside `makeResolver`. Kept separate
   * from `makeResolver` so the resolver closure stays allocation-light.
   *
   * @param {object} uniformState
   */
  bindUniformState(uniformState) {
    this._uniformState = uniformState;
  }

  /**
   * Lazily allocate (and rebuild on generation bump) the per-slice buffer +
   * bind group for `idx`.
   * @private
   */
  _ensureSlot(idx, bufferSize, layout, cameraBinding, extraEntries) {
    const device = this._device;
    let slot = this._slices.get(idx);
    if (!defined(slot)) {
      slot = {
        buffer: WebGPUBuffer.createUniformBuffer(
          device,
          bufferSize,
          `${this._label} camera UB slice ${idx}`,
        ),
        bindGroup: undefined,
        gen: -1,
        frameToken: -1,
      };
      this._slices.set(idx, slot);
    }
    if (slot.gen !== this._gen || !defined(slot.bindGroup)) {
      const entries = [
        { binding: cameraBinding, resource: { buffer: slot.buffer.buffer } },
      ];
      if (defined(extraEntries)) {
        for (let i = 0; i < extraEntries.length; i++) {
          entries.push(extraEntries[i]);
        }
      }
      slot.bindGroup = device.createBindGroup({
        label: `${this._label} camera bind group slice ${idx}`,
        layout: layout,
        entries: entries,
      });
      slot.gen = this._gen;
    }
    return slot;
  }

  /**
   * Cheap structural key over the extra entries' GPU resources so a texture
   * view rotation (new view object each frame on globe scenes) triggers a
   * bind-group rebuild without deep equality.
   * @private
   */
  static _keyForExtras(extraEntries) {
    if (!defined(extraEntries) || extraEntries.length === 0) {
      return "";
    }
    // Use the resources' object identity via a per-call WeakMap-free token:
    // bind-group resources are stable references within a frame, and rotate
    // by reference between frames, so a join of binding indices + a monotone
    // id stamped on each resource suffices. Fall back to length when the
    // resource can't be stamped (frozen/proxy objects).
    let key = "";
    for (let i = 0; i < extraEntries.length; i++) {
      const e = extraEntries[i];
      key += `${e.binding}:${WebGPUCollectionCameraUB._idOf(e.resource)};`;
    }
    return key;
  }

  /**
   * Stamp a monotone id on a resource object so reference rotation is
   * detectable across frames. GPUTextureView / GPUSampler are plain objects
   * we can tag with a non-enumerable symbol property.
   * @private
   */
  static _idOf(resource) {
    if (resource === null || typeof resource !== "object") {
      return String(resource);
    }
    let id = resource[ID_SYMBOL];
    if (!defined(id)) {
      id = ++_idCounter;
      try {
        Object.defineProperty(resource, ID_SYMBOL, {
          value: id,
          enumerable: false,
          configurable: false,
          writable: false,
        });
      } catch (e) {
        // Frozen / non-extensible (rare for GPU resources) — degrade to a
        // length-based key so we at least rebuild on count change.
        return "x";
      }
    }
    return id;
  }

  /**
   * Per-slice-write diagnostic. Records which slice indices got a write this
   * window + emits a throttled summary so multi-frustum scenes can confirm
   * distinct per-slice buffers are exercised. Body is pragma-stripped from
   * production builds, so it has zero runtime cost.
   * @private
   */
  _diagRecordWrite(idx) {
    //>>includeStart('debug', pragmas.debug);
    if (!this._diagSeen) {
      this._diagSeen = new Set();
      this._diagLastLog = 0;
    }
    this._diagSeen.add(idx);
    const now =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    if (now - this._diagLastLog > 2000 && this._diagSeen.size > 1) {
      this._diagLastLog = now;
      const slices = Array.from(this._diagSeen).sort((a, b) => a - b);
      console.log(
        `[WebGPU:CollectionCameraUB:${this._label}] per-slice camera-UB writes this window → slices [${slices.join(
          ", ",
        )}] (${this._slices.size} buffers allocated)`,
      );
      this._diagSeen.clear();
    }
    //>>includeEnd('debug');
  }

  /**
   * Release all per-slice GPU buffers. Bind groups are GC'd with their slots.
   */
  destroy() {
    for (const slot of this._slices.values()) {
      slot.buffer?.destroy?.();
    }
    this._slices.clear();
    this._scratch = null;
    this._uniformState = undefined;
  }
}

const ID_SYMBOL = Symbol("WebGPUCollectionCameraUB.id");
let _idCounter = 0;

export default WebGPUCollectionCameraUB;
