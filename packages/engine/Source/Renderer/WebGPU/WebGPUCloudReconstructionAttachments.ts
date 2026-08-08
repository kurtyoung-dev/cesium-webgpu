/// <reference types="@webgpu/types" />
/**
 * Cloud reconstruction attachment layout, lifetime, and generation.
 *
 * The cloud history is a colour-only half-resolution proxy, and
 * `CloudTemporalResolve.wgsl` says so itself: its `representativeShellDistance`
 * is a representative geometric proxy rather than physical cloud depth. One
 * mean depth per pixel cannot separate two overlapping volumes, cannot reject a
 * disoccluded history sample, and cannot tell a reprojection that crossed a
 * silhouette from one that did not. This module is the topology that fixes
 * that: the exact attachment set the reconstruction chain reads, its formats,
 * its byte cost, and the generation key that makes a stale bind group
 * impossible to serve.
 *
 * Current behaviour and current limits. Allocation, resize, device-swap
 * recreation, the generation key, the producer pass, and the byte and pass
 * counters are all wired. Two further pieces are wired but opt-in and default
 * off: the march-emitted depth, a compile-time variant described on
 * `CLOUD_EMITTED_ATTACHMENTS`, and the set's one consumer, the temporal
 * resolve, which reads depth, velocity and moments and validates history
 * against them. They are separate opt-ins, so a build can produce the set
 * without consuming it and the two halves stay independently testable.
 *
 * Absent: a current-frame phase covering one-sixteenth of the full-resolution
 * pixels, and a full-resolution history — the history below is still
 * half-resolution. Also absent is every thresholded consumer: attachment-aware
 * motion and depth rejection, variance clipping from the moment pair, reactive
 * history, wind advection, and disocclusion proper.
 *
 * WGSL register allocation is static, so anything added to the shared
 * `ProceduralClouds` module inflates every pipeline compiled from it, including
 * the shadow map, the cascade atlas and the god-ray mask, none of which want a
 * reconstruction attachment. The producer therefore lives in its own WGSL
 * module (`CloudReconstructionAttachments.wgsl`) and its own pipeline, and
 * re-derives the WGS84 shell intersection rather than importing it. That
 * duplication is what holds the march's register budget where it is;
 * `cloud-reconstruction-attachments.spec.mjs` pins `ProceduralClouds.wgsl` by
 * content hash so it cannot erode by accident.
 *
 * Slot 0 is not allocated here. The premultiplied colour and transmittance
 * attachment already exists as the half-resolution march target
 * (`ProceduralClouds Half-Res Target`, rgba16float, premultiplied RGB with
 * alpha, transmittance being `1 - a`), and re-allocating it would double the
 * cost of a target this topology only needs to name. It appears in the table
 * with `ownedHere: false`, so the contract is complete and the byte accounting
 * can still separate what this module added from what the whole set costs.
 *
 * Everything in this module is pure: no device calls, no allocation on the
 * per-frame path, and every function is executable under `node --test`.
 *
 * @module WebGPUCloudReconstructionAttachments
 */

/**
 * Slot indices into {@link CLOUD_RECONSTRUCTION_ATTACHMENTS}. Entries may be
 * added but never reordered or removed.
 */
