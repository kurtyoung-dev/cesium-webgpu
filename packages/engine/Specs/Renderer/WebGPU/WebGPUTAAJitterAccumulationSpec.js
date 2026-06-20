import { WebGPUTAAEffect } from "../../../Source/Renderer/WebGPU/WebGPUTAAEffect.js";

// NEW-CAMERA-JITTER-ACCUMULATION
//
// `WebGPUTAAEffect.applyProjectionJitter` writes sub-pixel jitter to the
// projection matrix as an ABSOLUTE `base + jitter` rather than an accumulating
// `+=`. The bug it fixes: `cam.frustum.projectionMatrix` is a dirty-cached
// getter — on a settled frustum it returns the SAME array every frame without
// recomputing, so the old `proj[8] += jitter.x` stacked each frame's jitter on
// top of the last and proj[8]/proj[9] drifted without bound (~linearly in the
// number of frames). On a CHANGING frustum the matrix recomputed to its
// un-jittered base each frame, so the old `+=` happened to be correct there.
//
// `applyProjectionJitter` exercises NO GPU device — it's pure CPU math over the
// projection array plus a few tracked scalars on the effect — so these run in
// the Karma headless browser with zero GPU dependency.

describe("Renderer/WebGPU TAA jitter accumulation", function () {
  // A representative un-jittered perspective projection (column-major). Only
  // indices [8]/[9] are touched by the jitter; the rest are inert here but
  // included so the array shape matches a real Matrix4-backed projection.
  function makeBaseProjection() {
    // prettier-ignore
    return [
      1.2990, 0.0,    0.0,    0.0,
      0.0,    1.7320, 0.0,    0.0,
      0.0,    0.0,   -1.0000, -1.0,
      0.0,    0.0,   -2.0000,  0.0,
    ];
  }

  // Sub-pixel jitter magnitude at a typical resolution: ±1/width in NDC.
  // computeJitter returns ((h-0.5)*2)/width, h ∈ [0,1), so |x| < 1/width.
  const SCREEN_WIDTH = 1920;
  const SCREEN_HEIGHT = 1080;
  const MAX_JITTER_X = 1.0 / SCREEN_WIDTH;
  const MAX_JITTER_Y = 1.0 / SCREEN_HEIGHT;

  it("stays BOUNDED at base±maxJitter over a long stable-frustum run (no accumulation)", function () {
    const taa = new WebGPUTAAEffect();
    // STABLE frustum: the same cached array is returned every frame, so we
    // mutate ONE array in place across all frames — exactly what the dirty-
    // cached getter does on a settled camera.
    const proj = makeBaseProjection();
    const base8 = proj[8];
    const base9 = proj[9];

    const FRAMES = 120;
    let maxAbsDriftX = 0;
    let maxAbsDriftY = 0;

    for (let frame = 0; frame < FRAMES; frame++) {
      const jitter = taa.computeJitter(frame, SCREEN_WIDTH, SCREEN_HEIGHT);
      taa.applyProjectionJitter(proj, jitter.x, jitter.y);

      const driftX = Math.abs(proj[8] - base8);
      const driftY = Math.abs(proj[9] - base9);
      maxAbsDriftX = Math.max(maxAbsDriftX, driftX);
      maxAbsDriftY = Math.max(maxAbsDriftY, driftY);

      // Per-frame assertion: the live value is ALWAYS within one max-jitter of
      // the base. Pre-fix this grew ~linearly (by frame 120 it would be ~120×
      // the single-frame magnitude, far outside this bound).
      expect(driftX).toBeLessThanOrEqual(MAX_JITTER_X * (1 + 1e-9));
      expect(driftY).toBeLessThanOrEqual(MAX_JITTER_Y * (1 + 1e-9));
    }

    // The peak drift over the whole run is sub-pixel — it never accumulated.
    expect(maxAbsDriftX).toBeLessThanOrEqual(MAX_JITTER_X * (1 + 1e-9));
    expect(maxAbsDriftY).toBeLessThanOrEqual(MAX_JITTER_Y * (1 + 1e-9));
  });

  it("a naive `+=` WOULD accumulate (negative control — proves the test exercises the right path)", function () {
    // Demonstrate the bug shape the fix prevents: applying jitter additively to
    // the SAME cached array every frame drifts ~linearly. This is the pre-fix
    // behaviour; we assert it diverges so the bounded test above is meaningful.
    const taa = new WebGPUTAAEffect();
    const proj = makeBaseProjection();
    const base8 = proj[8];

    const FRAMES = 120;
    let peakDrift = 0;
    for (let frame = 0; frame < FRAMES; frame++) {
      const jitter = taa.computeJitter(frame, SCREEN_WIDTH, SCREEN_HEIGHT);
      // Old buggy path: proj[8] += jitter.x.
      proj[8] += jitter.x;
      peakDrift = Math.max(peakDrift, Math.abs(proj[8] - base8));
    }
    // Against a dirty-cached array the additive jitter performs a random walk
    // with a non-zero-mean drift component, so the projection wanders well
    // outside the single-frame ±maxJitter envelope that the FIXED path is
    // pinned to. The peak drift over 120 frames is ~5× maxJitter (the fixed
    // path never exceeds 1×). Assert a comfortable margin above the fixed
    // bound so the negative control is robust to the exact IGN sequence.
    expect(peakDrift).toBeGreaterThan(MAX_JITTER_X * 3);
  });

  it("writes exactly base+jitter each frame on a stable frustum", function () {
    const taa = new WebGPUTAAEffect();
    const proj = makeBaseProjection();
    const base8 = proj[8];
    const base9 = proj[9];

    for (let frame = 0; frame < 30; frame++) {
      const jitter = taa.computeJitter(frame, SCREEN_WIDTH, SCREEN_HEIGHT);
      taa.applyProjectionJitter(proj, jitter.x, jitter.y);
      expect(proj[8]).toBeCloseTo(base8 + jitter.x, 12);
      expect(proj[9]).toBeCloseTo(base9 + jitter.y, 12);
    }
  });

  it("self-heals when the frustum recomputes to a fresh un-jittered base", function () {
    const taa = new WebGPUTAAEffect();

    // Frame 0: settled frustum, jitter applied to the cached array.
    const projA = makeBaseProjection();
    const baseA8 = projA[8];
    taa.applyProjectionJitter(projA, 0.001, 0.002);
    expect(projA[8]).toBeCloseTo(baseA8 + 0.001, 12);

    // Frame 1: the frustum changed (near/far edited) — the getter recomputes
    // and returns a DIFFERENT, un-jittered base. Simulate by handing a fresh
    // array whose [8]/[9] differ from `base + lastJitter`.
    const projB = makeBaseProjection();
    projB[8] = -1.5; // a different, clean base value
    projB[9] = 0.25;
    const baseB8 = projB[8];
    const baseB9 = projB[9];
    taa.applyProjectionJitter(projB, 0.003, 0.004);

    // It must add jitter to the NEW base, not the stale one — no leftover from
    // frame 0's base/jitter leaks in.
    expect(projB[8]).toBeCloseTo(baseB8 + 0.003, 12);
    expect(projB[9]).toBeCloseTo(baseB9 + 0.004, 12);
  });

  it("re-captures the base after resetProjectionJitter (snapshot-freeze path)", function () {
    const taa = new WebGPUTAAEffect();
    const proj = makeBaseProjection();
    const base8 = proj[8];

    // Apply jitter for a few frames.
    for (let frame = 0; frame < 5; frame++) {
      const jitter = taa.computeJitter(frame, SCREEN_WIDTH, SCREEN_HEIGHT);
      taa.applyProjectionJitter(proj, jitter.x, jitter.y);
    }
    // The matrix now carries base+jitter. A freeze resets the tracked base.
    taa.resetProjectionJitter();

    // The "matrix" still holds the last jittered value (the frozen branch sets
    // jitterX/Y=0 but does not rewrite the projection). On re-enable, the next
    // applyProjectionJitter must treat the CURRENT value as the new base (it no
    // longer matches base+lastJitter after the reset) and add jitter to it,
    // staying bounded relative to whatever base it re-captures.
    const recaptureBase = proj[8];
    taa.applyProjectionJitter(proj, 0.0005, 0.0006);
    expect(proj[8]).toBeCloseTo(recaptureBase + 0.0005, 12);
    // And it is NOT double-counting against the original base.
    expect(Math.abs(proj[8] - base8)).toBeLessThan(
      MAX_JITTER_X + 0.0005 + 1e-9,
    );
  });
});
