// probe-buffer-polyline-meters-width.mjs — census C-04 / `-07` item 18 acceptance.
//
// @purpose Measures whether a NON-draped BufferPolylineCollection with widthUnits:"meters" keeps a constant GROUND width on WebGPU: two collections, two camera distances one octave apart, stroke-width ratio per backend.
// @status ACTIVE
// @runtime lib/probe-runtime.mjs
//
// ── WHAT IT ANSWERS ─────────────────────────────────────────────────────────
//
// `buffer-polyline-meters-width.spec.mjs` proves the ARITHMETIC on the CPU: the
// packer's sign expression evaluates to the convention, and the transcribed
// WGSL width model agrees with the GLSL one through a real `PerspectiveFrustum`
// across an octave. What a CPU spec structurally cannot show is that the signed
// attribute survives the vertex buffer, that the shader module the pipeline
// actually got contains the branch (an unresolved bare `#import` is STRIPPED
// with only a debug-stripped warning), and that the miter does not invert. That
// is this probe's job, and it is the census's stated acceptance for C-04:
//
//   "one metres and one pixels collection at two camera distances one octave
//    apart; the metres stroke halves on both backends, the pixels stroke does
//    not."
//
// ── THE MEASUREMENT ─────────────────────────────────────────────────────────
//
// Two `BufferPolylineCollection`s in `scene.primitives`, NOT clamped, so they
// render as their own screen-space geometry — the non-draped path, which is a
// different code path from `probe-vector-draping.mjs`'s subject:
//
//   RED   60 m of road, `widthUnits: "meters"`  -> must HALVE per octave
//   BLUE  8 px of line, default pixels          -> must NOT move
//
// Both are north-south meridian segments, so they render as vertical strokes
// and a per-row horizontal run IS the stroke's perpendicular screen width. The
// globe is hidden and the background forced to black: the subject is a
// screen-space polyline, terrain would only contribute LOD noise to the pixel
// classification, and a black ground makes "changed" unambiguous.
//
// The statistic is the MEDIAN per-row run of each colour class, not the mean:
// runs are integer pixel counts and the top and bottom rows of a segment are
// clipped by the viewport, which drags a mean but not a median.
//
// ── EXPECTED BEHAVIOUR BEFORE AND AFTER ─────────────────────────────────────
//
// Before this lane, `WebGPUBufferPolylineRenderer` wrote the width UNSIGNED and
// `BufferPolylineMaterial.wgsl` had no sign test, so a metres width was drawn
// as a PIXEL width: the WebGPU metres ratio measured ~1.0 while WebGL's was
// ~2.0. The pre-fix symptom is therefore a distinct NUMBER rather than a
// missing one, which is what makes this leg diagnostic rather than a presence
// check — and what makes the probe exit non-zero on the pre-fix engine by
// construction.
//
// A THIRD failure mode is scored separately: signing the attribute without the
// shader branch extrudes by a NEGATIVE half-width, which inverts every miter.
// That does not read as "wrong width" but as a ribbon that folds — measured
// here as the metres stroke's row COUNT collapsing relative to the pixels
// stroke's over the same segment.
//
// ── MULTI-METRIC ────────────────────────────────────────────────────────────
//
// Per (renderer, run) cell the receipt carries, for each altitude and colour:
// the occupied row count, the median run, the mean run and the changed-pixel
// count; plus the console/page error lists and the settle frame counts. Noise
// behaviour:
//
//   median run      — integer-quantized. A ~19 px near stroke lands within
//                     +/-1 px run-to-run, so the octave ratio carries roughly
//                     +/-10%; the gate bands are set from that, not tighter.
//   occupied rows   — deterministic for a fixed camera on a hidden globe.
//   errors          — deterministic. Any GPU validation error is a finding.
//
// ── USAGE ───────────────────────────────────────────────────────────────────
//
//   node server.js --serve-built &
//   node Tools/visual-regression/probe-buffer-polyline-meters-width.mjs \
//     --renderer webgl,webgpu --runs 2
//
// `--scene-mode 3d|2d|cv-ortho` selects the projection under test. The octave
// law is the same in all three: a 2D camera's orthographic extents and a
// Columbus-View orthographic frustum's width are both tied to the eye height by
// `Camera._adjustOrthographicFrustum`, so doubling the height doubles the
// metres-per-pixel and halves a metres stroke, exactly as the perspective
// camera does. What differs is which arm of `csm_metersPerPixel` runs: the two
// orthographic modes are the GLSL's `czm_sceneMode2D || czm_orthographicIn3D`
// arm, and a chunk carrying only the perspective arm answers those cameras with
// the perspective formula, which multiplies the pixel size by the eye depth and
// leaves the stroke far too thin to measure — clause 0, STRUCTURAL, not FAIL.
//
// Exit codes are the shared runtime's.

