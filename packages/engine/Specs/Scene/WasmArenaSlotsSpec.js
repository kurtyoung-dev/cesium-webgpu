import {
  WasmArenaSlot,
  hasArenaSlots,
  allocFromSlot,
  freeSlot,
} from "../../Source/Scene/WasmArenaSlots.js";

describe("Scene/WasmArenaSlots", function () {
  // FORK-45: WasmArenaSlots is the JS-side companion to per-slot
  // arena allocation in the Rust crate. The spec covers two things:
  //
  //   1. The slot ID enum is stable (no accidental renumbering, no
  //      collisions, every bridge has a unique slot).
  //   2. The forward-compat helpers (hasArenaSlots, allocFromSlot,
  //      freeSlot) correctly fall through to the legacy single-arena
  //      API when the WASM module is older than v3.
  //
  // The slot enum stability matters because old WASM builds in the
  // wild may rely on a particular slot mapping; renumbering would
  // silently corrupt cross-version state.

  describe("WasmArenaSlot enum", function () {
    it("is frozen", function () {
      expect(Object.isFrozen(WasmArenaSlot)).toBe(true);
    });

    it("declares DEFAULT as slot 0", function () {
      // Slot 0 is the legacy fallback the Rust forwards alloc_buffer
      // and free_buffer to. Renumbering this would silently break the
      // backward-compat shim for un-migrated bridges.
      expect(WasmArenaSlot.DEFAULT).toBe(0);
    });

    it("assigns unique slots to every bridge", function () {
      const values = Object.values(WasmArenaSlot);
      const seen = new Set(values);
      expect(seen.size).toBe(values.length);
    });

    it("uses contiguous slot IDs from 0", function () {
      // Dense ordering keeps the Rust ARENAS array tight; a hole
      // would waste a Mutex<Vec<u8>> entry.
      const values = Object.values(WasmArenaSlot).sort((a, b) => a - b);
      for (let i = 0; i < values.length; i++) {
        expect(values[i]).toBe(i);
      }
    });

    it("fits within NUM_SLOTS=8 from the Rust side", function () {
      // The Rust crate hard-codes NUM_SLOTS = 8. If this enum grows
      // past that, lib.rs needs a matching bump and a WASM rebuild.
      const max = Math.max(...Object.values(WasmArenaSlot));
      expect(max)
        .withContext("Add NUM_SLOTS bump to packages/wasm/src/lib.rs first")
        .toBeLessThan(8);
    });

    it("declares all 7 known bridge slots", function () {
      // Spot-check the named slots so a careless rename of one of
      // these constants fails the spec instead of silently routing
      // a bridge to the wrong arena.
      expect(typeof WasmArenaSlot.CULL).toBe("number");
      expect(typeof WasmArenaSlot.SORT).toBe("number");
      expect(typeof WasmArenaSlot.HEIGHTMAP).toBe("number");
      expect(typeof WasmArenaSlot.QUANTIZED_MESH).toBe("number");
      expect(typeof WasmArenaSlot.RTE).toBe("number");
      expect(typeof WasmArenaSlot.MATRIX).toBe("number");
      expect(typeof WasmArenaSlot.POINT_CLOUD).toBe("number");
    });
  });

  describe("hasArenaSlots", function () {
    it("returns false for null/undefined modules", function () {
      expect(hasArenaSlots(null)).toBe(false);
      expect(hasArenaSlots(undefined)).toBe(false);
    });

    it("returns false for a legacy WASM module without alloc_buffer_slot", function () {
      const legacyMod = {
        alloc_buffer: () => 0,
        free_buffer: () => {},
      };
      expect(hasArenaSlots(legacyMod)).toBe(false);
    });

    it("returns true for a v3 WASM module with alloc_buffer_slot", function () {
      const v3Mod = {
        alloc_buffer: () => 0,
        free_buffer: () => {},
        alloc_buffer_slot: () => 0,
        free_buffer_slot: () => {},
        num_arena_slots: () => 8,
      };
      expect(hasArenaSlots(v3Mod)).toBe(true);
    });
  });

  describe("allocFromSlot", function () {
    it("calls alloc_buffer_slot when available", function () {
      const calls = [];
      const v3Mod = {
        alloc_buffer: function (n) {
          calls.push(["legacy", n]);
          return 100;
        },
        alloc_buffer_slot: function (slot, n) {
          calls.push(["slot", slot, n]);
          return 200;
        },
      };
      const ptr = allocFromSlot(v3Mod, WasmArenaSlot.CULL, 1024);
      expect(ptr).toBe(200);
      expect(calls).toEqual([["slot", WasmArenaSlot.CULL, 1024]]);
    });

    it("falls back to alloc_buffer on legacy modules", function () {
      const calls = [];
      const legacyMod = {
        alloc_buffer: function (n) {
          calls.push(["legacy", n]);
          return 50;
        },
      };
      const ptr = allocFromSlot(legacyMod, WasmArenaSlot.CULL, 2048);
      expect(ptr).toBe(50);
      expect(calls).toEqual([["legacy", 2048]]);
    });
  });

  describe("freeSlot", function () {
    it("calls free_buffer_slot when available", function () {
      const calls = [];
      const v3Mod = {
        free_buffer: function () {
          calls.push("legacy");
        },
        alloc_buffer_slot: function () {
          return 0;
        },
        free_buffer_slot: function (slot) {
          calls.push(["slot", slot]);
        },
      };
      freeSlot(v3Mod, WasmArenaSlot.SORT);
      expect(calls).toEqual([["slot", WasmArenaSlot.SORT]]);
    });

    it("falls back to free_buffer on legacy modules", function () {
      const calls = [];
      const legacyMod = {
        free_buffer: function () {
          calls.push("legacy");
        },
      };
      freeSlot(legacyMod, WasmArenaSlot.SORT);
      expect(calls).toEqual(["legacy"]);
    });
  });
});
