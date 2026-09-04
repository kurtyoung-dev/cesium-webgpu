// probe-pnts-model-attenuation.mjs — the Edge leg for PNTS model-path point attenuation.
//
// @purpose Measures whether a PNTS tileset's rendered point footprint responds to pointCloudShading.maximumAttenuation on each backend, at three camera distances, and banks the disabled-shading capture hashes so a before/after pair can be compared byte-for-byte.
// @status ACTIVE
//
// ── WHAT IT ANSWERS ─────────────────────────────────────────────────────────
//
// Every `.pnts` tileset loads through the Model pipeline (`Model.js` builds a
// `PntsLoader`; `Model3DTileContent` hands the tileset's `PointCloudShading`
// instance to the content model). On WebGL that pipeline sizes each point in
// `ModelVS.glsl` from `getPointSizeFromAttenuation` — `min(geometricError /
// depth * depthMultiplier, maximumAttenuation)`. On WebGPU the same primitives
// are drawn with the `point-list` topology, which rasterizes one pixel per
// point and has no `gl_PointSize` analogue, so the attenuation settings reach
// no shader at all.
//
// The observable consequence, and the thing this probe measures, is that the
// LIT-PIXEL COUNT of the same tileset at the same camera is expected to grow
// when `maximumAttenuation` grows, and does not on WebGPU.
//
// ── THE POSITIVE CONTROL IS BUILT IN ────────────────────────────────────────
//
// The liveness verdict is evaluated on BOTH backends from the same captures.
// WebGL is the control: if its own footprint does not grow with
// `maximumAttenuation`, the scene, the camera or the asset is wrong and the
// WebGPU result says nothing. A run where the WebGL liveness verdict fails is
// a broken measurement, not a green backend — read that verdict first.
//
// ── METRICS, AND HOW EACH BEHAVES ───────────────────────────────────────────
//
//   litPixels      — the count of pixels above a luminance floor over the
//                    whole canvas, with the globe, sky and FXAA removed so the
//                    only lit pixels are points. Deterministic for a fixed
//                    camera and asset; it is the footprint statistic.
//   meanColor      — per-channel mean over the lit pixels. Reported, never
//                    gated here: the dedicated-path colour tint is a separate
//                    open row and gating on colour would mix the two.
//   sha256         — the capture hash from the shared runtime. Only the
//                    disabled-shading captures are used as a verdict, and only
//                    when a baseline receipt is supplied.
//   growthRatio    — litPixels(max16) / litPixels(max4) at one distance, per
//                    backend. The liveness statistic.
//   parityRatio    — litPixels(webgpu) / litPixels(webgl) per cell. PROVISIONAL:
//                    the bound below has never been confirmed by a paired green
//                    run, so its verdicts are flagged `provisional` and are a
//                    reading, not a promotion limit, until one exists.
//
// ── DISABLED-SHADING IDENTITY ───────────────────────────────────────────────
//
// "With point-cloud shading disabled the frame is byte-identical" cannot be
// decided inside one run: it is a claim about two builds. So the disabled leg
// publishes its capture sha256 per (backend, distance), and `--baseline-receipt`
// points at a receipt banked from the earlier build. With no baseline the
// verdict records `pending-baseline` and does not pass, which keeps a run that
// never made the comparison from reading as one that did.
//
// ── PRECONDITIONS ───────────────────────────────────────────────────────────
//
//   * `npx gulp build` has run, so `/Build/CesiumUnminified/` is current.
//   * `node server.js --port 8094 --serve-built` is running. Use `localhost`,
//     not `127.0.0.1` — the dev server binds IPv6. Port 8080 is refused by the
//     shared runtime.
//   * Edge, not Firefox: Playwright's bundled Firefox has no WebGPU.
//   * No ion token is needed. The globe is hidden and the asset is local.
//
// Run:
//   node Tools/visual-regression/probe-pnts-model-attenuation.mjs
//   node Tools/visual-regression/probe-pnts-model-attenuation.mjs --renderer webgpu
//   node Tools/visual-regression/probe-pnts-model-attenuation.mjs --baseline-receipt Tools/visual-regression/output/pnts-model-attenuation/pnts-model-attenuation.json

