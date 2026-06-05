import WebGPUGlobeTranslucencyState, {
  updateWebGPUGlobeTranslucencyDerivedCommands,
  destroyWebGPUGlobeTranslucencyResources,
  DerivedCommandType,
} from "../../../Source/Renderer/WebGPU/WebGPUGlobeTranslucencyState.js";

describe("Renderer/WebGPU/WebGPUGlobeTranslucencyState", function () {
  // This module is pure: it derives WebGPU render-state metadata (blend /
  // depth / cull / colorWrite flags) for the nine globe-translucency
  // derived-command types and stamps that metadata onto a plain command
  // object via a Map-backed cache. None of it touches a GPUDevice, queue,
  // pipeline, or bind group — every path operates on ordinary JS objects
  // and Maps — so it is fully exercisable under Karma without a backend.
  //
  // The asserted flag tables below are copied verbatim from
  // getDerivedCommandState() in the source. getDerivedCommandState is not
  // exported, so it is tested indirectly through
  // updateWebGPUGlobeTranslucencyDerivedCommands, which is the public
  // entry point that calls it and caches the result.

  // Minimal fakes that mirror the shapes the real GlobeTranslucencyState
  // and WebGPUDrawCommand expose to this module. Building them here keeps
  // the test free of any scene/context construction.
  function makeState(typesToUpdate) {
    return {
      _webgpuCache: undefined,
      _derivedCommandTypesToUpdate: typesToUpdate,
      _derivedCommandTypesToUpdateLength: typesToUpdate.length,
    };
  }

  function makeCommand() {
    return {};
  }

  describe("DerivedCommandType enum", function () {
    // These integer identities must match GlobeTranslucencyState's derived
    // command ordering; a silent renumber here would map a command to the
    // wrong blend/cull pipeline variant at draw time.
    it("assigns the documented contiguous identities", function () {
      expect(DerivedCommandType.OPAQUE_FRONT_FACE).toBe(0);
      expect(DerivedCommandType.OPAQUE_BACK_FACE).toBe(1);
      expect(DerivedCommandType.DEPTH_ONLY_FRONT_FACE).toBe(2);
      expect(DerivedCommandType.DEPTH_ONLY_BACK_FACE).toBe(3);
      expect(DerivedCommandType.DEPTH_ONLY_FRONT_AND_BACK_FACE).toBe(4);
      expect(DerivedCommandType.TRANSLUCENT_FRONT_FACE).toBe(5);
      expect(DerivedCommandType.TRANSLUCENT_BACK_FACE).toBe(6);
      expect(DerivedCommandType.TRANSLUCENT_FRONT_FACE_MANUAL_DEPTH_TEST).toBe(
        7,
      );
      expect(DerivedCommandType.TRANSLUCENT_BACK_FACE_MANUAL_DEPTH_TEST).toBe(
        8,
      );
    });

    it("uses a unique identity per type (no collisions)", function () {
      const values = Object.values(DerivedCommandType);
      expect(new Set(values).size).toBe(values.length);
      expect(values.length).toBe(9);
    });
  });

  describe("module exports", function () {
    it("exposes the same members as named and default exports", function () {
      expect(WebGPUGlobeTranslucencyState.DerivedCommandType).toBe(
        DerivedCommandType,
      );
      expect(
        WebGPUGlobeTranslucencyState.updateWebGPUGlobeTranslucencyDerivedCommands,
      ).toBe(updateWebGPUGlobeTranslucencyDerivedCommands);
      expect(
        WebGPUGlobeTranslucencyState.destroyWebGPUGlobeTranslucencyResources,
      ).toBe(destroyWebGPUGlobeTranslucencyResources);
    });
  });

  describe("updateWebGPUGlobeTranslucencyDerivedCommands — cache init", function () {
    it("lazily creates the _webgpuCache with an empty Map and initialized=true after update", function () {
      const state = makeState([DerivedCommandType.OPAQUE_FRONT_FACE]);
      const command = makeCommand();
      expect(state._webgpuCache).toBeUndefined();

      updateWebGPUGlobeTranslucencyDerivedCommands(state, command, {});

      expect(state._webgpuCache).toBeDefined();
      expect(state._webgpuCache.derivedCommands instanceof Map).toBe(true);
      // initialized flips to true at the end of the update call.
      expect(state._webgpuCache.initialized).toBe(true);
      // One type was requested, so exactly one entry got cached.
      expect(state._webgpuCache.derivedCommands.size).toBe(1);
    });

    it("stamps the command with the derived list, count, and translucent marker", function () {
      const types = [
        DerivedCommandType.OPAQUE_FRONT_FACE,
        DerivedCommandType.TRANSLUCENT_BACK_FACE,
      ];
      const state = makeState(types);
      const command = makeCommand();

      updateWebGPUGlobeTranslucencyDerivedCommands(state, command, {});

      expect(Array.isArray(command._webgpuTranslucencyDerived)).toBe(true);
      expect(command._webgpuTranslucencyDerivedCount).toBe(2);
      expect(command._webgpuDerivedTranslucent).toBe(true);
      // The stamped descriptors line up with the requested types in order.
      expect(command._webgpuTranslucencyDerived[0].type).toBe(
        DerivedCommandType.OPAQUE_FRONT_FACE,
      );
      expect(command._webgpuTranslucencyDerived[1].type).toBe(
        DerivedCommandType.TRANSLUCENT_BACK_FACE,
      );
    });

    it("handles a zero-length update list without populating the cache", function () {
      const state = makeState([]);
      const command = makeCommand();

      updateWebGPUGlobeTranslucencyDerivedCommands(state, command, {});

      expect(state._webgpuCache.derivedCommands.size).toBe(0);
      expect(command._webgpuTranslucencyDerivedCount).toBe(0);
      expect(command._webgpuDerivedTranslucent).toBe(true);
      expect(command._webgpuTranslucencyDerived).toEqual([]);
    });
  });

  describe("updateWebGPUGlobeTranslucencyDerivedCommands — derived state tables", function () {
    // Helper: run update for a single type and return the stamped descriptor.
    function deriveOne(type) {
      const state = makeState([type]);
      const command = makeCommand();
      updateWebGPUGlobeTranslucencyDerivedCommands(state, command, {});
      return command._webgpuTranslucencyDerived[0];
    }

    it("OPAQUE_FRONT_FACE: opaque, depth write+test, cull back only, color on", function () {
      expect(deriveOne(DerivedCommandType.OPAQUE_FRONT_FACE)).toEqual({
        type: DerivedCommandType.OPAQUE_FRONT_FACE,
        blendEnabled: false,
        depthWriteEnabled: true,
        depthTestEnabled: true,
        cullFront: false,
        cullBack: true,
        colorWriteEnabled: true,
      });
    });

    it("OPAQUE_BACK_FACE: opaque, depth write+test, cull front only, color on", function () {
      expect(deriveOne(DerivedCommandType.OPAQUE_BACK_FACE)).toEqual({
        type: DerivedCommandType.OPAQUE_BACK_FACE,
        blendEnabled: false,
        depthWriteEnabled: true,
        depthTestEnabled: true,
        cullFront: true,
        cullBack: false,
        colorWriteEnabled: true,
      });
    });

    it("DEPTH_ONLY_FRONT_FACE: no blend, depth write+test, cull back only, color OFF", function () {
      expect(deriveOne(DerivedCommandType.DEPTH_ONLY_FRONT_FACE)).toEqual({
        type: DerivedCommandType.DEPTH_ONLY_FRONT_FACE,
        blendEnabled: false,
        depthWriteEnabled: true,
        depthTestEnabled: true,
        cullFront: false,
        cullBack: true,
        colorWriteEnabled: false,
      });
    });

    it("DEPTH_ONLY_BACK_FACE: no blend, depth write+test, cull front only, color OFF", function () {
      expect(deriveOne(DerivedCommandType.DEPTH_ONLY_BACK_FACE)).toEqual({
        type: DerivedCommandType.DEPTH_ONLY_BACK_FACE,
        blendEnabled: false,
        depthWriteEnabled: true,
        depthTestEnabled: true,
        cullFront: true,
        cullBack: false,
        colorWriteEnabled: false,
      });
    });

    it("DEPTH_ONLY_FRONT_AND_BACK_FACE: no blend, depth write+test, cull neither, color OFF", function () {
      expect(
        deriveOne(DerivedCommandType.DEPTH_ONLY_FRONT_AND_BACK_FACE),
      ).toEqual({
        type: DerivedCommandType.DEPTH_ONLY_FRONT_AND_BACK_FACE,
        blendEnabled: false,
        depthWriteEnabled: true,
        depthTestEnabled: true,
        cullFront: false,
        cullBack: false,
        colorWriteEnabled: false,
      });
    });

    it("TRANSLUCENT_FRONT_FACE: blend on, depth test no write, cull back only, color on", function () {
      expect(deriveOne(DerivedCommandType.TRANSLUCENT_FRONT_FACE)).toEqual({
        type: DerivedCommandType.TRANSLUCENT_FRONT_FACE,
        blendEnabled: true,
        depthWriteEnabled: false,
        depthTestEnabled: true,
        cullFront: false,
        cullBack: true,
        colorWriteEnabled: true,
      });
    });

    it("TRANSLUCENT_BACK_FACE: blend on, depth test no write, cull front only, color on", function () {
      expect(deriveOne(DerivedCommandType.TRANSLUCENT_BACK_FACE)).toEqual({
        type: DerivedCommandType.TRANSLUCENT_BACK_FACE,
        blendEnabled: true,
        depthWriteEnabled: false,
        depthTestEnabled: true,
        cullFront: true,
        cullBack: false,
        colorWriteEnabled: true,
      });
    });

    it("TRANSLUCENT_FRONT_FACE_MANUAL_DEPTH_TEST: blend on, NO depth write+test, cull back only", function () {
      expect(
        deriveOne(DerivedCommandType.TRANSLUCENT_FRONT_FACE_MANUAL_DEPTH_TEST),
      ).toEqual({
        type: DerivedCommandType.TRANSLUCENT_FRONT_FACE_MANUAL_DEPTH_TEST,
        blendEnabled: true,
        depthWriteEnabled: false,
        depthTestEnabled: false,
        cullFront: false,
        cullBack: true,
        colorWriteEnabled: true,
      });
    });

    it("TRANSLUCENT_BACK_FACE_MANUAL_DEPTH_TEST: blend on, NO depth write+test, cull front only", function () {
      expect(
        deriveOne(DerivedCommandType.TRANSLUCENT_BACK_FACE_MANUAL_DEPTH_TEST),
      ).toEqual({
        type: DerivedCommandType.TRANSLUCENT_BACK_FACE_MANUAL_DEPTH_TEST,
        blendEnabled: true,
        depthWriteEnabled: false,
        depthTestEnabled: false,
        cullFront: true,
        cullBack: false,
        colorWriteEnabled: true,
      });
    });

    it("falls back to the opaque-front default for an unknown type", function () {
      // The switch default mirrors OPAQUE_FRONT_FACE's flags but preserves
      // the caller-supplied (unknown) type value.
      const unknownType = 999;
      expect(deriveOne(unknownType)).toEqual({
        type: unknownType,
        blendEnabled: false,
        depthWriteEnabled: true,
        depthTestEnabled: true,
        cullFront: false,
        cullBack: true,
        colorWriteEnabled: true,
      });
    });
  });

  describe("updateWebGPUGlobeTranslucencyDerivedCommands — caching", function () {
    it("reuses the same derived-state object across repeated updates of one type", function () {
      const state = makeState([DerivedCommandType.TRANSLUCENT_FRONT_FACE]);
      const command1 = makeCommand();
      const command2 = makeCommand();

      updateWebGPUGlobeTranslucencyDerivedCommands(state, command1, {});
      const first = command1._webgpuTranslucencyDerived[0];

      // Second frame, same state cache, different command — should return
      // the cached descriptor instance, not recompute a fresh object.
      updateWebGPUGlobeTranslucencyDerivedCommands(state, command2, {});
      const second = command2._webgpuTranslucencyDerived[0];

      expect(second).toBe(first);
      expect(state._webgpuCache.derivedCommands.size).toBe(1);
    });

    it("caches one entry per distinct type", function () {
      const state = makeState([
        DerivedCommandType.OPAQUE_FRONT_FACE,
        DerivedCommandType.OPAQUE_BACK_FACE,
        DerivedCommandType.TRANSLUCENT_FRONT_FACE,
      ]);
      const command = makeCommand();

      updateWebGPUGlobeTranslucencyDerivedCommands(state, command, {});

      expect(state._webgpuCache.derivedCommands.size).toBe(3);
      expect(
        state._webgpuCache.derivedCommands.has(
          DerivedCommandType.OPAQUE_FRONT_FACE,
        ),
      ).toBe(true);
      expect(
        state._webgpuCache.derivedCommands.has(
          DerivedCommandType.OPAQUE_BACK_FACE,
        ),
      ).toBe(true);
      expect(
        state._webgpuCache.derivedCommands.has(
          DerivedCommandType.TRANSLUCENT_FRONT_FACE,
        ),
      ).toBe(true);
    });

    it("preserves a pre-existing cache instead of replacing it", function () {
      const state = makeState([DerivedCommandType.OPAQUE_FRONT_FACE]);
      const command = makeCommand();

      updateWebGPUGlobeTranslucencyDerivedCommands(state, command, {});
      const cacheRef = state._webgpuCache;

      updateWebGPUGlobeTranslucencyDerivedCommands(state, makeCommand(), {});

      // The same cache object is kept across frames (not re-allocated).
      expect(state._webgpuCache).toBe(cacheRef);
    });

    it("reuses a pre-existing _webgpuTranslucencyDerived array on the command", function () {
      const state = makeState([DerivedCommandType.OPAQUE_FRONT_FACE]);
      const command = makeCommand();

      updateWebGPUGlobeTranslucencyDerivedCommands(state, command, {});
      const arrRef = command._webgpuTranslucencyDerived;

      updateWebGPUGlobeTranslucencyDerivedCommands(state, command, {});

      // The array is only allocated when absent; subsequent updates write
      // into the existing array.
      expect(command._webgpuTranslucencyDerived).toBe(arrRef);
    });
  });

  describe("destroyWebGPUGlobeTranslucencyResources", function () {
    it("clears the derived-command Map and drops the cache reference", function () {
      const state = makeState([
        DerivedCommandType.OPAQUE_FRONT_FACE,
        DerivedCommandType.TRANSLUCENT_FRONT_FACE,
      ]);
      const command = makeCommand();
      updateWebGPUGlobeTranslucencyDerivedCommands(state, command, {});

      const mapRef = state._webgpuCache.derivedCommands;
      expect(mapRef.size).toBe(2);

      destroyWebGPUGlobeTranslucencyResources(state);

      // The Map is cleared before the cache reference is dropped.
      expect(mapRef.size).toBe(0);
      expect(state._webgpuCache).toBeUndefined();
    });

    it("is a no-op when no cache was ever created", function () {
      const state = makeState([DerivedCommandType.OPAQUE_FRONT_FACE]);
      expect(state._webgpuCache).toBeUndefined();

      expect(function () {
        destroyWebGPUGlobeTranslucencyResources(state);
      }).not.toThrow();

      expect(state._webgpuCache).toBeUndefined();
    });
  });
});
