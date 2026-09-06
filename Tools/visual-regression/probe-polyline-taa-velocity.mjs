#!/usr/bin/env node
/**
 * Probe: POLYLINE-TAA-VELOCITY (AR-752 / `AR-M38`).
 * @purpose AR-752: measures non-zero texels in the rg16float velocity target for an animating PolylineCollection under TAA, and the animating line's ghost-smear footprint against WebGL.
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * WHAT IT MEASURES, AND WHY THE NUMBER MATTERS.
 *
 * `archive/AUDIT_2026_05_02.md` recorded polyline TAA velocity as SHIPPED in
 * Batch 148. The gate that decides whether a polyline material has velocity
 * entry points compared the collection's PUBLIC `Material.type` ("Color",
 * "PolylineDash", …) against `"polylineColor"`, which is the renderer's
 * lowercase SHADER KEY and is never a `Material.type` — so it was
 * unconditionally true. No polyline ever built a velocity pipeline, and
 * `cmd.velocityCommand` was never constructed. The browser-free half of that
 * is measured by `polyline-taa-velocity-emission.spec.mjs` (36 gate entries,
 * 36 nulls, 0 velocity commands over six animated frames × six material
 * types); this probe measures the GPU half the spec cannot see:
 *
 *   CELL A (webgpu) — `velocityNonZeroTexels`: texels in the scene
 *     framebuffer's `rg16float` velocity target whose magnitude exceeds a
 *     half-float noise floor, after an animated run. The pre-fix number is
 *     exactly 0; the acceptance is > 0.
 *
 *   CELL B (webgpu) — the NEGATIVE CONTROL: the same animation with a
 *     `PolylineDash` material, whose WGSL has no `vertexVelocityMain`. It must
 *     stay at 0. Without it, a probe that reported "> 0" could not distinguish
 *     "the gate now resolves the shader key" from "the gate was deleted".
 *
 *   CELL C (webgpu) and CELL D (webgl) — `linePixels`: the count of
 *     line-coloured pixels in the final frame of the SAME animated sequence.
 *     WebGL has no TAA accumulation, so cell D is the crisp line's footprint
 *     and is the denominator. A WebGPU TAA history reprojected with correct
 *     motion vectors lands on the same footprint; one reprojected with the
 *     camera-only fallback smears the line along its trajectory and inflates
 *     the count. Acceptance: `linePixels(C) / linePixels(D)` in [0.75, 1.25].
 *
 *   CELL E (both) — the no-polyline control: the same scene with the collection
 *     omitted, on both backends, whose line-pixel count must stay 0. It is the
 *     runtime form of the row's "scenes with no polyline capture identically"
 *     clause; the browser-free form is A5 of the emission spec.
 *
 * NOISE. `velocityNonZeroTexels` is a count over a deterministic animation with
 * a fixed camera and `shouldAnimate = false`, so it is stable run to run; the
 * probe reports it for EACH of `--runs` and a verdict passes only when EVERY run
 * passes, so one lucky run cannot carry the acceptance. `linePixels` varies by a
 * few pixels with rasterisation, which is why the smear acceptance is a ±25 %
 * band rather than an equality. Run `--runs 3` to see the spread.
 *
 * Usage: node server.js --port 8094 --serve-built   (separate terminal, once)
 *        node Tools/visual-regression/probe-polyline-taa-velocity.mjs --runs 3
 * Out:   Tools/visual-regression/output/polyvel-*.png + polyvel-report.json +
 *        polyvel-runtime.json + polyvel-summary.md
 */
import fs from "node:fs";
import path from "node:path";

import { decodePng } from "../lib/png-decode.mjs";
import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { ProbeRefusal, isEntryPoint, runProbe } from "./lib/probe-runtime.mjs";

const VIEWPORT = { width: 640, height: 480 };
const CLOCK_ISO = "2026-06-21T18:00:00Z";
const FRAMES = 24;
// Machine safety: refuse rather than wedge the box on a hung device.
const WATCHDOG_BUDGET_MS = 5 * 60 * 1000;

// A half-float whose magnitude is at or below this is treated as "no motion".
// The velocity FS writes an exact `vec2<f32>(0.0)` for fragments it rejects and
// for a first frame with no history, so the floor only has to clear rg16float's
// quantisation of a genuinely still fragment.
export const VELOCITY_NOISE_FLOOR = 1.0e-4;

