/**
 * Shared determinism pinning for the `probe-weather-*.mjs` fleet.
 *
 * WHY THIS EXISTS. `probe-weather-channels.mjs` was pinned individually at Batch
 * 852 after five runs of ONE build produced GREEN/RED/RED/RED/RED. The root
 * cause was not specific to that probe: it loaded `?renderer=webgpu` with no
 * `offline` flag, so `Apps/CesiumViewer/CesiumViewerStartupOptions.js:27-42`
 * handed the Viewer Cesium World Terrain AND the Ion world-imagery base layer,
 * and a `max(r,g,b) > 120` bright-pixel metric counts a lit imagery tile as
 * CLOUD. The audit filed as `C13-WEATHER-PROBE-FLEET-NETWORK-GLOBE` found the
 * same instrument shape in the rest of the fleet, so the fix belongs in one
 * enforceable place rather than copied five times.
 *
 * WHAT A "PIN" MEANS HERE. Requesting a setting is not establishing it. Every
 * pin in this module is READ BACK — from the live scene object for the scene
 * pins, and from the packed cloud uniform buffer (`context._cloudCache
 * .uniformData`) for the shader-visible pins. `collectPinStructural` turns a pin
 * that did not take into a STRUCTURAL result (exit 3), never into a product
 * verdict: a probe that is not measuring the configuration it documents
 * certifies nothing.
 *
 * THE PIN SET, and the mechanism each one closes. The numbering matches the
 * P1..P8 headings in `probe-weather-channels.mjs`, which remains the reference
 * implementation and the place to read the full derivation.
 *
 *   P1 OFFLINE GLOBE   `&offline=true` in the URL (caller's job) plus
 *                      `imageryLayers.removeAll()` and a forced
 *                      `EllipsoidTerrainProvider`, both read back. Closes
 *                      "streamed imagery is counted as signal" and "streamed
 *                      terrain re-tiles the frame mid-capture".
 *   P2 ONE DRIVER      `useDefaultRenderLoop=false`, `requestRenderMode=false`,
 *                      `clock.shouldAnimate=false`, `clock.multiplier=0`, and
 *                      every render goes through `renderAt(julianDate)` with an
 *                      EXPLICIT date. `Scene.render()` with no argument
 *                      substitutes `JulianDate.now()`, so a probe that leaves
 *                      the widget rAF loop running advances the cloud `time`
 *                      uniform off the wall clock no matter what it sets on
 *                      `viewer.clock`.
 *   P3 ZERO WIND       `cloudWindSpeed = 0`. The default is 15.0
 *                      (`Scene/CloudVolumetrics.js:83`), and `cloud.time`
 *                      reaches the density field ONLY as
 *                      `windDirection * windSpeed * time`
 *                      (`Shaders/WebGPU/Environment/ProceduralClouds.wgsl`
 *                      1212-1214, 1294-1296, 1353-1355). At speed 0 the clock is
 *                      provably inert on cloud shape, which is what makes a
 *                      per-location clock safe.
 *   P4 ESCAPE TIER     `cloudQuality = 32`. Any value `!== 64` takes the
 *                      power-user escape hatch in `resolveCloudPreset`
 *                      (`WebGPUCloudTierPresets.ts:173-197`), forcing
 *                      `temporalEnabled:false`, `jitterEnabled:false`,
 *                      `noiseSource:LIVE`, `renderResScale:1.0`,
 *                      `lightConeSampling:false`. The DEFAULT is 64
 *                      (`CloudVolumetrics.js:164`), i.e. the tier path, which at
 *                      250 km resolves temporal accumulation + jitter + half-res
 *                      — every one of them a frame-index input to the march.
 *                      Read back as `maxSteps`(44) and `qualityFlags`(74).
 *   P5 APPLIED GATE    `awaitWeatherApplied` polls until the provider has data,
 *                      the cache has uploaded THAT version, and the shader
 *                      uniform enables the map — never a flat sleep. A flat
 *                      sleep leaves the deck rendering from global coverage
 *                      (dense everywhere), an independent route to a saturated
 *                      sample.
 *   P6 FIXED CLOCK     `localNoonAt` gives each longitude its own local mean
 *                      noon, so at a fixed latitude the solar elevation is equal
 *                      everywhere and illumination cannot masquerade as a
 *                      weather-field effect. Safe only because of P3.
 *   P7 SAME-TASK       `capture()` does render -> drawImage -> getImageData in
 *                      ONE task with no await between them, and `settle()` is a
 *                      WALL-CLOCK budget driven by `setTimeout(0)` yields, never
 *                      a frame count (a cold pipeline variant has measured
 *                      ~2674 ms to compile).
 *   P8 NO OTHER LIGHT  Optional, caller-selected: ground atmosphere, fog, sky,
 *                      sun, moon and skyBox off, dark globe base colour. Applied
 *                      only where the probe's metric is a brightness count; a
 *                      probe that deliberately measures against a lit sky
 *                      (`probe-weather-ingest.mjs`) keeps its sky.
 *
 * WHAT PINNING DOES TO THE NUMBERS. P1 (imagery gone), P3 (wind stopped), P4
 * (LIVE noise, full-res, no temporal) and P6 (uniform illumination) all move the
 * ABSOLUTE values a pinned probe reports. Values recorded before pinning are NOT
 * a baseline for the pinned probe and must not be compared against. Every scored
 * gate in this fleet is relative (a leg against its own control, or one sample
 * against another within one sweep), so the comparisons survive; the absolute
 * level does not.
 *
 * NOT A LICENCE TO LOOSEN. Nothing in this module widens, lowers or removes an
 * assertion. The determinism control is an ADDITIONAL gate whose tolerances are
 * set strictly inside the smallest margin the calling probe scores, so a control
 * PASS means the residual capture noise cannot flip an assertion.
 */

