/// <reference types="@webgpu/types" />
/**
 * C13-09 — cloud reconstruction attachment LAYOUT, LIFETIME, and GENERATION.
 *
 * WHAT THIS ROW OWNS, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * `C13-05` left the cloud history a COLOR-ONLY half-resolution proxy, and said
 * so in `CloudTemporalResolve.wgsl` itself: its `representativeShellDistance`
 * is "a representative geometric proxy, not physical cloud depth; per-pixel
 * front/weighted depth remains C13-09". One mean depth per pixel cannot
 * separate two overlapping volumes, cannot reject a disoccluded history sample,
 * and cannot tell a reprojection that crossed a silhouette from one that did
 * not. This module is the TOPOLOGY that fixes that: the exact attachment set
 * the reconstruction chain reads, its formats, its byte cost, and the
 * generation key that makes a stale bind group impossible to serve.
 *
 * ★ THIS ROW IS INFRASTRUCTURE. The producers write; NOTHING READS THEM YET.
 *   That is the Principle-7 scaffolding-with-documented-intent shape, and the
 *   inventory of live-versus-pending is right here rather than in a commit
 *   message:
 *
 *     LIVE at C13-09    — allocation, resize, device-swap recreation, the
 *                         generation key, the producer pass, and the byte /
 *                         pass counters the Gate-A surface reports.
 *     PENDING C13-10    — the true 1/16-rate current-frame march. It replaces
 *                         the analytic depth estimator below with per-sample
 *                         accumulation emitted from the march itself, and it
 *                         is the row that may change the march shader.
 *     PENDING C13-12    — the CONSUMERS: attachment-aware motion/depth
 *                         rejection, variance clipping from the moment pair,
 *                         reactive history, wind advection, disocclusion.
 *
 * ★ C13-39 BINDS THE SHAPE. Its negative result established that WGSL register
 *   allocation is STATIC, so anything added to the shared `ProceduralClouds`
 *   module inflates EVERY pipeline compiled from it — including the shadow map,
 *   the cascade atlas and the god-ray mask, none of which want a reconstruction
 *   attachment. So the producer lives in its own WGSL module
 *   (`CloudReconstructionAttachments.wgsl`) and its own pipeline, and it
 *   re-derives the WGS84 shell intersection rather than importing it. The
 *   duplication is the point: it is what keeps the march's register budget at
 *   exactly the value C13-39 measured. `cloud-reconstruction-attachments
 *   .spec.mjs` pins `ProceduralClouds.wgsl` by content hash so this cannot
 *   erode by accident.
 *
 * ★ SLOT 0 IS NOT ALLOCATED HERE. The premultiplied color/transmittance
 *   attachment the row asks for ALREADY EXISTS as the half-resolution march
 *   target (`ProceduralClouds Half-Res Target`, rgba16float, premultiplied RGB
 *   with alpha; transmittance is `1 - a`). Re-allocating it would double the
 *   cost of a target the topology only needed to NAME. It is in the table with
 *   `ownedHere: false` so the contract is complete and the byte accounting can
 *   still separate "what this row added" from "what the set costs".
 *
 * Everything in this module is pure: no device calls, no allocation on the
 * per-frame path, and every function is executable under `node --test`.
 *
 * @module WebGPUCloudReconstructionAttachments
 */

/** Slot indices into {@link CLOUD_RECONSTRUCTION_ATTACHMENTS}. ADD-ONLY. */
export const CloudAttachmentSlot = Object.freeze({
  /** Premultiplied color + alpha. The EXISTING half-res march target. */
  COLOR: 0,
  /** Front (nearest) and transmittance-weighted cloud distance, metres. */
  DEPTH: 1,
  /** Screen-space motion, reprojection validity, previous anchor distance. */
  VELOCITY: 2,
  /** First and second raw moments of normalized depth and of coverage. */
  MOMENTS: 3,
});

