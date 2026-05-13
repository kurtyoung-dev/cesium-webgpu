import { AsyncResourceMonitor } from "../../../Source/Renderer/WebGPU/AsyncResourceMonitor.js";

describe("Renderer/WebGPU/AsyncResourceMonitor", function () {
  // Unit tests for the per-context async-resource event bus. The monitor
  // is a pure JS object with no GPU dependency — runs in node + browser
  // without needing a WebGPU device.

  describe("begin/resolve/reject", function () {
    it("records inflight tokens and increments pendingCount", function () {
      const m = new AsyncResourceMonitor("test");
      expect(m.pendingCount).toBe(0);
      m.begin({ kind: "render-pipeline", key: "k1" });
      expect(m.pendingCount).toBe(1);
      m.begin({ kind: "render-pipeline", key: "k2" });
      expect(m.pendingCount).toBe(2);
    });

    it("returns the existing token on second begin with same key (idempotent)", function () {
      const m = new AsyncResourceMonitor("test");
      const t1 = m.begin({ kind: "render-pipeline", key: "k1" });
      const t2 = m.begin({ kind: "render-pipeline", key: "k1" });
      expect(t1).toBe(t2);
      expect(m.pendingCount).toBe(1);
    });

    it("clears inflight on resolve", function () {
      const m = new AsyncResourceMonitor("test");
      const t = m.begin({ kind: "render-pipeline", key: "k1" });
      m.resolve(t);
      expect(m.pendingCount).toBe(0);
      expect(m.getStats().resolved).toBe(1);
    });

    it("clears inflight on reject and records error", function () {
      const m = new AsyncResourceMonitor("test");
      const t = m.begin({ kind: "render-pipeline", key: "k1" });
      let captured = null;
      m.subscribe((event) => {
        if (event.kind === "rejected") {
          captured = event;
        }
      });
      const err = new Error("boom");
      m.reject(t, err);
      expect(m.pendingCount).toBe(0);
      expect(m.getStats().rejected).toBe(1);
      expect(captured.error).toBe(err);
    });

    it("resolve is idempotent — second resolve is a no-op", function () {
      const m = new AsyncResourceMonitor("test");
      const t = m.begin({ kind: "render-pipeline", key: "k1" });
      m.resolve(t);
      m.resolve(t); // no throw, no double-count
      expect(m.getStats().resolved).toBe(1);
    });

    it("accepts string key as well as token object", function () {
      const m = new AsyncResourceMonitor("test");
      m.begin({ kind: "render-pipeline", key: "k1" });
      m.resolve("k1");
      expect(m.pendingCount).toBe(0);
    });
  });

  describe("priority", function () {
    it("defaults to foreground", function () {
      const m = new AsyncResourceMonitor("test");
      const t = m.begin({ kind: "render-pipeline", key: "k1" });
      expect(t.priority).toBe("foreground");
      expect(m.pendingForegroundCount).toBe(1);
    });

    it("excludes background tokens from pendingForegroundCount", function () {
      const m = new AsyncResourceMonitor("test");
      m.begin({
        kind: "render-pipeline",
        key: "fg",
        priority: "foreground",
      });
      m.begin({
        kind: "render-pipeline",
        key: "bg",
        priority: "background",
      });
      expect(m.pendingCount).toBe(2);
      expect(m.pendingForegroundCount).toBe(1);
    });
  });

  describe("subscribe / dispatch", function () {
    it("fires started + resolved events to subscribers", function () {
      const m = new AsyncResourceMonitor("test");
      const events = [];
      m.subscribe((e) => events.push(e.kind));
      const t = m.begin({ kind: "render-pipeline", key: "k1" });
      m.resolve(t);
      expect(events).toEqual(["started", "resolved"]);
    });

    it("unsubscribe stops further events", function () {
      const m = new AsyncResourceMonitor("test");
      let count = 0;
      const off = m.subscribe(() => {
        count++;
      });
      m.begin({ kind: "render-pipeline", key: "k1" });
      off();
      m.begin({ kind: "render-pipeline", key: "k2" });
      expect(count).toBe(1);
    });

    it("subscriber error is caught and doesn't stop other subscribers", function () {
      const m = new AsyncResourceMonitor("test");
      let aRan = false;
      let cRan = false;
      m.subscribe(() => {
        aRan = true;
      });
      m.subscribe(() => {
        throw new Error("boom");
      });
      m.subscribe(() => {
        cRan = true;
      });
      // Suppress the error log noise during the spec run.
      spyOn(console, "error");
      m.begin({ kind: "render-pipeline", key: "k1" });
      expect(aRan).toBe(true);
      expect(cRan).toBe(true);
    });
  });

  describe("ownerSceneIds attribution (Phase 6)", function () {
    it("filters dispatch when both subscriber sceneId and token owners are set", function () {
      const m = new AsyncResourceMonitor("test");
      let aFires = 0;
      let bFires = 0;
      m.subscribe(
        () => {
          aFires++;
        },
        { sceneId: "scene-A" },
      );
      m.subscribe(
        () => {
          bFires++;
        },
        { sceneId: "scene-B" },
      );
      const t = m.begin({
        kind: "render-pipeline",
        key: "k1",
        ownerSceneIds: new Set(["scene-A"]),
      });
      m.resolve(t);
      expect(aFires).toBe(2); // started + resolved
      expect(bFires).toBe(0);
    });

    it("subscriber without sceneId fires regardless of owner set", function () {
      const m = new AsyncResourceMonitor("test");
      let fires = 0;
      m.subscribe(() => {
        fires++;
      });
      const t = m.begin({
        kind: "render-pipeline",
        key: "k1",
        ownerSceneIds: new Set(["scene-A"]),
      });
      m.resolve(t);
      expect(fires).toBe(2);
    });

    it("token without owners fires every subscriber regardless of sceneId", function () {
      const m = new AsyncResourceMonitor("test");
      let aFires = 0;
      let bFires = 0;
      m.subscribe(
        () => {
          aFires++;
        },
        { sceneId: "scene-A" },
      );
      m.subscribe(
        () => {
          bFires++;
        },
        { sceneId: "scene-B" },
      );
      const t = m.begin({ kind: "render-pipeline", key: "shared" });
      m.resolve(t);
      expect(aFires).toBe(2);
      expect(bFires).toBe(2);
    });
  });

  describe("reset (device-loss recovery)", function () {
    it("rejects every inflight token in one sweep", function () {
      const m = new AsyncResourceMonitor("test");
      m.begin({ kind: "render-pipeline", key: "k1" });
      m.begin({ kind: "render-pipeline", key: "k2" });
      const events = [];
      m.subscribe((e) => events.push(e));
      m.reset("device-lost");
      expect(m.pendingCount).toBe(0);
      expect(events.length).toBe(2);
      expect(events[0].kind).toBe("rejected");
      expect(events[1].kind).toBe("rejected");
      expect(m.getStats().rejected).toBe(2);
    });

    it("subsequent resolve on a reset token is a no-op", function () {
      const m = new AsyncResourceMonitor("test");
      const t = m.begin({ kind: "render-pipeline", key: "k1" });
      m.reset("device-lost");
      // Resolve after reset shouldn't throw or change counts.
      m.resolve(t);
      expect(m.pendingCount).toBe(0);
      expect(m.getStats().resolved).toBe(0);
    });

    it("preserves subscribers across reset", function () {
      const m = new AsyncResourceMonitor("test");
      let count = 0;
      m.subscribe(() => {
        count++;
      });
      m.begin({ kind: "render-pipeline", key: "k1" });
      m.reset("device-lost");
      // started + rejected (reset)
      expect(count).toBe(2);
      const t = m.begin({ kind: "render-pipeline", key: "k2" });
      m.resolve(t);
      // + started + resolved (post-reset, subscriber still attached)
      expect(count).toBe(4);
    });
  });

  describe("stats + breakdown", function () {
    it("tracks peakInflight watermark", function () {
      const m = new AsyncResourceMonitor("test");
      const t1 = m.begin({ kind: "render-pipeline", key: "k1" });
      const t2 = m.begin({ kind: "render-pipeline", key: "k2" });
      m.begin({ kind: "render-pipeline", key: "k3" });
      m.resolve(t1);
      m.resolve(t2);
      expect(m.getStats().peakInflight).toBe(3);
    });

    it("pendingByKind enumerates all 6 kinds", function () {
      const m = new AsyncResourceMonitor("test");
      m.begin({ kind: "render-pipeline", key: "rp" });
      m.begin({ kind: "compute-pipeline", key: "cp" });
      m.begin({ kind: "image-decode", key: "id" });
      const counts = m.pendingByKind;
      expect(counts["render-pipeline"]).toBe(1);
      expect(counts["compute-pipeline"]).toBe(1);
      expect(counts["image-decode"]).toBe(1);
      expect(counts["shader-module"]).toBe(0);
      expect(counts["texture-upload"]).toBe(0);
      expect(counts["buffer-map"]).toBe(0);
    });

    it("isInflight returns true while pending, false after resolve", function () {
      const m = new AsyncResourceMonitor("test");
      m.begin({ kind: "render-pipeline", key: "k1" });
      expect(m.isInflight("k1")).toBe(true);
      m.resolve("k1");
      expect(m.isInflight("k1")).toBe(false);
    });
  });

  describe("event payload", function () {
    it("includes durationMs on resolve", async function () {
      const m = new AsyncResourceMonitor("test");
      const events = [];
      m.subscribe((e) => events.push(e));
      const t = m.begin({ kind: "render-pipeline", key: "k1" });
      // Small wait so the duration is non-zero on most platforms.
      await new Promise((r) => setTimeout(r, 5));
      m.resolve(t);
      const resolved = events.find((e) => e.kind === "resolved");
      expect(resolved.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