import { readFileSync } from "node:fs";

import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";
import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";

const VIEWER_PATH = "/Apps/CesiumViewer/index.html";
const TILESET_URL =
  "/Apps/SampleData/Cesium3DTiles/PointCloud/PointCloudRGB/tileset.json";
const VIEWPORT = Object.freeze({ width: 800, height: 600 });

// A pixel counts as lit when its channels sum past this. The scene is cleared
// to black with the globe and sky removed, so the floor only has to clear PNG
// quantisation, not a background.
const LUMINANCE_FLOOR = 24;

/**
 * The three shading configurations. `off` is the identity leg; the two
 * attenuated legs differ ONLY in `maximumAttenuation`, so the growth between
 * them isolates the clamp WebGL applies in `getPointSizeFromAttenuation`.
 *
 * `baseResolution` is set explicitly because this tileset's root declares
 * `geometricError: 0`, which sends `PointCloudStylingPipelineStage`'s
 * `getGeometricError` down its estimate-from-bounds branch — a value that
 * depends on the point count and the node transform and is therefore not a
 * stable thing to write an expectation against.
 */
const SETTINGS = Object.freeze([
  {
    id: "shading-off",
    label: "pointCloudShading.attenuation = false — the identity leg",
    identityLeg: true,
    shading: { attenuation: false },
  },
  {
    id: "atten-max4",
    label: "attenuation on, maximumAttenuation 4",
    identityLeg: false,
    shading: {
      attenuation: true,
      maximumAttenuation: 4,
      geometricErrorScale: 1,
      baseResolution: 0.25,
      eyeDomeLighting: false,
    },
  },
  {
    id: "atten-max16",
    label: "attenuation on, maximumAttenuation 16",
    identityLeg: false,
    shading: {
      attenuation: true,
      maximumAttenuation: 16,
      geometricErrorScale: 1,
      baseResolution: 0.25,
      eyeDomeLighting: false,
    },
  },
]);

/**
 * Three camera distances from the tileset's bounding-sphere centre, looking
 * straight down. The asset's sphere radius is 5 m, so `near` frames it, `mid`
 * halves its angular size and `far` is where the geometric term, not the
 * clamp, decides the size on WebGL.
 */
const DISTANCES = Object.freeze([
  { id: "near", metres: 10 },
  { id: "mid", metres: 25 },
  { id: "far", metres: 60 },
]);

/** The distance the liveness verdict is evaluated at — the clamp binds here. */
const LIVENESS_DISTANCE_ID = "near";

/**
 * Decide the attenuation-liveness verdict for one backend.
 *
 * The claim is behavioural: raising `maximumAttenuation` from 4 to 16 must
 * enlarge the rendered footprint. It is stated as a ratio rather than an
 * absolute count so it survives a change of asset, viewport or camera.
 *
 * @param {object} options Inputs.
 * @param {number} options.smallLitPixels Lit pixels with maximumAttenuation 4.
 * @param {number} options.largeLitPixels Lit pixels with maximumAttenuation 16.
 * @param {number} options.ratioGate Minimum growth ratio.
 * @returns {object} The verdict body.
 */
export function decideLivenessVerdict({
  smallLitPixels,
  largeLitPixels,
  ratioGate,
}) {
  const growthRatio =
    smallLitPixels > 0 ? largeLitPixels / smallLitPixels : Number.NaN;
  return {
    smallLitPixels,
    largeLitPixels,
    growthRatio,
    ratioGate,
    pass: Number.isFinite(growthRatio) && growthRatio >= ratioGate,
  };
}

/**
 * Decide the cross-backend footprint verdict for one (setting, distance).
 *
 * @param {object} options Inputs.
 * @param {number} options.webglLitPixels WebGL lit pixels.
 * @param {number} options.webgpuLitPixels WebGPU lit pixels.
 * @param {number} options.gate Allowed ratio, in either direction.
 * @returns {object} The verdict body.
 */
