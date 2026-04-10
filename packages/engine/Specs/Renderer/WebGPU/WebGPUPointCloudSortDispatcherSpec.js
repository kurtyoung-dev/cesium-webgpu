import {
  nextPow2,
  floatToSortableUint,
  sortableUintToFloat,
} from "../../../Source/Renderer/WebGPU/WebGPUPointCloudSortDispatcher.js";

// ── Test fixtures ───────────────────────────────────────────────────
//
// The dispatcher itself needs a real GPUDevice for the buffer and
// pipeline allocations, so its `sort()` path is exercised by the
// in-browser shadow / 3D Tiles specs. These specs cover the pure-JS
// helpers that determine sort correctness:
//   - nextPow2 (capacity rounding)
//   - floatToSortableUint / sortableUintToFloat (key encoding round-trip)
//
// The encoding correctness is critical because the sort runs on
// unsigned integers — if floats round-trip incorrectly, the bitonic
// network produces a wrong ordering and the bug only shows up at the
// rendered tile level.

describe("Renderer/WebGPU/WebGPUPointCloudSortDispatcher helpers", function () {
  describe("nextPow2()", function () {
    it("returns 1 for 0 and 1", function () {
      expect(nextPow2(0)).toBe(1);
      expect(nextPow2(1)).toBe(1);
    });

    it("returns the same value for inputs that are already powers of two", function () {
      expect(nextPow2(2)).toBe(2);
      expect(nextPow2(4)).toBe(4);
      expect(nextPow2(256)).toBe(256);
      expect(nextPow2(1024)).toBe(1024);
    });

    it("rounds up to the next power of two for arbitrary inputs", function () {
      expect(nextPow2(3)).toBe(4);
      expect(nextPow2(5)).toBe(8);
      expect(nextPow2(257)).toBe(512);
      expect(nextPow2(1000)).toBe(1024);
      expect(nextPow2(1025)).toBe(2048);
    });
  });

  describe("floatToSortableUint() / sortableUintToFloat() round trip", function () {
    it("preserves zero", function () {
      const u = floatToSortableUint(0);
      expect(sortableUintToFloat(u)).toBe(0);
    });

    it("preserves small positive floats", function () {
      const values = [0.1, 1.5, 100.0, 1e6];
      for (const v of values) {
        const u = floatToSortableUint(v);
        expect(sortableUintToFloat(u)).toBeCloseTo(v, 4);
      }
    });

    it("preserves negative floats", function () {
      const values = [-0.1, -1.5, -100.0, -1e6];
      for (const v of values) {
        const u = floatToSortableUint(v);
        expect(sortableUintToFloat(u)).toBeCloseTo(v, 4);
      }
    });

    it("encodes the float ordering as the unsigned integer ordering", function () {
      // The whole point of the sortable encoding: a < b in float must
      // imply floatToSortableUint(a) < floatToSortableUint(b) in u32.
      const sample = [-1e6, -100.0, -1.5, -0.1, 0.0, 0.1, 1.5, 100.0, 1e6];
      for (let i = 0; i < sample.length - 1; i++) {
        const a = floatToSortableUint(sample[i]);
        const b = floatToSortableUint(sample[i + 1]);
        // Compare as unsigned (>>> 0).
        expect(a >>> 0).toBeLessThan(b >>> 0);
      }
    });

    it("handles the negative-zero edge case", function () {
      // -0 and +0 are different bit patterns but compare equal as floats.
      // After the sortable encoding, -0 sorts strictly before +0 — that's
      // ok for our use case (point cloud distSq values are never negative).
      const negZero = floatToSortableUint(-0);
      const posZero = floatToSortableUint(0);
      expect(negZero).not.toBe(posZero);
    });
  });
});