/**
 * One reconstruction attachment's immutable contract.
 *
 * `key` is a stable identity: it appears in GPU object labels, in the debug
 * snapshot, and in the spec. Renaming one is a breaking change to the evidence
 * trail, so the table is ADD-ONLY in the same sense as `ShaderDefine`.
 */
export interface CloudAttachmentSpec {
  /**
   * Index into the CONTRACT table. Owned attachments map to the producer's
   * MRT `@location(slot - 1)` because slot 0 is the shared march target and is
   * not an attachment of the producer pass.
   */
  readonly slot: number;
  /** Stable identity used in labels, statistics, and specs. */
  readonly key: string;
  /** GPU texture format. */
  readonly format: GPUTextureFormat;
  /** Bytes one texel occupies in `format`. */
  readonly bytesPerTexel: number;
  /** Human-readable channel semantics, published in the debug snapshot. */
  readonly channels: string;
  /**
   * False for slot 0: the half-resolution march target already exists and is
   * owned by the march, not by this row.
   */
  readonly ownedHere: boolean;
  /** Render-pass label of the pass that writes it. */
  readonly producer: string;
  /** Campaign rows that will READ it. Empty means "nothing consumes it yet". */
  readonly consumers: readonly string[];
  /**
   * Value the producer pass CLEARS this attachment to. Per-attachment because
   * one shared clear cannot be right for all of them: `-1` is the depth
   * channels' "this ray carries no cloud" sentinel, while a negative first
   * moment or a negative motion vector would be read as data. A texel the
   * full-screen triangle somehow misses must read as "no cloud, no motion, no
   * variance" rather than as the previous generation's contents.
   */
  readonly clearValue: GPUColorDict;
}

/**
 * The attachment set, in slot order.
 *
 * FORMAT RATIONALE, because each one was a decision rather than a default:
 *
 *   DEPTH is `rg32float`, not `rg16float`. Distances are metres on a planet:
 *   half-float carries an 11-bit mantissa, so at 100 km the quantum is ~50 m
 *   and at 1000 km it is ~500 m — larger than a cloud deck is thick. A depth
 *   attachment whose quantization exceeds the feature it separates cannot
 *   reject a disocclusion, which is the whole reason C13-12 wants it.
 *   `rg32float` is renderable in core WebGPU but NOT filterable without the
 *   optional `float32-filterable` feature, so consumers must read it with
 *   `textureLoad`, never a linear sampler.
 *
 *   VELOCITY is `rgba16float` rather than a bare `rg`. A two-channel motion
 *   vector cannot distinguish "did not move" from "could not be reprojected",
 *   and C13-12's rejection logic turns on exactly that difference. B carries
 *   the validity flag and A the normalized previous-frame anchor distance, so
 *   a consumer gets motion, trust, and the depth to compare against from one
 *   fetch.
 *
 *   MOMENTS is `rgba16float` over NORMALIZED quantities. Raw metre-squared
 *   moments overflow half-float at ~255 m; both pairs here are in [0,1]
 *   (depth divided by the resolved far cap, and coverage), so the format is
 *   exact enough to recover a variance and small enough to stay cheap.
 */
