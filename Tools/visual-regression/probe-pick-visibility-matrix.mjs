#!/usr/bin/env node
/**
 * Probe: the pick/visibility matrix — `AR-837`, the instrument `AR-M01` (the
 * named acceptance for `AR-001`) and `AR-M30` (the acceptance for `AR-030`)
 * both need and neither had.
 * @purpose AR-837's pick/visibility matrix: per item, visible + pickAsync-at-centre behind terrain over both disableDepthTestDistance legs, both logarithmicDepthBuffer legs and both backends, plus the AR-M30 surfacePosition defined-rate; judged against a named --expect before|after.
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * WHAT THIS MEASURES, AND WHY IT IS A MATRIX. `AR-837`'s acceptance column
 * (`QUEUE_2026-09-03_ARCHITECTURE_REVIEW.md:233`) is the specification, verbatim:
 *
 *   "a pick/visibility matrix instrument: per item, `visible` (yes/no) and
 *    `pickAsync` at centre (yes/no), over both `logarithmicDepthBuffer` legs
 *    and both backends; plus `surfacePosition` defined-rate for hits > 2 px
 *    from the cursor. Bar: today WebGPU misses the pick on billboard/label/
 *    point behind terrain at `disableDepthTestDistance = Infinity` while
 *    WebGL hits — the matrix must show that difference before `AR-001` lands
 *    and its disappearance after"
 *
 * The subject is therefore a DIFFERENCE between backends, not a number from
 * one of them, and the instrument has TWO first-class expectations. `--expect`
 * is required and has no default: a probe that defaulted to `after` would
 * report the pre-fix tree as a failure of the fix rather than as the
 * reproduction it is, and one that defaulted to `before` would do the mirror
 * image. Both legs are run by an Edge executor — BEFORE on a tree served from
 * Batch 1438 `08cb6fd4b2` (the commit before the fix), AFTER on the tip.
 *
 * THE SCENE. A nadir camera 400 km over (-105, 40) on `EllipsoidTerrainProvider`
 * with imagery removed, so the globe is a flat `baseColor` grey that no item's
 * hue can be confused with, and no tile request leaves the machine. Four
 * subjects sit 60 km BELOW the surface — behind terrain from this camera by a
 * margin no depth-precision regime can close — each in its own quadrant and
 * each owning a hue no other subject can produce:
 *
 *   BILLBOARD  RED      (-0.6, +0.3)   32x32 generated canvas
 *   LABEL      CYAN     (+0.6, +0.3)   showBackground, black glyphs on cyan
 *   POINT      YELLOW   (-0.6, -0.3)   pixelSize 30
 *   POLYLINE   MAGENTA  (+0.25..+0.95, -0.3)   HELD on AR-D09 — see below
 *
 * and a fifth primitive, the CONTROL, sits 120 km ABOVE the surface at the
 * screen centre in GREEN with no `disableDepthTestDistance` at all.
 *
 * WHY THE CONTROL IS LOAD-BEARING. The BEFORE leg's entire finding is a WebGPU
 * pick MISS. A miss and "this page never produced a pick" are the same
 * observation, and `Globe.pickable` defaults false — with the WebGL globe path
 * never referencing the id even when it is true (`Globe.js:1484-1500`) — so
 * there is no shared "something was picked" fallback to lean on. The control
 * is unoccluded and always pickable on both backends, so it converts the
 * ambiguity into an assertion: if the control does not pick, the cell proves
 * nothing and the run goes red on the control rather than filing a defect.
 *
 * WHY THE `ddtd = 0` LEG EXISTS. "No backend difference" is satisfied just as
 * well by two backends that are both wrong. Every item is measured at
 * `disableDepthTestDistance = 0` as well as `Infinity`, and the WebGL anchor is
 * asserted under BOTH expectations: at `Infinity` WebGL must be visible and
 * must pick; at `0` it must be occluded and must not. A scene that stopped
 * occluding would fail there instead of quietly passing everywhere.
 *
 * THE HELD ITEM. `Polyline.disableDepthTestDistance` is fork-added and honoured
 * by WebGPU only; `AR-D09` has not ruled on whether it stays. The polyline cell
 * is measured and published in full and is never asserted — `itemChecks`
 * returns nothing for it — so the ruling gets its evidence without this probe
 * pre-judging it.
 *
 * THE `AR-M30` LEG IS A DIFFERENT ROW. `surfacePosition` defined-rate for edge
 * hits more than 2 px from the cursor is `AR-030`'s acceptance, not
 * `AR-001`'s, and `AR-030`'s own text RETRACTS the "today 0%" figure it used to
 * carry. So this probe predicts nothing about the rate: it runs a wide-aperture
 * snap grid over a local glTF model on both backends, requires enough far edge
 * hits for a rate to mean anything, and compares WebGPU's rate to WebGL's —
 * which is what `AR-030`'s acceptance column actually names. Its verdicts carry
 * their own `ar-m30` id so a red there is attributable to `AR-030` alone.
 *
 * Usage: node server.js --port 8094 --serve-built   (separate terminal, once)
 *        node Tools/visual-regression/probe-pick-visibility-matrix.mjs --expect after
 * Out:   Tools/visual-regression/output/pick-visibility-matrix/
 */
