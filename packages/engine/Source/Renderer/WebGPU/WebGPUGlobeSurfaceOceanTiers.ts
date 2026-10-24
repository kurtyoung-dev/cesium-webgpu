/**
 * Ocean tier and transition state for the WebGPU globe surface renderer.
 *
 * The renderer owns three ocean tiers, selected through the hi-word shader
 * defines:
 *
 *   - Tier 0, classic WebGL-parity water (no hi define).
 *   - Tier 1, `ShaderDefineHi.ENHANCED_OCEAN`.
 *   - Tier 2, Tier 1 plus `ShaderDefineHi.UNDERWATER_OPTICS`, selected only
 *     while the eye is within {@link UNDERWATER_OPTICS_ENTER_M} of the sea (with
 *     {@link UNDERWATER_OPTICS_EXIT_M} exit hysteresis) or underground.
 *
 * Switching tier wipes the renderer-local pipeline caches and rebuilds the new
 * pipelines asynchronously, so the previous tier's pipelines are kept as
 * fallbacks and the shader cross-fades over {@link OCEAN_TRANSITION_DURATION_MS}.
 * The state machine for that lives here, free of any GPU object, so a Node spec
 * can drive the real class instead of matching its source text.
 *
 * What is NOT here: the pipeline caches themselves (the renderer owns them) and
 * the descriptor builders (`WebGPUGlobeSurfacePipelines.ts`).
 *
 * @module WebGPUGlobeSurfaceOceanTiers
 */

import type { GlobePipelineEntry } from "./WebGPUGlobeSurfaceTypes.js";

/** Length of the classic-to-enhanced cross-fade once the enhanced pipelines are ready. */
export const OCEAN_TRANSITION_DURATION_MS = 600;

/**
 * Longest the fade may sit at full deficit waiting for the enhanced pipelines.
 * Past it the fade is abandoned, so a compile that never lands cannot pin the
 * deficit at 1.0 or hold a request-render loop open.
 */
export const OCEAN_TRANSITION_PENDING_TIMEOUT_MS = 10000;

/** Eye height, metres, below which Tier 2 (underwater optics) is wanted. */
export const UNDERWATER_OPTICS_ENTER_M = 500;

/** Eye height, metres, above which Tier 2 is released again. */
export const UNDERWATER_OPTICS_EXIT_M = 1500;

/**
 * Eye height, metres, below which Tier 2 pipelines start to be warmed. Well
 * above the enter threshold so they are ready before the eye arrives, and well
 * below any orbital or ordinary aviation camera.
 */
export const UNDERWATER_WARM_ELIGIBLE_M = 5000;

/** Fields stamped onto a pipeline entry the first time it is resolved. */
export type OceanStampedEntry = Pick<
  GlobePipelineEntry,
  "oceanGeneration" | "builtEnhanced"
>;

/**
 * Decides the wanted Tier 2 state from the eye.
 *
 * @param enhanced Whether enhanced ocean is on; Tier 2 is never wanted without it.
 * @param underground `frameState.cameraUnderground`.
 * @param eyeHeight Eye height above the ellipsoid, metres, when known.
 * @param active Whether Tier 2 is currently active; selects the hysteresis side.
 * @returns `wanted` for the Tier 2 flag and `warmEligible` for the Tier 2 warm.
 */
export function resolveUnderwaterTier(
  enhanced: boolean,
  underground: boolean,
  eyeHeight: number | undefined,
  active: boolean,
): { wanted: boolean; warmEligible: boolean } {
  if (!enhanced) {
    return { wanted: false, warmEligible: false };
  }
  if (underground) {
    return { wanted: true, warmEligible: true };
  }
  if (typeof eyeHeight === "number" && Number.isFinite(eyeHeight)) {
    const threshold = active
      ? UNDERWATER_OPTICS_EXIT_M
      : UNDERWATER_OPTICS_ENTER_M;
    return {
      wanted: eyeHeight < threshold,
      warmEligible: eyeHeight < UNDERWATER_WARM_ELIGIBLE_M,
    };
  }
  return { wanted: active, warmEligible: false };
}

