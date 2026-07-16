import {
  ensurePickId,
  destroyPickIds,
  buildPickPipelineDescriptor,
  attachPickToColorCommand,
  attachPickVariantsToColorCommand,
  findFirstGeometryInstancePickId,
} from "../../../Source/Renderer/WebGPU/WebGPUPickCommandHelpers.js";

// These specs are pure-function tests — the helpers operate over plain JS
// objects (cache slots, descriptors, command bags) and a narrow
// `PickIdContext` interface. No GPUDevice / queue is needed: every pick-id
// is faked with an object carrying a `destroy()` spy, and the pipeline
// descriptor cloning is pure data transformation. We assert the lifecycle
// (allocate / cache / re-allocate / destroy) and the descriptor byte-shape
// (blend stripped, fragment entry swapped, multisample dropped, depth-write
// override) so a careless refactor of the boilerplate fails fast in CI.

describe("Renderer/WebGPU/WebGPUPickCommandHelpers", function () {
  // A fake CesiumPickId: just needs a `destroy()` so we can assert teardown.
  function makePickId(label) {
    return {
      label: label,
      destroyed: false,
      destroy: function () {
        this.destroyed = true;
      },
    };
  }

  // A fake PickIdContext that records how it was called and hands back a
  // fresh fake pickId each time, so we can assert allocation count + the
  // payload `{ primitive, id }` and `kind` arguments.
  function makeContext() {
    const calls = [];
    return {
      calls: calls,
      createPickId: function (object, kind) {
        const created = makePickId(`pick-${calls.length}`);
        calls.push({ object: object, kind: kind, created: created });
        return created;
      },
    };
  }

  describe("findFirstGeometryInstancePickId", function () {
    it("finds the canonical id through Ground/Classification wrapper depth", function () {
      const canonical = makePickId("geometry-instance");
      const innerPrimitive = { _pickIds: [canonical] };
      const classificationPrimitive = { _primitive: innerPrimitive };
      const groundPrimitive = { _primitive: classificationPrimitive };

      expect(findFirstGeometryInstancePickId(groundPrimitive)).toBe(canonical);
      expect(findFirstGeometryInstancePickId(classificationPrimitive)).toBe(
        canonical,
      );
      expect(findFirstGeometryInstancePickId(innerPrimitive)).toBe(canonical);
    });

    it("returns undefined without allocating when the inner primitive is not ready", function () {
      const wrapper = { _primitive: { _primitive: {} } };
      expect(findFirstGeometryInstancePickId(wrapper)).toBeUndefined();
      expect(wrapper._pickId).toBeUndefined();
    });
  });

  describe("ensurePickId — single-id mode", function () {
    it("allocates a pickId on first call and caches it", function () {
      const target = { id: "primA" };
      const context = makeContext();
      const cache = {};

      const result = ensurePickId(target, context, cache);

      expect(context.calls.length).toBe(1);
      expect(result).toBe(cache._pickId);
      expect(cache._pickId).toBe(context.calls[0].created);
      expect(cache._pickIdLastId).toBe("primA");
    });

    it("defaults the pick kind to 'primitive'", function () {
      const target = { id: "primA" };
      const context = makeContext();
      ensurePickId(target, context, {});
      expect(context.calls[0].kind).toBe("primitive");
    });

    it("passes through a custom pick kind", function () {
      const target = { id: "primA" };
      const context = makeContext();
      ensurePickId(target, context, {}, { kind: "model" });
      expect(context.calls[0].kind).toBe("model");
    });

    it("builds the pick payload from target + target.id", function () {
      const target = { id: "primA" };
      const context = makeContext();
      ensurePickId(target, context, {});
      expect(context.calls[0].object.primitive).toBe(target);
      expect(context.calls[0].object.id).toBe("primA");
    });

    it("returns the cached id without re-allocating when id is unchanged", function () {
      const target = { id: "primA" };
      const context = makeContext();
      const cache = {};

      const first = ensurePickId(target, context, cache);
      const second = ensurePickId(target, context, cache);

      expect(second).toBe(first);
      expect(context.calls.length).toBe(1);
    });

    it("re-allocates and destroys the stale id when target.id changes", function () {
      const target = { id: "primA" };
      const context = makeContext();
      const cache = {};

      const first = ensurePickId(target, context, cache);
      // Reassign the primitive's runtime id; stale color must be reclaimed.
      target.id = "primB";
      const second = ensurePickId(target, context, cache);

      expect(context.calls.length).toBe(2);
      expect(first.destroyed).toBe(true);
      expect(second).not.toBe(first);
      expect(cache._pickId).toBe(second);
      expect(cache._pickIdLastId).toBe("primB");
    });

    it("does not allocate when allowAllocate is false and nothing is cached", function () {
      const target = { id: "primA" };
      const context = makeContext();
      const cache = {};

      const result = ensurePickId(target, context, cache, {
        allowAllocate: false,
      });

      expect(result).toBeUndefined();
      expect(context.calls.length).toBe(0);
      expect(cache._pickId).toBeUndefined();
    });

    it("returns the existing cached id when allowAllocate is false even if id changed", function () {
      const target = { id: "primA" };
      const context = makeContext();
      const cache = {};

      const first = ensurePickId(target, context, cache);
      target.id = "primB";
      const result = ensurePickId(target, context, cache, {
        allowAllocate: false,
      });

      // No re-allocation; returns the stale cached id rather than undefined.
      expect(result).toBe(first);
      expect(context.calls.length).toBe(1);
      expect(first.destroyed).toBe(false);
    });
  });

  describe("ensurePickId — multi-id mode", function () {
    it("creates the pickIds map and allocates one entry per key", function () {
      const target = {};
      const context = makeContext();
      const cache = {};

      const a = ensurePickId(target, context, cache, { idKey: "0_0" });
      const b = ensurePickId(target, context, cache, { idKey: "0_1" });

      expect(context.calls.length).toBe(2);
      expect(cache.pickIds["0_0"]).toBe(a);
      expect(cache.pickIds["0_1"]).toBe(b);
      expect(a).not.toBe(b);
    });

    it("uses the idKey as the payload id", function () {
      const target = {};
      const context = makeContext();
      ensurePickId(target, context, {}, { idKey: "3_7" });
      expect(context.calls[0].object.primitive).toBe(target);
      expect(context.calls[0].object.id).toBe("3_7");
    });

    it("returns the cached entry without re-allocating for a known key", function () {
      const target = {};
      const context = makeContext();
      const cache = {};

      const first = ensurePickId(target, context, cache, { idKey: "0_0" });
      const second = ensurePickId(target, context, cache, { idKey: "0_0" });

      expect(second).toBe(first);
      expect(context.calls.length).toBe(1);
    });

    it("returns undefined and skips map creation when allowAllocate is false and map is absent", function () {
      const context = makeContext();
      const cache = {};

      const result = ensurePickId({}, context, cache, {
        idKey: "0_0",
        allowAllocate: false,
      });

      expect(result).toBeUndefined();
      expect(cache.pickIds).toBeUndefined();
      expect(context.calls.length).toBe(0);
    });

    it("returns undefined for an unknown key when allowAllocate is false but map exists", function () {
      const context = makeContext();
      const cache = {};

      // Seed the map with one entry.
      ensurePickId({}, context, cache, { idKey: "0_0" });
      const result = ensurePickId({}, context, cache, {
        idKey: "9_9",
        allowAllocate: false,
      });

      expect(result).toBeUndefined();
      expect(context.calls.length).toBe(1);
    });
  });

  describe("destroyPickIds", function () {
    it("is a no-op when given undefined", function () {
      expect(function () {
        destroyPickIds(undefined);
      }).not.toThrow();
    });

    it("destroys and clears the single-id slot", function () {
      const pickId = makePickId("single");
      const cache = { _pickId: pickId, _pickIdLastId: "primA" };

      destroyPickIds(cache);

      expect(pickId.destroyed).toBe(true);
      expect(cache._pickId).toBeUndefined();
      expect(cache._pickIdLastId).toBeUndefined();
    });

    it("destroys every entry and clears the multi-id slot", function () {
      const a = makePickId("a");
      const b = makePickId("b");
      const cache = { pickIds: { "0_0": a, "0_1": b } };

      destroyPickIds(cache);

      expect(a.destroyed).toBe(true);
      expect(b.destroyed).toBe(true);
      expect(cache.pickIds).toBeUndefined();
    });

    it("destroys both slots when a cache carries single + multi ids", function () {
      const single = makePickId("single");
      const multi = makePickId("multi");
      const cache = {
        _pickId: single,
        _pickIdLastId: "primA",
        pickIds: { "0_0": multi },
      };

      destroyPickIds(cache);

      expect(single.destroyed).toBe(true);
      expect(multi.destroyed).toBe(true);
      expect(cache._pickId).toBeUndefined();
      expect(cache._pickIdLastId).toBeUndefined();
      expect(cache.pickIds).toBeUndefined();
    });

    it("is a no-op on an empty cache", function () {
      const cache = {};
      expect(function () {
        destroyPickIds(cache);
      }).not.toThrow();
      expect(cache._pickId).toBeUndefined();
      expect(cache.pickIds).toBeUndefined();
    });
  });

  describe("buildPickPipelineDescriptor", function () {
    // A minimal color descriptor matching the WebGPURenderPipelineDescriptor
    // shape the helper reads. Module references are opaque sentinels so we can
    // assert they pass through by identity.
    const vertexModule = { tag: "vertexModule" };
    const fragmentModule = { tag: "fragmentModule" };

    function makeColorDescriptor(overrides) {
      const base = {
        name: "MyColor",
        layout: { tag: "layout" },
        vertex: {
          module: vertexModule,
          entryPoint: "vertexMain",
          buffers: [{ tag: "vb" }],
        },
        fragment: {
          module: fragmentModule,
          entryPoint: "fragmentMain",
          targets: [
            {
              format: "rgba8unorm",
              blend: {
                color: { srcFactor: "src-alpha" },
                alpha: { srcFactor: "one" },
              },
              writeMask: 0xf,
            },
          ],
        },
        primitive: { topology: "triangle-list" },
        depthStencil: {
          format: "depth24plus",
          depthWriteEnabled: false,
          depthCompare: "less",
        },
        multisample: { count: 4 },
      };
      return Object.assign(base, overrides);
    }

    it("strips blend from color targets while preserving format and writeMask", function () {
      const color = makeColorDescriptor();
      const pick = buildPickPipelineDescriptor(color, "fragmentPickMain");

      expect(pick.fragment.targets.length).toBe(1);
      const target = pick.fragment.targets[0];
      expect(target.blend).toBeUndefined();
      expect(target.format).toBe("rgba8unorm");
      expect(target.writeMask).toBe(0xf);
    });

    it("swaps the fragment entry point to the supplied pick entry", function () {
      const color = makeColorDescriptor();
      const pick = buildPickPipelineDescriptor(color, "fragmentPickMain");
      expect(pick.fragment.entryPoint).toBe("fragmentPickMain");
      // Module reference is preserved (helper does NOT swap the module).
      expect(pick.fragment.module).toBe(fragmentModule);
    });

    it("does not mutate the input color descriptor", function () {
      const color = makeColorDescriptor();
      buildPickPipelineDescriptor(color, "fragmentPickMain");
      // Blend on the original target must remain intact.
      expect(color.fragment.targets[0].blend).toBeDefined();
      expect(color.fragment.entryPoint).toBe("fragmentMain");
      expect(color.multisample).toEqual({ count: 4 });
    });

    it("preserves the vertex stage (module, entryPoint, buffers)", function () {
      const color = makeColorDescriptor();
      const pick = buildPickPipelineDescriptor(color, "fragmentPickMain");
      expect(pick.vertex.module).toBe(vertexModule);
      expect(pick.vertex.entryPoint).toBe("vertexMain");
      expect(pick.vertex.buffers).toBe(color.vertex.buffers);
    });

    it("preserves layout and primitive references", function () {
      const color = makeColorDescriptor();
      const pick = buildPickPipelineDescriptor(color, "fragmentPickMain");
      expect(pick.layout).toBe(color.layout);
      expect(pick.primitive).toBe(color.primitive);
    });

    it("drops the multisample state so the pick pipeline is single-sample", function () {
      const color = makeColorDescriptor();
      const pick = buildPickPipelineDescriptor(color, "fragmentPickMain");
      expect(pick.multisample).toBeUndefined();
    });

    it("defaults the name to '<color> pick'", function () {
      const color = makeColorDescriptor();
      const pick = buildPickPipelineDescriptor(color, "fragmentPickMain");
      expect(pick.name).toBe("MyColor pick");
    });

    it("honors a name override", function () {
      const color = makeColorDescriptor();
      const pick = buildPickPipelineDescriptor(color, "fragmentPickMain", {
        name: "CustomPick",
      });
      expect(pick.name).toBe("CustomPick");
    });

    it("forces depthWriteEnabled true by default", function () {
      const color = makeColorDescriptor();
      // Color descriptor has depthWriteEnabled:false; default override → true.
      const pick = buildPickPipelineDescriptor(color, "fragmentPickMain");
      expect(pick.depthStencil.depthWriteEnabled).toBe(true);
    });

    it("inherits the color depthWriteEnabled when forceDepthWriteEnabled is false", function () {
      const color = makeColorDescriptor();
      color.depthStencil.depthWriteEnabled = false;
      const pick = buildPickPipelineDescriptor(color, "fragmentPickMain", {
        forceDepthWriteEnabled: false,
      });
      expect(pick.depthStencil.depthWriteEnabled).toBe(false);
    });

    it("preserves the depthStencil format/compare while overriding write", function () {
      const color = makeColorDescriptor();
      const pick = buildPickPipelineDescriptor(color, "fragmentPickMain");
      expect(pick.depthStencil.format).toBe("depth24plus");
      expect(pick.depthStencil.depthCompare).toBe("less");
    });

    it("leaves depthStencil undefined when the color descriptor has none", function () {
      const color = makeColorDescriptor({ depthStencil: undefined });
      const pick = buildPickPipelineDescriptor(color, "fragmentPickMain");
      expect(pick.depthStencil).toBeUndefined();
    });

    it("filters out the rgba16float G-buffer target", function () {
      const color = makeColorDescriptor();
      color.fragment.targets = [
        { format: "rgba8unorm", blend: { color: {} }, writeMask: 0xf },
        { format: "rgba16float", writeMask: 0xf },
      ];
      const pick = buildPickPipelineDescriptor(color, "fragmentPickMain");
      expect(pick.fragment.targets.length).toBe(1);
      expect(pick.fragment.targets[0].format).toBe("rgba8unorm");
    });

    it("filters out null/undefined color targets", function () {
      const color = makeColorDescriptor();
      color.fragment.targets = [
        { format: "rgba8unorm", writeMask: 0xf },
        null,
        undefined,
      ];
      const pick = buildPickPipelineDescriptor(color, "fragmentPickMain");
      expect(pick.fragment.targets.length).toBe(1);
      expect(pick.fragment.targets[0].format).toBe("rgba8unorm");
    });

    it("throws when the color descriptor has no fragment stage", function () {
      const color = makeColorDescriptor({ fragment: undefined });
      expect(function () {
        buildPickPipelineDescriptor(color, "fragmentPickMain");
      }).toThrowError(/has no fragment stage/);
    });
  });

  describe("attachPickToColorCommand", function () {
    it("creates the derivedCommands.picking slot when absent", function () {
      const colorCommand = {};
      const pickCommand = { tag: "pick" };
      attachPickToColorCommand(colorCommand, pickCommand);
      expect(colorCommand.derivedCommands.picking.pickCommand).toBe(
        pickCommand,
      );
    });

    it("adds picking to an existing derivedCommands bag", function () {
      const colorCommand = { derivedCommands: { other: { tag: "x" } } };
      const pickCommand = { tag: "pick" };
      attachPickToColorCommand(colorCommand, pickCommand);
      expect(colorCommand.derivedCommands.picking.pickCommand).toBe(
        pickCommand,
      );
      // Existing keys are preserved.
      expect(colorCommand.derivedCommands.other).toEqual({ tag: "x" });
    });

    it("replaces the pickCommand on an existing picking slot", function () {
      const first = { tag: "first" };
      const second = { tag: "second" };
      const colorCommand = {
        derivedCommands: { picking: { pickCommand: first } },
      };
      attachPickToColorCommand(colorCommand, second);
      expect(colorCommand.derivedCommands.picking.pickCommand).toBe(second);
    });

    it("is idempotent for the same pick command", function () {
      const colorCommand = {};
      const pickCommand = { tag: "pick" };
      attachPickToColorCommand(colorCommand, pickCommand);
      attachPickToColorCommand(colorCommand, pickCommand);
      expect(colorCommand.derivedCommands.picking.pickCommand).toBe(
        pickCommand,
      );
    });
  });

  describe("attachPickVariantsToColorCommand", function () {
    it("creates the derivedCommands.picking slot and sets hover variant", function () {
      const colorCommand = {};
      const hover = { tag: "hover" };
      attachPickVariantsToColorCommand(colorCommand, { hoverPick: hover });
      expect(colorCommand.derivedCommands.picking.pickHoverCommand).toBe(hover);
    });

    it("sets both precise pass commands", function () {
      const colorCommand = {};
      const pass1 = { tag: "p1" };
      const pass2 = { tag: "p2" };
      attachPickVariantsToColorCommand(colorCommand, {
        precisePass1: pass1,
        precisePass2: pass2,
      });
      expect(colorCommand.derivedCommands.picking.pickPrecisePass1Command).toBe(
        pass1,
      );
      expect(colorCommand.derivedCommands.picking.pickPrecisePass2Command).toBe(
        pass2,
      );
    });

    it("preserves an existing default pickCommand on the picking slot", function () {
      const defaultPick = { tag: "default" };
      const colorCommand = {
        derivedCommands: { picking: { pickCommand: defaultPick } },
      };
      attachPickVariantsToColorCommand(colorCommand, {
        hoverPick: { tag: "hover" },
      });
      expect(colorCommand.derivedCommands.picking.pickCommand).toBe(
        defaultPick,
      );
      expect(colorCommand.derivedCommands.picking.pickHoverCommand).toEqual({
        tag: "hover",
      });
    });

    it("leaves variant slots untouched when not supplied", function () {
      const colorCommand = {};
      attachPickVariantsToColorCommand(colorCommand, {});
      const picking = colorCommand.derivedCommands.picking;
      expect(picking.pickHoverCommand).toBeUndefined();
      expect(picking.pickPrecisePass1Command).toBeUndefined();
      expect(picking.pickPrecisePass2Command).toBeUndefined();
    });

    it("does not overwrite a sibling key in an existing derivedCommands bag", function () {
      const colorCommand = { derivedCommands: { other: { tag: "x" } } };
      attachPickVariantsToColorCommand(colorCommand, {
        hoverPick: { tag: "hover" },
      });
      expect(colorCommand.derivedCommands.other).toEqual({ tag: "x" });
      expect(colorCommand.derivedCommands.picking.pickHoverCommand).toEqual({
        tag: "hover",
      });
    });
  });
});
