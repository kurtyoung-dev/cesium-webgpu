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
 * screen centre in GREEN with no `disableDepthTestDistance` at all. Each
 * collection additionally carries one off-screen EXTENT KEEPER — see
 * `lib/pick-visibility-matrix-page.mjs` for the job-10 measurement that made it
 * necessary, and `subjectRenderabilityChecks` for what it now guarantees.
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
 * As of round 2 the `ddtd = 0` cells are judged EXPECTATION-INDEPENDENTLY, as
 * an occlusion-parity claim of their own. Job 10 found WebGPU failing to
 * occlude subjects 60 km behind terrain with `logarithmicDepthBuffer = false`,
 * with BIT-IDENTICAL numbers on the pre- and post-`AR-001` trees — a difference
 * on both sides of the fix, which `--expect` must not be made to answer for.
 * `--expect` therefore governs the `ddtd = infinity` cells alone.
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
 * snap over cursor rings scaled to a local glTF model's own MEASURED projected
 * radius, on both backends, requires enough far edge hits for a rate to mean
 * anything, and compares WebGPU's rate to WebGL's — which is what `AR-030`'s
 * acceptance column actually names. Its verdicts carry their own `ar-m30` id so
 * a red there is attributable to `AR-030` alone. The leg's subject MUST carry
 * `EXT_mesh_primitive_edge_visibility` and MUST load with an `edgeDisplayMode`
 * other than the `SURFACES_ONLY` default, or no fragment in the scene can set
 * the snap payload's edge flag on both backends and the leg measures nothing —
 * see `SNAP` for the mechanism and for job 10's evidence.
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
  PICK_WARMUP_ATTEMPTS,
  allChecksPass,
  cellClaim,
  cellKey,
  classifyPick,
  classifyVisibility,
  controlChecks,
  isHeldItem,
  itemChecks,
  pickWarmupChecks,
  resolveExpectation,
  snapLegStanding,
  subjectRenderabilityChecks,
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
  cellClaim,
  classifyPick,
  classifyVisibility,
  itemChecks,
  occlusionParityCellPass,
  pickWarmupChecks,
  resolveExpectation,
  snapLegStanding,
  subjectRenderabilityChecks,
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
  // The extent keepers' longitude offset from the scene centre. The viewport's
  // half-width at this camera is about 1.9 deg of longitude AT THE KEEPERS' OWN
  // HEIGHT and about 2.7 deg at the surface (Cesium's default 60 deg fov is the
  // HORIZONTAL one at aspect > 1), so 3.0 deg is off-screen — but the margin
  // comes from `controlHeight`: at the SUBJECTS' -60 km the half-width is about
  // 3.1 deg, and a keeper placed down there at this offset would be on canvas.
  // Being off-screen is what lets a keeper lift a collection's bounding sphere
  // clear of the horizon occluder without appearing in any sample window. See
  // `lib/pick-visibility-matrix-page.mjs`, "EXTENT KEEPERS".
  keeperDLon: 3.0,
  sampleHalfWidth: 10,
  settleFrames: 140,
  legSettleFrames: 45,
  pickWarmupAttempts: PICK_WARMUP_ATTEMPTS,
});

