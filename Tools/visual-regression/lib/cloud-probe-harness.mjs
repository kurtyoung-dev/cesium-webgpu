/**
 * Installs the browser-side cloud probe helper. The function is deliberately
 * self-contained so Playwright can inject it with `page.addInitScript`.
 * @purpose Self-contained browser-side helper (addInitScript) configuring defaultCloudCollection.volumetric and verifying every value round-tripped.
 * @status ACTIVE
 *
 * Cloud volumetric configuration moved off `Globe` during cloud unification.
 * Probes must configure `globe.defaultCloudCollection.volumetric` directly and
 * verify that every requested value survived the round trip.
 *
 * TWO PATHS, TWO OWNERS (Campaign 13 v2, Wave 1). This module carries two
 * independent concerns and they are maintained by different lanes, so the split
 * is written down rather than discovered in a merge:
 *
 *   - READINESS — `awaitProceduralReady` and `proceduralRealization`: does the
 *     renderer exist, is its pipeline built, did it record work. Owned by lane
 *     L1 (`C13-N08a`), which is repairing what "recorded work" counts.
 *   - CAPTURE — `photometricContext` and the constants it publishes: what a
 *     photometric measurement needs from the page in order to be a measurement
 *     of radiance rather than of the tonemapper. Owned by lane L6 (`C13-N09`).
 *
 * Neither path calls the other. A change to one that needs the other is a
 * message between the lanes, not an edit across the line.
 *
 * WHY THE CAPTURE PATH GATHERS RATHER THAN COMPUTES. The arithmetic of the HDR
 * rule lives in `lib/cloud-photometry.mjs`, on the Node side, where it is unit
 * testable and shared. What is only knowable INSIDE the page is the exposure
 * the march actually used and where the sun disc landed on the canvas — so that
 * is all this path returns. Duplicating the inverse-Reinhard here would create
 * a second copy that drifts, and the injected-function constraint means it
 * could never import the first.
 */