import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";

const VIEWPORT = Object.freeze({ width: 1024, height: 768 });

/** The two eye heights, one octave apart, on the same nadir look vector. */
export const NEAR_HEIGHT_METRES = 6000.0;
export const FAR_HEIGHT_METRES = 12000.0;

/** Authored widths. 60 m is ~19 px at the near height on this viewport. */
export const METRES_WIDTH = 60.0;
export const PIXELS_WIDTH = 8.0;

/** The projections the probe can put the same measurement under. */
export const SCENE_MODES = Object.freeze(["3d", "2d", "cv-ortho"]);

/**
 * Gate bands. A metres stroke must halve across the octave; a pixel stroke must
 * not move. The pre-fix WebGPU metres ratio was ~1.0 and an inverted conversion
 * would read ~0.5, both far outside the band.
 */
export const DEFAULT_BANDS = Object.freeze({
  metresOctave: [1.6, 2.5],
  pixelsOctave: [0.8, 1.25],
  minimumRows: 40,
  minimumNearRun: 6,
});

/**
 * The probe's assertion, as a pure function so it has a node runner home and an
 * inertness leg. Every clause is a statement about the picture, never about
 * engine source text.
 *
 * @param {object} cell One (renderer, run) cell's measurements.
 * @param {object} bands Gate bands, shaped like {@link DEFAULT_BANDS}.
 * @returns {Array<object>} One verdict per acceptance clause.
 */
export function decideMetresWidthVerdicts(cell, bands) {
  const prefix = `${cell.renderer}/run${cell.run}`;
  const near = cell.near;
  const far = cell.far;
  const measurable =
    near.metres.rows >= bands.minimumRows &&
    far.metres.rows >= bands.minimumRows &&
    near.pixels.rows >= bands.minimumRows &&
    far.pixels.rows >= bands.minimumRows &&
    near.metres.median >= bands.minimumNearRun &&
    near.pixels.median >= 1 &&
    far.metres.median >= 1 &&
    far.pixels.median >= 1;

  if (!measurable) {
    // STRUCTURAL, never FAIL: an unmeasurable stroke files a phantom defect if
    // scored as a product failure and a false green if scored as a pass.
    return [
      {
        id: `${prefix}/clause0-subject-visible`,
        claim:
          "clause 0 — both collections drew a stroke thick enough and long enough to measure",
        near,
        far,
        bands,
        pass: null,
        why:
          `rows ${near.metres.rows}/${far.metres.rows} (metres) and ` +
          `${near.pixels.rows}/${far.pixels.rows} (pixels); medians ` +
          `${near.metres.median}/${far.metres.median} and ` +
          `${near.pixels.median}/${far.pixels.median}`,
      },
    ];
  }

  const metresRatio = near.metres.median / far.metres.median;
  const pixelsRatio = near.pixels.median / far.pixels.median;
  return [
    {
      id: `${prefix}/clause1-metres-halves`,
      claim:
        "clause 1 — a widthUnits:'meters' stroke halves when the eye height doubles",
      metresRatio,
      near: near.metres,
      far: far.metres,
      band: bands.metresOctave,
      preFixSymptom: 1.0,
      pass:
        metresRatio >= bands.metresOctave[0] &&
        metresRatio <= bands.metresOctave[1],
    },
    {
      id: `${prefix}/clause2-pixels-unmoved`,
      claim:
        "clause 2 — a default pixels stroke does NOT move across the same octave",
      pixelsRatio,
      near: near.pixels,
      far: far.pixels,
      band: bands.pixelsOctave,
      pass:
        pixelsRatio >= bands.pixelsOctave[0] &&
        pixelsRatio <= bands.pixelsOctave[1],
    },
    {
      id: `${prefix}/clause3-miter-not-inverted`,
      claim:
        "clause 3 — the metres ribbon still covers its whole segment, so the signed width did not invert the miter",
      metresRows: near.metres.rows,
      pixelsRows: near.pixels.rows,
      rowRatio: near.metres.rows / Math.max(near.pixels.rows, 1),
      // Both segments span the same latitudes, so their occupied row counts
      // must be within a few percent. A negative half-width folds the ribbon
      // and collapses the count.
      pass: near.metres.rows / Math.max(near.pixels.rows, 1) >= 0.8,
    },
    {
      id: `${prefix}/clause4-clean`,
      claim: "clause 4 — no console error and no page error in the whole run",
      consoleErrors: cell.consoleErrors,
      pageErrors: cell.pageErrors,
      pass: cell.consoleErrors.length === 0 && cell.pageErrors.length === 0,
    },
  ];
}