export const CLOUD_RECONSTRUCTION_ATTACHMENTS: readonly CloudAttachmentSpec[] =
  Object.freeze([
    Object.freeze({
      slot: CloudAttachmentSlot.COLOR,
      key: "color",
      format: "rgba16float" as GPUTextureFormat,
      bytesPerTexel: 8,
      channels:
        "RGB = premultiplied cloud radiance, A = alpha (transmittance = 1 - A)",
      ownedHere: false,
      producer: "ProceduralClouds half-res pass",
      consumers: Object.freeze([
        "CloudTemporalResolve pass",
        "CloudUpscale composite pass",
      ]),
      clearValue: Object.freeze({ r: 0, g: 0, b: 0, a: 0 }),
    }),
    Object.freeze({
      slot: CloudAttachmentSlot.DEPTH,
      key: "depth",
      format: "rg32float" as GPUTextureFormat,
      bytesPerTexel: 8,
      channels:
        "R = front (nearest) cloud distance in metres, G = transmittance-weighted mean distance in metres; both -1 when the ray carries no cloud",
      ownedHere: true,
      producer: "CloudReconstructionAttachments pass",
      consumers: Object.freeze([]),
      // Both channels are metres, and -1 is the "no cloud on this ray"
      // sentinel every consumer must propagate rather than read as zero.
      clearValue: Object.freeze({ r: -1, g: -1, b: 0, a: 0 }),
    }),
    Object.freeze({
      slot: CloudAttachmentSlot.VELOCITY,
      key: "velocity",
      format: "rgba16float" as GPUTextureFormat,
      bytesPerTexel: 8,
      channels:
        "RG = current UV minus reprojected previous UV, B = reprojection validity (1 or 0), A = previous anchor distance normalized by the far cap",
      ownedHere: true,
      producer: "CloudReconstructionAttachments pass",
      consumers: Object.freeze([]),
      // Zero motion with validity (B) zero reads as "could not be
      // reprojected", which is exactly what an unwritten texel means.
      clearValue: Object.freeze({ r: 0, g: 0, b: 0, a: 0 }),
    }),
    Object.freeze({
      slot: CloudAttachmentSlot.MOMENTS,
      key: "moments",
      format: "rgba16float" as GPUTextureFormat,
      bytesPerTexel: 8,
      channels:
        "R = mean normalized depth, G = mean squared normalized depth, B = mean coverage, A = mean squared coverage (variance = G - R*R and A - B*B)",
      ownedHere: true,
      producer: "CloudReconstructionAttachments pass",
      consumers: Object.freeze([]),
      // All four are means of non-negative quantities; zero is both the
      // correct empty value and a zero variance.
      clearValue: Object.freeze({ r: 0, g: 0, b: 0, a: 0 }),
    }),
  ]);

/** Attachments this row allocates, in MRT `@location` order. */
export const CLOUD_OWNED_ATTACHMENTS: readonly CloudAttachmentSpec[] =
  Object.freeze(
    CLOUD_RECONSTRUCTION_ATTACHMENTS.filter((spec) => spec.ownedHere),
  );

/** Render-pass label of the producer. Registered in the observability table. */
export const CLOUD_ATTACHMENT_PASS_LABEL =
  "CloudReconstructionAttachments pass";

/**
 * `AttachmentUniforms` float count — MUST equal the WGSL struct length in
 * `CloudReconstructionAttachments.wgsl`: previousVpRte(16) +
 * inverseCurrentVpRte(16) + six vec4 rows = 56. Fits the 256-byte minimum
 * uniform-buffer allocation without growing it.
 */
export const CLOUD_ATTACHMENT_UNIFORM_FLOATS = 56;

/** Byte size of the producer's uniform block. */
export const CLOUD_ATTACHMENT_UNIFORM_BYTES =
  CLOUD_ATTACHMENT_UNIFORM_FLOATS * 4;

/** Bytes ONE attachment occupies at the given size. */
export function cloudAttachmentBytes(
  spec: CloudAttachmentSpec,
  width: number,
  height: number,
): number {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  return w * h * spec.bytesPerTexel;
}

/**
 * Bytes the attachments THIS ROW ALLOCATES occupy at the given size. The
 * pre-existing color target is excluded on purpose: it is not new cost, and
 * reporting it as such would overstate what the row added.
 */
export function cloudOwnedAttachmentBytes(
  width: number,
  height: number,
): number {
  let total = 0;
  for (let i = 0; i < CLOUD_OWNED_ATTACHMENTS.length; i++) {
    total += cloudAttachmentBytes(CLOUD_OWNED_ATTACHMENTS[i], width, height);
  }
  return total;
}