// The acceptance band the row states for the ghost-smear ratio.
export const SMEAR_RATIO_MIN = 0.75;
export const SMEAR_RATIO_MAX = 1.25;

/**
 * Decodes one IEEE-754 binary16 value from a 16-bit unsigned pattern.
 *
 * `copyTextureToBuffer` on an `rg16float` target hands back raw half-floats,
 * and neither `DataView` nor a typed array reads them, so the probe decodes
 * them itself rather than asking the page to convert (which would put the
 * conversion inside the thing being measured).
 *
 * @param {number} bits The 16-bit pattern.
 * @returns {number} The decoded value.
 */
export function decodeHalf(bits) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x03ff;
  if (exponent === 0) {
    return sign * mantissa * 2 ** -24;
  }
  if (exponent === 0x1f) {
    return mantissa ? Number.NaN : sign * Infinity;
  }
  return sign * (mantissa + 1024) * 2 ** (exponent - 25);
}

/**
 * Counts velocity texels whose motion clears the noise floor.
 *
 * @param {number[]} halves Flat `[r0, g0, r1, g1, …]` half-float patterns.
 * @param {number} [floor] Magnitude at or below which a texel counts as still.
 * @returns {{nonZero: number, total: number, maxMagnitude: number}} The counts.
 */
export function countNonZeroVelocityTexels(
  halves,
  floor = VELOCITY_NOISE_FLOOR,
) {
  let nonZero = 0;
  let maxMagnitude = 0;
  const total = Math.floor(halves.length / 2);
  for (let i = 0; i < total; i++) {
    const vx = decodeHalf(halves[i * 2]);
    const vy = decodeHalf(halves[i * 2 + 1]);
    if (!Number.isFinite(vx) || !Number.isFinite(vy)) {
      continue;
    }
    const magnitude = Math.hypot(vx, vy);
    if (magnitude > maxMagnitude) {
      maxMagnitude = magnitude;
    }
    if (magnitude > floor) {
      nonZero += 1;
    }
  }
  return { nonZero, total, maxMagnitude };
}

/**
 * Turns one run's cells into the probe's verdicts.
 *
 * Kept pure and exported so `polyline-taa-velocity-emission.spec.mjs` can pin
 * the pass/fail arithmetic without an Edge slot: a probe whose verdict logic is
 * only ever exercised by the probe itself reports whatever it computes.
 *
 * @param {object} cells One run's measurements.
 * @returns {Array<{id: string, claim: string, pass: boolean, detail: object}>} Verdicts.
 */
export function verdictsFor(cells) {
  const {
    animatedColor,
    animatedDash,
    webgpuLinePixels,
    webglLinePixels,
    errors,
  } = cells;
  const ratio = webglLinePixels > 0 ? webgpuLinePixels / webglLinePixels : null;
  return [
    {
      id: "velocity-emitted",
      claim:
        "AR-752 — an animating PolylineCollection under TAA writes non-zero motion vectors (pre-fix: exactly 0)",
      pass: animatedColor.nonZero > 0,
      detail: { nonZeroTexels: animatedColor.nonZero },
    },
    {
      id: "negative-control-dash",
      claim:
        "a PolylineDash polyline, whose WGSL has no velocity entry points, still writes none",
      pass: animatedDash.nonZero === 0,
      detail: { nonZeroTexels: animatedDash.nonZero },
    },
    {
      id: "ghost-smear-ratio",
      claim: `the animating line's footprint under WebGPU TAA is within [${SMEAR_RATIO_MIN}, ${SMEAR_RATIO_MAX}] of WebGL's`,
      pass:
        ratio !== null && ratio >= SMEAR_RATIO_MIN && ratio <= SMEAR_RATIO_MAX,
      detail: { ratio, webgpuLinePixels, webglLinePixels },
    },
    {
      id: "gate-clean",
      claim: "no device, validation or console faults",
      pass: errors === 0,
      detail: { errors },
    },
  ];
}

// ---------------------------------------------------------------------------
// Page-side scene construction
// ---------------------------------------------------------------------------