/** Packed cloud-uniform slots read back to prove the shader-visible pins took. */
export const WEATHER_PIN_SLOTS = Object.freeze({
  time: 35,
  maxSteps: 44,
  weatherEnabled: 64,
  qualityFlags: 74,
  channelStrength: 107,
});

/**
 * qualityFlags bits that MUST be clear on the `cloudQuality !== 64` escape
 * hatch: NOISE_BAKED(0), HALF_RES(1), TEMPORAL(2), JITTER(3), LIGHT_CONE(10).
 * Any of them set means the tier path is active and the march has a frame-index
 * input, so consecutive captures of one configuration are not comparable.
 */
export const FORBIDDEN_QUALITY_BITS =
  (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 10);

/** The escape-hatch quality every pinned weather probe uses. */
export const PINNED_CLOUD_QUALITY = 32;

/**
 * Determinism pins shared by every pinned weather probe. Spread into the
 * probe's own authored dials; the probe's coverage/density/layer values are
 * deliberately NOT touched here, because those are the scene under test.
 */
export const WEATHER_DETERMINISM_DIALS = Object.freeze({
  cloudWindSpeed: 0,
  cloudQuality: PINNED_CLOUD_QUALITY,
  cloudCastShadows: false,
  cloudContributesIBL: false,
});

/**
 * Installs the browser-side pinning helper. Deliberately self-contained: this
 * function is serialized by `page.addInitScript`, which drops the surrounding
 * module closure, so it may not reference anything defined outside its own body.
 * Cesium itself is passed in per call rather than captured, because the init
 * script runs before the application module graph exists.
 */
