/**
 * Installs the browser-side cloud probe helper. The function is deliberately
 * self-contained so Playwright can inject it with `page.addInitScript`.
 * @purpose Self-contained browser-side helper (addInitScript) configuring defaultCloudCollection.volumetric and verifying every value round-tripped.
 * @status ACTIVE
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
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
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
        throw new Error(
          `cloud probe configuration failed: ${errors.join("; ")}`,
        );
      }
      return truth;
    },

    /**
     * Await the lazy procedural-cloud feature renderer and prove that it has
     * executed far enough to RECORD a frame. A fixed number of rAF warm-up
     * frames is not a readiness contract: on a cold chunk load the Scene
     * legitimately skips the effect while the feature renderer is absent.
     * Neither is `pipelineReady` — a compiled pipeline is not a written pixel,
     * and the returned counters keep the two apart (C13-N08a).
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
              destination: cloneCartesian(camera.positionWC ?? camera.position),
              direction: cloneCartesian(camera.directionWC ?? camera.direction),
              up: cloneCartesian(camera.upWC ?? camera.up),
            }
          : undefined;
      // WHICH ENTRY IS THE WORK (C13-N08a). Batch 1468 split the composite
      // into `prepareCloudFrameAndEncodeMask` + `executePreparedCloudFrame`,
      // and the live composition takes the split entry — see
      // `WebGPUSceneRendererEnvironmentalEffects.ts:327-329`. `execute`
      // (`executeProceduralClouds`) survives as a convenience wrapper that no
      // scene path calls, so instrumenting it ALONE counted an entry the
      // composition bypasses: readiness timed out at `executeCalls=0` over a
      // renderer that was in fact rendering, and that is the whole of the
      // `C13-42d` symptom at HEAD. Both entries are counted. They cannot
      // double-count: `executeProceduralClouds` calls the module-level
      // `executePreparedCloudFrame` directly, never this object's property.
      const counters = {
        prepareCalls: 0,
        legacyExecuteCalls: 0,
        preparedFrameCalls: 0,
        recordedFrames: 0,
      };
      const restores = [];
      const instrument = (method, observe) => {
        const original = featureRenderer[method];
        if (typeof original !== "function") {
          return false;
        }
        try {
          featureRenderer[method] = function (...args) {
            const returned = Reflect.apply(original, this, args);
            observe(returned);
            return returned;
          };
        } catch {
          // A frozen renderer lands on the readiness-contract error below.
          return false;
        }
        if (featureRenderer[method] === original) {
          return false;
        }
        restores.push(() => {
          featureRenderer[method] = original;
        });
        return true;
      };

      // PIPELINE BUILT IS NOT WORK RECORDED. `pipelineReady` says the renderer
      // compiled its pipeline; `recordedFrames` says a composite entry returned
      // `true`, which is the renderer's own word that it wrote the output view.
      // A renderer that reports ready while recording nothing is exactly what
      // `C13-42d` reported, and only the second counter can tell them apart.
      // `prepareCalls` is the rung between: it says the composition reached the
      // renderer at all, so a zero here and a zero there mean different bugs.
      instrument("prepareCloudFrameAndEncodeMask", () => {
        counters.prepareCalls++;
      });
      const recordReturn = (key, recorded) => (returned) => {
        counters[key]++;
        if (recorded(returned)) {
          counters.recordedFrames++;
        }
      };
      // The two entries are read ASYMMETRICALLY, and deliberately.
      // `executePreparedCloudFrame` has returned `boolean` since it existed,
      // so `true` is a positive statement that the frame was recorded and
      // anything else is not. `executeProceduralClouds` was declared `void`
      // when it was written and only later came to forward the split entry's
      // boolean, so `undefined` off that entry carries NO information —
      // requiring `=== true` there would make readiness permanently
      // unreachable for a probe on the wrapper path, which is a worse failure
      // than the false pass it would prevent. Only an explicit `false` is
      // treated as `did not record`.
      const preparedInstrumented = instrument(
        "executePreparedCloudFrame",
        recordReturn("preparedFrameCalls", (returned) => returned === true),
      );
      const legacyInstrumented = instrument(
        "execute",
        recordReturn("legacyExecuteCalls", (returned) => returned !== false),
      );
      if (!preparedInstrumented && !legacyInstrumented) {
        // Hand the renderer back before refusing: `prepareCloudFrameAndEncodeMask`
        // may already carry a wrapper, and this exit is outside the `finally`.
        for (const restore of restores) {
          restore();
        }
        throw new Error(
          "cloud probe could not instrument either procedural composite entry (executePreparedCloudFrame, execute)",
        );
      }
      const executeCallCount = () =>
        counters.preparedFrameCalls + counters.legacyExecuteCalls;

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
            counters.recordedFrames > 0
          ) {
            return {
              ok: true,
              featureRendererKey,
              waitedFrames: frame + 1,
              // `executeCalls` keeps its published meaning — how many times a
              // composite entry was invoked — so the probes that gate on
              // `readiness.executeCalls > 0` keep reading what they meant.
              executeCalls: executeCallCount(),
              ...counters,
              cameraDriven: typeof camera?.rotateRight === "function",
              ...realization,
            };
          }
        }

        // Name every rung. "executeCalls=0" alone sent the 2026-09-09 triage
        // at a resource-allocation bug that did not exist; the counters say
        // whether the composition never arrived, arrived and prepared nothing,
        // or prepared and recorded nothing — three different defects.
        throw new Error(
          `procedural cloud renderer recorded no frame in ${maxFrames} moving frames (executeCalls=${executeCallCount()}, counters=${JSON.stringify(
            counters,
          )}): ${JSON.stringify(proceduralRealization())}`,
        );
      } finally {
        for (const restore of restores) {
          restore();
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
