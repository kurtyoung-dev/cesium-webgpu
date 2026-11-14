/**
 * @purpose Opt-in landing-stage activation and bounded CPU-statistics readback of ordinary HALF cloud reconstruction consumption at the declared 1080p medium quality.
 * @status ACTIVE
 */

/**
 * PAGE SIDE. Uses the public Debug switch; cache and statistics are CPU
 * mirrors of the renderer, not a native command or GPU-upload attestation.
 * Each successful read follows a requested render at the frozen rig clock.
 */
export async function pageStageCloudReconstruction({
  deadlineMs = 60_000,
  maxFrames = 360,
  settleReads = 3,
} = {}) {
  for (const [name, value, limit] of [
    ["deadlineMs", deadlineMs, 60_000],
    ["maxFrames", maxFrames, 360],
    ["settleReads", settleReads, 30],
  ]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > limit) {
      throw new TypeError(`cloud reconstruction: invalid ${name}`);
    }
  }
  const viewer = window.viewer;
  const scene = viewer?.scene;
  const context = scene?.context ?? scene?._context;
  const debug = window.CesiumDebug;
  if (
    !context?.isWebGPU ||
    typeof context.getRendererStatistics !== "function" ||
    typeof debug?.cloudReconstruction !== "function" ||
    typeof scene?.requestRender !== "function" ||
    typeof scene?.render !== "function"
  ) {
    throw new Error(
      "cloud reconstruction: required WebGPU/Debug API unavailable",
    );
  }
  const deadline = performance.now() + deadlineMs;
  const check = () => {
    if (performance.now() >= deadline) {
      throw new Error("cloud reconstruction: readiness deadline");
    }
    if (
      viewer.useDefaultRenderLoop !== false ||
      viewer.clock?.shouldAnimate !== false
    ) {
      throw new Error(
        "cloud reconstruction: manual frozen-clock ownership lost",
      );
    }
  };
  const snapshot = () => {
    const clouds = context.getRendererStatistics()?.volumetricClouds;
    const cache = context._cloudCache;
    if (!clouds || !cache) {
      return null;
    }
    const ray = clouds.raymarch;
    const reconstruction = clouds.reconstruction;
    const emission = reconstruction?.emission;
    const attachments = reconstruction?.attachments;
    const passes = clouds.passes;
    if (!ray || !emission || !attachments || !passes) {
      return null;
    }
    return {
      frames: clouds.frames,
      raymarch: { ...ray },
      emission: { ...emission },
      attachments: {
        produced: attachments.produced,
        width: attachments.width,
        height: attachments.height,
        liveBytes: attachments.liveBytes,
        targetCount: attachments.targetCount,
      },
      passes: {
        half: passes["ProceduralClouds half-res pass"],
        temporal: passes["CloudTemporalResolve pass"],
        upscale: passes["CloudUpscale composite pass"],
        reuse: passes["CloudPrimaryReuse march pass"],
      },
      cache: {
        enabled: cache.reconstructionEnabled,
        attachmentsEnabled: cache.attachmentsEnabled,
        primaryReuseApplied: cache.primaryReuseApplied,
        preview: cache.usingStartupPreview,
        selectedMarchDefinesHi: cache.selectedMarchDefinesHi,
      },
      viewport: {
        width: scene.drawingBufferWidth,
        height: scene.drawingBufferHeight,
        dpr: window.devicePixelRatio,
      },
    };
  };
  let renderCalls = 0;
  let applied = false;
  let stable = 0;
  let lastFrame = -1;
  let observed = null;
  for (; renderCalls < maxFrames;) {
    check();
    if (!applied && context._cloudCache) {
      const response = debug.cloudReconstruction(true);
      if (
        !response ||
        context._cloudCache.reconstructionEnabled !== true ||
        context._cloudCache.attachmentsEnabled !== true
      ) {
        throw new Error("cloud reconstruction: public activation not applied");
      }
      applied = true;
    }
    scene.requestRender();
    scene.render(viewer.clock.currentTime);
    renderCalls++;
    check();
    observed = snapshot();
    const r = observed?.raymarch;
    const e = observed?.emission;
    const t = observed?.attachments;
    const p = observed?.passes;
    const c = observed?.cache;
    const v = observed?.viewport;
    // These are ShaderDefineHi's add-only directional and deep-shadow bits.
    const family = (c?.selectedMarchDefinesHi & 196608) === 196608;
    const ready =
      applied &&
      Number.isSafeInteger(observed?.frames) &&
      observed.frames > lastFrame &&
      c.enabled === true &&
      c.attachmentsEnabled === true &&
      c.primaryReuseApplied === false &&
      c.preview === false &&
      family &&
      v.width === 1920 &&
      v.height === 1080 &&
      v.dpr === 1 &&
      r.width === 960 &&
      r.height === 540 &&
      r.halfResActive === true &&
      r.maxSteps === 48 &&
      r.lightSteps === 4 &&
      r.requestedPrimarySteps === 48 &&
      r.requestedLightSteps === 4 &&
      (r.qualityFlags & 15) === 15 &&
      r.budgetRefused === false &&
      e.requested === true &&
      e.emitted === true &&
      e.consumed === true &&
      e.producerTargets === 2 &&
      t.produced === true &&
      t.width === 960 &&
      t.height === 540 &&
      t.liveBytes === 960 * 540 * 24 &&
      p.half > 0 &&
      p.temporal > 0 &&
      p.upscale > 0 &&
      p.reuse === 0;
    lastFrame = observed?.frames ?? lastFrame;
    stable = ready ? stable + 1 : 0;
    if (stable >= settleReads) {
      const publicReadback = debug.cloudReconstruction();
      check();
      if (
        publicReadback?.requested !== true ||
        publicReadback.emitted !== true ||
        publicReadback.consumed !== true ||
        publicReadback.producerTargets !== 2
      ) {
        throw new Error(
          "cloud reconstruction: fresh public readback disagrees",
        );
      }
      return {
        requested: true,
        applied,
        ready: true,
        evidence: "CPU renderer statistics and cache mirrors",
        renderCalls,
        stableReads: stable,
        observed,
        publicReadback: { ...publicReadback },
      };
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  throw new Error(
    `cloud reconstruction: not ready after ${renderCalls} renders; ${JSON.stringify(observed)}`,
  );
}