import fs from "node:fs";
import path from "node:path";

import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import {
  captureMatrix,
  captureSnap,
} from "./lib/pick-visibility-matrix-page.mjs";
import { ProbeRefusal, isEntryPoint, runProbe } from "./lib/probe-runtime.mjs";
import {
  DDTD_LEGS,
  ITEMS,
  LOG_DEPTH_LEGS,
  MIN_CURSOR_OFFSET_PIXELS,
  PICK_ATTEMPTS,
  allChecksPass,
  cellKey,
  classifyPick,
  classifyVisibility,
  controlChecks,
  isHeldItem,
  itemChecks,
  resolveExpectation,
  summarizeCell,
  surfacePositionChecks,
} from "./lib/pick-visibility-matrix-verdicts.mjs";

// The decision functions live in `lib/pick-visibility-matrix-verdicts.mjs`,
// which has no imports of its own, so `pick-visibility-matrix-verdicts.spec.mjs`
// can mutate them as text and execute the mutant. `AR-837`'s acceptance is that
// the matrix separates two worlds; proving the separation is carried by the
// SHIPPED decision — and not by a spec-supplied flag — needs the real file.
export {
  DDTD_LEGS,
  ITEMS,
  LOG_DEPTH_LEGS,
  allChecksPass,
  buildChecks,
  classifyPick,
  classifyVisibility,
  itemChecks,
  resolveExpectation,
  surfacePositionChecks,
} from "./lib/pick-visibility-matrix-verdicts.mjs";

const VIEWPORT = { width: 1024, height: 768 };
const WATCHDOG_BUDGET_MS = 12 * 60 * 1000;

/** Offline-friendly scene anchor: no tile, imagery or ion request leaves the machine. */
const SCENE = Object.freeze({
  lon: -105.0,
  lat: 40.0,
  cameraHeight: 400000.0,
  // 60 km below the ellipsoid: behind terrain by a margin no depth-precision
  // regime closes, in either `logarithmicDepthBuffer` leg.
  itemHeight: -60000.0,
  // 120 km above it: unoccluded from the same camera.
  controlHeight: 120000.0,
  sampleHalfWidth: 10,
  settleFrames: 140,
  legSettleFrames: 45,
});

/** The `AR-M30` leg's scene and grid. */
const SNAP = Object.freeze({
  modelUrl: "/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb",
  lon: -105.0,
  lat: 40.0,
  height: 100.0,
  scale: 20.0,
  readyFrames: 300,
  settleFrames: 90,
  // 9x9 cursors on a 9 px pitch: +/-36 px, comfortably inside the truck's
  // ~237 px on-screen length, which is where a WIDE aperture produces winning
  // edge hits that are FAR from the cursor — the population `AR-M30` names.
  gridSpan: 4,
  gridStep: 9,
  retries: 6,
});

