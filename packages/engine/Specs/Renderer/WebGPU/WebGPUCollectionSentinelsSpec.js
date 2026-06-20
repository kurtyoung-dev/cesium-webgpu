import {
  beginCollectionFrame,
  endCollectionFrame,
  validateInstanceSyncResult,
  validateDrawTargets,
  validateInstancedDrawBuffer,
} from "../../../Source/Renderer/WebGPU/WebGPUCollectionRendererBase.js";

// NEW-COLLECTIONS-ERROR-SENTINELS — the three PERMANENT (non-pragma) fault
// detectors mandated by CLAUDE.md's "Permanent sentinels to add for new
// subsystems" for every WebGPU collection renderer (Billboard / Label /
// Point / Polyline / Cloud). These specs prove each sentinel:
//   (a) stays SILENT and inert on the happy path (zero behavior change), and
//   (b) `console.error`s + skips/clamps under a forced fault.
// Pure logic over the shared base helpers — no GPUDevice required.
describe("Renderer/WebGPU/WebGPUCollectionRendererBase sentinels", function () {
  // -----------------------------------------------------------------------
  // Sentinel 1 — re-entry / infinite-loop guard
  // -----------------------------------------------------------------------
  describe("Sentinel 1 — re-entry guard (begin/endCollectionFrame)", function () {
    it("a normal non-overlapping call reports depth 1 and never logs", function () {
      const cache = {};
      spyOn(console, "error");
      const depth = beginCollectionFrame(cache, "Billboard");
      endCollectionFrame(cache);
      expect(depth).toBe(1);
      expect(cache._frameReentryDepth).toBe(0);
      expect(console.error).not.toHaveBeenCalled();
    });

    it("legitimate overlap below the sane limit does not log", function () {
      const cache = {};
      spyOn(console, "error");
      // 8 overlapping in-flight entries (under the limit of 16).
      for (let i = 0; i < 8; i++) {
        beginCollectionFrame(cache, "Billboard");
      }
      expect(cache._frameReentryDepth).toBe(8);
      expect(console.error).not.toHaveBeenCalled();
      for (let i = 0; i < 8; i++) {
        endCollectionFrame(cache);
      }
      expect(cache._frameReentryDepth).toBe(0);
    });

    it("re-entry past the sane limit logs a permanent error (throttled)", function () {
      const cache = {};
      spyOn(console, "error");
      // 17 nested entries without settling — a runaway recursive build.
      for (let i = 0; i < 17; i++) {
        beginCollectionFrame(cache, "Billboard");
      }
      expect(cache._frameReentryDepth).toBe(17);
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.error.calls.mostRecent().args[0]).toContain("re-entry");
      // Throttle: a further entry in the same window does NOT re-log.
      beginCollectionFrame(cache, "Billboard");
      expect(console.error).toHaveBeenCalledTimes(1);
    });

    it("endCollectionFrame never drives the depth below 0", function () {
      const cache = {};
      endCollectionFrame(cache);
      endCollectionFrame(cache);
      expect(cache._frameReentryDepth).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Sentinel 2 — null-target guard
  // -----------------------------------------------------------------------
  describe("Sentinel 2 — null-target guard", function () {
    it("validateInstanceSyncResult passes a non-null buffer with visible instances", function () {
      spyOn(console, "error");
      const ok = validateInstanceSyncResult(
        { visibleCount: 5, buffer: { size: 1024 } },
        "Billboard",
      );
      expect(ok).toBe(true);
      expect(console.error).not.toHaveBeenCalled();
    });

    it("validateInstanceSyncResult returns false silently for an empty collection", function () {
      spyOn(console, "error");
      const ok = validateInstanceSyncResult(
        { visibleCount: 0, buffer: null },
        "Billboard",
      );
      expect(ok).toBe(false);
      expect(console.error).not.toHaveBeenCalled();
    });

    it("validateInstanceSyncResult logs + skips a null buffer with visible instances", function () {
      spyOn(console, "error");
      const ok = validateInstanceSyncResult(
        { visibleCount: 7, buffer: null },
        "Billboard",
      );
      expect(ok).toBe(false);
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.error.calls.mostRecent().args[0]).toContain("null buffer");
    });

    it("validateDrawTargets passes when every target is live", function () {
      spyOn(console, "error");
      // Mix of a WebGPUBuffer-wrapper shape (.buffer set) and a raw GPUBuffer.
      const ok = validateDrawTargets([{ buffer: {} }, {}], "CloudCollection");
      expect(ok).toBe(true);
      expect(console.error).not.toHaveBeenCalled();
    });

    it("validateDrawTargets logs + skips when a target is null", function () {
      spyOn(console, "error");
      // Unique label per logging test — the throttle map is keyed by label.
      const ok = validateDrawTargets(
        [{ buffer: {} }, null],
        "SentinelSpecNullTarget",
      );
      expect(ok).toBe(false);
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.error.calls.mostRecent().args[0]).toContain("null");
    });

    it("validateDrawTargets logs + skips a destroyed WebGPUBuffer wrapper (.buffer === null)", function () {
      spyOn(console, "error");
      const ok = validateDrawTargets(
        [{ buffer: null }],
        "SentinelSpecDestroyedWrapper",
      );
      expect(ok).toBe(false);
      expect(console.error).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // Sentinel 3 — size-validation / overflow guard
  // -----------------------------------------------------------------------
  describe("Sentinel 3 — instanced-draw size validation", function () {
    it("returns the full count silently when the buffer fits", function () {
      spyOn(console, "error");
      // 3 instances × 56 B = 168 B ≤ 256 B buffer.
      const safe = validateInstancedDrawBuffer(
        { size: 256 },
        3,
        56,
        "CloudCollection",
      );
      expect(safe).toBe(3);
      expect(console.error).not.toHaveBeenCalled();
    });

    it("logs + clamps the count to what the buffer holds on overflow", function () {
      spyOn(console, "error");
      // 5 instances × 56 B = 280 B > 168 B buffer → clamp to floor(168/56)=3.
      // Unique label per logging test — the throttle map is keyed by label.
      const safe = validateInstancedDrawBuffer(
        { size: 168 },
        5,
        56,
        "SentinelSpecOverflow",
      );
      expect(safe).toBe(3);
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.error.calls.mostRecent().args[0]).toContain("clamping");
    });

    it("returns 0 for a null buffer (nothing safe to draw)", function () {
      spyOn(console, "error");
      const safe = validateInstancedDrawBuffer(null, 5, 56, "CloudCollection");
      expect(safe).toBe(0);
    });

    it("returns 0 for a zero instance count without logging", function () {
      spyOn(console, "error");
      const safe = validateInstancedDrawBuffer({ size: 256 }, 0, 56, "Label");
      expect(safe).toBe(0);
      expect(console.error).not.toHaveBeenCalled();
    });
  });
});