/**
 * The `AR-M30` leg's scene and cursor rings.
 *
 * THE SUBJECT MUST CARRY `EXT_mesh_primitive_edge_visibility`. `isEdge` is not
 * a property of where the cursor sits: it is a fragment flag that only a
 * model's EDGE PASS writes. `ModelFS.glsl:68` declares `isEdge = false` and
 * sets it true only at `:202-203`, inside `#ifdef HAS_EDGE_VISIBILITY` under
 * `u_isEdgePass`; `PickingPipelineStage.js:43` packs it into the snap payload
 * and `SnapFramebuffer.js:56` is the ONLY place it is ever derived. The edge
 * stage exists only when `defined(primitive.edgeVisibility)`
 * (`ModelRuntimePrimitive.js:269,357-363`), which is populated only from the
 * glTF primitive's `EXT_mesh_primitive_edge_visibility`
 * (`GltfLoader.js:1415-1418`). Job 10's subject was
 * `Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb`, which has NO
 * extensions at all — `extensionsUsed` undefined, every primitive's
 * `extensions` null, and the byte string `EXT_` absent from all 441,972 bytes —
 * so no fragment in that scene could set the flag at any aperture or cursor
 * pattern, and its 81/81 zero-`isEdge` result was a property of the ASSET, not
 * of the grid. `Specs/Data/Models/glTF-2.0/EdgeVisibility/glTF-Binary/
 * EdgeVisibility.glb` (8,144 B) declares the extension in `extensionsUsed` and
 * carries it on BOTH primitives; `server.js` serves the repository root, so it
 * is offline and free. Section N of the companion spec decodes whatever asset
 * this field names and refuses one without the extension.
 *
 * WHY `edgeDisplayMode` IS SET, AND WHICH BACKEND NEEDS IT. WebGL does not:
 * its snap pass pushes `_edgeSnapCommand` REGARDLESS of the display mode
 * (`ModelDrawCommand.js:250-258` — "snapping works even when edges are visually
 * suppressed"), and `pushEdgeCommands` is called unconditionally
 * (`ModelSceneGraph.js:1243-1245`). WebGPU does: its whole edge emitter,
 * INCLUDING the snap variant, sits inside a block gated on
 * `edgeDisplayMode !== SURFACES_ONLY` (`WebGPUModelRenderer.ts:8514-8517`, snap
 * variant at `:8770+`). Left at the `SURFACES_ONLY` default (`Model.js:489`)
 * this leg would read edge hits on WebGL and none on WebGPU, and publish a
 * backend difference that is a CONFIGURATION artifact rather than `AR-030`'s.
 */