export function installWeatherPinHarness() {
  const root = globalThis;

  const SLOTS = {
    time: 35,
    maxSteps: 44,
    weatherEnabled: 64,
    qualityFlags: 74,
    channelStrength: 107,
  };

  const sceneOf = () => {
    const scene = root.viewer?.scene;
    if (!scene) {
      throw new Error("weather pin harness requires window.viewer.scene");
    }
    return scene;
  };

  const uniformAt = (slot) =>
    sceneOf().context?._cloudCache?.uniformData?.[slot];

  const slotSnapshot = () => ({
    time: uniformAt(SLOTS.time),
    maxSteps: uniformAt(SLOTS.maxSteps),
    weatherMapEnabled: uniformAt(SLOTS.weatherEnabled),
    qualityFlags: uniformAt(SLOTS.qualityFlags),
    channelStrength: uniformAt(SLOTS.channelStrength),
  });

  // P2: EVERY render in a pinned probe goes through here. `scene.render()` with
  // no argument substitutes `JulianDate.now()` into frameState.time.
  const renderAt = (julianDate) => {
    const viewer = root.viewer;
    viewer.clock.currentTime = julianDate;
    viewer.scene.render(julianDate);
  };

  // P7: wall-clock settle. A frame count silently under-runs a cold pipeline
  // variant, which has measured ~2674 ms to compile.
  const settle = async (julianDate, milliseconds) => {
    const deadline = performance.now() + milliseconds;
    let frames = 0;
    while (performance.now() < deadline) {
      renderAt(julianDate);
      frames++;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return frames;
  };

  root.__weatherPin = Object.freeze({
    SLOTS,

    /**
     * P1 + P2 (+ optional P8). Returns the READ-BACK report; the caller feeds it
     * to `collectPinStructural` in Node.
     */
    pinScene(C, options) {
      const opts = options ?? {};
      const viewer = root.viewer;
      const scene = viewer.scene;

      // ── P2: one render driver, one clock.
      viewer.useDefaultRenderLoop = false;
      scene.requestRenderMode = false;
      viewer.clock.clockRange = C.ClockRange.UNBOUNDED;
      viewer.clock.shouldAnimate = false;
      viewer.clock.multiplier = 0.0;

      for (const selector of [
        ".cesium-viewer-timelineContainer",
        ".cesium-viewer-animationContainer",
        ".cesium-viewer-bottom",
        ".cesium-viewer-toolbar",
        ".cesium-viewer-fullscreenContainer",
        ".cesium-viewer-navigationContainer",
        ".cesium-navigation-help",
        ".cesium-renderer-toggle",
      ]) {
        const element = document.querySelector(selector);
        if (element) {
          element.style.display = "none";
        }
      }

      // ── P1: offline globe. `&offline=true` asks the app for no base layer and
      // no world terrain; these are the read-back proofs, because a probe that
      // merely REQUESTED determinism has not established it.
      const imageryLayersBefore = scene.globe.imageryLayers.length;
      scene.globe.imageryLayers.removeAll();
      let terrainForced = false;
      if (
        !(scene.globe.terrainProvider instanceof C.EllipsoidTerrainProvider)
      ) {
        scene.globe.terrainProvider = new C.EllipsoidTerrainProvider();
        terrainForced = true;
      }

      // ── P8, opt-in per probe.
      if (opts.darkGlobe === true) {
        scene.globe.show = true;
        scene.globe.enableLighting = false;
        scene.globe.baseColor = C.Color.fromBytes(20, 20, 25);
      }
      if (opts.groundAtmosphere === false) {
        scene.globe.showGroundAtmosphere = false;
      }
      if (opts.fog === false && scene.fog) {
        scene.fog.enabled = false;
      }
      if (opts.sky === false) {
        if (scene.skyAtmosphere) {
          scene.skyAtmosphere.show = false;
        }
        if (scene.skyBox) {
          scene.skyBox.show = false;
        }
        if (scene.sun) {
          scene.sun.show = false;
        }
        if (scene.moon) {
          scene.moon.show = false;
        }
        scene.backgroundColor = C.Color.BLACK;
      }

      return {
        rendererType: String(scene.context?.rendererType ?? "").toLowerCase(),
        isWebGPU: scene.context?.isWebGPU === true,
        useDefaultRenderLoop: viewer.useDefaultRenderLoop,
        requestRenderMode: scene.requestRenderMode,
        shouldAnimate: viewer.clock.shouldAnimate,
        clockMultiplier: viewer.clock.multiplier,
        imageryLayersBefore,
        imageryLayersAfter: scene.globe.imageryLayers.length,
        ellipsoidTerrain:
          scene.globe.terrainProvider instanceof C.EllipsoidTerrainProvider,
        terrainForced,
        showGroundAtmosphere: scene.globe.showGroundAtmosphere,
        enableLighting: scene.globe.enableLighting,
        canvas: { width: scene.canvas.width, height: scene.canvas.height },
      };
    },

    /** P6: local mean noon for a longitude, on a fixed UTC day. */
    localNoonAt(C, longitudeDegrees, day) {
      const d = day ?? {};
      return C.JulianDate.fromDate(
        new Date(
          Date.UTC(d.year ?? 2026, d.month ?? 5, d.day ?? 1, 12, 0, 0) -
            (longitudeDegrees / 15.0) * 60 * 60 * 1000,
        ),
      );
    },

    /** Read back the dials that must survive the round trip onto the scene. */
    readDials() {
      const volumetric = sceneOf().globe.defaultCloudCollection.volumetric;
      return {
        cloudWindSpeed: volumetric.cloudWindSpeed,
        cloudQuality: volumetric.cloudQuality,
        cloudCastShadows: volumetric.cloudCastShadows,
        cloudContributesIBL: volumetric.cloudContributesIBL,
      };
    },

    renderAt,
    settle,
    uniformAt,
    slotSnapshot,

    /**
     * Readiness by BINNED `Pass.GLOBE` command count plus a wall-clock minimum
     * settle — not a frame count, and not a bare timeout.
     */
    async awaitGlobeReady(C, julianDate, minimumSettleMs, budgetMs) {
      if (!C.Pass || !Number.isInteger(C.Pass.GLOBE)) {
        throw new Error(
          "Pass.GLOBE is not exported; readiness cannot be binned",
        );
      }
      const scene = sceneOf();
      const binnedGlobeCommands = () => {
        const frustums = scene._view?.frustumCommandsList ?? [];
        let total = 0;
        for (const frustum of frustums) {
          total += frustum?.indices ? frustum.indices[C.Pass.GLOBE] | 0 : 0;
        }
        return total;
      };
      const start = performance.now();
      let binned = 0;
      let firstBinnedMs = null;
      while (performance.now() - start < budgetMs) {
        renderAt(julianDate);
        binned = binnedGlobeCommands();
        if (binned > 0 && firstBinnedMs === null) {
          firstBinnedMs = performance.now() - start;
        }
        if (
          firstBinnedMs !== null &&
          performance.now() - start >= minimumSettleMs
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return {
        binnedGlobeCommands: binned,
        firstBinnedMs,
        elapsedMs: Math.round(performance.now() - start),
      };
    },

    /**
     * P5. `provider.hasData` only says the CPU pack exists. This additionally
     * requires the cache to have uploaded THAT version and the shader uniform to
     * report the map enabled.
     */
    async awaitWeatherApplied(provider, julianDate, budgetMs) {
      const scene = sceneOf();
      const start = performance.now();
      let state = {};
      while (performance.now() - start < budgetMs) {
        renderAt(julianDate);
        const cache = scene.context?._cloudCache;
        state = {
          hasData: provider.hasData === true,
          providerVersion: provider.version,
          uploadedVersion: cache?.weatherProviderVersion,
          weatherMapEnabled: uniformAt(SLOTS.weatherEnabled),
          lastError: provider.lastError ? String(provider.lastError) : null,
        };
        if (
          state.hasData &&
          state.providerVersion === state.uploadedVersion &&
          state.weatherMapEnabled === 1
        ) {
          return {
            ok: true,
            waitedMs: Math.round(performance.now() - start),
            ...state,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return {
        ok: false,
        waitedMs: Math.round(performance.now() - start),
        ...state,
      };
    },

    /**
     * P7. render -> drawImage -> getImageData in ONE task. The pixel buffer is
     * returned for IN-PAGE reduction only; callers must never serialize it back
     * across the evaluate boundary.
     */
    capture(julianDate, wantPng) {
      const scene = sceneOf();
      const canvas = scene.canvas;
      if (!root.__weatherPinScratch) {
        const element = document.createElement("canvas");
        root.__weatherPinScratch = {
          element,
          context: element.getContext("2d", { willReadFrequently: true }),
        };
      }
      const scratch = root.__weatherPinScratch;
      renderAt(julianDate);
      const width = canvas.width;
      const height = canvas.height;
      scratch.element.width = width;
      scratch.element.height = height;
      scratch.context.drawImage(canvas, 0, 0);
      const data = scratch.context.getImageData(0, 0, width, height).data;
      const png = wantPng ? scratch.element.toDataURL("image/png") : null;
      return { data, width, height, png, slots: slotSnapshot() };
    },

    /**
     * The fleet's shared brightness reducer: `max(r,g,b) > threshold` over the
     * central band, plus the CONTINUOUS `meanMax` companion so a threshold
     * straddle is diagnosable from the log without a second run. Identical
     * geometry and threshold to the pre-pinning probes.
     */
    brightFraction(frame, threshold, step) {
      const { data, width, height } = frame;
      const stride = step ?? 3;
      let bright = 0;
      let sumMax = 0;
      let samples = 0;
      for (let y = Math.floor(height * 0.2); y < height * 0.8; y += stride) {
        for (let x = Math.floor(width * 0.2); x < width * 0.8; x += stride) {
          const i = (y * width + x) * 4;
          const mx = Math.max(data[i], data[i + 1], data[i + 2]);
          if (mx > threshold) {
            bright++;
          }
          sumMax += mx;
          samples++;
        }
      }
      return {
        frac: samples ? bright / samples : 0,
        meanMax: samples ? +(sumMax / samples).toFixed(2) : 0,
        samples,
      };
    },
  });
}

/** Inject the browser helper before the application loads. */
export async function installWeatherPinHarnessOnPage(page) {
  await page.addInitScript(installWeatherPinHarness);
}

/**
 * The enforceable half. Turns the read-back report plus every scored capture's
 * uniform snapshot into STRUCTURAL reasons. A non-empty return means the probe
 * is not measuring the configuration it documents, so its gate verdicts are
 * diagnostic output only.
 *
 * @param {object} options
 * @param {object} options.pins Report from `__weatherPin.pinScene`.
 * @param {object} [options.dials] Report from `__weatherPin.readDials`.
 * @param {Array<object>} options.captures Every capture whose numbers are scored;
 *   each must carry the `slots` snapshot and a `label` for the message.
 * @param {object} [options.applied] `{ legName: awaitWeatherApplied result }`.
 * @param {number} [options.expectedChannelStrength] Required slot-107 value when
 *   the probe drives a single strength for every scored capture. Probes with a
 *   gated leg pass `expectedChannelStrength` per capture instead (see below).
 * @param {boolean} [options.requireWeatherMap] Require slot 64 === 1 on every
 *   scored capture. False for probes that deliberately score a map-off leg.
 */
export function collectPinStructural(options) {
  const {
    pins,
    dials,
    captures,
    applied,
    expectedChannelStrength,
    requireWeatherMap = true,
    brightThreshold,
  } = options;
  const structural = [];

  if (pins.imageryLayersAfter !== 0) {
    structural.push(
      `globe still has ${pins.imageryLayersAfter} imagery layer(s)` +
        (brightThreshold === undefined
          ? " — streamed imagery enters the scored frame"
          : ` — bright imagery is counted as cloud by the mx>${brightThreshold} metric`),
    );
  }
  if (!pins.ellipsoidTerrain) {
    structural.push(
      "globe terrain is not an EllipsoidTerrainProvider — streamed terrain re-tiles the frame mid-capture",
    );
  }
  if (pins.useDefaultRenderLoop !== false) {
    structural.push(
      "viewer.useDefaultRenderLoop did not stay false — a second render driver advances frameState.time off the wall clock",
    );
  }
  if (pins.requestRenderMode !== false) {
    structural.push("scene.requestRenderMode did not stay false");
  }
  if (pins.shouldAnimate !== false) {
    structural.push("viewer.clock.shouldAnimate did not stay false");
  }
  if (pins.clockMultiplier !== 0) {
    structural.push(
      `viewer.clock.multiplier read ${pins.clockMultiplier}, expected 0`,
    );
  }

  if (dials) {
    if (dials.cloudWindSpeed !== 0) {
      structural.push(
        `cloudWindSpeed round trip failed (${dials.cloudWindSpeed}) — the cloud time uniform is no longer inert on the density field`,
      );
    }
    if (dials.cloudQuality !== PINNED_CLOUD_QUALITY) {
      structural.push(
        `cloudQuality round trip failed (${dials.cloudQuality}), expected ${PINNED_CLOUD_QUALITY}`,
      );
    }
    if (
      dials.cloudCastShadows !== false ||
      dials.cloudContributesIBL !== false
    ) {
      structural.push(
        `cloud shadow/IBL pins did not take (castShadows=${dials.cloudCastShadows}, contributesIBL=${dials.cloudContributesIBL}) — the env-cube refill is revision-edge-triggered and would land at an arbitrary point in the sweep`,
      );
    }
  }

  const badSteps = captures.filter(
    (c) => c.slots.maxSteps !== PINNED_CLOUD_QUALITY,
  );
  if (badSteps.length) {
    structural.push(
      `maxSteps(slot 44) read ${badSteps[0].slots.maxSteps} on ${badSteps.length} capture(s) (first: ${badSteps[0].label}), expected ${PINNED_CLOUD_QUALITY} — the tier escape hatch is not active`,
    );
  }
  const badFlags = captures.filter(
    (c) => ((c.slots.qualityFlags | 0) & FORBIDDEN_QUALITY_BITS) !== 0,
  );
  if (badFlags.length) {
    structural.push(
      `qualityFlags(slot 74) = 0x${(badFlags[0].slots.qualityFlags | 0).toString(16)} on ${badFlags.length} capture(s) (first: ${badFlags[0].label}) — a forbidden baked/half-res/temporal/jitter/light-cone bit is set, so the march has a frame-index input`,
    );
  }
  if (requireWeatherMap) {
    const badWeather = captures.filter((c) => c.slots.weatherMapEnabled !== 1);
    if (badWeather.length) {
      structural.push(
        `weatherMapEnabled(slot 64) != 1 on ${badWeather.length} capture(s) (first: ${badWeather[0].label}) — the deck was rendering from global coverage, not the weather map`,
      );
    }
  }
  const strengthChecked = captures.filter(
    (c) =>
      c.expectedChannelStrength !== undefined ||
      expectedChannelStrength !== undefined,
  );
  const badStrength = strengthChecked.filter(
    (c) =>
      c.slots.channelStrength !==
      (c.expectedChannelStrength ?? expectedChannelStrength),
  );
  if (badStrength.length) {
    structural.push(
      `weatherChannelStrength(slot 107) did not take on ${badStrength.length} capture(s) (first: ${badStrength[0].label} read ${badStrength[0].slots.channelStrength}, expected ${badStrength[0].expectedChannelStrength ?? expectedChannelStrength})`,
    );
  }

  for (const [leg, state] of Object.entries(applied ?? {})) {
    if (!state.ok) {
      structural.push(
        `${leg} weather bytes never reached the GPU within the budget (${JSON.stringify(state)})`,
      );
    }
  }

  return structural;
}

/**
 * The determinism control. Two captures of ONE configuration, taken back to
 * back, must agree inside a tolerance set strictly INSIDE the smallest margin
 * the probe scores, and the cloud `time` uniform must read the same value at
 * each sample in both. If they do not, the probe reports STRUCTURAL and
 * certifies nothing — a probe that cannot reproduce its own capture cannot
 * certify a channel.
 *
 * Note that leg B typically reaches its first sample from leg A's LAST pose
 * while leg A reached it from the readiness pose, so the control also tests
 * independence from view history, which is where the recorded `channels` flip
 * lived.
 *
 * @param {object} options
 * @param {string} options.label Control name for the message.
 * @param {Array<{key:(string|number), value:number, time:number}>} options.a
 * @param {Array<{key:(string|number), value:number, time:number}>} options.b
 * @param {number} options.perSample Max allowed |a-b| at any one sample.
 * @param {number} options.mean Max allowed |mean(a)-mean(b)|.
 * @param {number} [options.absSum] Max allowed sum of |a-b| across samples.
 *   Supply this when the probe SCORES a sum of per-sample deltas, so the control
 *   bounds the same quantity the assertion reads.
 */
export function collectRepeatStructural(options) {
  const { label, a, b, perSample, mean, absSum } = options;
  if (a.length !== b.length) {
    return {
      reasons: [
        `${label}: control legs have different sample counts (${a.length} vs ${b.length})`,
      ],
      maxPerSample: NaN,
      meanDelta: NaN,
      deltaSum: NaN,
      timeDrift: [],
      deltas: [],
    };
  }
  const deltas = a.map((sample, i) => Math.abs(sample.value - b[i].value));
  const maxPerSample = deltas.length ? Math.max(...deltas) : 0;
  const deltaSum = +deltas.reduce((acc, d) => acc + d, 0).toFixed(4);
  const average = (list) =>
    list.length ? list.reduce((acc, s) => acc + s.value, 0) / list.length : 0;
  const meanDelta = Math.abs(average(a) - average(b));
  const timeDrift = a
    .map((sample, i) => ({ key: sample.key, a: sample.time, b: b[i].time }))
    .filter((row) => row.a !== row.b);

  const reasons = [];
  if (!(maxPerSample <= perSample)) {
    reasons.push(
      `${label}: max per-sample delta ${maxPerSample.toFixed(4)} exceeds tolerance ${perSample}`,
    );
  }
  if (!(meanDelta <= mean)) {
    reasons.push(
      `${label}: mean delta ${meanDelta.toFixed(4)} exceeds tolerance ${mean}`,
    );
  }
  if (absSum !== undefined && !(deltaSum <= absSum)) {
    reasons.push(
      `${label}: summed |delta| ${deltaSum.toFixed(4)} exceeds tolerance ${absSum} — the scored sum cannot be distinguished from capture noise`,
    );
  }
  if (timeDrift.length) {
    reasons.push(
      `${label}: cloud time uniform (slot 35) drifted on ${timeDrift.length} sample(s): ${JSON.stringify(timeDrift.slice(0, 3))}`,
    );
  }
  if (reasons.length) {
    reasons.unshift(`${label}: the probe did not reproduce its own capture`);
  }
  return { reasons, maxPerSample, meanDelta, deltaSum, timeDrift, deltas };
}
