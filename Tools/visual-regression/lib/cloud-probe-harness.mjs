/**
 * Installs the browser-side cloud probe helper. The function is deliberately
 * self-contained so Playwright can inject it with `page.addInitScript`.
 *
 * Cloud volumetric configuration moved off `Globe` during cloud unification.
 * Probes must configure `globe.defaultCloudCollection.volumetric` directly and
 * verify that every requested value survived the round trip.
 */
export function installCloudProbeHarness() {
  const root = globalThis;

  const valuesEqual = (actual, expected) => {
    if (
      expected !== null &&
      typeof expected === "object" &&
      !Array.isArray(expected)
    ) {
      return Object.keys(expected).every((key) =>
        valuesEqual(actual?.[key], expected[key]),
      );
    }
    return Object.is(actual, expected);
  };

  const snapshotValue = (value) => {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      return Object.fromEntries(
        Object.keys(value).map((key) => [key, snapshotValue(value[key])]),
      );
    }
    return value;
  };

  const proceduralRealization = () => {
    const viewer = root.viewer;
    const context = viewer?.scene?.context;
    const cache = context?._cloudCache;
    const uniforms = cache?.uniformData;
    return {
      cachePresent: cache !== undefined && cache !== null,
      initialized: cache?.initialized === true,
      pipelineReady: cache?.pipeline !== null && cache?.pipeline !== undefined,
      maxSteps: uniforms?.[44],
      lightSteps: uniforms?.[45],
      qualityFlags: uniforms?.[74],
      halfWidth: cache?.halfWidth ?? 0,
      halfHeight: cache?.halfHeight ?? 0,
      temporalWidth: cache?.temporalWidth ?? 0,
      temporalHeight: cache?.temporalHeight ?? 0,
      temporalPipelineReady:
        cache?.temporalPipeline !== null &&
        cache?.temporalPipeline !== undefined,
      frameCounter: cache?.frameCounter ?? 0,
    };
  };

  root.__cloudProbe = Object.freeze({
    configure(options = {}) {
      const viewer = root.viewer;
      if (!viewer?.scene?.globe?.defaultCloudCollection) {
        throw new Error(
          "cloud probe requires viewer.scene.globe.defaultCloudCollection",
        );
      }

      const scene = viewer.scene;
      const context = scene.context;
      const rendererType = String(
        context?.rendererType ?? (context?.isWebGPU ? "webgpu" : "webgl"),
      ).toLowerCase();
      const errors = [];

      scene.requestRenderMode = false;
      const collection = scene.globe.defaultCloudCollection;
      const volumetric = collection.volumetric;
      const requested = options.volumetric ?? {};

      for (const [key, value] of Object.entries(requested)) {
        if (!(key in volumetric)) {
          errors.push(`unknown CloudVolumetrics property ${key}`);
          continue;
        }
        volumetric[key] = value;
      }
      collection.enableVolumetric = options.enableVolumetric !== false;

      if (scene.requestRenderMode !== false) {
        errors.push("scene.requestRenderMode did not stay false");
      }
      if (options.requireWebGPU === true && rendererType !== "webgpu") {
        errors.push(`expected WebGPU, resolved ${String(rendererType)}`);
      }
      if (
        collection.enableVolumetric !==
        (options.enableVolumetric !== false)
      ) {
        errors.push(
          `enableVolumetric round trip failed: ${String(
            collection.enableVolumetric,
          )}`,
        );
      }

      const config = {};
      for (const [key, expected] of Object.entries(requested)) {
        if (!(key in volumetric)) {
          continue;
        }
        const actual = volumetric[key];
        config[key] = snapshotValue(actual);
        if (!valuesEqual(actual, expected)) {
          errors.push(
            `${key} round trip failed: expected ${JSON.stringify(
              expected,
            )}, received ${JSON.stringify(actual)}`,
          );
        }
      }

      const truth = {
        ok: errors.length === 0,
        errors,
        rendererType,
        isWebGPU: context?.isWebGPU === true,
        requestRenderMode: scene.requestRenderMode,
        enableVolumetric: collection.enableVolumetric,
        renderMode: collection.renderMode,
        config,
      };
      if (!truth.ok) {
        throw new Error(`cloud probe configuration failed: ${errors.join("; ")}`);
      }
      return truth;
    },

    /**
     * Await the lazy procedural-cloud feature renderer and prove that it has
     * executed far enough to initialize its renderer cache. A fixed number of
     * rAF warm-up frames is not a readiness contract: on a cold chunk load the
     * Scene legitimately skips the effect while the feature renderer is absent.
     */
    async awaitProceduralReady(options = {}) {
      const viewer = root.viewer;
      const scene = viewer?.scene;
      const context = scene?.context;
      const featureRendererKey = options.featureRendererKey;
      if (!scene || !context) {
        throw new Error("cloud probe requires viewer.scene.context");
      }
      if (typeof featureRendererKey !== "number") {
        throw new Error(
          "cloud probe requires the exported PROCEDURAL_CLOUDS feature-renderer key",
        );
      }
      if (typeof context.getFeatureRendererAsync !== "function") {
        throw new Error(
          "cloud probe requires GraphicsContext.getFeatureRendererAsync",
        );
      }

      const featureRenderer =
        await context.getFeatureRendererAsync(featureRendererKey);
      if (!featureRenderer) {
        throw new Error(
          `procedural cloud feature renderer ${featureRendererKey} is unavailable`,
        );
      }

      const maxFrames = Math.max(1, options.maxFrames ?? 180);
      const frameTime = options.frameTime ?? viewer.clock?.currentTime;
      const camera = scene.camera;
      const cloneCartesian = (value) => {
        if (!value) {
          return undefined;
        }
        if (typeof value.clone === "function") {
          return value.clone();
        }
        return { x: value.x, y: value.y, z: value.z };
      };
      const cameraState =
        camera && typeof camera.setView === "function"
          ? {
              destination: cloneCartesian(
                camera.positionWC ?? camera.position,
              ),
              direction: cloneCartesian(
                camera.directionWC ?? camera.direction,
              ),
              up: cloneCartesian(camera.upWC ?? camera.up),
            }
          : undefined;
      let executeCalls = 0;
      let executeInstrumented = false;
      const originalExecute = featureRenderer.execute;
      if (typeof originalExecute === "function") {
        try {
          featureRenderer.execute = function (...args) {
            executeCalls++;
            return Reflect.apply(originalExecute, this, args);
          };
          executeInstrumented = featureRenderer.execute !== originalExecute;
        } catch {
          // Report the exact readiness-contract failure below.
        }
      }
      if (!executeInstrumented) {
        throw new Error(
          "cloud probe could not instrument the procedural renderer execute path",
        );
      }

      try {
        for (let frame = 0; frame < maxFrames; frame++) {
          // The renderer intentionally freezes idle scene work. Drive a bounded,
          // alternating camera rotation during readiness so a cold feature
          // renderer cannot be "warmed" by frames that never reach the
          // environmental-effects chain. The helper restores the entry pose
          // before returning; callers then set their exact evidence camera.
          if (typeof camera?.rotateRight === "function") {
            camera.rotateRight((frame & 1) === 0 ? 0.01 : -0.01);
          }
          scene.requestRender?.();
          scene.render(frameTime);
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const realization = proceduralRealization();
          if (
            realization.initialized &&
            realization.pipelineReady &&
            executeCalls > 0
          ) {
            return {
              ok: true,
              featureRendererKey,
              waitedFrames: frame + 1,
              executeCalls,
              cameraDriven: typeof camera?.rotateRight === "function",
              ...realization,
            };
          }
        }

        throw new Error(
          `procedural cloud renderer did not initialize after ${maxFrames} moving frames (executeCalls=${executeCalls}): ${JSON.stringify(
            proceduralRealization(),
          )}`,
        );
      } finally {
        if (executeInstrumented) {
          featureRenderer.execute = originalExecute;
        }
        if (
          cameraState?.destination &&
          cameraState.direction &&
          cameraState.up
        ) {
          camera.setView({
            destination: cameraState.destination,
            orientation: {
              direction: cameraState.direction,
              up: cameraState.up,
            },
          });
        }
      }
    },

    proceduralRealization,
  });
}

/** Inject the browser helper before the application loads. */
export async function installCloudProbeHarnessOnPage(page) {
  await page.addInitScript(installCloudProbeHarness);
}
