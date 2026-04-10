import PerformanceTracker from "../../Source/Services/PerformanceTracker.js";

// ── Test fixtures ───────────────────────────────────────────────────
//
// PerformanceTracker is backend-neutral and works on plain sample
// objects. These specs cover the begin/sample/end lifecycle, the
// auto-end frame cap, the CSV / JSON exporters, and the
// statistics roll-up that runs in `endTrace()`.

function makeSample(frameNumber, overrides) {
  return {
    frameNumber,
    cpuMs: 5.0,
    gpuMs: 3.0,
    drawCount: 100,
    snapshotFrozen: false,
    bundleStats: {
      cacheSize: 0,
      hits: 0,
      misses: 0,
      ephemeralBuilds: 0,
      hitRate: 0,
      frozen: false,
    },
    ...overrides,
  };
}

describe("Services/PerformanceTracker", function () {
  describe("active flag", function () {
    it("defaults to false", function () {
      const t = new PerformanceTracker();
      expect(t.active).toBe(false);
      expect(t.label).toBeNull();
    });

    it("becomes true after beginTrace and false after endTrace", function () {
      const t = new PerformanceTracker();
      t.beginTrace("test");
      expect(t.active).toBe(true);
      expect(t.label).toBe("test");
      t.endTrace();
      expect(t.active).toBe(false);
      expect(t.label).toBeNull();
    });
  });

  describe("beginTrace validation", function () {
    it("rejects empty/non-string labels", function () {
      const t = new PerformanceTracker();
      expect(() => t.beginTrace("")).toThrow();
      expect(() => t.beginTrace(null)).toThrow();
      expect(() => t.beginTrace(undefined)).toThrow();
    });

    it("a second beginTrace cancels and replaces the first", function () {
      const t = new PerformanceTracker();
      t.beginTrace("first");
      t.sample(makeSample(0));
      t.beginTrace("second");
      expect(t.active).toBe(true);
      expect(t.label).toBe("second");
      // The second trace starts fresh — the first sample is gone.
      const result = t.endTrace();
      expect(result.label).toBe("second");
      expect(result.samples).toEqual([]);
    });
  });

  describe("sample()", function () {
    it("is a no-op when no trace is active", function () {
      const t = new PerformanceTracker();
      // No throw, no state change.
      t.sample(makeSample(0));
      expect(t.active).toBe(false);
    });

    it("stores recorded fields and computes relFrame", function () {
      const t = new PerformanceTracker();
      t.beginTrace("t");
      t.sample(makeSample(100));
      t.sample(makeSample(101));
      t.sample(makeSample(102));
      const result = t.endTrace();
      expect(result.samples.length).toBe(3);
      expect(result.samples[0].frameNumber).toBe(100);
      expect(result.samples[0].relFrame).toBe(0);
      expect(result.samples[1].relFrame).toBe(1);
      expect(result.samples[2].relFrame).toBe(2);
    });

    it("flattens bundleStats into row fields", function () {
      const t = new PerformanceTracker();
      t.beginTrace("t");
      t.sample(
        makeSample(0, {
          bundleStats: {
            cacheSize: 5,
            hits: 100,
            misses: 4,
            ephemeralBuilds: 1,
            hitRate: 0.952,
            frozen: true,
          },
        }),
      );
      const result = t.endTrace();
      const row = result.samples[0];
      expect(row.bundleCacheSize).toBe(5);
      expect(row.bundleHits).toBe(100);
      expect(row.bundleMisses).toBe(4);
      expect(row.bundleEphemeral).toBe(1);
      expect(row.bundleHitRate).toBeCloseTo(0.952, 4);
      expect(row.bundleFrozen).toBe(true);
    });

    it("auto-ends after the configured frame count", function () {
      const t = new PerformanceTracker();
      t.beginTrace("t", { frames: 3 });
      t.sample(makeSample(0));
      t.sample(makeSample(1));
      expect(t.active).toBe(true);
      t.sample(makeSample(2));
      // After the 3rd sample the latch flips off, but the result is
      // held until endTrace() is called.
      expect(t.active).toBe(false);
      const result = t.endTrace();
      expect(result.samples.length).toBe(3);
    });

    it("frames=0 disables auto-end", function () {
      const t = new PerformanceTracker();
      t.beginTrace("t", { frames: 0 });
      for (let i = 0; i < 1000; i++) {
        t.sample(makeSample(i));
      }
      expect(t.active).toBe(true);
      const result = t.endTrace();
      expect(result.samples.length).toBe(1000);
    });

    it("forwards extra fields onto the row", function () {
      const t = new PerformanceTracker();
      t.beginTrace("t");
      t.sample({
        frameNumber: 0,
        extra: { custom: 42, label: "alpha" },
      });
      const result = t.endTrace();
      expect(result.samples[0].custom).toBe(42);
      expect(result.samples[0].label).toBe("alpha");
    });
  });

  describe("summary roll-up (endTrace)", function () {
    it("aggregates cpuMs/gpuMs across samples", function () {
      const t = new PerformanceTracker();
      t.beginTrace("agg");
      t.sample(makeSample(0, { cpuMs: 10, gpuMs: 5 }));
      t.sample(makeSample(1, { cpuMs: 20, gpuMs: 6 }));
      t.sample(makeSample(2, { cpuMs: 30, gpuMs: 7 }));
      const r = t.endTrace();
      expect(r.summary.cpuMs.count).toBe(3);
      expect(r.summary.cpuMs.min).toBe(10);
      expect(r.summary.cpuMs.max).toBe(30);
      expect(r.summary.cpuMs.avg).toBe(20);
      expect(r.summary.cpuMs.total).toBe(60);
      expect(r.summary.gpuMs.count).toBe(3);
      expect(r.summary.gpuMs.avg).toBe(6);
    });

    it("computes the snapshotFrozenRatio", function () {
      const t = new PerformanceTracker();
      t.beginTrace("frozen");
      t.sample(makeSample(0, { snapshotFrozen: true }));
      t.sample(makeSample(1, { snapshotFrozen: true }));
      t.sample(makeSample(2, { snapshotFrozen: false }));
      t.sample(makeSample(3, { snapshotFrozen: true }));
      const r = t.endTrace();
      expect(r.summary.snapshotFrozenRatio).toBeCloseTo(0.75, 4);
    });

    it("computes avgBundleHitRate", function () {
      const t = new PerformanceTracker();
      t.beginTrace("hits");
      t.sample(
        makeSample(0, {
          bundleStats: {
            hits: 0,
            misses: 0,
            ephemeralBuilds: 0,
            hitRate: 1.0,
            frozen: false,
            cacheSize: 0,
          },
        }),
      );
      t.sample(
        makeSample(1, {
          bundleStats: {
            hits: 0,
            misses: 0,
            ephemeralBuilds: 0,
            hitRate: 0.5,
            frozen: false,
            cacheSize: 0,
          },
        }),
      );
      const r = t.endTrace();
      expect(r.summary.avgBundleHitRate).toBeCloseTo(0.75, 4);
    });

    it("skips missing fields without crashing", function () {
      const t = new PerformanceTracker();
      t.beginTrace("partial");
      t.sample({ frameNumber: 0 }); // no cpuMs / gpuMs / bundleStats
      const r = t.endTrace();
      expect(r.summary.cpuMs).toBeUndefined();
      expect(r.summary.gpuMs).toBeUndefined();
      expect(r.summary.avgBundleHitRate).toBeUndefined();
      expect(r.summary.snapshotFrozenRatio).toBeUndefined();
    });
  });

  describe("toCSV()", function () {
    it("emits a header row + one row per sample", function () {
      const t = new PerformanceTracker();
      t.beginTrace("csv");
      t.sample(makeSample(0));
      t.sample(makeSample(1));
      const r = t.endTrace();
      const csv = t.toCSV(r);
      const lines = csv.split("\n");
      expect(lines.length).toBe(3);
      expect(lines[0]).toContain("frameNumber");
      expect(lines[0]).toContain("relFrame");
      expect(lines[1]).toContain("0,0,");
    });

    it("returns empty string when no samples", function () {
      const t = new PerformanceTracker();
      expect(t.toCSV()).toBe("");
    });

    it("escapes commas and quotes in string fields", function () {
      const t = new PerformanceTracker();
      t.beginTrace("escape");
      t.sample({ frameNumber: 0, extra: { tag: 'a,b"c' } });
      const r = t.endTrace();
      const csv = t.toCSV(r);
      expect(csv).toContain('"a,b""c"');
    });
  });

  describe("toJSON()", function () {
    it("returns 'null' for an empty result", function () {
      const t = new PerformanceTracker();
      expect(t.toJSON()).toBe("null");
    });

    it("rounds floats to 4 decimal places", function () {
      const t = new PerformanceTracker();
      t.beginTrace("round");
      t.sample(makeSample(0, { cpuMs: 3.1415926535 }));
      const r = t.endTrace();
      const json = t.toJSON(r);
      expect(json).toContain("3.1416");
      expect(json).not.toContain("3.1415926535");
    });
  });

  describe("traceCount + lastResult", function () {
    it("increments traceCount per completed trace", function () {
      const t = new PerformanceTracker();
      expect(t.traceCount).toBe(0);
      t.beginTrace("a");
      t.endTrace();
      expect(t.traceCount).toBe(1);
      t.beginTrace("b");
      t.endTrace();
      expect(t.traceCount).toBe(2);
    });

    it("retains lastResult after the tracker resets", function () {
      const t = new PerformanceTracker();
      t.beginTrace("kept");
      t.sample(makeSample(0));
      t.endTrace();
      expect(t.lastResult).not.toBeNull();
      expect(t.lastResult.label).toBe("kept");
    });
  });
});