export const SNAP = Object.freeze({
  modelUrl:
    "/Specs/Data/Models/glTF-2.0/EdgeVisibility/glTF-Binary/EdgeVisibility.glb",
  // The extension both halves of the leg depend on. Section N of the spec
  // decodes `modelUrl` and requires this string in its `extensionsUsed`.
  requiredExtension: "EXT_mesh_primitive_edge_visibility",
  // Resolved in the page against `Cesium.EdgeDisplayMode`; a string because
  // `cfg` crosses the `page.evaluate` boundary by structured clone.
  edgeDisplayMode: "SURFACES_AND_EDGES",
  // Numeric fallback for a bundle whose barrel does not re-export the enum —
  // the two shipped edge probes drive this feature by number for the same
  // reason. Section N of the spec pins these against `Scene/EdgeDisplayMode.js`
  // itself, so this is a mirror with a guard rather than a second authority.
  edgeModeValues: Object.freeze({
    SURFACES_ONLY: 0,
    SURFACES_AND_EDGES: 1,
    EDGES_ONLY: 2,
  }),
  lon: -105.0,
  lat: 40.0,
  // Job 10's BEFORE leg rendered real terrain on the WebGL page and buried its
  // model: (-105, 40) carries ~1500 m of terrain, and the model sat at 100 m.
  // The page now pins `EllipsoidTerrainProvider`, and this height keeps the
  // model clear of any terrain a future scene change could reintroduce.
  height: 2500.0,
  scale: 10.0,
  readyFrames: 300,
  settleFrames: 90,
  // The camera range is DERIVED from the model's own bounding-sphere radius
  // rather than tuned per asset: at range `rangeFactor * r` the projected
  // radius is `(H/2) / (tan(fovy/2) * rangeFactor)` — independent of `scale`
  // and of the asset's units — which is 148 px at this probe's 1024x768 and
  // Cesium's default 60 deg horizontal fov (fovy 46.8 deg at 4:3). Swapping the
  // subject therefore cannot silently mis-frame the leg.
  rangeFactor: 6.0,
  // Cursors on concentric rings scaled to the MODEL'S OWN measured projected
  // radius, from well inside the silhouette to just outside it, so a wide
  // aperture straddles the outline whatever the model's screen size. 4 rings x
  // 20 steps + the centre = 81 cursors, the same population job 10 reported.
  ringFractions: Object.freeze([0.45, 0.7, 0.95, 1.2]),
  ringSteps: 20,
  // Below this projected radius the model is too small for an aperture to mean
  // anything, and the leg refuses rather than reporting an empty rate. The
  // derived range puts the measured radius at ~148 px, so this floor catches a
  // mis-framing rather than trimming a healthy leg.
  minScreenRadius: 60,
  inFrameAttempts: 16,
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
    // Present on the CONTROL only: the discarded picks spent cooking the leg's
    // pick pipelines before anything was measured. Published, not asserted for
    // cost; `pickWarmupChecks` asserts only that it resolved.
    pickWarmup: raw.pickWarmup ?? null,
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
      const renderability = [];
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

        // One renderability record per (item, log-depth page): the engine-visible
        // preconditions for the subject to be measurable at all, on both
        // backends. This is what job 10's billboard needed and did not have.
        for (const item of ITEMS) {
          const record = { run, item, logDepth };
          for (const renderer of options.renderers) {
            record[renderer] = perRenderer[renderer]?.renderability?.[item] ?? {
              present: false,
              show: false,
              imageReady: null,
              commandExecuted: false,
            };
          }
          renderability.push(record);
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
        // "Loaded", "projected" and "in frame, in front of the globe" are three
        // different claims, and job 10 banked a leg where the first two were
        // true and the third was false. `snapLegStanding` owns the decision so
        // a browser-free spec can execute and mutate it.
        const standing = snapLegStanding(result.measured);
        if (standing !== null) {
          throw new ProbeRefusal(
            standing.code,
            `${standing.message} (${renderer})`,
            {
              renderer,
              modelUrl: SNAP.modelUrl,
              framing: result.measured.framing ?? null,
            },
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

      return [
        {
          kind: "run",
          run,
          expectation,
          cells,
          controls,
          renderability,
          snap,
          gates,
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
      renderability: entry.renderability,
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
      // A subject that never reaches the screen measures 0 hue pixels, which
      // reads exactly like occlusion. These come FIRST so a run that lost a
      // subject says so before it says anything about `AR-001`.
      for (const record of entry.renderability ?? []) {
        for (const check of subjectRenderabilityChecks(record)) {
          verdicts.push({
            id: `${check.id}-run${run}`,
            claim: `AR-837 — ${check.label}`,
            pass: check.pass,
          });
        }
      }
      for (const control of entry.controls) {
        for (const check of pickWarmupChecks(control)) {
          verdicts.push({
            id: `${check.id}-run${run}`,
            claim: `AR-837 — ${check.label}`,
            pass: check.pass,
          });
        }
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
          // Not an interpolated string here: which ROW a cell verdict is filed
          // under is a decision, and it lives in the import-free module the
          // spec can mutate. See `cellClaim`.
          claim: cellClaim(cell, expectation),
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
      lines.push(
        "| subject renderability | webgl | webgpu |",
        "| --- | --- | --- |",
      );
      for (const record of entry.renderability ?? []) {
        const show = (measured) =>
          `present ${measured?.present === true}, show ${measured?.show === true}, imageReady ${measured?.imageReady ?? "n/a"}, command ${measured?.commandExecuted === true ? "EXECUTED" : "CULLED"}`;
        lines.push(
          `| ${record.item}/log-${record.logDepth ? "on" : "off"} | ${show(record.webgl)} | ${show(record.webgpu)} |`,
        );
      }
      lines.push("");
      lines.push(
        "| pick warm-up (discarded, before the leg is measured) | webgl | webgpu |",
        "| --- | --- | --- |",
      );
      for (const control of entry.controls) {
        const show = (measured) => {
          const warmup = measured?.pickWarmup;
          return warmup
            ? `${warmup.resolved ? "resolved" : "NEVER RESOLVED"} after ${warmup.attempts} of ${warmup.budget}`
            : "n/a";
        };
        lines.push(
          `| log-${control.logDepth ? "on" : "off"}/ddtd-${control.ddtd} | ${show(control.webgl)} | ${show(control.webgpu)} |`,
        );
      }
      lines.push("");
      for (const leg of entry.snap) {
        lines.push(
          `AR-M30 (aperture ${leg.snapWidth} px, subject ${leg.webgl?.modelUrl ?? leg.webgpu?.modelUrl ?? "?"} at edgeDisplayMode ${leg.webgl?.edgeDisplayMode ?? leg.webgpu?.edgeDisplayMode ?? "?"}, cursors on rings scaled to its measured projected radius ${Math.round(leg.webgl?.framing?.screenRadius ?? 0)}/${Math.round(leg.webgpu?.framing?.screenRadius ?? 0)} px): webgl ${leg.webgl?.surfaceDefined ?? 0}/${leg.webgl?.farEdgeHits ?? 0} of ${leg.webgl?.edgeHits ?? 0} edge hits, webgpu ${leg.webgpu?.surfaceDefined ?? 0}/${leg.webgpu?.farEdgeHits ?? 0} of ${leg.webgpu?.edgeHits ?? 0}, defined for edge hits more than ${MIN_CURSOR_OFFSET_PIXELS} px from the cursor.`,
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