export function decideParityVerdict({ webglLitPixels, webgpuLitPixels, gate }) {
  const parityRatio =
    webglLitPixels > 0 ? webgpuLitPixels / webglLitPixels : Number.NaN;
  return {
    webglLitPixels,
    webgpuLitPixels,
    parityRatio,
    gate,
    // PROVISIONAL until a paired green run calibrates the bound; see the header.
    provisional: true,
    pass:
      Number.isFinite(parityRatio) &&
      parityRatio <= gate &&
      parityRatio >= 1 / gate,
  };
}

/**
 * Decide the disabled-shading identity verdict for one capture.
 *
 * @param {object} options Inputs.
 * @param {string} options.sha256 This run's capture hash.
 * @param {string|null} options.baselineSha256 The banked hash, when supplied.
 * @returns {object} The verdict body.
 */
export function decideIdentityVerdict({ sha256, baselineSha256 }) {
  if (baselineSha256 === null || baselineSha256 === undefined) {
    return {
      sha256,
      baselineSha256: null,
      status: "pending-baseline",
      pass: false,
    };
  }
  return {
    sha256,
    baselineSha256,
    status: sha256 === baselineSha256 ? "identical" : "changed",
    pass: sha256 === baselineSha256,
  };
}

/**
 * Read the disabled-leg hashes out of a receipt banked by an earlier run.
 *
 * @param {object|null} receipt A parsed receipt, or null.
 * @returns {Map<string, string>} Cell id to capture sha256.
 */
export function identityHashesFromReceipt(receipt) {
  const hashes = new Map();
  for (const cell of receipt?.cells ?? []) {
    if (cell.identityLeg !== true) {
      continue;
    }
    for (const sample of cell.samples ?? []) {
      hashes.set(
        `${cell.renderer}/${cell.setting}/${sample.distance}`,
        sample.sha256,
      );
    }
  }
  return hashes;
}

/**
 * The page-side setup. Strips everything that is not a point from the frame,
 * loads the tileset with this cell's shading, and installs the two helpers the
 * Node side calls per distance.
 *
 * Written as a string-free function so the bundler and the linter both see it;
 * `page.evaluate` serialises it.
 *
 * @param {object} argument Serialised inputs.
 * @returns {Promise<object>} Setup facts.
 */
async function pageSetup({ tilesetUrl, shading, luminanceFloor }) {
  const cesium = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  const scene = viewer.scene;
  const nextFrame = () =>
    new Promise((resolve) => requestAnimationFrame(resolve));

  scene.globe.show = false;
  if (scene.skyBox) {
    scene.skyBox.show = false;
  }
  if (scene.skyAtmosphere) {
    scene.skyAtmosphere.show = false;
  }
  if (scene.sun) {
    scene.sun.show = false;
  }
  if (scene.moon) {
    scene.moon.show = false;
  }
  scene.backgroundColor = cesium.Color.BLACK;
  scene.fog.enabled = false;
  // FXAA smears a one-pixel point differently on each backend, which would
  // land in the footprint count as a cross-backend difference that is not one.
  if (scene.postProcessStages && scene.postProcessStages.fxaa) {
    scene.postProcessStages.fxaa.enabled = false;
  }
  viewer.clock.shouldAnimate = false;

  let tileset;
  try {
    tileset = await cesium.Cesium3DTileset.fromUrl(tilesetUrl, {
      pointCloudShading: shading,
    });
  } catch (error) {
    return { ok: false, error: `tileset load failed: ${error}` };
  }
  scene.primitives.add(tileset);

  for (let frame = 0; frame < 600 && !tileset.tilesLoaded; frame++) {
    scene.render();
    await nextFrame();
  }
  if (!tileset.tilesLoaded) {
    return { ok: false, error: "tileset never reported tilesLoaded" };
  }

  window.__leofaView = async (metres) => {
    const sphere = tileset.boundingSphere;
    const carto = cesium.Cartographic.fromCartesian(sphere.center);
    viewer.camera.setView({
      destination: cesium.Cartesian3.fromRadians(
        carto.longitude,
        carto.latitude,
        carto.height + metres,
      ),
      orientation: {
        heading: 0,
        pitch: -cesium.Math.PI_OVER_TWO,
        roll: 0,
      },
    });
    for (let frame = 0; frame < 16; frame++) {
      scene.render();
      await nextFrame();
    }
    return {
      metres,
      // The three inputs WebGL's depthMultiplier is built from, recorded so a
      // cross-backend comparison can be checked against the formula rather
      // than assumed to share it.
      drawingBufferHeight: scene.context.drawingBufferHeight,
      sseDenominator: viewer.camera.frustum.sseDenominator,
      pixelRatio: scene.pixelRatio,
      rendererType: scene.context.rendererType ?? "webgl",
    };
  };

  window.__leofaLitPixels = async (base64) => {
    const response = await fetch(`data:image/png;base64,${base64}`);
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context2d = canvas.getContext("2d", { willReadFrequently: true });
    context2d.drawImage(bitmap, 0, 0);
    const data = context2d.getImageData(0, 0, canvas.width, canvas.height).data;
    let litPixels = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    for (let index = 0; index < data.length; index += 4) {
      const luminance = data[index] + data[index + 1] + data[index + 2];
      if (luminance > luminanceFloor) {
        litPixels++;
        sumR += data[index];
        sumG += data[index + 1];
        sumB += data[index + 2];
      }
    }
    return {
      width: canvas.width,
      height: canvas.height,
      litPixels,
      meanColor:
        litPixels > 0
          ? [sumR / litPixels, sumG / litPixels, sumB / litPixels]
          : [0, 0, 0],
    };
  };

  return {
    ok: true,
    attenuation: tileset.pointCloudShading.attenuation === true,
    maximumAttenuation: tileset.pointCloudShading.maximumAttenuation ?? null,
    geometricErrorScale: tileset.pointCloudShading.geometricErrorScale,
    baseResolution: tileset.pointCloudShading.baseResolution ?? null,
  };
}