export const CloudAttachmentSlot = Object.freeze({
  /**
   * Premultiplied color and alpha, carried by the existing half-resolution
   * march target.
   */
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
 * trail, so the table is add-only in the same sense as `ShaderDefine`.
 */
export interface CloudAttachmentSpec {
  /**
   * Index into the contract table. Owned attachments map to the producer's
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
  /** Render-pass label of the pass that writes it on the default path. */
  readonly producer: string;
  /**
   * Render-pass label of the pass that writes it when
   * `ShaderDefineHi.CLOUD_MARCH_EMIT_RECONSTRUCTION` is compiled, when that
   * differs from {@link producer}. Present only on the depth slot, whose
   * ownership moves to the march under that variant; absent everywhere else,
   * because an absent field is a stronger statement than a duplicated one.
   */
  readonly variantProducer?: string;
  /**
   * Render-pass labels that read it. An empty list means nothing consumes it
   * yet.
   */
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
 * Each format is a decision rather than a default:
 *
 *   Depth is `rg32float`, not `rg16float`. Distances are metres on a planet:
 *   half-float carries an 11-bit mantissa, so at 100 km the quantum is ~50 m
 *   and at 1000 km it is ~500 m — larger than a cloud deck is thick. A depth
 *   attachment whose quantization exceeds the feature it separates cannot
 *   reject a disocclusion, which is the whole reason a rejection test needs
 *   it. `rg32float` is renderable in core WebGPU but not filterable without
 *   the optional `float32-filterable` feature, so consumers must read it with
 *   `textureLoad`, never a linear sampler.
 *
 *   Velocity is `rgba16float` rather than a bare `rg`. A two-channel motion
 *   vector cannot distinguish "did not move" from "could not be reprojected",
 *   and the rejection logic turns on exactly that difference. B carries the
 *   validity flag and A the normalized previous-frame anchor distance, so a
 *   consumer gets motion, trust, and the depth to compare against from one
 *   fetch.
 *
 *   Moments is `rgba16float` over normalized quantities. Raw metre-squared
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
      // Under the emission variant the march writes this slot as a second
      // colour target and the producer reads it instead.
      variantProducer: "ProceduralClouds half-res pass",
      consumers: Object.freeze(["CloudTemporalResolve pass"]),
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
      consumers: Object.freeze(["CloudTemporalResolve pass"]),
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
      consumers: Object.freeze(["CloudTemporalResolve pass"]),
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
 * `AttachmentUniforms` float count. It has to equal the WGSL struct length in
 * `CloudReconstructionAttachments.wgsl`: previousVpRte(16) +
 * inverseCurrentVpRte(16) + six vec4 rows = 56. Fits the 256-byte minimum
 * uniform-buffer allocation without growing it.
 */
export const CLOUD_ATTACHMENT_UNIFORM_FLOATS = 56;

/** Byte size of the producer's uniform block. */
export const CLOUD_ATTACHMENT_UNIFORM_BYTES =
  CLOUD_ATTACHMENT_UNIFORM_FLOATS * 4;

/** Bytes a single attachment occupies at the given size. */
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
 * Bytes the attachments this module allocates occupy at the given size. The
 * pre-existing color target is excluded: it is not new cost, and reporting it
 * as such would overstate what the reconstruction set adds.
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

/** Bytes the entire contract occupies, including the shared color target. */
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
 * `generation` starts at 0, meaning nothing is allocated, and increments on
 * every (re)allocation, which is what makes a resize or a device swap
 * observable rather than silent. It is never reset to a previously used value,
 * so a bind group captured under generation N can never be mistaken for one
 * built under a later N — a property retained bind groups are meant to key on.
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
 * Return the record to "nothing allocated" without rewinding the generation.
 *
 * Rewinding would let a retired bind group's key collide with a later one, so
 * release keeps the counter monotonic and clears only the resident facts.
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
 * Transmittance-weighted mean distance through a single cloud interval, in
 * metres.
 *
 * The march already resolved this pixel's alpha; this recovers the depth that
 * alpha implies rather than guessing the interval midpoint the way the
 * colour-only history proxy does. Assume uniform extinction `s` over
 * `[t0, t1]` with `alpha = 1 - exp(-s * L)`, so the transmittance-weighted
 * density along the ray is the truncated exponential
 * `s * exp(-s * (t - t0)) / alpha` and
 *
 *     E[t] = t0 + 1/s - L * (1 - alpha) / alpha.
 *
 * Two limits matter. As `alpha -> 0` the estimator tends to the interval
 * midpoint — a uniformly thin interval has its mass in the middle — and that
 * limit is a branch, because the two terms both diverge like `span / alpha`
 * and their difference loses most of its significant digits below
 * `alpha ~ 1e-4`. The branch is continuous with the formula at its threshold.
 *
 * As `alpha -> 1` the estimator tends toward `t0`, but only logarithmically:
 * at `alpha = 1 - 1e-4` it is still ~11% of the interval past the entry point.
 * There is therefore no snap-to-`t0` branch — one would introduce a
 * discontinuity of a tenth of the deck thickness exactly where an opaque
 * cloud's depth is handed to a reprojection. Instead the transmittance is
 * floored at {@link CLOUD_WEIGHTED_DEPTH_MIN_TRANSMITTANCE} so the logarithm
 * stays finite, and a fully opaque pixel reports a visible surface a short way
 * inside the deck, which is both continuous and closer to what an opaque cloud
 * looks like than the entry plane is.
 *
 * Returns `-1` for an empty interval so callers propagate "no cloud" rather
 * than a plausible-looking zero.
 *
 * This is an estimator, not an accumulation, and is exact only for uniform
 * extinction inside the interval. It is nonetheless the default rather than a
 * deprecated path: it is the only depth available to a build that does not
 * compile the emitting march, it is the `//>>else` branch of that variant, and
 * it is the reference the accumulation is checked against. The accumulation
 * itself is {@link cloudMarchWeightedDepth}. The WGSL producer mirrors this
 * expression for expression.
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

/**
 * Attachments the producer pass writes when the march emits the depth slot.
 *
 * The estimator above answers what depth a given alpha implies over a given
 * geometric interval. The functions below answer what depth the march actually
 * integrated, which the estimator cannot reach without changing the march.
 * They are the CPU twins of the `CLOUD_MARCH_EMIT_RECONSTRUCTION` variant, and
 * they sit beside the estimator in the same pure module so the two can be read
 * side by side and `node --test` can execute both without a device.
 *
 * Ownership moves under the variant rather than duplicating: when it is
 * compiled the march writes contract slot 1 (`depth`) as a second colour
 * target and the producer pass reads it, because a render pass cannot sample
 * an attachment it also writes. Slot 1 is therefore absent from this list,
 * which is derived from {@link CLOUD_OWNED_ATTACHMENTS} rather than restated,
 * so adding an owned attachment updates both at once.
 */
export const CLOUD_EMITTED_ATTACHMENTS: readonly CloudAttachmentSpec[] =
  Object.freeze(
    CLOUD_OWNED_ATTACHMENTS.filter(
      (spec) => spec.slot !== CloudAttachmentSlot.DEPTH,
    ),
  );

/**
 * Slot the march writes directly under the emission variant. Named rather than
 * spelled `1` at the three call sites that need it.
 */
export const CLOUD_MARCH_EMITTED_SLOT = CloudAttachmentSlot.DEPTH;

/**
 * Alpha floor for the emission division, mirroring `CLOUD_EMIT_MIN_ALPHA` in
 * `ProceduralClouds.wgsl`.
 *
 * It is far below any alpha that can reach the division: a deck only records a
 * front distance after a sample with `density > 0.001` contributed, and the
 * march's own early-out stops at `transmittance < 0.01`. It exists so that a
 * deck which recorded a front distance and then had every weight cancel in
 * `f32` cannot publish a NaN into an attachment a consumer trusts.
 */
export const CLOUD_EMIT_MIN_ALPHA = 1.0e-6;

/**
 * rgba16float's relative quantum near 1 (`2^-10`), mirroring
 * `CLOUD_MOMENT_F16_QUANTUM` in `CloudTemporalResolve.wgsl`.
 *
 * This is a storage tolerance, not a quality threshold. The moment attachment
 * stores `E[x]` and `E[x²]` as independent half-floats, so a record from a real
 * distribution can violate `E[x²] >= E[x]²` by about this much through rounding
 * alone. Moving it changes what counts as a self-consistent record and nothing
 * else — no cloud, no blend weight, no rejection policy depends on its value.
 */
export const CLOUD_MOMENT_F16_QUANTUM = 0.0009765625;

/**
 * Transmittance-weighted mean distance the march accumulated, in metres.
 *
 * `weightedDistanceSum` is `Σ wᵢ·tᵢ` over the march's own per-sample weights
 * `wᵢ = (1 - exp(-σᵢ·Δᵢ))·Tᵢ` — the identical weights its radiance accumulation
 * uses — and `Σ wᵢ = alpha` by construction, so the mean is the plain quotient.
 * Nothing is assumed about how the extinction varies inside the interval, which
 * is the single respect in which this is strictly better than
 * {@link cloudTransmittanceWeightedDepth}: that estimator is exact only for
 * uniform extinction, and a cloud is the opposite of uniform.
 *
 * Returns `-1` when the ray carried no cloud, so the sentinel propagates
 * exactly as it does everywhere else in the contract.
 *
 * @param frontDistance Nearest contributing sample distance, or a negative
 *   value when the deck contributed nothing.
 * @param weightedDistanceSum `Σ wᵢ·tᵢ` in metres.
 * @param alpha The deck's resolved alpha (`Σ wᵢ`).
 */
export function cloudMarchWeightedDepth(
  frontDistance: number,
  weightedDistanceSum: number,
  alpha: number,
): number {
  if (frontDistance < 0.0 || alpha <= 0.0) {
    return -1.0;
  }
  return weightedDistanceSum / Math.max(alpha, CLOUD_EMIT_MIN_ALPHA);
}

/** One deck's emission, as `marchDeck` returns it under the variant. */
export interface CloudDeckEmission {
  /** Nearest contributing sample distance in metres; negative when empty. */
  readonly frontDistance: number;
  /** `Σ wᵢ·tᵢ` over the deck's own transmittance weights, metres. */
  readonly weightedDistanceSum: number;
  /** The deck's resolved alpha. */
  readonly alpha: number;
}

/**
 * Compose the multi-deck front / weighted pair the way `fragmentMain` does.
 *
 * Two things here are decisions rather than bookkeeping:
 *
 *   The front is a minimum, not the first deck. The composite is ordered by
 *   `|cameraAltitude - deckMidAltitude|`, a vertical-band key that is not ray
 *   order for an oblique view — a high deck can be entered before a low one.
 *   Taking the first deck's front would hand a disocclusion test the wrong
 *   surface in exactly the multi-deck case the attachment set exists to serve.
 *
 *   The weighted mean composes exactly. Deck `k` enters the composite with
 *   weight `transₖ` (the running transmittance in front of it) and its own
 *   weights sum to `alphaₖ`, so `Σₖ transₖ·Σᵢwₖᵢtₖᵢ` divided by
 *   `Σₖ transₖ·alphaₖ` — which is the composited alpha — is the
 *   transmittance-weighted mean over the whole stack. No renormalization
 *   fudge is needed and none is applied.
 *
 * Decks are consumed in composite order and an empty deck (alpha <= 0) is
 * skipped exactly as the shader's `continue` skips it. The opaque early-out
 * (`trans < 0.005`) is applied here too, so the twin stops where the shader
 * stops rather than integrating decks the GPU never marched.
 *
 * @param decks Per-deck emissions in front-to-back composite order.
 */
export function cloudCompositeMarchDepth(decks: readonly CloudDeckEmission[]): {
  front: number;
  weighted: number;
  alpha: number;
} {
  let front = -1.0;
  let weightedSum = 0.0;
  let accAlpha = 0.0;
  let trans = 1.0;
  for (let k = 0; k < decks.length; k++) {
    if (trans < 0.005) {
      break;
    }
    const deck = decks[k];
    if (deck.alpha <= 0.0) {
      continue;
    }
    if (
      deck.frontDistance >= 0.0 &&
      (front < 0.0 || deck.frontDistance < front)
    ) {
      front = deck.frontDistance;
    }
    weightedSum += trans * deck.weightedDistanceSum;
    accAlpha += trans * deck.alpha;
    trans *= 1.0 - deck.alpha;
  }
  if (front < 0.0 || accAlpha <= 0.0) {
    return { front: -1.0, weighted: -1.0, alpha: accAlpha };
  }
  return {
    front: front,
    weighted: weightedSum / Math.max(accAlpha, CLOUD_EMIT_MIN_ALPHA),
    alpha: accAlpha,
  };
}

/**
 * Why the temporal resolve refused to reuse history for one texel.
 *
 * The order is part of the contract: the WGSL tests these in exactly this
 * sequence and returns on the first hit, so a twin that reordered them would
 * agree on "rejected" while disagreeing on the reason — and the reason is what
 * the counters publish. Entries may be added but never reordered or removed.
 */
export const CloudHistoryRejection = Object.freeze({
  /** History is usable; the resolve proceeds to the clamp + blend. */
  NONE: 0,
  /** A moment record that no distribution could have produced. */
  MALFORMED_MOMENTS: 1,
  /** Every texel in the producer's 3x3 was empty — the early-out. */
  EMPTY_NEIGHBOURHOOD: 2,
  /** The producer marked the reprojection unusable (velocity B = 0). */
  PRODUCER_INVALID: 3,
  /** The depth attachment carries the no-cloud sentinel. */
  NO_CLOUD_ANCHOR: 4,
  /** The motion vector lands outside the previous frame. */
  OFF_SCREEN: 5,
});

/** One texel's attachment record, as the resolve reads it. */
export interface CloudReconstructionTexel {
  /** moments.r — mean normalized depth. */
  readonly depthMean: number;
  /** moments.g — mean squared normalized depth. */
  readonly depthSecondMoment: number;
  /** moments.b — mean coverage. */
  readonly coverageMean: number;
  /** moments.a — mean squared coverage. */
  readonly coverageSecondMoment: number;
  /** velocity.r/g — current UV minus reprojected previous UV. */
  readonly motionU: number;
  readonly motionV: number;
  /** velocity.b — the producer's reprojection validity (1 or 0). */
  readonly reprojectionValidity: number;
  /** depth.g — transmittance-weighted mean distance, metres; -1 = no cloud. */
  readonly weightedDepth: number;
  /** This texel's UV. */
  readonly u: number;
  readonly v: number;
}

/**
 * CPU twin of the `CLOUD_RECONSTRUCTION_CONSUME` validity gate in
 * `CloudTemporalResolve.wgsl`.
 *
 * The boundary of this function is that it contains no tuned number. The
 * policies that would belong elsewhere — attachment-aware motion and depth
 * rejection, variance clipping, reactive history, wind advection in
 * reprojection, disocclusion — each need one: a depth-delta bound, a clip
 * width in sigmas, a reactivity ramp. What is returned here is only facts the
 * producer already recorded ({@link CloudHistoryRejection.PRODUCER_INVALID},
 * {@link CloudHistoryRejection.NO_CLOUD_ANCHOR},
 * {@link CloudHistoryRejection.OFF_SCREEN}), one internal-consistency
 * requirement whose only constant is the storage format's own quantum, and one
 * early-out that is exactly output-equivalent to running the full path.
 *
 * @returns A {@link CloudHistoryRejection} value.
 */
export function classifyCloudReconstructionHistory(
  texel: CloudReconstructionTexel,
): number {
  const depthVariance =
    texel.depthSecondMoment - texel.depthMean * texel.depthMean;
  const coverageVariance =
    texel.coverageSecondMoment - texel.coverageMean * texel.coverageMean;
  if (
    depthVariance < -CLOUD_MOMENT_F16_QUANTUM ||
    coverageVariance < -CLOUD_MOMENT_F16_QUANTUM
  ) {
    return CloudHistoryRejection.MALFORMED_MOMENTS;
  }
  if (
    texel.coverageMean <= 0.0 &&
    coverageVariance <= CLOUD_MOMENT_F16_QUANTUM
  ) {
    return CloudHistoryRejection.EMPTY_NEIGHBOURHOOD;
  }
  if (texel.reprojectionValidity < 0.5) {
    return CloudHistoryRejection.PRODUCER_INVALID;
  }
  if (texel.weightedDepth < 0.0) {
    return CloudHistoryRejection.NO_CLOUD_ANCHOR;
  }
  const previousU = texel.u - texel.motionU;
  const previousV = texel.v - texel.motionV;
  if (
    previousU < 0.0 ||
    previousU > 1.0 ||
    previousV < 0.0 ||
    previousV > 1.0
  ) {
    return CloudHistoryRejection.OFF_SCREEN;
  }
  return CloudHistoryRejection.NONE;
}
