import VisualPerformanceTargetService from "../../Source/Services/VisualPerformanceTargetService.js";

// ── Test fixtures ───────────────────────────────────────────────────
//
// VisualPerformanceTargetService is backend-neutral. These specs cover
// the registration API, the tick contract, and the Phase 6 statistics
// surface. The auto-tuner body itself is intentionally a stub today
// (probes / sinks aren't queried), so we don't have an output to
// assert against — only the structural surface.

function makeProbeFn(value) {
  return () => ({ value });
}

function makeSink(levels, initialIndex = 0) {
  let index = initialIndex;
  return {
    levels: levels.slice(),
    cost: 1,
    getLevel: () => levels[index],
    setLevel: (level) => {
      const i = levels.indexOf(level);
      if (i >= 0) {
        index = i;
      }
    },
  };
}

describe("Services/VisualPerformanceTargetService", function () {
  describe("enabled flag", function () {
    it("defaults to false", function () {
      const svc = new VisualPerformanceTargetService();
      expect(svc.enabled).toBe(false);
    });

    it("can be toggled on and off", function () {
      const svc = new VisualPerformanceTargetService();
      svc.enabled = true;
      expect(svc.enabled).toBe(true);
      svc.enabled = false;
      expect(svc.enabled).toBe(false);
    });
  });

  describe("targetFps", function () {
    it("defaults to 60", function () {
      const svc = new VisualPerformanceTargetService();
      expect(svc.targetFps).toBe(60);
    });

    it("accepts positive numbers", function () {
      const svc = new VisualPerformanceTargetService();
      svc.targetFps = 30;
      expect(svc.targetFps).toBe(30);
      svc.targetFps = 144;
      expect(svc.targetFps).toBe(144);
    });

    it("rejects non-positive values via DeveloperError", function () {
      const svc = new VisualPerformanceTargetService();
      expect(() => {
        svc.targetFps = 0;
      }).toThrow();
      expect(() => {
        svc.targetFps = -1;
      }).toThrow();
    });
  });

  describe("snapshotMode flag (set externally by Scene.render)", function () {
    it("defaults to false", function () {
      const svc = new VisualPerformanceTargetService();
      expect(svc.snapshotMode).toBe(false);
    });

    it("can be flipped on and off", function () {
      const svc = new VisualPerformanceTargetService();
      svc.snapshotMode = true;
      expect(svc.snapshotMode).toBe(true);
      svc.snapshotMode = false;
      expect(svc.snapshotMode).toBe(false);
    });
  });

  describe("probe registry", function () {
    it("registers and unregisters probes", function () {
      const svc = new VisualPerformanceTargetService();
      svc.registerProbe("a", makeProbeFn(1));
      expect(svc.probeCount).toBe(1);
      const removed = svc.unregisterProbe("a");
      expect(removed).toBe(true);
      expect(svc.probeCount).toBe(0);
    });

    it("rejects non-function probes", function () {
      const svc = new VisualPerformanceTargetService();
      expect(() => svc.registerProbe("bad", null)).toThrow();
      expect(() => svc.registerProbe("bad", 42)).toThrow();
    });

    it("unregisterProbe of unknown name returns false", function () {
      const svc = new VisualPerformanceTargetService();
      expect(svc.unregisterProbe("nope")).toBe(false);
    });
  });

  describe("sink registry", function () {
    it("registers and unregisters sinks", function () {
      const svc = new VisualPerformanceTargetService();
      svc.registerSink("fog", makeSink(["low", "high"]));
      expect(svc.sinkCount).toBe(1);
      expect(svc.unregisterSink("fog")).toBe(true);
      expect(svc.sinkCount).toBe(0);
    });

    it("rejects sinks with no levels", function () {
      const svc = new VisualPerformanceTargetService();
      expect(() =>
        svc.registerSink("bad", {
          levels: [],
          getLevel: () => "x",
          setLevel: () => {},
        }),
      ).toThrow();
    });

    it("rejects sinks missing getLevel/setLevel", function () {
      const svc = new VisualPerformanceTargetService();
      expect(() => svc.registerSink("bad", { levels: ["a"] })).toThrow();
    });
  });

  describe("tick() contract", function () {
    it("is a no-op when disabled", function () {
      const svc = new VisualPerformanceTargetService();
      // No assertion target — we just verify it doesn't throw on the
      // disabled path with no scene.
      expect(() => svc.tick()).not.toThrow();
    });

    it("is a no-op when snapshot mode is frozen", function () {
      const svc = new VisualPerformanceTargetService();
      svc.enabled = true;
      svc.snapshotMode = true;
      const probe = jasmine.createSpy("probe").and.returnValue({ x: 1 });
      svc.registerProbe("p", probe);
      svc.tick({ _renderRequested: true });
      // Phase 0 stub doesn't query probes — but the contract is "must
      // not run the body when snapshotMode is set". Spec asserts the
      // service didn't throw and the probe was never queried.
      expect(probe).not.toHaveBeenCalled();
    });

    it("is a no-op on idle frames (defensive guard)", function () {
      const svc = new VisualPerformanceTargetService();
      svc.enabled = true;
      const probe = jasmine.createSpy("probe").and.returnValue({});
      svc.registerProbe("p", probe);
      svc.tick({ _renderRequested: false });
      expect(probe).not.toHaveBeenCalled();
    });
  });

  describe("getStatistics() (Phase 6 debug surface)", function () {
    it("returns the standard shape on a fresh service", function () {
      const svc = new VisualPerformanceTargetService();
      const stats = svc.getStatistics();
      expect(stats.enabled).toBe(false);
      expect(stats.targetFps).toBe(60);
      expect(stats.snapshotMode).toBe(false);
      expect(stats.probeCount).toBe(0);
      expect(stats.sinkCount).toBe(0);
      expect(stats.probes).toEqual({});
      expect(stats.sinks).toEqual({});
    });

    it("queries each registered probe lazily", function () {
      const svc = new VisualPerformanceTargetService();
      svc.registerProbe("frame_time", () => ({ ms: 16.7 }));
      svc.registerProbe("draw_count", () => 42);
      const stats = svc.getStatistics();
      expect(stats.probes.frame_time).toEqual({ ms: 16.7 });
      expect(stats.probes.draw_count).toBe(42);
    });

    it("isolates a thrown probe in its own error field", function () {
      const svc = new VisualPerformanceTargetService();
      svc.registerProbe("ok", () => ({ ok: true }));
      svc.registerProbe("broken", () => {
        throw new Error("boom");
      });
      const stats = svc.getStatistics();
      expect(stats.probes.ok).toEqual({ ok: true });
      expect(stats.probes.broken.error).toContain("boom");
    });

    it("reports each sink's current level + level list", function () {
      const svc = new VisualPerformanceTargetService();
      svc.registerSink("fog_quality", makeSink(["low", "medium", "high"], 1));
      const stats = svc.getStatistics();
      expect(stats.sinks.fog_quality.level).toBe("medium");
      expect(stats.sinks.fog_quality.levels).toEqual(["low", "medium", "high"]);
      expect(stats.sinks.fog_quality.cost).toBe(1);
    });

    it("isolates a thrown sink.getLevel() in its own error field", function () {
      const svc = new VisualPerformanceTargetService();
      svc.registerSink("broken", {
        levels: ["a", "b"],
        getLevel: () => {
          throw new Error("read failed");
        },
        setLevel: () => {},
      });
      const stats = svc.getStatistics();
      expect(stats.sinks.broken.level).toContain("read failed");
    });
  });

  describe("destroy()", function () {
    it("clears probes and sinks", function () {
      const svc = new VisualPerformanceTargetService();
      svc.registerProbe("p", makeProbeFn(1));
      svc.registerSink("s", makeSink(["a"]));
      svc.destroy();
      expect(svc.probeCount).toBe(0);
      expect(svc.sinkCount).toBe(0);
    });
  });
});
