import WebGPUVertexArrayFacade from "../../../Source/Renderer/WebGPU/WebGPUVertexArrayFacade.js";
import ComponentDatatype from "../../../Source/Core/ComponentDatatype.js";

// ── Scope ───────────────────────────────────────────────────────────
//
// WebGPUVertexArrayFacade has two distinct surfaces:
//
//   1. Device-free (covered here): the constructor (which only STORES the
//      device — it never touches it until commit()), the CPU-side array
//      bookkeeping (resize(), writers[]), validation throws, and the pure
//      static helpers (_verifyAttributes, _vertexSizeInBytes,
//      _createArrayViews). resize() is invoked by the constructor and only
//      allocates plain ArrayBuffers + typed views — no GPU calls.
//
//   2. Device-bound (SKIPPED here): commit(), subCommit(), getBufferLayouts()
//      and getGPUBuffers() — these call device.createBuffer /
//      device.queue.writeBuffer / read buffer.size, all of which require a
//      live GPUDevice/queue. (subCommit()'s range-validation throws ARE
//      covered, because they fire before any device call.)
//
// A bare stub device ({}) is sufficient for everything below: the only
// device member any exercised path reads is none — the constructor merely
// assigns `this._device = device`.

// Minimal stub — never invoked by any path exercised in this spec.
function stubDevice() {
  return /** @type {any} */ ({});
}

// FLOAT-3 + FLOAT-2 attributes on distinct indices: the common collection
// layout (e.g. position + texcoord). Both default to FLOAT usage so they
// share one managed buffer.
function twoFloatAttributes() {
  return [
    { index: 0, componentsPerAttribute: 3 },
    { index: 1, componentsPerAttribute: 2 },
  ];
}

