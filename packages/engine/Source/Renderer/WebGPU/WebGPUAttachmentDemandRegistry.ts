/**
 * C9-09-ATTACHMENT-DEMAND-REGISTRY (`FAR-401-C0`).
 *
 * ONE canonical, pre-pass, per-frame attachment-demand record describing
 * every enabled attachment consumer. It is computed once per frame per
 * context (in `WebGPUContext.updateAndClearFramebuffers`, before any scene
 * pass opens or any pipeline builds) and is then immutable for the rest of
 * the frame. Both the *legacy executor* (the three scene-pass-open sites,
 * the G-buffer allocation site, the `makeSceneFBTargets` pipeline builders)
 * and the *future FAR-400/401 render graph* (Wave-6 T1) are meant to read
 * this same record so exactly one authority decides the frame's scene-FB
 * attachment topology.
 *
 * SCOPE (C9-09): registry + wiring + truthful reporting ONLY. This slice
 * changes NO topology — `computeAttachmentDemand` is a pure function that is
 * *recorded* on the context and surfaced through the debug snapshot, but
 * nothing in the render path yet gates on it. The default force switch keeps
 * the frame in the historical full-MRT topology (`forceSceneMRT` defaults
 * `true`), so the reported `topology` is `"mrt"` on every frame today,
 * matching the always-MRT executor. C9-10 (`FAR-403-C0`) is the slice that
 * acts on `gbufferDemanded` to drop the G-buffer when no consumer needs it.
 *
 * CONSERVATIVE-DEMAND CONTRACT (campaign 9 rule 3 / plan invariant 2): any
 * consumer that cannot be confidently enumerated must be treated as
 * demanding the complete topology. The `forceSceneMRT` escape hatch and the
 * OR-of-readers rule below are how that is honored — a reader we are unsure
 * about is added to the OR (demands MRT), never dropped.
 *
 * PURITY: `computeAttachmentDemand` reads only plain scene flags plus the
 * caller-supplied force switch. It holds NO GPU handles and NO caches, so
 * device loss/recovery is trivially safe (the record is recomputed next
 * frame from scene state).
 */

/**
 * The subset of scene state the demand record reads. Declared structurally
 * (not `any`) because `Scene` is a JS module outside the `.ts` boundary; the
 * fields below are all real, verified `Scene.js` members.
 */
export interface AttachmentDemandSceneLike {
  /** Screen-space reflections consumer — reads eye-space normals. */
  _enableSSR?: boolean;
  /** NPR outline consumer — reads eye-space normals. */
  _enableNPROutlines?: boolean;
  /** Contact-shadow consumer — reads eye-space normals. */
  _enableContactShadows?: boolean;
  /**
   * Deferred-lighting master. Mirrors `frameState.useDeferredLighting =
   * (scene.deferredLighting === true)` (`Scene.js` prepareFrame). Drives the
   * AO / SSGI / debug-overlay G-buffer feed.
   */
  deferredLighting?: boolean;
  /** G-buffer normal debug overlay (`CesiumDebug.showGBufferNormals`). */
  debugShowGBufferNormals?: boolean;
  /** TAA — uses the separate rg16float velocity target, NOT this G-buffer. */
  taaEnabled?: boolean;
  /** Order-independent translucency request (contained off by default). */
  _useOIT?: boolean;
  /** Edge-visibility MRT feature. */
  _enableEdgeVisibility?: boolean;
  /** Post-process stage collection — AO/SSGI live under `.ambientOcclusion`. */
  postProcessStages?: {
    ambientOcclusion?: { enabled?: boolean };
  };
}

/**
 * G-buffer reader breakdown. Each boolean is one enumerated consumer of the
 * scene-FB slot-1 `rgba16float` normal-roughness attachment.
 */
export interface AttachmentGBufferReaders {
  ssr: boolean;
  nprOutlines: boolean;
  contactShadows: boolean;
  deferredLighting: boolean;
  /**
   * SSGI feed. On WebGPU the AO/SSGI stage only reads G-buffer normals when
   * deferred lighting is also on (`WebGPUSceneRenderer` AO feed gate), so
   * this is reported as `ambientOcclusion.enabled && deferredLighting`. Its
   * demand is already subsumed by `deferredLighting` in the OR; it is broken
   * out for observability and for the C9-10 precise-variant work.
   */
  ssgi: boolean;
  /** G-buffer normal debug overlay. */
  debugOverlay: boolean;
}

/**
 * Observe-only record of the OTHER attachment families a frame uses. C9-09's
 * acceptance requires the record to "cover every attachment consumer"; only
 * the G-buffer family is *acted on* (in C9-10). These are recorded for the
 * future graph and for truthful reporting — none of them gate anything here.
 */
export interface AttachmentOtherFamilies {
  /** rg16float velocity target (TAA). */
  velocityTarget: boolean;
  /** OIT accum/reveal framebuffer request (FAR-003-contained off by default). */
  oitRequested: boolean;
  /** Edge-visibility MRT. */
  edgeMrt: boolean;
  /** Globe-depth sampleable copy (on for every non-pick render frame). */
  globeDepth: boolean;
  /** Pick mini-frame (single-target `pickPipelineFormat` by construction). */
  picking: boolean;
  /** Post-process composite active (WebGPU always composites off-screen). */
  postProcess: boolean;
}

