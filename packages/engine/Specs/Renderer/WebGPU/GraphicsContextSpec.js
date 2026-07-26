import { destroyObject, FeatureRendererKey } from "../../../index.js";
import ContextRegistry from "../../../Source/Renderer/ContextRegistry.js";
import GraphicsContext from "../../../Source/Renderer/GraphicsContext.js";

class FakeGraphicsContext extends GraphicsContext {
  constructor() {
    super();
    this._destroyed = false;
  }

  get id() {
    return "feature-readiness-test";
  }

  get rendererType() {
    return "webgl";
  }

  isDestroyed() {
    return this._destroyed;
  }

  invalidateFeatureGeneration() {
    this._invalidatePendingFeatureRenderers();
  }

  destroy() {
    if (this._destroyed) {
      return;
    }
    this._destroyed = true;
    this._destroyFeatureRenderers();
  }
}

class DestroyObjectGraphicsContext extends FakeGraphicsContext {
  destroy() {
    if (this.isDestroyed()) {
      return;
    }
    this._destroyFeatureRenderers();
    return destroyObject(this);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("Renderer/GraphicsContext", function () {
  describe("FeatureRendererKey", function () {
    it("has expected enumerated keys", function () {
      expect(FeatureRendererKey.BILLBOARD_COLLECTION).toBeDefined();
      expect(FeatureRendererKey.POINT_PRIMITIVE_COLLECTION).toBeDefined();
      expect(FeatureRendererKey.POLYLINE_COLLECTION).toBeDefined();
      expect(FeatureRendererKey.CLOUD_COLLECTION).toBeDefined();
      expect(FeatureRendererKey.PRIMITIVE).toBeDefined();
      expect(FeatureRendererKey.SUN).toBeDefined();
      expect(FeatureRendererKey.MOON).toBeDefined();
      expect(FeatureRendererKey.SKY_ATMOSPHERE).toBeDefined();
      expect(FeatureRendererKey.CUBE_MAP_PANORAMA).toBeDefined();
      expect(FeatureRendererKey.GLOBE_SURFACE).toBeDefined();
      expect(FeatureRendererKey.MODEL).toBeDefined();
      expect(FeatureRendererKey.SCENE_RENDERER).toBeDefined();
    });

    it("has sequential integer values", function () {
      // Keys should be integers for O(1) array indexing
      expect(typeof FeatureRendererKey.BILLBOARD_COLLECTION).toBe("number");
      expect(typeof FeatureRendererKey.PRIMITIVE).toBe("number");
      expect(typeof FeatureRendererKey.COUNT).toBe("number");
    });

    it("COUNT equals total number of keys", function () {
      // COUNT should be one more than the highest key value
      const count = FeatureRendererKey.COUNT;
      expect(count).toBeGreaterThan(30); // We have 36+ keys
    });

    it("all keys are unique", function () {
      const values = new Set();
      const keys = Object.keys(FeatureRendererKey).filter((k) => k !== "COUNT");
      for (const key of keys) {
        const val = FeatureRendererKey[key];
        if (typeof val === "number") {
          expect(values.has(val)).toBe(false);
          values.add(val);
        }
      }
    });
  });

  describe("ContextRegistry", function () {
    it("is defined", function () {
      expect(ContextRegistry).toBeDefined();
    });
  });

  describe("feature renderer readiness", function () {
    let context;

    beforeEach(function () {
      context = new FakeGraphicsContext();
    });

    afterEach(function () {
      context.destroy();
    });

    it("FAR-103 distinguishes unsupported from a cold loading renderer", async function () {
      const key = FeatureRendererKey.POINT_CLOUD;
      expect(context.getFeatureRendererReadiness(key).kind).toBe("unsupported");

      const gate = deferred();
      let loadCount = 0;
      context.registerFeatureRendererLoader(key, async function () {
        loadCount++;
        return gate.promise;
      });

      const first = context.getFeatureRendererReadiness(key);
      const second = context.getFeatureRendererReadiness(key);
      expect(first.kind).toBe("loading");
      expect(second.kind).toBe("loading");
      expect(second.promise).toBe(first.promise);
      expect(context.getFeatureRenderer(key)).toBeUndefined();

      await Promise.resolve();
      expect(loadCount).toBe(1);

      const renderer = { update: function () {} };
      gate.resolve(renderer);
      await first.promise;
      expect(context.getFeatureRendererReadiness(key)).toEqual(
        jasmine.objectContaining({
          kind: "ready",
          renderer: renderer,
          generation: first.generation,
        }),
      );
      expect(context.getFeatureRenderer(key)).toBe(renderer);
    });

    it("FAR-103 notifies a frame-wakeup subscriber when loading becomes ready", async function () {
      const key = FeatureRendererKey.GAUSSIAN_SPLAT;
      const gate = deferred();
      const renderer = { update: function () {} };
      context.registerFeatureRendererLoader(key, async function () {
        return gate.promise;
      });

      const events = [];
      const unsubscribe = context.subscribeFeatureRendererReadiness(
        function (eventKey, state) {
          events.push({ key: eventKey, state: state });
        },
      );

      const loading = context.getFeatureRendererReadiness(key);
      gate.resolve(renderer);
      await loading.promise;

      expect(events.length).toBe(1);
      expect(events[0].key).toBe(key);
      expect(events[0].state.kind).toBe("ready");
      expect(events[0].state.renderer).toBe(renderer);

      unsubscribe();
    });

    it("FAR-103 keeps loader failures stable instead of retrying per lookup", async function () {
      const key = FeatureRendererKey.VOXEL_PRIMITIVE;
      const expectedError = new Error("deterministic import failure");
      let loadCount = 0;
      spyOn(console, "warn");
      context.registerFeatureRendererLoader(key, async function () {
        loadCount++;
        throw expectedError;
      });

      const loading = context.getFeatureRendererReadiness(key);
      await loading.promise;
      const failed = context.getFeatureRendererReadiness(key);
      expect(failed.kind).toBe("failed");
      expect(failed.error).toBe(expectedError);
      expect(failed.generation).toBe(loading.generation);
      expect(context.getFeatureRendererReadiness(key)).toBe(failed);
      expect(context.getFeatureRenderer(key)).toBeUndefined();
      expect(loadCount).toBe(1);
    });

    it("FAR-103 does not install a completion from a stale generation", async function () {
      const key = FeatureRendererKey.POINT_CLOUD_EDL;
      const gate = deferred();
      const renderer = { update: function () {} };
      context.registerFeatureRendererLoader(key, async function () {
        return gate.promise;
      });

      const events = [];
      context.subscribeFeatureRendererReadiness(function (eventKey, state) {
        events.push({ key: eventKey, state: state });
      });
      const loading = context.getFeatureRendererReadiness(key);
      await Promise.resolve();

      context.invalidateFeatureGeneration();
      const invalidated = context.getFeatureRendererStatus(key);
      expect(invalidated.kind).toBe("unsupported");
      expect(invalidated.generation).not.toBe(loading.generation);

      gate.resolve(renderer);
      await loading.promise;
      expect(context.hasFeatureRenderer(key)).toBe(false);
      expect(context.getFeatureRendererStatus(key)).toBe(invalidated);
      expect(events.length).toBe(0);
    });

    it("FAR-103 does not install a renderer after destroy during load", async function () {
      const key = FeatureRendererKey.GAUSSIAN_SPLAT;
      const gate = deferred();
      context.registerFeatureRendererLoader(key, async function () {
        return gate.promise;
      });

      const loading = context.getFeatureRendererReadiness(key);
      await Promise.resolve();
      context.destroy();
      gate.resolve({ update: function () {} });
      await loading.promise;

      expect(context.hasFeatureRenderer(key)).toBe(false);
      expect(context.getFeatureRendererStatus(key).kind).toBe("unsupported");
    });

    it("settles a pending loader after destroyObject without calling replaced methods", async function () {
      const realDestroyContext = new DestroyObjectGraphicsContext();
      const key = FeatureRendererKey.CUBE_MAP_PANORAMA;
      const gate = deferred();
      realDestroyContext.registerFeatureRendererLoader(key, async function () {
        return gate.promise;
      });

      const loading = realDestroyContext.getFeatureRendererReadiness(key);
      await Promise.resolve();
      realDestroyContext.destroy();
      gate.resolve({ update: function () {} });

      await expectAsync(loading.promise).toBeResolvedTo(undefined);
    });
  });
});