/**
 * Everything below runs INSIDE the page. `page.evaluate` serializes the
 * function source and drops the surrounding closure, so every helper is
 * defined here rather than imported.
 */
const RUN_LANE = async ({
  nearHeight,
  farHeight,
  metresWidth,
  pixelsWidth,
  sceneMode,
}) => {
  const C = (window.Cesium =
    window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
  const viewer = window.viewer;
  const scene = viewer.scene;
  const canvas = scene.canvas;
  const rendererType = String(scene.context?.rendererType ?? "").toLowerCase();

  // Deterministic, globe-free scene: the subject is a screen-space polyline and
  // terrain would only add LOD noise to the colour classification.
  viewer.useDefaultRenderLoop = false;
  scene.requestRenderMode = false;
  viewer.clock.shouldAnimate = false;
  scene.globe.show = false;
  scene.skyBox.show = false;
  scene.skyAtmosphere.show = false;
  scene.sun.show = false;
  scene.moon.show = false;
  scene.backgroundColor = C.Color.BLACK;
  scene.fog.enabled = false;

  // The projection under test. `scene.mode = …` is an instantaneous morph, so
  // the camera set below lands in the target mode rather than mid-morph.
  if (sceneMode === "2d") {
    scene.mode = C.SceneMode.SCENE2D;
  } else if (sceneMode === "cv-ortho") {
    scene.mode = C.SceneMode.COLUMBUS_VIEW;
    scene.camera.switchToOrthographicFrustum();
  }

  const scratch = document.createElement("canvas");
  const scratchContext = scratch.getContext("2d", {
    willReadFrequently: true,
  });
  const renderNow = () => {
    scene.initializeFrame();
    scene.render(viewer.clock.currentTime);
  };
  // NO live-canvas reader here. Copying `scene.canvas` into a scratch 2D
  // context can read an already-invalidated swap-chain texture, and
  // `probe-fleet-contract.spec.mjs` rejects the construct outright. The
  // sanctioned path is the runtime's element screenshot: Playwright captures a
  // PNG, hands its bytes back, and the decode below draws an `<img>` — never
  // the live canvas — into the scratch context.
  const decode = (base64) =>
    new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        scratch.width = image.naturalWidth;
        scratch.height = image.naturalHeight;
        scratchContext.drawImage(image, 0, 0);
        resolve(
          scratchContext.getImageData(0, 0, scratch.width, scratch.height),
        );
      };
      image.onerror = () => reject(new Error("capture did not decode"));
      image.src = `data:image/png;base64,${base64}`;
    });
  const settleMs = async (milliseconds) => {
    const deadline = performance.now() + milliseconds;
    let frames = 0;
    while (performance.now() < deadline) {
      renderNow();
      frames++;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return frames;
  };

  const meridian = (longitude) => {
    const positions = [];
    for (let lat = 38.2; lat <= 38.8 + 1e-9; lat += 0.01) {
      const p = C.Cartesian3.fromDegrees(longitude, lat, 0.0);
      positions.push(p.x, p.y, p.z);
    }
    return new Float64Array(positions);
  };

  const collectionFor = (options) => {
    const collection = new C.BufferPolylineCollection({
      primitiveCountMax: 4,
      vertexCountMax: 1024,
      ...(options.widthUnits ? { widthUnits: options.widthUnits } : {}),
    });
    collection.add({
      positions: meridian(options.longitude),
      material: new C.BufferPolylineMaterial({
        color: options.color,
        width: options.width,
      }),
    });
    return collection;
  };

  const metresCollection = collectionFor({
    longitude: -105.02,
    width: metresWidth,
    widthUnits: "meters",
    color: new C.Color(1.0, 0.0, 0.0, 1.0),
  });
  const pixelsCollection = collectionFor({
    longitude: -104.98,
    width: pixelsWidth,
    color: new C.Color(0.0, 0.0, 1.0, 1.0),
  });
  scene.primitives.add(metresCollection);
  scene.primitives.add(pixelsCollection);

  /**
   * Median and mean per-row contiguous run of one colour class, plus the number
   * of rows the class occupies. A pixel counts as the class when that channel
   * dominates the other two, so a colour swap moves pixels between classes
   * rather than merely dimming a mean.
   */
  const rowRuns = (image, wantRed) => {
    const { width, height, data } = image;
    const runs = [];
    let changed = 0;
    for (let y = 0; y < height; y++) {
      let run = 0;
      let best = 0;
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const isWanted = wantRed
          ? r > b + 30 && r > g + 30
          : b > r + 30 && b > g + 30;
        if (isWanted) {
          changed++;
          run++;
          if (run > best) best = run;
        } else {
          run = 0;
        }
      }
      if (best > 0) runs.push(best);
    }
    runs.sort((a, b) => a - b);
    const sum = runs.reduce((total, value) => total + value, 0);
    return {
      rows: runs.length,
      changed,
      median: runs.length === 0 ? 0 : runs[Math.floor(runs.length / 2)],
      mean: runs.length === 0 ? 0 : sum / runs.length,
    };
  };

  const lookAt = (height) =>
    scene.camera.setView({
      destination: C.Cartesian3.fromDegrees(-105.0, 38.5, height),
      orientation: { heading: 0, pitch: C.Math.toRadians(-90), roll: 0 },
    });

  // The page keeps the controls; the Node side drives the two altitudes so the
  // screenshot between them is the runtime's, not this function's.
  window.__metresWidthProbe = {
    lookAt,
    settle: settleMs,
    render: renderNow,
    measure: async (base64) => {
      const image = await decode(base64);
      return {
        size: { width: image.width, height: image.height },
        metres: rowRuns(image, true),
        pixels: rowRuns(image, false),
      };
    },
  };

  return {
    rendererType,
    canvasSize: { width: canvas.width, height: canvas.height },
    pixelRatio: viewer.resolutionScale ?? 1,
  };
};