/** Bytes the WHOLE contract occupies, including the shared color target. */
export function cloudAttachmentSetBytes(width: number, height: number): number {
  let total = 0;
  for (let i = 0; i < CLOUD_RECONSTRUCTION_ATTACHMENTS.length; i++) {
    total += cloudAttachmentBytes(
      CLOUD_RECONSTRUCTION_ATTACHMENTS[i],
      width,
      height,
    );
  }
  return total;
}

/**
 * Generation record for the owned attachment set.
 *
 * `generation` starts at 0 meaning "nothing allocated" and increments on every
 * (re)allocation. C13-40 will key retained bind groups on it; until then it is
 * what makes a resize or a device swap OBSERVABLE rather than silent. It is
 * never reset to a previously used value, so a bind group captured under
 * generation N can never be mistaken for one built under a later N.
 *
 * `deviceKey` is the owning `GPUDevice`, held as an opaque object so this
 * module stays device-free and node-testable. Identity comparison is the whole
 * contract: a new device after loss is a new key, which forces reallocation
 * even if the size is unchanged.
 */
export interface CloudAttachmentGeneration {
  generation: number;
  width: number;
  height: number;
  deviceKey: object | null;
  /** Owned bytes resident under the current generation; 0 when unallocated. */
  liveBytes: number;
}

/** Allocate the generation record. Called once per cloud cache. */
export function createCloudAttachmentGeneration(): CloudAttachmentGeneration {
  return {
    generation: 0,
    width: 0,
    height: 0,
    deviceKey: null,
    liveBytes: 0,
  };
}

/**
 * True when the owned attachments must be (re)created before this frame's
 * producer pass can run.
 *
 * A non-positive size is treated as "needs allocation" so the caller's own
 * guard is the one that decides to skip, rather than this predicate silently
 * certifying a zero-sized set as current.
 */
export function cloudAttachmentsNeedAllocation(
  state: CloudAttachmentGeneration,
  width: number,
  height: number,
  deviceKey: object,
): boolean {
  const w = Math.floor(width);
  const h = Math.floor(height);
  if (w <= 0 || h <= 0) {
    return true;
  }
  return (
    state.generation === 0 ||
    state.deviceKey !== deviceKey ||
    state.width !== w ||
    state.height !== h
  );
}

/**
 * Record a completed (re)allocation and return the NEW generation.
 *
 * Called only after every owned texture has actually been created, so a
 * partially built set never advertises itself as a complete generation.
 */
export function commitCloudAttachmentGeneration(
  state: CloudAttachmentGeneration,
  width: number,
  height: number,
  deviceKey: object,
): number {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  state.generation++;
  state.width = w;
  state.height = h;
  state.deviceKey = deviceKey;
  state.liveBytes = cloudOwnedAttachmentBytes(w, h);
  return state.generation;
}

/**
 * Return the record to "nothing allocated" WITHOUT rewinding the generation.
 *
 * Rewinding would let a retired bind group's key collide with a future one,
 * which is the precise failure C13-40's retirement work has to be able to rule
 * out. Release keeps the counter monotonic and only clears the resident facts.
 */
export function releaseCloudAttachmentGeneration(
  state: CloudAttachmentGeneration,
): void {
  state.width = 0;
  state.height = 0;
  state.deviceKey = null;
  state.liveBytes = 0;
}

/** True when `generation` still describes the resident set. */
export function cloudAttachmentGenerationIsCurrent(
  state: CloudAttachmentGeneration,
  generation: number,
): boolean {
  return (
    generation > 0 &&
    generation === state.generation &&
    state.deviceKey !== null &&
    state.width > 0 &&
    state.height > 0
  );
}

