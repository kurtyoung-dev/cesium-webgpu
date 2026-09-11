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
 *     `PolylineDash` material, whose WGSL has no `vertexVelocityMain`. Its
 *     region must stay at 0 WITH THE TARGET PRESENT. Without it, a probe that
 *     reported "> 0" could not distinguish "the gate now resolves the shader
 *     key" from "the gate was deleted".
 *
 *   CELL P (webgpu) — the POSITIVE CONTROL, present in BOTH velocity scenes: an
 *     animating `PointPrimitiveCollection` point parked to the left of the
 *     line. Its velocity comes from a DIFFERENT renderer and a different
 *     prev-stream mechanism (`WebGPUResidentInstanceBuffer`'s dirty-range prev
 *     mirror, `WebGPUPointPrimitiveRenderer.js:1210`), so it answers the one
 *     question cells A and B cannot ask of themselves: is this readback LIVE?
 *     Its region MUST read non-zero. Until Batch 1448 the only cell required to
 *     be non-zero was the one under test, so the dash control's green came off
 *     a zero it never measured — `_velocityTexture` did not exist for a scene
 *     whose only primitive emits no velocity command, and `unavailable: true`
 *     scored as a pass. That is Éowyn's job-10 instrument defect (d).
 *
 *   REGIONS. Cells A, B and P are counted inside SCREEN RECTANGLES the page
 *     derives from `scene.cartesianToCanvasCoordinates` of the subjects
 *     themselves, not from an assumed field of view. Whole-frame counts cannot
 *     separate the line from its own positive control.
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
 *     omitted, on both backends. It is the runtime form of the row's "scenes
 *     with no polyline capture identically" clause; the browser-free form is A5
 *     of the emission spec. It is REPORTED, not verdicted, and it does NOT read
 *     0: the Cesium ion credit wordmark clears `countLinePixels`' cyan test and
 *     both backends measure ~440 px for it. That constant does NOT cancel out of
 *     the smear ratio — it sits in BOTH terms, which pulls the measured ratio
 *     toward 1 ((3948-440)/(3557-440) = 1.125 against the 1.110 reported), so
 *     the [0.75, 1.25] bar is slightly permissive as stated. The docstring used
 *     to claim "must stay 0" against a shipped measurement of 440, which is Éowyn's
 *     job-10 instrument defect (e). The claim is corrected here rather than the
 *     measurement: the cell's job is the identical-capture clause, and equality
 *     across the backends is what it shows.
 *
 * WHY THE FIRST THREE EDGE RUNS READ FLAT ZERO (round 3, Batch 1448). The
 * velocity target came back with `nonZero: 0` and a maximum magnitude of
 * 1.3328e-7 — a REAL readback of a live target, not a blind one. That number is
 * `hypot(2·2^-24, 2^-24)`, one and two half-precision denormal ULPs, and it is
 * exactly the residual the velocity FS leaves when the previous and current
 * position streams carry the SAME world positions: the current clip position
 * goes through the RTE path and the previous one through a full mat4 multiply
 * of `high + low` in f32, and those two spellings of one point differ by
 * 0.10-0.16 m at this geometry, which is 6e-8 to 9e-8 NDC at the probe's camera.
 * A stepped frame would have read ~1.6e-2. The frame that reached the readback
 * had simply not moved: `Viewer` runs its own render loop
 * (`CesiumWidget.js:657`, `useDefaultRenderLoop ?? true`, rendering on EVERY
 * rAF), the probe stepped the polyline only before its own `scene.render()`
 * calls, and the loop rendered further un-stepped frames between them and
 * during the readback round-trip. An unmoved polyline writes zero BY DESIGN.
 * The probe now owns the render loop outright and ENCODES the copy
 * synchronously at the end of the last stepped frame, so the bytes belong to a
 * frame the probe stepped.
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
 * Counts velocity texels that clear the noise floor INSIDE one screen rectangle.
 *
 * Whole-frame counting cannot tell the polyline's motion vectors from those of
 * the positive control that shares the frame with it, so every velocity cell is
 * counted twice — once in the subject's rectangle and once in the control's.
 * The rectangle is inclusive on both corners and clamped to the target; an
 * absent or degenerate rectangle returns `invalid: true` rather than a zero
 * that would read like a measurement.
 *
 * @param {number[]} halves Flat `[r0, g0, r1, g1, …]` half-float patterns.
 * @param {number} width Target width in texels.
 * @param {number} height Target height in texels.
 * @param {{x0: number, y0: number, x1: number, y1: number}|null} region The rectangle.
 * @param {number} [floor] Magnitude at or below which a texel counts as still.
 * @returns {{nonZero: number, total: number, maxMagnitude: number, invalid?: boolean}} The counts.
 */