/**
 * Replaces `fallbackCache` with every resolved (or fallback) pipeline of
 * `pipelineCache`, so tiles keep drawing with the previous tier while the new
 * one compiles.
 *
 * An EMPTY `pipelineCache` leaves `fallbackCache` as it is. That is the second
 * flip of a compound change in one tick (enhanced ocean turning on while the eye
 * is already underwater wipes the cache twice): the first wipe has already moved
 * the drawable pipelines into `fallbackCache`, and clearing it again with
 * nothing left to copy would drop them and leave the tiles blank until Tier 2
 * compiles.
 */
export function stashResolvedPipelinesAsFallback(
  pipelineCache: ReadonlyMap<string, GlobePipelineEntry>,
  fallbackCache: Map<string, GPURenderPipeline>,
): void {
  if (pipelineCache.size === 0) {
    return;
  }
  fallbackCache.clear();
  for (const [key, entry] of pipelineCache) {
    const existing = entry.pipeline ?? entry.fallbackPipeline;
    if (existing) {
      fallbackCache.set(key, existing);
    }
  }
}

function defaultNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * The classic-to-enhanced fade. Pipelines resolve asynchronously, so the
 * deficit is 1.0 (classic look) while the enhanced pipelines are pending, and
 * falls on a smoothstep to 0 over {@link OCEAN_TRANSITION_DURATION_MS} once the
 * first enhanced pipeline is ready.
 *
 * Every cache wipe bumps a generation; an entry remembers the generation it was
 * first resolved under, and a resolution from an older generation is ignored,
 * because that entry is no longer in the renderer's cache.
 */
export class GlobeOceanTierTransition {
  private _generation = 0;
  private _resolvedEnhanced = false;
  private _pending = false;
  private _pendingSinceMs = 0;
  private _abandoned = false;
  private _startMs = 0;
  private _frameKey = Number.NaN;
  private _frameNowMs: number;
  private readonly _now: () => number;
  // One stable function, so `afterRender.includes` can recognise it.
  private readonly _frameRequest = (): boolean => true;

  constructor(now: () => number = defaultNow) {
    this._now = now;
    this._frameNowMs = now();
  }

  /** True while the fade holds, or is running, and so still needs frames. */
  get isActive(): boolean {
    return this._pending || this._startMs > 0;
  }

  get generation(): number {
    return this._generation;
  }

  /**
   * The renderer's pipeline caches were wiped: entries built before this call
   * are no longer in the cache, so their resolutions no longer count.
   */
  invalidate(): void {
    this._generation++;
    this._abandoned = false;
  }

  /**
   * `Globe.enableEnhancedOcean` flipped.
   *
   * @param enabled The new state.
   * @param hadFallbackPipelines Whether the renderer has pipelines to keep
   *   drawing with while the new tier compiles; with none, nothing is on screen
   *   to cross-fade from.
   */
  onEnhancedChanged(enabled: boolean, hadFallbackPipelines: boolean): void {
    this.invalidate();
    this._startMs = 0;
    if (!enabled) {
      this._resolvedEnhanced = false;
      this._pending = false;
      return;
    }
    if (!this._resolvedEnhanced && hadFallbackPipelines) {
      this._pending = true;
      this._pendingSinceMs = this._now();
    }
  }

  /** A tile drew with a previous-tier pipeline while the current tier compiles. */
  noteFallbackUsed(enhancedEnabled: boolean): void {
    if (
      enhancedEnabled &&
      !this._resolvedEnhanced &&
      !this._abandoned &&
      this._startMs === 0 &&
      !this._pending
    ) {
      this._pending = true;
      this._pendingSinceMs = this._now();
    }
  }

  /** Records the generation and tier an entry was built under; first call wins. */
  stamp(entry: OceanStampedEntry, enhancedEnabled: boolean): void {
    if (entry.oceanGeneration === undefined) {
      entry.oceanGeneration = this._generation;
      entry.builtEnhanced = enhancedEnabled;
    }
  }