/**
 * Transmittance-weighted mean distance through ONE cloud interval, in metres.
 *
 * The march already resolved this pixel's alpha; this recovers the depth that
 * alpha implies rather than guessing the interval midpoint the way C13-05's
 * proxy does. Assume uniform extinction `s` over `[t0, t1]` with
 * `alpha = 1 - exp(-s * L)`, so the transmittance-weighted density along the
 * ray is the truncated exponential `s * exp(-s * (t - t0)) / alpha` and
 *
 *     E[t] = t0 + 1/s - L * (1 - alpha) / alpha.
 *
 * Two limits matter. As `alpha -> 0` the estimator tends to the interval
 * MIDPOINT — a uniformly thin interval has its mass in the middle — and that
 * one IS a branch, because the two terms both diverge like `span / alpha` and
 * their difference loses most of its significant digits below `alpha ~ 1e-4`.
 * The branch is CONTINUOUS with the formula at its threshold.
 *
 * As `alpha -> 1` the estimator tends toward `t0`, but only LOGARITHMICALLY:
 * at `alpha = 1 - 1e-4` it is still ~11% of the interval past the entry point.
 * There is therefore deliberately NO snap-to-`t0` branch — one would introduce
 * a discontinuity of a tenth of the deck thickness exactly where an opaque
 * cloud's depth is being handed to a reprojection. Instead the transmittance
 * is floored at {@link CLOUD_WEIGHTED_DEPTH_MIN_TRANSMITTANCE} so the
 * logarithm stays finite, and a fully opaque pixel reports a visible surface a
 * short way inside the deck, which is both continuous and closer to what an
 * opaque cloud actually looks like than the entry plane is.
 *
 * Returns `-1` for an empty interval so callers propagate "no cloud" rather
 * than a plausible-looking zero.
 *
 * ★ THIS IS AN ESTIMATOR, NOT AN ACCUMULATION. It is exact only for uniform
 *   extinction inside the interval. `C13-10` owns the march rewrite that emits
 *   the true per-sample transmittance-weighted depth; this is what the topology
 *   can produce WITHOUT touching `ProceduralClouds.wgsl`, and the WGSL producer
 *   mirrors it expression-for-expression.
 *
 * @param t0 Interval entry distance in metres.
 * @param t1 Interval exit distance in metres.
 * @param alpha Cloud alpha the march resolved for this pixel, in [0, 1].
 */
export function cloudTransmittanceWeightedDepth(
  t0: number,
  t1: number,
  alpha: number,
): number {
  const span = t1 - t0;
  if (!(span > 0.0)) {
    return -1.0;
  }
  const a = Math.min(Math.max(alpha, 0.0), 1.0);
  if (a <= CLOUD_WEIGHTED_DEPTH_MIN_ALPHA) {
    return t0 + 0.5 * span;
  }
  const oneMinusA = Math.max(1.0 - a, CLOUD_WEIGHTED_DEPTH_MIN_TRANSMITTANCE);
  const sigma = -Math.log(oneMinusA) / span;
  return t0 + 1.0 / sigma - (span * oneMinusA) / a;
}

/**
 * Alpha below which the two terms of the estimator both diverge like
 * `span / alpha` and their difference loses most of its significant digits.
 * The interval midpoint is the exact limit, and the branch is continuous with
 * the formula here to better than one part in ten thousand of the interval.
 */
export const CLOUD_WEIGHTED_DEPTH_MIN_ALPHA = 1.0e-4;

/**
 * Transmittance floor. `log(0)` is an indeterminate value in WGSL and `1 - a`
 * stops resolving in `f32` within about `6e-8` of one, so the floor keeps the
 * logarithm finite without introducing a branch.
 */
export const CLOUD_WEIGHTED_DEPTH_MIN_TRANSMITTANCE = 1.0e-6;

/**
 * Pack the producer's uniform block into a caller-owned `Float32Array`.
 *
 * Allocation-free by contract: the array is the cache's, `matrices` are the
 * ones `UniformState` already produced, and nothing here creates an object. The
 * layout is byte-locked to `AttachmentUniforms` in
 * `CloudReconstructionAttachments.wgsl`.
 *
 * @param out Destination, at least {@link CLOUD_ATTACHMENT_UNIFORM_FLOATS} long.
 * @param inputs Everything the frame already resolved.
 */