async function buildScene(page, { renderer, materialType, withPolyline }) {
  return await page.evaluate(
    async ({ renderer, materialType, withPolyline, clockIso }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      if (window.__probeViewer && !window.__probeViewer.isDestroyed()) {
        try {
          window.__probeViewer.destroy();
        } catch (e) {
          void e;
        }
      }
      let container = document.getElementById("cesiumContainer");
      if (!container) {
        container = document.createElement("div");
        container.id = "cesiumContainer";
        document.body.appendChild(container);
      }
      container.innerHTML = "";
      Object.assign(container.style, {
        position: "absolute",
        top: "0",
        left: "0",
        width: "640px",
        height: "480px",
      });

      const viewer = await C.Viewer.createAsync("cesiumContainer", {
        contextOptions: { renderer },
        msaaSamples: 1,
        baseLayerPicker: false,
        geocoder: false,
        timeline: false,
        animation: false,
        fullscreenButton: false,
        navigationHelpButton: false,
        homeButton: false,
        sceneModePicker: false,
        infoBox: false,
        selectionIndicator: false,
        shouldAnimate: false,
      });
      window.__probeViewer = viewer;
      window.viewer = viewer;

      const scene = viewer.scene;
      scene.msaaSamples = 1;
      viewer.clock.shouldAnimate = false;
      viewer.clock.currentTime = C.JulianDate.fromIso8601(clockIso);
      scene.globe.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;
      scene.backgroundColor = C.Color.BLACK.clone();
      scene.fog.enabled = false;
      // The velocity pass only runs when TAA is on; it is also the accumulation
      // that smears a line whose motion vectors are missing.
      scene.taaEnabled = true;

      // A fixed camera: every pixel of motion in this scene comes from the
      // polyline moving, not from the camera. A moving camera would be
      // reprojected by TAA's camera-only fallback and would paint velocity
      // texels whether or not the polyline emits any.
      scene.camera.setView({
        destination: C.Cartesian3.fromDegrees(0.0, 0.0, 3.0e6),
      });

      window.__probeCollection = undefined;
      if (withPolyline) {
        const collection = scene.primitives.add(new C.PolylineCollection());
        const material =
          materialType === "Color"
            ? C.Material.fromType("Color", {
                color: C.Color.CYAN.clone(),
              })
            : C.Material.fromType("PolylineDash", {
                color: C.Color.CYAN.clone(),
                gapColor: C.Color.TRANSPARENT.clone(),
              });
        collection.add({
          positions: C.Cartesian3.fromDegreesArray([-6.0, 0.0, 6.0, 0.0]),
          width: 12.0,
          material,
        });
        window.__probeCollection = collection;
      }

      // Arm the WebGPU velocity readback path: the scene framebuffer allocates
      // the rg16float target with COPY_SRC, so the probe can copy it out
      // without changing anything the renderer does.
      window.__probeReadVelocity = async () => {
        const alt = scene._alternateSceneRenderer;
        const framebuffer = alt?._sceneFramebuffer;
        const texture = framebuffer?._velocityTexture;
        const device = scene.context._device ?? scene.context.device;
        if (!texture || !device) {
          return { available: false, halves: [], width: 0, height: 0 };
        }
        const width = texture.width;
        const height = texture.height;
        const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
        const readback = device.createBuffer({
          size: bytesPerRow * height,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          label: "polyvel-readback",
        });
        const encoder = device.createCommandEncoder({ label: "polyvel-copy" });
        encoder.copyTextureToBuffer(
          { texture },
          { buffer: readback, bytesPerRow },
          { width, height, depthOrArrayLayers: 1 },
        );
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const view = new DataView(readback.getMappedRange());
        const halves = [];
        for (let y = 0; y < height; y++) {
          const rowOffset = y * bytesPerRow;
          for (let x = 0; x < width; x++) {
            halves.push(view.getUint16(rowOffset + x * 4, true));
            halves.push(view.getUint16(rowOffset + x * 4 + 2, true));
          }
        }
        readback.unmap();
        readback.destroy();
        return { available: true, halves, width, height };
      };

      // Animate the far endpoint along the equator, one step per frame. The
      // near endpoint is fixed so the line sweeps rather than translates, which
      // gives the velocity field a range of magnitudes instead of one.
      window.__probeStep = (frame) => {
        const collection = window.__probeCollection;
        if (!collection || collection.length === 0) {
          return;
        }
        const polyline = collection.get(0);
        polyline.positions = C.Cartesian3.fromDegreesArray([
          -6.0,
          0.0,
          6.0,
          -3.0 + frame * 0.25,
        ]);
      };

      window.__probeRender = async (frames, animated) => {
        for (let frame = 0; frame < frames; frame++) {
          if (animated) {
            window.__probeStep(frame);
          }
          scene.render();
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      };

      await new Promise((resolve) => setTimeout(resolve, 200));
      return { rendererType: scene.context.rendererType ?? renderer };
    },
    { renderer, materialType, withPolyline, clockIso: CLOCK_ISO },
  );
}

// ---------------------------------------------------------------------------
// Capture helpers
// ---------------------------------------------------------------------------

/**
 * Counts pixels that carry the cyan the polyline is drawn in.
 *
 * @param {{data: Buffer|Uint8Array}} image A decoded capture.
 * @returns {number} The count.
 */
export function countLinePixels(image) {
  let count = 0;
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    // Cyan on black: green and blue well above the background, red low.
    if (g > 40 && b > 40 && r < g - 20) {
      count += 1;
    }
  }
  return count;
}