/**
 * The canonical per-frame demand record. Plain data — safe to freeze on the
 * context and hand to both executors.
 */
export interface AttachmentDemandRecord {
  /** Per-reader G-buffer demand breakdown. */
  gbufferReaders: AttachmentGBufferReaders;
  /** Compact bitmask of `gbufferReaders` (bit order matches the field list). */
  gbufferReadersMask: number;
  /** OR of every enumerated reader — the TRUE consumer demand, before force. */
  gbufferReadersDemand: boolean;
  /** Force switch (conservative default `true` until the Gate-B flip). */
  forceSceneMRT: boolean;
  /** `gbufferReadersDemand || forceSceneMRT` — what the topology follows. */
  gbufferDemanded: boolean;
  /** Effective scene-FB color topology this frame. */
  topology: "mrt" | "one-target";
  /** Observe-only record of the other attachment families. */
  other: AttachmentOtherFamilies;
}

/** Bit positions for `gbufferReadersMask` (add-only; do not renumber). */
export const GBUFFER_READER_BITS = {
  SSR: 1 << 0,
  NPR_OUTLINES: 1 << 1,
  CONTACT_SHADOWS: 1 << 2,
  DEFERRED_LIGHTING: 1 << 3,
  SSGI: 1 << 4,
  DEBUG_OVERLAY: 1 << 5,
} as const;

/**
 * Options controlling the pure demand computation.
 */
export interface ComputeAttachmentDemandOptions {
  /**
   * When `true` (the conservative default until the C9-10 Gate-B decision
   * clears), the frame is forced to full-MRT topology regardless of reader
   * demand — preserving today's exact behavior. Any consumer that cannot be
   * enumerated is covered by keeping this `true`.
   */
  forceSceneMRT: boolean;
  /** True when the frame is a pick/pickVoxel mini-frame. */
  picking?: boolean;
  /** True when a globe-depth sampleable copy is produced this frame. */
  globeDepth?: boolean;
  /** True when the post-process composite runs this frame. */
  postProcess?: boolean;
}

/**
 * Compute the canonical attachment-demand record for one frame. Pure: no side
 * effects, no GPU handles, deterministic in its inputs.
 *
 * @param scene - The scene-like state carrier (real `Scene` at runtime).
 * @param options - Force switch + per-frame pass context.
 * @returns The frozen-able demand record.
 */
export function computeAttachmentDemand(
  scene: AttachmentDemandSceneLike,
  options: ComputeAttachmentDemandOptions,
): AttachmentDemandRecord {
  const ssr = scene._enableSSR === true;
  const nprOutlines = scene._enableNPROutlines === true;
  const contactShadows = scene._enableContactShadows === true;
  const deferredLighting = scene.deferredLighting === true;
  const debugOverlay = scene.debugShowGBufferNormals === true;
  const aoEnabled = scene.postProcessStages?.ambientOcclusion?.enabled === true;
  // SSGI only feeds the G-buffer when deferred lighting is also on (the
  // WebGPU AO feed gate). Recorded for observability; demand is subsumed by
  // `deferredLighting` in the OR below.
  const ssgi = aoEnabled && deferredLighting;

  const gbufferReaders: AttachmentGBufferReaders = {
    ssr,
    nprOutlines,
    contactShadows,
    deferredLighting,
    ssgi,
    debugOverlay,
  };

  let gbufferReadersMask = 0;
  if (ssr) gbufferReadersMask |= GBUFFER_READER_BITS.SSR;
  if (nprOutlines) gbufferReadersMask |= GBUFFER_READER_BITS.NPR_OUTLINES;
  if (contactShadows) gbufferReadersMask |= GBUFFER_READER_BITS.CONTACT_SHADOWS;
  if (deferredLighting)
    gbufferReadersMask |= GBUFFER_READER_BITS.DEFERRED_LIGHTING;
  if (ssgi) gbufferReadersMask |= GBUFFER_READER_BITS.SSGI;
  if (debugOverlay) gbufferReadersMask |= GBUFFER_READER_BITS.DEBUG_OVERLAY;

  const gbufferReadersDemand =
    ssr ||
    nprOutlines ||
    contactShadows ||
    deferredLighting ||
    ssgi ||
    debugOverlay;

  const forceSceneMRT = options.forceSceneMRT === true;
  const gbufferDemanded = gbufferReadersDemand || forceSceneMRT;

  const other: AttachmentOtherFamilies = {
    velocityTarget: scene.taaEnabled === true,
    oitRequested: scene._useOIT === true,
    edgeMrt: scene._enableEdgeVisibility === true,
    globeDepth: options.globeDepth === true,
    picking: options.picking === true,
    postProcess: options.postProcess === true,
  };

  return {
    gbufferReaders,
    gbufferReadersMask,
    gbufferReadersDemand,
    forceSceneMRT,
    gbufferDemanded,
    topology: gbufferDemanded ? "mrt" : "one-target",
    other,
  };
}