/**
 * Run one (renderer, setting) cell: its own browser context, its own page, and
 * one capture per distance.
 *
 * @param {object} options Cell inputs.
 * @param {object} options.browser The Playwright browser.
 * @param {string} options.origin The governed origin.
 * @param {string} options.renderer The backend.
 * @param {object} options.setting One entry of SETTINGS.
 * @param {number} options.run The repeat index.
 * @param {number} options.timeoutMs Navigation and predicate timeout.
 * @param {string} options.outputDirectory Where captures are written.
 * @param {Array<object>} options.captures Runtime capture sink.
 * @returns {Promise<object>} The cell result.
 */
async function runCell({
  browser,
  origin,
  renderer,
  setting,
  run,
  timeoutMs,
  outputDirectory,
  captures,
}) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);

  try {
    await page.goto(`${origin}${VIEWER_PATH}?renderer=${renderer}`, {
      waitUntil: "load",
      timeout: timeoutMs,
    });
    await page.waitForFunction(() => window.viewer !== undefined, null, {
      timeout: timeoutMs,
    });
    await armWebGPUDevices(page);

    const setup = await page.evaluate(pageSetup, {
      tilesetUrl: TILESET_URL,
      shading: setting.shading,
      luminanceFloor: LUMINANCE_FLOOR,
    });
    if (setup.ok !== true) {
      throw new ProbeRefusal(
        "scene-setup-failed",
        `${renderer}/${setting.id}: ${setup.error}`,
        { renderer, setting: setting.id, error: setup.error },
      );
    }

    const samples = [];
    for (const distance of DISTANCES) {
      const view = await page.evaluate(
        (metres) => window.__leofaView(metres),
        distance.metres,
      );
      if (view.rendererType !== renderer) {
        throw new ProbeRefusal(
          "renderer-mismatch",
          `asked for ${renderer} and the page reported ${view.rendererType}; a silent fallback makes every number in this cell incomparable`,
          { renderer, reported: view.rendererType },
        );
      }
      const capture = await captureElement({
        page,
        selector: "canvas",
        index: 0,
        name: `${renderer}-${setting.id}-${distance.id}-run${run}`,
        outputDirectory,
        captures,
      });
      const pixels = await page.evaluate(
        (base64) => window.__leofaLitPixels(base64),
        capture.buffer.toString("base64"),
      );
      samples.push({
        distance: distance.id,
        metres: distance.metres,
        sha256: capture.sha256,
        capture: capture.path,
        view,
        ...pixels,
      });
      process.stdout.write(
        `${renderer}/${setting.id}/${distance.id}: litPixels=${pixels.litPixels} ` +
          `mean=[${pixels.meanColor.map((v) => v.toFixed(1)).join(", ")}]\n`,
      );
    }

    const gate = await collectGateErrors(page);
    return {
      renderer,
      setting: setting.id,
      label: setting.label,
      identityLeg: setting.identityLeg,
      run,
      shading: setting.shading,
      setup,
      samples,
      gateErrors: gate.errors,
      deviceLost: gate.deviceLost,
      armedDevices: gate.armedDevices,
      consoleErrors: [...consoleErrors],
    };
  } finally {
    await context.close();
  }
}