/**
 * One backend's whole measurement, in its own page.
 *
 * @param {object} options Inputs.
 * @param {object} options.browser The Playwright browser.
 * @param {string} options.origin The served origin.
 * @param {string} options.renderer The backend.
 * @param {number} options.run The repeat index.
 * @param {string} options.sceneMode One of {@link SCENE_MODES}.
 * @param {string} options.outputDirectory Where captures are written.
 * @param {Array<object>} options.captures Runtime capture sink.
 * @returns {Promise<object>} The cell.
 */
async function runCell({
  browser,
  origin,
  renderer,
  run,
  sceneMode,
  outputDirectory,
  captures,
}) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => pageErrors.push(String(error.message)));

  try {
    await page.goto(
      `${origin}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
      { waitUntil: "networkidle", timeout: 90000 },
    );
    await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

    const measured = await page.evaluate(RUN_LANE, {
      metresWidth: METRES_WIDTH,
      pixelsWidth: PIXELS_WIDTH,
      sceneMode,
    });

    // A silent WebGL fallback must HARD-REFUSE: a probe that scores a WebGL
    // frame as a WebGPU pass is a false green, which is the exact failure this
    // whole instrument exists to prevent.
    if (measured.rendererType !== renderer) {
      throw new ProbeRefusal(
        "renderer-mismatch",
        `requested ${renderer} but scene.context.rendererType is "${measured.rendererType}"`,
        { renderer, measured: measured.rendererType },
      );
    }

    /**
     * One altitude: point the camera, settle, take the runtime's element
     * screenshot, and hand its bytes back to the page to classify. The capture
     * is banked beside the receipt either way, so a disputed ratio can be
     * re-measured from the PNG rather than re-run.
     */
    const atHeight = async (label, height) => {
      const frames = await page.evaluate(async (h) => {
        window.__metresWidthProbe.lookAt(h);
        return window.__metresWidthProbe.settle(2000);
      }, height);
      const capture = await captureElement({
        page,
        selector: "canvas",
        index: 0,
        name: `${renderer}-run${run}-${label}`,
        outputDirectory,
        captures,
      });
      const classified = await page.evaluate(
        (b) => window.__metresWidthProbe.measure(b),
        capture.buffer.toString("base64"),
      );
      return { label, height, frames, capture: capture.sha256, ...classified };
    };

    const near = await atHeight("near", NEAR_HEIGHT_METRES);
    const far = await atHeight("far", FAR_HEIGHT_METRES);

    return {
      renderer,
      run,
      sceneMode,
      ...measured,
      near,
      far,
      consoleErrors,
      pageErrors,
    };
  } finally {
    await page.close();
  }
}

/**
 * The console report.
 *
 * @param {object} receipt The probe receipt.
 * @returns {void}
 */
function printReport(receipt) {
  const mode = receipt.cells?.[0]?.sceneMode ?? "3d";
  console.log(
    `\n── BufferPolylineCollection widthUnits:'meters' (C-04) — scene mode ${mode} ──`,
  );
  for (const verdict of receipt.verdicts) {
    const state =
      verdict.pass === true
        ? "PASS"
        : verdict.pass === false
          ? "FAIL"
          : "STRUCTURAL";
    const detail =
      verdict.metresRatio !== undefined
        ? `metresRatio=${verdict.metresRatio.toFixed(3)} band=[${verdict.band}] (pre-fix ~${verdict.preFixSymptom})`
        : verdict.pixelsRatio !== undefined
          ? `pixelsRatio=${verdict.pixelsRatio.toFixed(3)} band=[${verdict.band}]`
          : verdict.rowRatio !== undefined
            ? `metres/pixels occupied rows=${verdict.rowRatio.toFixed(3)}`
            : (verdict.why ?? `errors=${(verdict.consoleErrors ?? []).length}`);
    console.log(`${state} ${verdict.id} ${detail}`);
  }
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "buffer-polyline-meters-width",
  title:
    "Non-draped BufferPolylineCollection widthUnits:'meters' — census C-04 (`-07` item 18)",
  outputSubdirectory: "buffer-polyline-meters-width",
  receiptEnvelope: "probe-owned",
  args: {
    extraOptions: [
      {
        flag: "--metres-ratio-floor",
        key: "metresRatioFloor",
        kind: "non-negative-number",
        default: DEFAULT_BANDS.metresOctave[0],
      },
      {
        flag: "--metres-ratio-ceiling",
        key: "metresRatioCeiling",
        kind: "non-negative-number",
        default: DEFAULT_BANDS.metresOctave[1],
      },
      {
        flag: "--scene-mode",
        key: "sceneMode",
        kind: "string",
        default: "3d",
      },
    ],
  },
  async cells({ browser, origin, run, options, outputDirectory, captures }) {
    const sceneMode = options.sceneMode ?? "3d";
    if (!SCENE_MODES.includes(sceneMode)) {
      throw new ProbeRefusal(
        `--scene-mode must be one of ${SCENE_MODES.join(", ")}, got ${sceneMode}`,
      );
    }
    const produced = [];
    for (const renderer of options.renderers) {
      produced.push(
        await runCell({
          browser,
          origin,
          renderer,
          run,
          sceneMode,
          outputDirectory,
          captures,
        }),
      );
    }
    return produced;
  },
  verdicts(cells, { options }) {
    const bands = {
      ...DEFAULT_BANDS,
      metresOctave: [
        options.metresRatioFloor ?? DEFAULT_BANDS.metresOctave[0],
        options.metresRatioCeiling ?? DEFAULT_BANDS.metresOctave[1],
      ],
    };
    return cells.flatMap((cell) => decideMetresWidthVerdicts(cell, bands));
  },
  receipt(cells, context) {
    const receipt = {
      generatedAt: context.generatedAt,
      origin: context.origin,
      runs: context.options?.runs ?? null,
      nearHeightMetres: NEAR_HEIGHT_METRES,
      farHeightMetres: FAR_HEIGHT_METRES,
      metresWidth: METRES_WIDTH,
      pixelsWidth: PIXELS_WIDTH,
      sceneMode: context.options?.sceneMode ?? "3d",
      cellOrder: cells.map((c) => `${c.renderer}/run${c.run}`),
      verdicts: context.verdicts,
      cells,
    };
    if (cells.length > 0) {
      printReport(receipt);
    }
    return receipt;
  },
  summary(receipt) {
    const passed = receipt.verdicts.filter((v) => v.pass === true).length;
    const structural = receipt.verdicts.filter((v) => v.pass === null).length;
    return [
      "# BufferPolylineCollection widthUnits:'meters' — census C-04",
      "",
      `Generated: ${receipt.generatedAt}`,
      "",
      `Eye heights: ${receipt.nearHeightMetres} m and ${receipt.farHeightMetres} m (one octave).`,
      `Authored widths: ${receipt.metresWidth} m (red) and ${receipt.pixelsWidth} px (blue).`,
      "",
      `Verdicts: ${passed}/${receipt.verdicts.length} passed` +
        (structural > 0 ? `, ${structural} STRUCTURAL` : "") +
        ".",
      "",
      "The pre-fix WebGPU symptom is a metres ratio of ~1.0 (the width took the",
      "pixel arm), not a missing measurement.",
      "",
    ].join("\n");
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
