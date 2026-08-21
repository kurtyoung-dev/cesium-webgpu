/**
 * Canonical pre-pass attachment demand for a WebGPU frame.
 *
 * The record describes every enabled attachment consumer. It is computed
 * once per frame and context in
 * `WebGPUContext.updateAndClearFramebuffers`, before any scene pass opens or
 * pipeline builds, and remains immutable for the rest of the frame. The
 * current executor's scene-pass open sites, G-buffer allocation, and
 * `makeSceneFBTargets` pipeline builders share this authority. The same data
 * contract can also feed a render graph without introducing a second source
 * of attachment-topology decisions.
 *
 * This record is currently observational: `computeAttachmentDemand` publishes
 * it on the context and through the debug snapshot, while the render path
 * continues to use the full-MRT topology. `forceSceneMRT` therefore defaults
 * to `true`, making the reported topology match the executor. A demand-driven
 * executor can use `gbufferDemanded` to omit the G-buffer only after every
 * pipeline and pass-open site is topology-aware.
 *
 * Demand is conservative: a consumer that cannot be enumerated confidently
 * requires the complete topology. `forceSceneMRT` provides the escape hatch,
 * and every known reader participates in the Boolean union rather than being
 * omitted on uncertainty.
 *
 * `computeAttachmentDemand` reads only plain scene flags and the
 * caller-supplied force switch. It holds no GPU handles or caches, so device
 * recovery simply recomputes the record from scene state on the next frame.
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
  /** TAA uses the separate `rg16float` velocity target rather than this G-buffer. */
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
   * demand is already subsumed by `deferredLighting` in the Boolean union; it
   * remains separate for observability and precise topology selection.
   */
  ssgi: boolean;
  /** G-buffer normal debug overlay. */
  debugOverlay: boolean;
}

/**
 * Observe-only record of the other attachment families a frame uses. The
 * G-buffer family is the topology-selection input; these families remain
 * recorded for truthful reporting and for a future render graph, without
 * gating work in this module.
 */
export interface AttachmentOtherFamilies {
  /** rg16float velocity target (TAA). */
  velocityTarget: boolean;
  /** OIT accumulation/reveal framebuffer request, contained off by default. */
  oitRequested: boolean;
  /** Edge-visibility MRT. */
  edgeMrt: boolean;
  /** Globe-depth sampleable copy (on for every non-pick render frame). */
  globeDepth: boolean;
  /** Pick mini-frame (single-target `pickPipelineFormat` by construction). */
  picking: boolean;
  /** Post-process composite active (WebGPU always composites off-screen). */
  postProcess: boolean;
  /**
   * The frame demands resolved scene color when a consumer reads
   * `colorTarget.getColorTextureView(0)` or `_sceneColorView`. This is true
   * whenever the WebGPU post-process composite runs because its blit is the
   * path that reaches the canvas. The resolve-on-consume path honors this
   * demand. It remains observational here: the actual resolve count is
   * measured on the context as
   * `_attachmentDemandActual.sceneColorResolveOpens`; behavior is driven by
   * that demand plus the intra-frame staleness flag
   * (`WebGPUContext._sceneColorResolvePending`). A pure per-frame record cannot
   * track intra-frame staleness, so the ensure helper uses that flag when it
   * executes a resolve.
   */
  resolvedSceneColor: boolean;
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
  /** Boolean union of every enumerated reader before the force switch. */
  gbufferReadersDemand: boolean;
  /** Conservative force switch; defaults to `true` while topology is fixed. */
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
   * When `true`, the frame uses full-MRT topology regardless of reader demand.
   * This is the conservative default while the executor has a fixed topology
   * and covers any consumer that cannot yet be enumerated.
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
  // `deferredLighting` in the Boolean union below.
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
    // The post-process composite is the WebGPU canvas path, so it always
    // demands current resolved scene color before it runs.
    resolvedSceneColor: options.postProcess === true,
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