/**
 * The four subjects plus the control, as the page builds and measures them.
 * `sample` is the world position whose projection is both the pixel window's
 * centre and the `pickAsync` window position — "at centre", in `AR-837`'s words.
 */
const SUBJECT_LAYOUT = Object.freeze({
  billboard: Object.freeze({ dLon: -0.6, dLat: 0.3 }),
  label: Object.freeze({ dLon: 0.6, dLat: 0.3 }),
  point: Object.freeze({ dLon: -0.6, dLat: -0.3 }),
  polyline: Object.freeze({ dLon: 0.6, dLat: -0.3 }),
});

// ---------------------------------------------------------------------------
// Capture.
// ---------------------------------------------------------------------------

/**
 * Opens one page, runs one capture function on it, screenshots the canvas and
 * collects the WebGPU error gate.
 *
 * @param {object} options Options.
 * @param {object} options.browser Playwright browser.
 * @param {string} options.origin Served origin.
 * @param {string} options.renderer Backend.
 * @param {string} options.outputDirectory Where the PNG goes.
 * @param {string} options.pngName File name for the capture.
 * @param {Function} options.capture `(page) => Promise<object>`.
 * @returns {Promise<object>} The capture plus gate state.
 */
async function onPage({
  browser,
  origin,
  renderer,
  outputDirectory,
  pngName,
  capture,
}) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  try {
    const consoleErrors = attachConsoleErrorGate(page);
    await page.addInitScript(errorGateInit);
    await page.goto(
      `${origin}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
      { waitUntil: "networkidle", timeout: 90000 },
    );
    await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });
    await armWebGPUDevices(page);

    const measured = await capture(page);
    const buffer = await page.screenshot({ omitBackground: false });
    const file = path.join(outputDirectory, `${pngName}.png`);
    fs.writeFileSync(file, buffer);

    const gate = await collectGateErrors(page);
    return {
      measured,
      png: file,
      gateErrors: gate.errors.length,
      gateErrorsSample: gate.errors.slice(0, 6),
      deviceLost: gate.deviceLost ?? null,
      consoleErrors: consoleErrors.slice(0, 6),
    };
  } finally {
    await page.close();
  }
}

/**
 * Turns one backend's raw measurement into the three-way classification the
 * verdict functions read.
 *
 * @param {object|undefined} measurement Raw per-item measurement.
 * @returns {object} The classified measurement.
 */
function classifyMeasurement(measurement) {
  const raw = measurement ?? {};
  return {
    centre: raw.centre ?? null,
    huePixels: raw.huePixels ?? null,
    // Observed, never asserted: the label's glyph (SDF) coverage beside its
    // background (non-SDF) hue. See `lib/pick-visibility-matrix-page.mjs`.
    glyphPixels: raw.glyphPixels ?? null,
    pickHits: raw.pickHits ?? null,
    pickAttempts: raw.pickAttempts ?? null,
    pickIds: raw.pickIds ?? [],
    visibility: classifyVisibility(raw.huePixels),
    pickClass: classifyPick(raw.pickHits, raw.pickAttempts),
  };
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "pick-visibility-matrix",
  title: "Pick / visibility matrix (AR-837 — the AR-M01 and AR-M30 instrument)",
  receiptEnvelope: "probe-owned",
  args: {
    extraOptions: [
      { flag: "--expect", key: "expect", kind: "string" },
      {
        flag: "--snap-width",
        key: "snapWidth",
        kind: "positive-integer",
        default: 45,
      },
    ],
  },
  async cells({ browser, origin, outputDirectory, options, run }) {
    // No default: `AR-837` names two outcomes and the probe judges against the
    // one it was told. A missing flag is malformed input, not a choice.
    const expectation = resolveExpectation(options.expect);
    if (options.renderers.length !== 2) {
      throw new ProbeRefusal(
        "renderer-pair-required",
        `probe-pick-visibility-matrix reports the DIFFERENCE between backends per cell and cannot compute one from a single backend; got --renderer ${options.renderers.join(",")}`,
        { renderers: options.renderers },
      );
    }
    fs.mkdirSync(outputDirectory, { recursive: true });

    // Everything that can hang — page open, navigation, the settle, the pick
    // loops and the snap grid — runs inside `work`, so the watchdog covers the
    // whole budget rather than only the render loops.
    const work = (async () => {
      const cells = [];
      const controls = [];
      const snap = [];
      const gates = [];

      for (const logDepth of LOG_DEPTH_LEGS) {
        const perRenderer = {};
        const pngs = {};
        for (const renderer of options.renderers) {
          const result = await onPage({
            browser,
            origin,
            renderer,
            outputDirectory,
            pngName: `pick-visibility-matrix-${renderer}-log-${logDepth ? "on" : "off"}-run${run}`,
            capture: (page) =>
              captureMatrix(page, {
                ...SCENE,
                logDepth,
                items: [...ITEMS],
                ddtdLegs: [...DDTD_LEGS],
                layout: SUBJECT_LAYOUT,
                pickAttempts: PICK_ATTEMPTS,
              }),
          });
          perRenderer[renderer] = result.measured;
          pngs[renderer] = result.png;
          gates.push({
            leg: `matrix/log-${logDepth ? "on" : "off"}/${renderer}`,
            renderer,
            gateErrors: result.gateErrors,
            gateErrorsSample: result.gateErrorsSample,
            deviceLost: result.deviceLost,
            consoleErrors: result.consoleErrors,
          });
        }

        for (const ddtd of DDTD_LEGS) {
          const control = { run, logDepth, ddtd };
          for (const renderer of options.renderers) {
            control[renderer] = classifyMeasurement(
              perRenderer[renderer]?.controls?.[ddtd],
            );
            control[`${renderer}Png`] = pngs[renderer];
          }
          controls.push(control);
          for (const item of ITEMS) {
            const cell = { run, item, ddtd, logDepth, held: isHeldItem(item) };
            for (const renderer of options.renderers) {
              cell[renderer] = classifyMeasurement(
                perRenderer[renderer]?.legs?.[ddtd]?.[item],
              );
            }
            cells.push(cell);
          }
        }
      }

      for (const renderer of options.renderers) {
        const result = await onPage({
          browser,
          origin,
          renderer,
          outputDirectory,
          pngName: `pick-visibility-matrix-snap-${renderer}-run${run}`,
          capture: (page) =>
            captureSnap(page, {
              ...SNAP,
              snapWidth: options.snapWidth,
              minOffset: MIN_CURSOR_OFFSET_PIXELS,
            }),
        });
        if (result.measured.modelReady !== true) {
          throw new ProbeRefusal(
            "snap-model-never-ready",
            `the AR-M30 leg's glTF model never reached ready on ${renderer}; the leg saw no subject, so it has no standing to report a surfacePosition rate`,
            { renderer, modelUrl: SNAP.modelUrl },
          );
        }
        if (result.measured.projected !== true) {
          throw new ProbeRefusal(
            "snap-model-not-projected",
            `the AR-M30 leg could not project its model to window coordinates on ${renderer}`,
            { renderer },
          );
        }
        if (snap.length === 0) {
          snap.push({ run, snapWidth: options.snapWidth });
        }
        const leg = snap[0];
        leg[renderer] = result.measured;
        leg[`${renderer}Png`] = result.png;
        gates.push({
          leg: `snap/${renderer}`,
          renderer,
          gateErrors: result.gateErrors,
          gateErrorsSample: result.gateErrorsSample,
          deviceLost: result.deviceLost,
          consoleErrors: result.consoleErrors,
        });
      }

      return [{ kind: "run", run, expectation, cells, controls, snap, gates }];
    })();
    work.catch(() => {});
    let watchdogTimer;
    const watchdog = new Promise((_resolve, reject) => {
      watchdogTimer = setTimeout(
        () =>
          reject(
            new ProbeRefusal(
              "watchdog-timeout",
              `probe-pick-visibility-matrix exceeded its ${WATCHDOG_BUDGET_MS}ms machine-safety budget`,
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
    const runs = cells.map((entry) => ({
      run: entry.run,
      expectation: entry.expectation,
      controls: entry.controls,
      snap: entry.snap,
      gates: entry.gates,
      matrix: entry.cells.map((cell) => ({
        ...summarizeCell(cell),
        webgl: cell.webgl,
        webgpu: cell.webgpu,
      })),
    }));
    return {
      base: context.origin,
      expectation: cells[0]?.expectation ?? null,
      row: "AR-837",
      measures: ["AR-M01", "AR-M30"],
      heldItems: ITEMS.filter((item) => isHeldItem(item)),
      runs,
    };
  },
  verdicts(cells) {
    const verdicts = [];
    for (const entry of cells) {
      const { run, expectation } = entry;
      for (const control of entry.controls) {
        verdicts.push({
          id: `control-log-${control.logDepth ? "on" : "off"}-ddtd-${control.ddtd}-run${run}`,
          claim: `AR-837 — the unoccluded control renders and picks on both backends (log ${control.logDepth ? "on" : "off"}, ddtd ${control.ddtd}), so a subject miss is a measurement and not a dead pick path`,
          pass: allChecksPass(controlChecks(control)),
        });
      }
      for (const cell of entry.cells) {
        if (isHeldItem(cell.item)) {
          // Measured and published; never judged, until `AR-D09` rules.
          continue;
        }
        verdicts.push({
          id: `${cellKey(cell)}-run${run}`,
          claim: `AR-837/${expectation} — ${cell.item} behind terrain at disableDepthTestDistance ${cell.ddtd} with logarithmicDepthBuffer ${cell.logDepth ? "on" : "off"}`,
          pass: allChecksPass(itemChecks(cell.item, cell, expectation)),
        });
      }
      for (const leg of entry.snap) {
        for (const check of surfacePositionChecks(leg)) {
          verdicts.push({
            id: `${check.id}-run${run}`,
            claim: `AR-M30 (row AR-030, NOT AR-001) — ${check.label}`,
            pass: check.pass,
          });
        }
      }
      // The device-health gate has to be a VERDICT: `exitCodeForOutcome` reads
      // verdicts and nothing else, so a leg with uncaptured WebGPU validation
      // errors or a lost device would otherwise exit 0 on the matrix alone.
      verdicts.push({
        id: `gate-run${run}`,
        claim: `AR-837 — no uncaptured WebGPU errors and no device loss across the run's ${entry.gates.length} pages`,
        pass: entry.gates.every(
          (gate) => gate.gateErrors === 0 && !gate.deviceLost,
        ),
      });
    }
    return verdicts;
  },
  summary(receipt) {
    const lines = [
      "# Pick / visibility matrix (AR-837)",
      "",
      `Base: \`${receipt.base}\``,
      "",
      `Expectation: **${receipt.expectation}**`,
      "",
    ];
    for (const entry of receipt.runs) {
      lines.push(`## run ${entry.run}`, "");
      lines.push(
        "| cell | webgl visible | webgpu visible | webgl pick | webgpu pick | differs |",
        "| --- | --- | --- | --- | --- | --- |",
      );
      for (const row of entry.matrix) {
        const differs = row.visibilityDiffers || row.pickDiffers ? "YES" : "no";
        lines.push(
          `| ${row.key}${row.held ? " (held, AR-D09)" : ""} | ${row.webglVisible} | ${row.webgpuVisible} | ${row.webglPick} | ${row.webgpuPick} | ${differs} |`,
        );
      }
      lines.push("");
      for (const leg of entry.snap) {
        lines.push(
          `AR-M30 (aperture ${leg.snapWidth} px): webgl ${leg.webgl?.surfaceDefined ?? 0}/${leg.webgl?.farEdgeHits ?? 0}, webgpu ${leg.webgpu?.surfaceDefined ?? 0}/${leg.webgpu?.farEdgeHits ?? 0} defined for edge hits more than ${MIN_CURSOR_OFFSET_PIXELS} px from the cursor.`,
          "",
        );
      }
    }
    return lines.join("\n");
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