describe("Renderer/WebGPU/WebGPUVertexArrayFacade", function () {
  describe("module shape", function () {
    it("default-exports the facade class", function () {
      expect(WebGPUVertexArrayFacade).toBeDefined();
      expect(typeof WebGPUVertexArrayFacade).toBe("function");
    });

    it("exposes the pure static helpers", function () {
      expect(typeof WebGPUVertexArrayFacade._verifyAttributes).toBe("function");
      expect(typeof WebGPUVertexArrayFacade._vertexSizeInBytes).toBe(
        "function",
      );
      expect(typeof WebGPUVertexArrayFacade._createArrayViews).toBe("function");
    });
  });

  describe("constructor validation", function () {
    it("throws when device is undefined", function () {
      expect(function () {
        return new WebGPUVertexArrayFacade(undefined, twoFloatAttributes());
      }).toThrowDeveloperError();
    });

    it("throws when attributes is undefined", function () {
      expect(function () {
        return new WebGPUVertexArrayFacade(stubDevice(), undefined);
      }).toThrowDeveloperError();
    });

    it("throws when attributes is empty", function () {
      expect(function () {
        return new WebGPUVertexArrayFacade(stubDevice(), []);
      }).toThrowDeveloperError();
    });

    it("throws when componentsPerAttribute is below 1", function () {
      expect(function () {
        return new WebGPUVertexArrayFacade(stubDevice(), [
          { index: 0, componentsPerAttribute: 0 },
        ]);
      }).toThrowDeveloperError();
    });

    it("throws when componentsPerAttribute is above 4", function () {
      expect(function () {
        return new WebGPUVertexArrayFacade(stubDevice(), [
          { index: 0, componentsPerAttribute: 5 },
        ]);
      }).toThrowDeveloperError();
    });

    it("throws when two attributes share an index", function () {
      expect(function () {
        return new WebGPUVertexArrayFacade(stubDevice(), [
          { index: 0, componentsPerAttribute: 3 },
          { index: 0, componentsPerAttribute: 2 },
        ]);
      }).toThrowDeveloperError();
    });
  });

  describe("constructor defaults", function () {
    it("defaults size to 0 when sizeInVertices is omitted", function () {
      const facade = new WebGPUVertexArrayFacade(
        stubDevice(),
        twoFloatAttributes(),
      );
      expect(facade.size).toBe(0);
    });

    it("stores the supplied vertex count in size", function () {
      const facade = new WebGPUVertexArrayFacade(
        stubDevice(),
        twoFloatAttributes(),
        8,
      );
      expect(facade.size).toBe(8);
    });

    it("builds one writer per managed attribute index", function () {
      const facade = new WebGPUVertexArrayFacade(
        stubDevice(),
        twoFloatAttributes(),
        4,
      );
      // Writers are indexed by attribute index (0 and 1 here).
      expect(typeof facade.writers[0]).toBe("function");
      expect(typeof facade.writers[1]).toBe("function");
    });

    it("starts out not destroyed", function () {
      const facade = new WebGPUVertexArrayFacade(
        stubDevice(),
        twoFloatAttributes(),
        4,
      );
      expect(facade.isDestroyed()).toBe(false);
    });
  });

  describe("writers (CPU-side, no device)", function () {
    // The facade groups same-usage attributes into one interleaved buffer.
    // FLOAT-3 (index 0) + FLOAT-2 (index 1) → stride of 20 bytes = 5 floats.
    // Both views alias the same ArrayBuffer, so the writers interleave.
    it("writes interleaved components into the shared array view", function () {
      const facade = new WebGPUVertexArrayFacade(
        stubDevice(),
        twoFloatAttributes(),
        2,
      );

      // vertexSizeInComponentType (stride in float units) = 20 / 4 = 5.
      facade.writers[0](0, 1, 2, 3); // vertex 0, index-0 attr → floats 0..2
      facade.writers[1](0, 4, 5); // vertex 0, index-1 attr → floats 3..4

      // Reach into the managed buffer to confirm the bytes landed where the
      // offset math says they should. (No device touched.)
      const managed = facade._allBuffers[0];
      const floats = new Float32Array(managed.arrayBuffer);
      expect(floats[0]).toBe(1);
      expect(floats[1]).toBe(2);
      expect(floats[2]).toBe(3);
      expect(floats[3]).toBe(4);
      expect(floats[4]).toBe(5);
    });

    it("offsets the second vertex by the full stride", function () {
      const facade = new WebGPUVertexArrayFacade(
        stubDevice(),
        twoFloatAttributes(),
        2,
      );

      facade.writers[0](1, 7, 8, 9); // vertex 1 → floats 5..7 (stride 5)
      const floats = new Float32Array(facade._allBuffers[0].arrayBuffer);
      expect(floats[5]).toBe(7);
      expect(floats[6]).toBe(8);
      expect(floats[7]).toBe(9);
    });

    it("flags the managed buffer for commit after a write", function () {
      const facade = new WebGPUVertexArrayFacade(
        stubDevice(),
        twoFloatAttributes(),
        2,
      );
      expect(facade._allBuffers[0].needsCommit).toBe(false);
      facade.writers[0](0, 1, 2, 3);
      expect(facade._allBuffers[0].needsCommit).toBe(true);
    });
  });

  describe("resize (CPU-side, no device)", function () {
    it("updates size and rebuilds writers", function () {
      const facade = new WebGPUVertexArrayFacade(
        stubDevice(),
        twoFloatAttributes(),
        2,
      );
      facade.resize(10);
      expect(facade.size).toBe(10);
      expect(typeof facade.writers[0]).toBe("function");
      expect(typeof facade.writers[1]).toBe("function");
    });

    it("grows the backing ArrayBuffer to the new vertex count", function () {
      const facade = new WebGPUVertexArrayFacade(
        stubDevice(),
        twoFloatAttributes(),
        2,
      );
      const managed = facade._allBuffers[0];
      // stride = 20 bytes; 2 vertices → 40 bytes.
      expect(managed.arrayBuffer.byteLength).toBe(40);
      facade.resize(5);
      // 5 vertices → 100 bytes.
      expect(facade._allBuffers[0].arrayBuffer.byteLength).toBe(100);
    });

    it("preserves previously written data when growing", function () {
      const facade = new WebGPUVertexArrayFacade(
        stubDevice(),
        twoFloatAttributes(),
        2,
      );
      facade.writers[0](0, 11, 22, 33);
      facade.resize(4);
      const floats = new Float32Array(facade._allBuffers[0].arrayBuffer);
      expect(floats[0]).toBe(11);
      expect(floats[1]).toBe(22);
      expect(floats[2]).toBe(33);
    });
  });

  describe("subCommit range validation (throws before any device call)", function () {
    it("throws when offsetInVertices is negative", function () {
      const facade = new WebGPUVertexArrayFacade(
        stubDevice(),
        twoFloatAttributes(),
        4,
      );
      expect(function () {
        facade.subCommit(-1, 1);
      }).toThrowDeveloperError();
    });

    it("throws when offsetInVertices is at or past size", function () {
      const facade = new WebGPUVertexArrayFacade(
        stubDevice(),
        twoFloatAttributes(),
        4,
      );
      expect(function () {
        facade.subCommit(4, 1);
      }).toThrowDeveloperError();
    });

    it("throws when the range exceeds the buffer size", function () {
      const facade = new WebGPUVertexArrayFacade(
        stubDevice(),
        twoFloatAttributes(),
        4,
      );
      expect(function () {
        facade.subCommit(2, 3);
      }).toThrowDeveloperError();
    });

    it("does not throw for an in-range request (no dirty buffers → no device call)", function () {
      const facade = new WebGPUVertexArrayFacade(
        stubDevice(),
        twoFloatAttributes(),
        4,
      );
      // No writes → needsCommit false → the loop body (writeBuffer) is
      // skipped, so no device/queue is needed.
      expect(function () {
        facade.subCommit(0, 2);
      }).not.toThrow();
    });
  });

  describe("endSubCommits (CPU-side, no device)", function () {
    it("clears the dirty flag on every managed buffer", function () {
      const facade = new WebGPUVertexArrayFacade(
        stubDevice(),
        twoFloatAttributes(),
        2,
      );
      facade.writers[0](0, 1, 2, 3);
      expect(facade._allBuffers[0].needsCommit).toBe(true);
      facade.endSubCommits();
      expect(facade._allBuffers[0].needsCommit).toBe(false);
    });
  });

  describe("destroy / isDestroyed (CPU-side, no GPU buffers allocated)", function () {
    it("reports destroyed after destroy() and is idempotent", function () {
      const facade = new WebGPUVertexArrayFacade(
        stubDevice(),
        twoFloatAttributes(),
        4,
      );
      facade.destroy();
      expect(facade.isDestroyed()).toBe(true);
      // No gpuBuffer was ever created, so destroy() never calls
      // buffer.gpuBuffer.destroy() — safe without a device.
      expect(facade.writers.length).toBe(0);
    });
  });

  // ── Pure static helpers ───────────────────────────────────────────
  //
  // These operate on the array passed in directly (the constructor sorts
  // first, but the helpers themselves do not), so every assertion below
  // passes a pre-shaped array and copies the expected math straight from
  // the source.

  describe("_verifyAttributes", function () {
    it("fills in the documented defaults", function () {
      const out = WebGPUVertexArrayFacade._verifyAttributes([
        { componentsPerAttribute: 3 },
      ]);
      const a = out[0];
      // index defaults to the array position.
      expect(a.index).toBe(0);
      expect(a.enabled).toBe(true);
      expect(a.componentDatatype).toBe(ComponentDatatype.FLOAT);
      expect(a.normalize).toBe(false);
      // usage defaults to STATIC_DRAW (0x88e4).
      expect(a.usage).toBe(0x88e4);
    });

    it("preserves explicitly supplied fields", function () {
      const out = WebGPUVertexArrayFacade._verifyAttributes([
        {
          index: 7,
          enabled: false,
          componentsPerAttribute: 2,
          componentDatatype: ComponentDatatype.UNSIGNED_SHORT,
          normalize: true,
          usage: 0x88e8, // DYNAMIC_DRAW
        },
      ]);
      const a = out[0];
      expect(a.index).toBe(7);
      expect(a.enabled).toBe(false);
      expect(a.componentsPerAttribute).toBe(2);
      expect(a.componentDatatype).toBe(ComponentDatatype.UNSIGNED_SHORT);
      expect(a.normalize).toBe(true);
      expect(a.usage).toBe(0x88e8);
    });

    it("defaults index to array position when omitted", function () {
      const out = WebGPUVertexArrayFacade._verifyAttributes([
        { componentsPerAttribute: 1 },
        { componentsPerAttribute: 1 },
      ]);
      expect(out[0].index).toBe(0);
      expect(out[1].index).toBe(1);
    });

    it("throws on a duplicate index", function () {
      expect(function () {
        WebGPUVertexArrayFacade._verifyAttributes([
          { index: 2, componentsPerAttribute: 1 },
          { index: 2, componentsPerAttribute: 1 },
        ]);
      }).toThrowDeveloperError();
    });

    it("throws when componentsPerAttribute is out of [1,4]", function () {
      expect(function () {
        WebGPUVertexArrayFacade._verifyAttributes([
          { componentsPerAttribute: 5 },
        ]);
      }).toThrowDeveloperError();
    });
  });

  describe("_vertexSizeInBytes", function () {
    it("computes a single FLOAT-3 attribute as 12 bytes", function () {
      // 3 comps * 4 bytes = 12; 12 % 4 == 0 → no padding.
      expect(
        WebGPUVertexArrayFacade._vertexSizeInBytes([
          {
            componentsPerAttribute: 3,
            componentDatatype: ComponentDatatype.FLOAT,
          },
        ]),
      ).toBe(12);
    });

    it("sums FLOAT-3 + FLOAT-2 to 20 bytes", function () {
      // 12 + 8 = 20; aligned to 4 → 20.
      expect(
        WebGPUVertexArrayFacade._vertexSizeInBytes([
          {
            componentsPerAttribute: 3,
            componentDatatype: ComponentDatatype.FLOAT,
          },
          {
            componentsPerAttribute: 2,
            componentDatatype: ComponentDatatype.FLOAT,
          },
        ]),
      ).toBe(20);
    });

    it("pads a FLOAT-3 + UNSIGNED_BYTE-1 layout up to 16 bytes", function () {
      // 12 + 1 = 13; maxCompSize = first attr (FLOAT) = 4; 13 % 4 == 1 →
      // +3 = 16; 16 % 4 == 0 → 16.
      expect(
        WebGPUVertexArrayFacade._vertexSizeInBytes([
          {
            componentsPerAttribute: 3,
            componentDatatype: ComponentDatatype.FLOAT,
          },
          {
            componentsPerAttribute: 1,
            componentDatatype: ComponentDatatype.UNSIGNED_BYTE,
          },
        ]),
      ).toBe(16);
    });

    it("rounds a SHORT-1 attribute up to the 4-byte WebGPU stride minimum", function () {
      // 1 comp * 2 bytes = 2; maxCompSize = 2, 2 % 2 == 0; rem4: 2 % 4 == 2
      // → +2 = 4.
      expect(
        WebGPUVertexArrayFacade._vertexSizeInBytes([
          {
            componentsPerAttribute: 1,
            componentDatatype: ComponentDatatype.SHORT,
          },
        ]),
      ).toBe(4);
    });

    it("rounds a SHORT-3 attribute up to 8 bytes", function () {
      // 3 * 2 = 6; maxCompSize 2, 6 % 2 == 0; rem4: 6 % 4 == 2 → +2 = 8.
      expect(
        WebGPUVertexArrayFacade._vertexSizeInBytes([
          {
            componentsPerAttribute: 3,
            componentDatatype: ComponentDatatype.SHORT,
          },
        ]),
      ).toBe(8);
    });

    it("defaults a datatype-less attribute to FLOAT sizing", function () {
      // No componentDatatype → FLOAT → 4 comps * 4 = 16.
      expect(
        WebGPUVertexArrayFacade._vertexSizeInBytes([
          { componentsPerAttribute: 4 },
        ]),
      ).toBe(16);
    });
  });

  describe("_createArrayViews", function () {
    it("assigns sequential byte offsets per attribute", function () {
      const views = WebGPUVertexArrayFacade._createArrayViews(
        [
          {
            index: 0,
            componentsPerAttribute: 3,
            componentDatatype: ComponentDatatype.FLOAT,
          },
          {
            index: 1,
            componentsPerAttribute: 2,
            componentDatatype: ComponentDatatype.FLOAT,
          },
        ],
        20,
      );
      expect(views.length).toBe(2);
      // First attr starts at 0.
      expect(views[0].offsetInBytes).toBe(0);
      // Second attr starts after 3 floats = 12 bytes.
      expect(views[1].offsetInBytes).toBe(12);
    });

    it("computes vertexSizeInComponentType as stride / component size", function () {
      const views = WebGPUVertexArrayFacade._createArrayViews(
        [
          {
            index: 0,
            componentsPerAttribute: 3,
            componentDatatype: ComponentDatatype.FLOAT,
          },
          {
            index: 1,
            componentsPerAttribute: 2,
            componentDatatype: ComponentDatatype.FLOAT,
          },
        ],
        20,
      );
      // 20-byte stride / 4-byte float = 5 component slots per vertex.
      expect(views[0].vertexSizeInComponentType).toBe(5);
      expect(views[1].vertexSizeInComponentType).toBe(5);
    });

    it("carries through index, enabled, datatype and normalize", function () {
      const views = WebGPUVertexArrayFacade._createArrayViews(
        [
          {
            index: 4,
            enabled: false,
            componentsPerAttribute: 2,
            componentDatatype: ComponentDatatype.UNSIGNED_SHORT,
            normalize: true,
          },
        ],
        4,
      );
      const v = views[0];
      expect(v.index).toBe(4);
      expect(v.enabled).toBe(false);
      expect(v.componentDatatype).toBe(ComponentDatatype.UNSIGNED_SHORT);
      expect(v.normalize).toBe(true);
      // stride 4 / short size 2 = 2.
      expect(v.vertexSizeInComponentType).toBe(2);
    });

    it("leaves the typed view unpopulated until resize() fills it", function () {
      // _createArrayViews sets view.view to undefined; only _resizeBuffer
      // (driven by resize()) materializes the typed array.
      const views = WebGPUVertexArrayFacade._createArrayViews(
        [
          {
            index: 0,
            componentsPerAttribute: 1,
            componentDatatype: ComponentDatatype.FLOAT,
          },
        ],
        4,
      );
      expect(views[0].view).toBeUndefined();
    });
  });
});