  /**
   * A pipeline entry resolved. Only an entry built with enhanced ocean on, and
   * still in the cache, marks enhanced as resolved and starts the fade.
   */
  noteResolved(entry: OceanStampedEntry): void {
    if (entry.oceanGeneration !== this._generation || !entry.builtEnhanced) {
      return;
    }
    this._resolvedEnhanced = true;
    if (this._pending) {
      this._pending = false;
      this._startMs = this._now();
    }
  }

  /** An entry's compile was rejected: abandon the fade rather than wait for it. */
  noteFailed(entry: OceanStampedEntry): void {
    if (entry.oceanGeneration !== this._generation || !entry.builtEnhanced) {
      return;
    }
    this._abandon();
  }

  /**
   * Samples the clock once per frame (`frameKey` is the frame number; an
   * unknown key samples on every call), so the deficit the uniform packer reads
   * is a pure function of that sample, and times out a fade that never started.
   */
  beginFrame(frameKey: number | undefined): void {
    const key = typeof frameKey === "number" ? frameKey : Number.NaN;
    if (key === this._frameKey) {
      return;
    }
    this._frameKey = key;
    const now = this._now();
    this._frameNowMs = now;
    if (
      this._pending &&
      now - this._pendingSinceMs >= OCEAN_TRANSITION_PENDING_TIMEOUT_MS
    ) {
      this._abandon();
    }
    if (
      this._startMs > 0 &&
      now - this._startMs >= OCEAN_TRANSITION_DURATION_MS
    ) {
      this._startMs = 0;
    }
  }

  /** 1.0 while pending, then 1 to 0 on a smoothstep; pure over the frame sample. */
  get deficit(): number {
    if (this._pending) {
      return 1.0;
    }
    if (this._startMs > 0) {
      const elapsed = this._frameNowMs - this._startMs;
      if (elapsed >= OCEAN_TRANSITION_DURATION_MS) {
        return 0.0;
      }
      const t = Math.max(
        0.0,
        Math.min(1.0, elapsed / OCEAN_TRANSITION_DURATION_MS),
      );
      return 1.0 - t * t * (3.0 - 2.0 * t);
    }
    return 0.0;
  }

  /**
   * Asks for another frame while the fade is active, at most once per frame
   * however many tiles call it: the callback is one stable function and is
   * pushed only when `afterRender` does not hold it yet.
   */
  requestFrame(afterRender: Array<() => boolean> | null | undefined): void {
    if (!this.isActive || !afterRender) {
      return;
    }
    if (!afterRender.includes(this._frameRequest)) {
      afterRender.push(this._frameRequest);
    }
  }

  private _abandon(): void {
    this._pending = false;
    this._abandoned = true;
  }
}

/** One Tier 1 colour-pass key whose Tier 2 pipelines can be warmed later. */
export interface UnderwaterWarmCandidate {
  hasNormals: boolean;
  hasWebMercatorT: boolean;
  strideBytes: number;
  hasGeodeticSurfaceNormals: boolean;
  disableCulling: boolean;
}

/**
 * Holds back the Tier 2 warm until the eye first comes within
 * {@link UNDERWATER_WARM_ELIGIBLE_M} of the sea. Keys requested before then are
 * remembered and released all at once on arming; keys requested after are
 * warmed at once.
 */
export class GlobeUnderwaterWarmPlan {
  private _eligible = false;
  private readonly _candidates = new Map<string, UnderwaterWarmCandidate>();

  get eligible(): boolean {
    return this._eligible;
  }

  /**
   * @returns True when the caller should warm this key now; false when it was
   *   remembered for later.
   */
  noteCandidate(key: string, candidate: UnderwaterWarmCandidate): boolean {
    if (this._eligible) {
      return true;
    }
    this._candidates.set(key, candidate);
    return false;
  }

  /** Marks the eye as near; returns the remembered keys to warm, once. */
  arm(): UnderwaterWarmCandidate[] {
    if (this._eligible) {
      return [];
    }
    this._eligible = true;
    const released = Array.from(this._candidates.values());
    this._candidates.clear();
    return released;
  }

  reset(): void {
    this._eligible = false;
    this._candidates.clear();
  }
}