/**
 * Index a run's cells by `renderer/setting` for the verdict builders.
 *
 * @param {Array<object>} cells Every cell of the run.
 * @returns {Map<string, object>} The index.
 */
function indexCells(cells) {
  return new Map(
    cells.map((cell) => [`${cell.renderer}/${cell.setting}`, cell]),
  );
}

/**
 * @param {object|undefined} cell A cell.
 * @param {string} distanceId Which distance.
 * @returns {object|undefined} The sample.
 */
function sampleAt(cell, distanceId) {
  return cell?.samples?.find((sample) => sample.distance === distanceId);
}

/**
 * Build every verdict the run supports. Cells the run did not produce — a
 * single-backend run, say — contribute no verdict rather than a failing one.
 *
 * @param {Array<object>} cells Every cell of the run.
 * @param {object} options Gate inputs.
 * @param {number} options.livenessRatio Minimum growth ratio.
 * @param {number} options.parityGate Allowed cross-backend ratio.
 * @param {Map<string, string>} options.baselineHashes Banked identity hashes.
 * @returns {Array<object>} The verdicts.
 */
export function buildAttenuationVerdicts(
  cells,
  { livenessRatio, parityGate, baselineHashes },
) {
  const byCell = indexCells(cells);
  const renderers = [...new Set(cells.map((cell) => cell.renderer))];
  const verdicts = [];

  for (const renderer of renderers) {
    const small = sampleAt(
      byCell.get(`${renderer}/atten-max4`),
      LIVENESS_DISTANCE_ID,
    );
    const large = sampleAt(
      byCell.get(`${renderer}/atten-max16`),
      LIVENESS_DISTANCE_ID,
    );
    if (!small || !large) {
      continue;
    }
    verdicts.push({
      id: `liveness/${renderer}`,
      claim:
        "raising pointCloudShading.maximumAttenuation from 4 to 16 enlarges the rendered footprint",
      // WebGL is the control: its failure invalidates the WebGPU reading.
      control: renderer === "webgl",
      ...decideLivenessVerdict({
        smallLitPixels: small.litPixels,
        largeLitPixels: large.litPixels,
        ratioGate: livenessRatio,
      }),
    });
  }

  for (const setting of SETTINGS) {
    const webgl = byCell.get(`webgl/${setting.id}`);
    const webgpu = byCell.get(`webgpu/${setting.id}`);
    if (!webgl || !webgpu) {
      continue;
    }
    for (const distance of DISTANCES) {
      const webglSample = sampleAt(webgl, distance.id);
      const webgpuSample = sampleAt(webgpu, distance.id);
      if (!webglSample || !webgpuSample) {
        continue;
      }
      verdicts.push({
        id: `parity/${setting.id}/${distance.id}`,
        claim: "the WebGPU footprint matches WebGL at this camera distance",
        ...decideParityVerdict({
          webglLitPixels: webglSample.litPixels,
          webgpuLitPixels: webgpuSample.litPixels,
          gate: parityGate,
        }),
      });
    }
  }

  for (const cell of cells) {
    if (cell.identityLeg !== true) {
      continue;
    }
    for (const sample of cell.samples) {
      const id = `${cell.renderer}/${cell.setting}/${sample.distance}`;
      verdicts.push({
        id: `identity/${id}`,
        claim:
          "with point-cloud shading disabled the capture is unchanged from the banked baseline",
        ...decideIdentityVerdict({
          sha256: sample.sha256,
          baselineSha256: baselineHashes.get(id) ?? null,
        }),
      });
    }
  }

  for (const cell of cells) {
    const faults = [
      ...cell.gateErrors,
      ...cell.consoleErrors,
      ...(cell.deviceLost ? [`device lost: ${cell.deviceLost}`] : []),
    ];
    verdicts.push({
      id: `errors/${cell.renderer}/${cell.setting}`,
      claim:
        "the cell produced no GPU validation fault, console fault or page error",
      faults,
      pass: faults.length === 0,
    });
  }

  return verdicts;
}