export function countNonZeroVelocityTexelsInRegion(
  halves,
  width,
  height,
  region,
  floor = VELOCITY_NOISE_FLOOR,
) {
  if (
    !region ||
    !Number.isFinite(region.x0) ||
    !Number.isFinite(region.y0) ||
    !Number.isFinite(region.x1) ||
    !Number.isFinite(region.y1) ||
    !(width > 0) ||
    !(height > 0)
  ) {
    return { nonZero: 0, total: 0, maxMagnitude: 0, invalid: true };
  }
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(region.x0)));
  const x1 = Math.max(0, Math.min(width - 1, Math.ceil(region.x1)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(region.y0)));
  const y1 = Math.max(0, Math.min(height - 1, Math.ceil(region.y1)));
  if (x1 < x0 || y1 < y0) {
    return { nonZero: 0, total: 0, maxMagnitude: 0, invalid: true };
  }
  let nonZero = 0;
  let maxMagnitude = 0;
  let total = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const index = (y * width + x) * 2;
      if (index + 1 >= halves.length) {
        continue;
      }
      const vx = decodeHalf(halves[index]);
      const vy = decodeHalf(halves[index + 1]);
      total += 1;
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
  }
  return { nonZero, total, maxMagnitude };
}

/**
 * Reduces one page-side velocity read into the cell this probe verdicts on.
 *
 * An unavailable read is NOT flattened into zeros: `unavailable` is carried so
 * the verdicts can refuse rather than score it, which is the whole of instrument
 * defect (d).
 *
 * @param {{available: boolean, halves: number[], width: number, height: number, regions: object|null}} read The page-side read.
 * @returns {object} `{unavailable}` or `{frame, line, control, width, height, regions}`.
 */