export function installCloudProbeHarness() {
  const root = globalThis;

  // These live INSIDE the function on purpose. `page.addInitScript` serializes
  // this function's source and nothing else, so a module-scope constant would
  // arrive in the page as a ReferenceError at first call — which is exactly the
  // failure the "deliberately self-contained" note above is warning about.
  // `cloud-photometry-rule.spec.mjs` pins the slot equal to the Node-side
  // constant by OBSERVING what `photometricContext()` reports, since the two
  // copies cannot be linked.

  /** Reinhard exposure slot: `ProceduralClouds.wgsl:106`, packed at
   * `WebGPUProceduralCloudRenderer.ts:3823`. */
  const EXPOSURE_UNIFORM_SLOT = 97;

  /** Geometric angular radius of the solar disc from Earth, ~0.267 deg. */
  const SUN_ANGULAR_RADIUS_RADIANS = 0.004652;

  /** @see photometricContext — why the default mask is wider than the disc. */
  const DEFAULT_SUN_DISC_RADIUS_SCALE = 3;

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

    /**
     * C13-N09 — everything a photometric bar needs from the page, and nothing
     * it can compute on the Node side.
     *
     * §1.3 of the Campaign 13 v2 plan makes one rule binding on every
     * photometric statistic: measure linear PRE-tonemap values, with the sun
     * disc masked. The march tone-maps at `ProceduralClouds.wgsl:2645-2646`
     * (`exposed = weightedColor * cloud.exposure; toneMapped = exposed /
     * (exposed + 1)`), so a ratio taken off the canvas bytes is a ratio of that
     * curve, not of the clouds.
     *
     * Inverting it needs the exposure the march ACTUALLY used — not the
     * packer's 0.22 fallback, and not a constant transcribed into a probe. That
     * is uniform slot 97 (`ProceduralClouds.wgsl:106`;
     * `WebGPUProceduralCloudRenderer.ts:3823`), reachable only here.
     *
     * Masking the sun needs the disc's position in CANVAS pixels, which is a
     * projection of `uniformState.sunPositionWC` through this frame's camera —
     * also reachable only here.
     *
     * Anything this cannot establish is returned as `null` with a `reasons`
     * entry. A caller must treat a null exposure as a refusal: measuring
     * against a guessed exposure produces a number whose scale is a guess, and
     * `photometricStats` in `lib/cloud-photometry.mjs` throws rather than
     * default it.
     *
     * @param {object} [options]
     * @param {number} [options.sunDiscRadiusScale] Multiple of the sun's
     *   geometric angular radius to mask. Default 3: the disc itself subtends
     *   ~0.267 deg, but bloom, the aureole and the glow pass spread far beyond
     *   it, and a mask that only covers the geometry leaves the brightest
     *   pixels in the ROI — which is the whole failure the rule exists to stop.
     * @returns {object}
     */
    photometricContext(options = {}) {
      const viewer = root.viewer;
      const scene = viewer?.scene;
      const context = scene?.context;
      const canvas = scene?.canvas;
      const reasons = [];

      const cache = context?._cloudCache;
      const uniforms = cache?.uniformData;
      const rawExposure = uniforms?.[EXPOSURE_UNIFORM_SLOT];
      const exposure =
        typeof rawExposure === "number" &&
        Number.isFinite(rawExposure) &&
        rawExposure > 0
          ? rawExposure
          : null;
      if (exposure === null) {
        reasons.push(
          `cloud exposure unavailable at uniform slot ${EXPOSURE_UNIFORM_SLOT} ` +
            `(read ${String(rawExposure)}); the renderer cache may not have ` +
            "packed a frame yet",
        );
      }

      const width = canvas?.width ?? null;
      const height = canvas?.height ?? null;
      if (!(width > 0 && height > 0)) {
        reasons.push("canvas has no positive drawing-buffer size");
      }

      // Sun disc, projected. `worldToWindowCoordinates` returns CSS pixels
      // while the capture is in drawing-buffer pixels, so the result is scaled
      // by the same ratio the canvas itself carries. Skipping that scale is how
      // a mask ends up half the size of the disc on a HiDPI capture.
      let sunDisc = null;
      const Cesium = root.Cesium;
      const sunWC = context?.uniformState?.sunPositionWC;
      const fovy = scene?.camera?.frustum?.fovy;
      if (!Cesium?.SceneTransforms?.worldToWindowCoordinates) {
        reasons.push(
          "Cesium.SceneTransforms.worldToWindowCoordinates unavailable",
        );
      } else if (!sunWC) {
        reasons.push("uniformState.sunPositionWC unavailable");
      } else if (!(
        typeof fovy === "number" &&
        Number.isFinite(fovy) &&
        fovy > 0
      )) {
        reasons.push(
          `camera.frustum.fovy unavailable (${String(fovy)}); an orthographic ` +
            "or infinite frustum has no single pixels-per-radian scale",
        );
      } else {
        const windowPosition = Cesium.SceneTransforms.worldToWindowCoordinates(
          scene,
          sunWC,
        );
        if (!windowPosition) {
          // Behind the camera or off-screen: nothing to mask, and that is a
          // fact about the frame rather than a failure of the context.
          sunDisc = {
            visible: false,
            reason: "sun not projected onto the canvas",
          };
        } else {
          const cssWidth = canvas.clientWidth || width;
          const cssHeight = canvas.clientHeight || height;
          const scaleX = width / cssWidth;
          const scaleY = height / cssHeight;
          const scale =
            typeof options.sunDiscRadiusScale === "number" &&
            Number.isFinite(options.sunDiscRadiusScale) &&
            options.sunDiscRadiusScale > 0
              ? options.sunDiscRadiusScale
              : DEFAULT_SUN_DISC_RADIUS_SCALE;
          // Pixels per radian at the optical axis: half the drawing-buffer
          // height spans tan(fovy/2) in world units at unit depth.
          const pixelsPerRadian = height / 2 / Math.tan(fovy / 2);
          sunDisc = {
            visible: true,
            x: windowPosition.x * scaleX,
            y: windowPosition.y * scaleY,
            radiusPixels: SUN_ANGULAR_RADIUS_RADIANS * pixelsPerRadian * scale,
            radiusScale: scale,
            angularRadiusRadians: SUN_ANGULAR_RADIUS_RADIANS,
            devicePixelScale: { x: scaleX, y: scaleY },
          };
        }
      }

      return {
        ok: reasons.length === 0,
        reasons,
        exposure,
        exposureSlot: EXPOSURE_UNIFORM_SLOT,
        width,
        height,
        sunDisc,
        // The capture's encoding is a premise about the presentation format,
        // not a preference. `bgra8unorm` (and every non-`-srgb` format) means
        // the byte IS the shader's output, so the decode is the identity.
        transfer:
          typeof context?._presentationFormat === "string" &&
          context._presentationFormat.endsWith("-srgb")
            ? "srgb"
            : "identity",
        presentationFormat: context?._presentationFormat ?? null,
        rendererType: String(
          context?.rendererType ?? (context?.isWebGPU ? "webgpu" : "webgl"),
        ).toLowerCase(),
      };
    },

    proceduralRealization,
  });
}

/** Inject the browser helper before the application loads. */
export async function installCloudProbeHarnessOnPage(page) {
  await page.addInitScript(installCloudProbeHarness);
}