/**
 * @param {object} receipt The receipt.
 * @returns {void}
 */
function printReport(receipt) {
  console.log("\n── footprint (lit pixels) ──");
  for (const cell of receipt.cells) {
    const row = cell.samples
      .map((sample) => `${sample.distance}=${sample.litPixels}`)
      .join(" ");
    console.log(`${cell.renderer}/${cell.setting}: ${row}`);
  }
  console.log("\n── verdicts ──");
  for (const verdict of receipt.verdicts) {
    const flags = [
      verdict.control === true ? "CONTROL" : null,
      verdict.provisional === true ? "PROVISIONAL" : null,
      verdict.status ?? null,
    ]
      .filter(Boolean)
      .join(" ");
    console.log(
      `${verdict.pass ? "PASS" : "FAIL"} ${verdict.id}${flags ? ` [${flags}]` : ""}`,
    );
  }
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "pnts-model-attenuation",
  title:
    "PNTS model path — pointCloudShading attenuation footprint, three distances",
  outputSubdirectory: "pnts-model-attenuation",
  receiptEnvelope: "runtime",
  args: {
    extraOptions: [
      {
        flag: "--liveness-ratio",
        key: "livenessRatio",
        kind: "non-negative-number",
        default: 1.5,
      },
      {
        flag: "--parity-gate",
        key: "parityGate",
        kind: "non-negative-number",
        default: 1.35,
      },
      {
        flag: "--baseline-receipt",
        key: "baselineReceipt",
        kind: "string",
        default: null,
      },
    ],
  },
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    const produced = [];
    for (const renderer of options.renderers) {
      for (const setting of SETTINGS) {
        produced.push(
          await runCell({
            browser,
            origin,
            renderer,
            setting,
            run,
            timeoutMs: options.timeoutMs,
            outputDirectory,
            captures,
          }),
        );
      }
    }
    return produced;
  },
  verdicts(cells, { options }) {
    let baseline = null;
    if (options.baselineReceipt !== null) {
      baseline = readBaselineReceipt(options.baselineReceipt);
    }
    return buildAttenuationVerdicts(cells, {
      livenessRatio: options.livenessRatio,
      parityGate: options.parityGate,
      baselineHashes: identityHashesFromReceipt(baseline),
    });
  },
  receipt(cells, context) {
    const receipt = {
      generatedAt: context.generatedAt,
      tileset: TILESET_URL,
      viewport: VIEWPORT,
      luminanceFloor: LUMINANCE_FLOOR,
      livenessDistance: LIVENESS_DISTANCE_ID,
      settings: SETTINGS,
      distances: DISTANCES,
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
    return [
      "# PNTS model-path attenuation",
      "",
      `Generated: ${receipt.generatedAt}`,
      "",
      `Tileset: \`${receipt.tileset}\``,
      "",
      `Verdicts: ${passed}/${receipt.verdicts.length} passed.`,
      "",
    ].join("\n");
  },
};

/**
 * Read a receipt banked by an earlier run of this probe.
 *
 * A supplied path that cannot be read is a refusal, not an empty baseline: a
 * typo would otherwise turn every identity verdict into `pending-baseline` and
 * read as "the comparison has not been set up yet".
 *
 * @param {string} file Path to the receipt.
 * @returns {object} The parsed receipt.
 */
function readBaselineReceipt(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new ProbeRefusal(
      "baseline-receipt-unreadable",
      `--baseline-receipt ${file} could not be read: ${error}`,
      { file },
    );
  }
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