export function packCloudAttachmentUniforms(
  out: Float32Array,
  inputs: CloudAttachmentUniformInputs,
): void {
  out.fill(0.0);
  let o = 0;
  const previous = inputs.previousViewProjectionRelativeToEye;
  if (previous !== null && previous.length >= 16) {
    for (let i = 0; i < 16; i++) {
      out[o++] = previous[i];
    }
  } else {
    o += 16;
  }
  const inverseCurrent = inputs.inverseCurrentViewProjectionRelativeToEye;
  if (inverseCurrent !== null && inverseCurrent.length >= 16) {
    for (let i = 0; i < 16; i++) {
      out[o++] = inverseCurrent[i];
    }
  } else {
    o += 16;
  }
  // encodedCameraHighAndFarCap
  out[o++] = inputs.encodedCameraHighX;
  out[o++] = inputs.encodedCameraHighY;
  out[o++] = inputs.encodedCameraHighZ;
  out[o++] = inputs.depthNormalizationMeters;
  // encodedCameraLowAndHeight
  out[o++] = inputs.encodedCameraLowX;
  out[o++] = inputs.encodedCameraLowY;
  out[o++] = inputs.encodedCameraLowZ;
  out[o++] = inputs.cameraGeodeticHeight;
  // cameraDeltaAndWidth
  out[o++] = inputs.cameraDeltaX;
  out[o++] = inputs.cameraDeltaY;
  out[o++] = inputs.cameraDeltaZ;
  out[o++] = inputs.width;
  // primaryDeckAndResolutionY
  out[o++] = inputs.deckBottom;
  out[o++] = inputs.deckTop;
  out[o++] = inputs.height;
  out[o++] = inputs.reprojectionValid ? 1.0 : 0.0;
  // deckBoundsLowMid
  out[o++] = inputs.deckLowBottom;
  out[o++] = inputs.deckLowTop;
  out[o++] = inputs.deckMidBottom;
  out[o++] = inputs.deckMidTop;
  // deckBoundsHighAndFlags
  out[o++] = inputs.deckHighBottom;
  out[o++] = inputs.deckHighTop;
  out[o++] = inputs.multiDeck ? 1.0 : 0.0;
  out[o++] = inputs.generation;
}

/** Everything {@link packCloudAttachmentUniforms} writes. All pre-resolved. */
export interface CloudAttachmentUniformInputs {
  readonly previousViewProjectionRelativeToEye: ArrayLike<number> | null;
  readonly inverseCurrentViewProjectionRelativeToEye: ArrayLike<number> | null;
  readonly encodedCameraHighX: number;
  readonly encodedCameraHighY: number;
  readonly encodedCameraHighZ: number;
  readonly encodedCameraLowX: number;
  readonly encodedCameraLowY: number;
  readonly encodedCameraLowZ: number;
  readonly cameraGeodeticHeight: number;
  readonly cameraDeltaX: number;
  readonly cameraDeltaY: number;
  readonly cameraDeltaZ: number;
  /**
   * Metres the depth channels are divided by before they enter the moment
   * pair. The resolved far cap when one is configured; otherwise a fixed
   * planetary fallback, because dividing by zero would publish NaN moments.
   */
  readonly depthNormalizationMeters: number;
  readonly width: number;
  readonly height: number;
  readonly reprojectionValid: boolean;
  readonly deckBottom: number;
  readonly deckTop: number;
  readonly deckLowBottom: number;
  readonly deckLowTop: number;
  readonly deckMidBottom: number;
  readonly deckMidTop: number;
  readonly deckHighBottom: number;
  readonly deckHighTop: number;
  readonly multiDeck: boolean;
  readonly generation: number;
}

/**
 * Fallback for {@link CloudAttachmentUniformInputs.depthNormalizationMeters}
 * when no far cap is configured. Comfortably past the horizon distance from
 * orbit, so a normalized depth stays inside [0, 1] for any visible cloud.
 */
export const CLOUD_ATTACHMENT_DEFAULT_DEPTH_NORMALIZATION_METERS = 2.0e6;