export function velocityCellFromRead(read) {
  if (!read || read.available !== true) {
    return {
      unavailable: true,
      frame: { nonZero: 0, total: 0, maxMagnitude: 0 },
      line: { nonZero: 0, total: 0, maxMagnitude: 0, invalid: true },
      control: { nonZero: 0, total: 0, maxMagnitude: 0, invalid: true },
      regions: null,
    };
  }
  const { halves, width, height } = read;
  const regions = read.regions ?? null;
  return {
    unavailable: false,
    frame: countNonZeroVelocityTexels(halves),
    line: countNonZeroVelocityTexelsInRegion(
      halves,
      width,
      height,
      regions?.line ?? null,
    ),
    control: countNonZeroVelocityTexelsInRegion(
      halves,
      width,
      height,
      regions?.control ?? null,
    ),
    width,
    height,
    regions,
  };
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
  // A read that never happened must not score. Both velocity cells require
  // their target to have EXISTED — `_velocityTexture` is allocated inside
  // `_runVelocityPass` and nowhere else, so its absence means the pass did not
  // run and the cell measured nothing.
  const colourAvailable = animatedColor.unavailable !== true;
  const dashAvailable = animatedDash.unavailable !== true;
  return [
    {
      id: "velocity-emitted",
      claim:
        "AR-752 — an animating PolylineCollection under TAA writes non-zero motion vectors in its own screen region (pre-fix: exactly 0)",
      pass: colourAvailable && animatedColor.line.nonZero > 0,
      detail: {
        nonZeroTexels: animatedColor.line.nonZero,
        regionTexels: animatedColor.line.total,
        maxMagnitude: animatedColor.line.maxMagnitude,
        frameNonZeroTexels: animatedColor.frame.nonZero,
        unavailable: animatedColor.unavailable === true,
      },
    },
    {
      id: "velocity-positive-control",
      claim:
        "the animating PointPrimitive sharing each scene writes non-zero motion vectors in ITS region, in both the Color and the Dash run — so an all-zero polyline read is attributable to the polyline and not to a blind readback",
      pass:
        colourAvailable &&
        dashAvailable &&
        animatedColor.control.nonZero > 0 &&
        animatedDash.control.nonZero > 0,
      detail: {
        colorControlNonZeroTexels: animatedColor.control.nonZero,
        dashControlNonZeroTexels: animatedDash.control.nonZero,
        colorUnavailable: animatedColor.unavailable === true,
        dashUnavailable: animatedDash.unavailable === true,
      },
    },
    {
      id: "negative-control-dash",
      claim:
        "a PolylineDash polyline, whose WGSL has no velocity entry points, still writes none in its region WITH the target present and the positive control non-zero",
      pass:
        dashAvailable &&
        animatedDash.control.nonZero > 0 &&
        animatedDash.line.nonZero === 0,
      detail: {
        nonZeroTexels: animatedDash.line.nonZero,
        controlNonZeroTexels: animatedDash.control.nonZero,
        unavailable: animatedDash.unavailable === true,
      },
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
      // OWN THE RENDER LOOP. `useDefaultRenderLoop` defaults to true
      // (`CesiumWidget.js:657`) and `startRenderLoop` renders on EVERY rAF, so
      // a probe that steps its subject only before its own `scene.render()`
      // calls hands the readback whatever the loop drew afterwards — an
      // un-stepped frame, whose velocity is zero by design. That is what made
      // the first three Edge runs of this probe read flat zero. Every frame this
      // probe measures must be a frame this probe stepped.
      viewer.useDefaultRenderLoop = false;
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

      // THE POSITIVE CONTROL. An animating point, parked well to the left of
      // the line, whose velocity is produced by a DIFFERENT renderer and a
      // different prev-stream mechanism than the polyline's
      // (`WebGPUPointPrimitiveRenderer` over `WebGPUResidentInstanceBuffer`'s
      // dirty-range prev mirror). It is what makes a zero on the polyline cell
      // attributable: with the control non-zero in the same read, the readback
      // and the velocity pass are demonstrably live. It is drawn RED so
      // `countLinePixels`' cyan test never counts it into the smear ratio.
      window.__probeControlPoints = undefined;
      window.__probeControlPosition = undefined;
      if (withPolyline) {
        const points = scene.primitives.add(new C.PointPrimitiveCollection());
        points.add({
          position: C.Cartesian3.fromDegrees(-10.5, 0.0),
          color: C.Color.RED.clone(),
          pixelSize: 20.0,
        });
        window.__probeControlPoints = points;
      }

      window.__probeCollection = undefined;
      window.__probeLinePositions = undefined;
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

      // Screen rectangles for the two subjects, derived from where THIS scene
      // projects them rather than from an assumed field of view, and scaled from
      // CSS canvas pixels into the velocity target's device pixels. The pads
      // clear each subject's own footprint (line half-width 6 px, point radius
      // 10 px) and still leave the two rectangles ~35 px apart at this camera.
      window.__probeRegions = (texWidth, texHeight) => {
        const canvas = scene.canvas;
        const scaleX = texWidth / (canvas.clientWidth || texWidth);
        const scaleY = texHeight / (canvas.clientHeight || texHeight);
        const project = (cartesians, padPx) => {
          if (!cartesians || cartesians.length === 0) {
            return null;
          }
          let x0 = Infinity;
          let y0 = Infinity;
          let x1 = -Infinity;
          let y1 = -Infinity;
          for (const cartesian of cartesians) {
            const canvasPosition =
              scene.cartesianToCanvasCoordinates(cartesian);
            if (!canvasPosition) {
              return null;
            }
            x0 = Math.min(x0, canvasPosition.x);
            x1 = Math.max(x1, canvasPosition.x);
            y0 = Math.min(y0, canvasPosition.y);
            y1 = Math.max(y1, canvasPosition.y);
          }
          return {
            x0: (x0 - padPx) * scaleX,
            y0: (y0 - padPx) * scaleY,
            x1: (x1 + padPx) * scaleX,
            y1: (y1 + padPx) * scaleY,
          };
        };
        return {
          line: project(window.__probeLinePositions, 12.0),
          control: project(
            window.__probeControlPosition
              ? [window.__probeControlPosition]
              : undefined,
            18.0,
          ),
        };
      };

      // Arm the WebGPU velocity readback path: the scene framebuffer allocates
      // the rg16float target with COPY_SRC, so the probe can copy it out
      // without changing anything the renderer does. `_velocityTexture` is
      // allocated inside `_runVelocityPass` and nowhere else, so its absence is
      // itself the finding "no command in this scene carried a velocity
      // command" — it is reported as unavailable, never flattened to a zero.
      //
      // The copy is ENCODED AND SUBMITTED SYNCHRONOUSLY, from the tail of the
      // last stepped `scene.render()`, so the bytes belong to a frame the probe
      // stepped. Encoding it from a later round-trip is what let an un-stepped
      // frame supply the measurement.
      window.__probeVelocityCapture = null;
      window.__probeCaptureVelocity = () => {
        const alt = scene._alternateSceneRenderer;
        const framebuffer = alt?._sceneFramebuffer;
        const texture = framebuffer?._velocityTexture;
        const device = scene.context._device ?? scene.context.device;
        if (!texture || !device) {
          window.__probeVelocityCapture = { available: false };
          return;
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
        window.__probeVelocityCapture = {
          available: true,
          readback,
          bytesPerRow,
          width,
          height,
          regions: window.__probeRegions(width, height),
        };
      };

      window.__probeReadVelocity = async () => {
        const capture = window.__probeVelocityCapture;
        if (!capture || capture.available !== true) {
          return {
            available: false,
            halves: [],
            width: 0,
            height: 0,
            regions: null,
          };
        }
        window.__probeVelocityCapture = null;
        const { readback, bytesPerRow, width, height, regions } = capture;
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
        return { available: true, halves, width, height, regions };
      };

      // Animate the far endpoint along the equator, one step per frame. The
      // near endpoint is fixed so the line sweeps rather than translates, which
      // gives the velocity field a range of magnitudes instead of one. The
      // control point steps with it, 0.05 deg of longitude per frame — 0.999 px,
      // i.e. 3.1e-3 NDC against the 1e-4 noise floor, about 31x — staying left
      // of the line for the whole sweep.
      window.__probeStep = (frame) => {
        const collection = window.__probeCollection;
        if (collection && collection.length > 0) {
          const polyline = collection.get(0);
          const positions = C.Cartesian3.fromDegreesArray([
            -6.0,
            0.0,
            6.0,
            -3.0 + frame * 0.25,
          ]);
          polyline.positions = positions;
          window.__probeLinePositions = positions;
        }
        const points = window.__probeControlPoints;
        if (points && points.length > 0) {
          const point = points.get(0);
          const position = C.Cartesian3.fromDegrees(-10.5 + frame * 0.05, 0.0);
          point.position = position;
          window.__probeControlPosition = position;
        }
      };

      window.__probeRender = async (frames, animated) => {
        for (let frame = 0; frame < frames; frame++) {
          if (animated) {
            window.__probeStep(frame);
          }
          scene.render();
          if (animated && frame === frames - 1) {
            // Same synchronous turn as the render that produced them: no other
            // frame can reach the velocity target before the copy is encoded.
            window.__probeCaptureVelocity();
          }
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        return {
          renderLoopDisabled: viewer.useDefaultRenderLoop === false,
          velocityCaptured: !!window.__probeVelocityCapture,
        };
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

      // Every scene must be one the probe drove alone. A run in which the
      // Viewer's own loop was still rendering measured frames the probe never
      // stepped, and that is a refusal, not a number. It matters beyond the two
      // velocity cells: the smear denominator is the LAST frame of an animated
      // WebGL run, and free-running frames after the last step let TAA keep
      // converging on the numerator's side of the same ratio.
      const assertProbeOwnedTheLoop = (status, cell) => {
        if (status?.renderLoopDisabled !== true) {
          throw new ProbeRefusal(
            "render-loop-not-owned",
            `probe-polyline-taa-velocity cell ${cell}: the Viewer's default render loop was still running, so the velocity target holds a frame the probe did not step`,
            { cell, status },
          );
        }
      };

      // A — animating Color polyline on WebGPU: the measurement.
      await buildScene(page, {
        renderer: "webgpu",
        materialType: "Color",
        withPolyline: true,
      });
      assertProbeOwnedTheLoop(
        await page.evaluate(
          (frames) => window.__probeRender(frames, true),
          FRAMES,
        ),
        "A",
      );
      const animatedColor = velocityCellFromRead(
        await page.evaluate(() => window.__probeReadVelocity()),
      );
      const webgpuShot = await capture(page, outputDirectory, "webgpu-color");

      // B — the negative control: PolylineDash has no velocity entry points.
      // The positive control shares the scene, so the target EXISTS here and a
      // zero on the dash line is a measured zero rather than an absent read.
      await buildScene(page, {
        renderer: "webgpu",
        materialType: "PolylineDash",
        withPolyline: true,
      });
      assertProbeOwnedTheLoop(
        await page.evaluate(
          (frames) => window.__probeRender(frames, true),
          FRAMES,
        ),
        "B",
      );
      const animatedDash = velocityCellFromRead(
        await page.evaluate(() => window.__probeReadVelocity()),
      );

      // E1 — the no-polyline control on WebGPU.
      await buildScene(page, {
        renderer: "webgpu",
        materialType: "Color",
        withPolyline: false,
      });
      assertProbeOwnedTheLoop(
        await page.evaluate(
          (frames) => window.__probeRender(frames, false),
          FRAMES,
        ),
        "E1",
      );
      const emptyWebgpu = await capture(page, outputDirectory, "webgpu-empty");

      // D — the same animation on WebGL: the smear denominator.
      await buildScene(page, {
        renderer: "webgl",
        materialType: "Color",
        withPolyline: true,
      });
      assertProbeOwnedTheLoop(
        await page.evaluate(
          (frames) => window.__probeRender(frames, true),
          FRAMES,
        ),
        "D",
      );
      const webglShot = await capture(page, outputDirectory, "webgl-color");

      // E2 — the no-polyline control on WebGL.
      await buildScene(page, {
        renderer: "webgl",
        materialType: "Color",
        withPolyline: false,
      });
      assertProbeOwnedTheLoop(
        await page.evaluate(
          (frames) => window.__probeRender(frames, false),
          FRAMES,
        ),
        "E2",
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
      "| run | Color line | Color control | Dash line | Dash control | webgpu line px | webgl line px | ratio | errors |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ];
    runs.forEach((run, index) => {
      const ratio =
        run.webglLinePixels > 0
          ? (run.webgpuLinePixels / run.webglLinePixels).toFixed(3)
          : "n/a";
      const cell = (measurement) =>
        measurement.unavailable === true ? "UNAVAILABLE" : undefined;
      const colorUnavailable = cell(run.animatedColor);
      const dashUnavailable = cell(run.animatedDash);
      lines.push(
        `| ${index + 1} | ${colorUnavailable ?? run.animatedColor.line.nonZero} | ${colorUnavailable ?? run.animatedColor.control.nonZero} | ${dashUnavailable ?? run.animatedDash.line.nonZero} | ${dashUnavailable ?? run.animatedDash.control.nonZero} | ${run.webgpuLinePixels} | ${run.webglLinePixels} | ${ratio} | ${run.errors} |`,
      );
    });
    lines.push("");
    return lines.join("\n");
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