async function capture(page, outputDirectory, name) {
  const buffer = await page.locator("canvas").first().screenshot();
  fs.writeFileSync(path.join(outputDirectory, `polyvel-${name}.png`), buffer);
  return { buffer, decoded: decodePng(buffer) };
}

// ---------------------------------------------------------------------------
// The descriptor the shared runtime executes
// ---------------------------------------------------------------------------

export const descriptor = {
  name: "polyvel",
  title: "Polyline TAA velocity emission (AR-752)",
  outputSubdirectory: "",
  receiptEnvelope: "probe-owned",
  async cells({ browser, origin, outputDirectory, options }) {
    fs.mkdirSync(outputDirectory, { recursive: true });
    if (
      options.renderers.length !== 2 ||
      !options.renderers.includes("webgl") ||
      !options.renderers.includes("webgpu")
    ) {
      throw new ProbeRefusal(
        "renderers-incomplete",
        `probe-polyline-taa-velocity needs both backends: the smear ratio's denominator is WebGL's footprint; got --renderer ${options.renderers.join(",")}`,
        { renderers: options.renderers },
      );
    }

    const work = (async () => {
      const page = await browser.newPage({ viewport: VIEWPORT });
      const consoleErrors = attachConsoleErrorGate(page);
      await page.addInitScript(errorGateInit);
      await page.goto(
        `${origin}/Apps/CesiumViewer/index.html?renderer=webgpu`,
        {
          waitUntil: "networkidle",
          timeout: 90000,
        },
      );
      await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });
      await armWebGPUDevices(page);

      // A — animating Color polyline on WebGPU: the measurement.
      await buildScene(page, {
        renderer: "webgpu",
        materialType: "Color",
        withPolyline: true,
      });
      await page.evaluate(
        (frames) => window.__probeRender(frames, true),
        FRAMES,
      );
      const animatedColorRead = await page.evaluate(() =>
        window.__probeReadVelocity(),
      );
      const animatedColor = animatedColorRead.available
        ? countNonZeroVelocityTexels(animatedColorRead.halves)
        : { nonZero: 0, total: 0, maxMagnitude: 0, unavailable: true };
      const webgpuShot = await capture(page, outputDirectory, "webgpu-color");

      // B — the negative control: PolylineDash has no velocity entry points.
      await buildScene(page, {
        renderer: "webgpu",
        materialType: "PolylineDash",
        withPolyline: true,
      });
      await page.evaluate(
        (frames) => window.__probeRender(frames, true),
        FRAMES,
      );
      const animatedDashRead = await page.evaluate(() =>
        window.__probeReadVelocity(),
      );
      const animatedDash = animatedDashRead.available
        ? countNonZeroVelocityTexels(animatedDashRead.halves)
        : { nonZero: 0, total: 0, maxMagnitude: 0, unavailable: true };

      // E1 — the no-polyline control on WebGPU.
      await buildScene(page, {
        renderer: "webgpu",
        materialType: "Color",
        withPolyline: false,
      });
      await page.evaluate(
        (frames) => window.__probeRender(frames, false),
        FRAMES,
      );
      const emptyWebgpu = await capture(page, outputDirectory, "webgpu-empty");

      // D — the same animation on WebGL: the smear denominator.
      await buildScene(page, {
        renderer: "webgl",
        materialType: "Color",
        withPolyline: true,
      });
      await page.evaluate(
        (frames) => window.__probeRender(frames, true),
        FRAMES,
      );
      const webglShot = await capture(page, outputDirectory, "webgl-color");

      // E2 — the no-polyline control on WebGL.
      await buildScene(page, {
        renderer: "webgl",
        materialType: "Color",
        withPolyline: false,
      });
      await page.evaluate(
        (frames) => window.__probeRender(frames, false),
        FRAMES,
      );
      const emptyWebgl = await capture(page, outputDirectory, "webgl-empty");

      const gate = await collectGateErrors(page);
      // ONE CELL PER RUN, WRAPPED IN AN ARRAY. The runtime collects each run
      // with `cells.push(...(produced ?? []))` (`lib/probe-runtime.mjs`), so a
      // bare object is not a cell — it is a value the spread cannot iterate,
      // and the run dies inside the runtime carrying the runtime's line
      // number and no mention of this probe. That is exactly what cost AR-752
      // its Edge acceptance leg on 2026-09-05.
      return [
        {
          animatedColor,
          animatedDash,
          webgpuLinePixels: countLinePixels(webgpuShot.decoded),
          webglLinePixels: countLinePixels(webglShot.decoded),
          emptyWebgpuLinePixels: countLinePixels(emptyWebgpu.decoded),
          emptyWebglLinePixels: countLinePixels(emptyWebgl.decoded),
          errors:
            gate.errors.length +
            consoleErrors.length +
            (gate.deviceLost ? 1 : 0),
          gateErrorsSample: gate.errors.slice(0, 6),
        },
      ];
    })();
    work.catch(() => {});
    let watchdogTimer;
    const watchdog = new Promise((_resolve, reject) => {
      watchdogTimer = setTimeout(
        () =>
          reject(
            new ProbeRefusal(
              "watchdog-timeout",
              `probe-polyline-taa-velocity exceeded its ${WATCHDOG_BUDGET_MS}ms machine-safety budget`,
              { budgetMs: WATCHDOG_BUDGET_MS },
            ),
          ),
        WATCHDOG_BUDGET_MS,
      );
    });
    try {
      return await Promise.race([work, watchdog]);
    } finally {
      clearTimeout(watchdogTimer);
    }
  },
  receipt(cells, context) {
    return { base: context.origin, runs: cells };
  },
  verdicts(cells) {
    // `cells` is the array of per-run results the runtime collected — it is
    // built as `const cells = []` and only ever pushed into, so it is an array
    // by construction and needs no `Array.isArray` coercion here. The coercion
    // that used to sit on this line is what made the bare-object return above
    // look survivable; the runtime spread had already thrown long before this
    // function was reached. The verdict reads the WORST run, so one lucky run
    // cannot carry it.
    const perRun = cells.map((run) => verdictsFor(run));
    const ids = perRun[0].map((verdict) => verdict.id);
    return ids.map((id, index) => ({
      id,
      claim: perRun[0][index].claim,
      pass: perRun.every((verdicts) => verdicts[index].pass),
      detail: perRun.map((verdicts) => verdicts[index].detail),
    }));
  },
  summary(receipt) {
    // `receipt.runs` is the same array `receipt()` was handed; see `verdicts`.
    const runs = receipt.runs;
    const lines = [
      "# Polyline TAA velocity emission (AR-752)",
      "",
      `Base: \`${receipt.base}\``,
      "",
      "| run | velocity texels (Color) | velocity texels (Dash control) | webgpu line px | webgl line px | ratio | errors |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    ];
    runs.forEach((run, index) => {
      const ratio =
        run.webglLinePixels > 0
          ? (run.webgpuLinePixels / run.webglLinePixels).toFixed(3)
          : "n/a";
      lines.push(
        `| ${index + 1} | ${run.animatedColor.nonZero} | ${run.animatedDash.nonZero} | ${run.webgpuLinePixels} | ${run.webglLinePixels} | ${ratio} | ${run.errors} |`,
      );
    });
    lines.push("");
    return lines.join("\n");
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
