// DP-H7 (Batch 328) — geodesic-arcType polyline subdivision probe.
// @purpose Premise-refutation record: proved DP-H7's geodesic-subdivision root cause FALSE — PolylineCollection curves correctly on WebGPU (CPU-side)
// @status INVESTIGATION
// @runtime lib/probe-runtime.mjs
//
// CLAIM under test (DP-H7): a Polyline / PolylineCollection with
// arcType GEODESIC straight-lines a chord through the Earth on WebGPU because
// "the CPU-side geodesic subdivision (PolylinePipeline.generateArc) is not
// routed into the WebGPU polyline vertex build."
//
// FINDING (this probe): that root cause is FALSE. The geodesic/rhumb
// subdivision is CPU-side and backend-neutral (PolylineGeometry.createGeometry
// + PolylineGeometryUpdater both call PolylinePipeline.generateCartesianArc
// BEFORE any renderer sees the positions). The WebGPU PolylineCollection
// renderer (WebGPUPolylineRenderer) renders whatever positions it is given, so
// when fed the subdivided positions it draws the geodesic CURVE — matching
// WebGL. This probe proves the PolylineCollection path CURVES on WebGPU.
//
// (Separately, this probe records that the appearance-based polyline PRIMITIVE
// path — PolylineColorAppearance / PolylineMaterialAppearance over a
// PolylineGeometry Primitive — renders NOTHING on WebGPU regardless of arcType,
// because there is no WGSL port of PolylineCommon + PolylineColorAppearanceVS.
// That is a distinct missing-feature gap, NOT a geodesic-subdivision bug; it is
// surfaced as a newly-scoped tracked item, not "fixed" here.)
//
// Scene: a great-circle geodesic between two 60N points 180 deg apart in
// longitude (lon -90 / lon +90). The geodesic arcs UP over the north pole; a
// red straight-chord reference (same endpoints, no subdivision) cuts across
// below it. Viewed from high above the equator looking down with the globe
// hidden, the cyan geodesic visibly bows away from the red chord. The probe
// asserts the WebGPU geodesic bows (curve, not chord) AND matches WebGL.
//
// WHY IT IS STILL LIVE, AND WHY ITS STATUS IS UNCHANGED. Its conclusion is
// banked (`DEFERRED_WORK.md` DP-H7, Batch 328), and `DX-03`
// (`QUEUE_2026-08-29_RESEARCH_DISPATCH.md`) names it as the single remaining
// HIGH-set move — HELD behind `DX-14` and an explicit maintainer release, a
// disposition that row does not choose in advance and this harvest does not
// choose for it. Meanwhile the G7 cluster of `CAMPAIGN11_EXECUTION_GUIDE`
// names it in C11-73's verification recipe and in the entity-scale traps (the
// 2D wrap paths duplicate segment logic). So it stays where it is, keeps
// `@status INVESTIGATION`, and runs on the kit.
//
// ON THE SHARED RUNTIME (probe-kit harvest, polyline family, DX-108). The
// browser, the origin (`--port`, a governed Edge port, never 8080), the
// served-build preflight, the Edge slot, the lifecycle deadline and the
// receipt belong to `lib/probe-runtime.mjs`. The scene is the rig
// `polyline-geodesic`, built in the page from its data, still one page per
// backend in one browser, WebGPU first. Each frame is an element capture of
// the scene canvas through `captureElement`, taken after
// `lib/strip-viewer-widgets.mjs` has removed the viewer chrome that otherwise
// sits inside the canvas's rectangle (a run with chrome left over the canvas
// refuses), where the original read `toDataURL` of the canvas and decoded it
// in a third page. The arc is `curveBowAgainstChord`
// (`lib/metrics/curve-bow.mjs`, the original `measureArc`), the coverage is
// `maskCount` (`lib/metrics/colour-mask.mjs`) and the cross-backend mismatch
// is `diffImages` (`lib/image-diff.mjs`, per-channel tolerance 24). A frame
// pair of different sizes is not compared: the diff clause then FAILS, where
// the original's private diff compared the overlapping bytes and could pass.
//
// Usage: node server.js --port 8094 --serve-built   (separate terminal, once)
//        node Tools/visual-regression/probe-polyline-geodesic.mjs
// Out:   Tools/visual-regression/output/polyline-geodesic/
import { attachPageDiagnostics } from "../lib/attach-page-diagnostics.mjs";
import { decodePng } from "../lib/png-decode.mjs";
import { diffImages } from "./lib/image-diff.mjs";
import { channelThresholds, maskCount } from "./lib/metrics/colour-mask.mjs";
import { curveBowAgainstChord } from "./lib/metrics/curve-bow.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";
import { STRIP_WIDGETS_SOURCE } from "./lib/strip-viewer-widgets.mjs";
import rig from "./rigs/polyline-geodesic.mjs";

/** The scene this probe builds. */
export const RIG = rig;

/** The geodesic's colour class: `r < 80 && g > 140 && b > 140`. */
export const CYAN = channelThresholds({ rBelow: 80, gAbove: 140, bAbove: 140 });

/** The straight chord's colour class: `r > 150 && g < 90 && b < 90`. */
export const RED = channelThresholds({ rAbove: 150, gBelow: 90, bBelow: 90 });

/** Coverage: a channel sum above 40. */
export const COVERED = (r, g, b) => r + g + b > 40;

/** The per-channel tolerance of the cross-backend mismatch. */
export const DIFF_TOLERANCE = 24;

/** The canvas the scene draws into; the CesiumViewer page has exactly one. */
const SCENE_CANVAS = ".cesium-widget canvas";

/**
 * A bound on one backend's work, from the probe's own step timeouts: page load
 * (90 s), the wait for `window.viewer` (90 s), the settle loop (at most half a
 * second per settle frame) and the capture (30 s). Not a measurement — a
 * ceiling past which the lifecycle stops the run (the original had no watchdog
 * at all).
 */
const BACKEND_BUDGET_MS = 90_000 + 90_000 + rig.readiness.frames * 500 + 30_000;

/**
 * Builds the rig's scene in the page and renders its settle frames.
 * `page.evaluate` ships this function's SOURCE, so everything it reads arrives
 * in `input`; the pixels are read in Node from the capture.
 *
 * @param {object} page Playwright page.
 * @returns {Promise<{subdividedCount: number}>} Page-side facts.
 */
async function buildScene(page) {
  return page.evaluate(
    async (input) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;

      scene.requestRenderMode = input.dials.requestRenderMode;
      v.clock.shouldAnimate = input.dials.shouldAnimate;

      // Hide globe/sky so ONLY the polyline shows against black.
      for (const name of input.dials.hide) {
        if (name === "fog") {
          scene.fog.enabled = false;
        } else if (scene[name]) {
          scene[name].show = false;
        }
      }
      scene.backgroundColor = C.Color.BLACK;

      const ellipsoid = scene.ellipsoid;

      // Two points at 60N, 180 deg apart in longitude: the great-circle
      // geodesic arcs up OVER the north pole, while the straight chord cuts
      // straight across the top of the globe. Viewed from a point above the
      // equator looking north, the geodesic bows up toward the pole and clearly
      // separates from the (lower, flatter) straight chord — a large,
      // view-stable screen bow.
      const [lon0, lat0, lon1, lat1] = input.dials.endpointsDegrees;
      const p0 = C.Cartesian3.fromDegrees(lon0, lat0, 0.0, ellipsoid);
      const p1 = C.Cartesian3.fromDegrees(lon1, lat1, 0.0, ellipsoid);

      // CPU-side geodesic subdivision — the SAME generateCartesianArc call
      // PolylineGeometry.createGeometry / PolylineGeometryUpdater make. This is
      // backend-neutral; both WebGL and WebGPU receive these subdivided points.
      const subdivided = C.PolylinePipeline.generateCartesianArc({
        positions: [p0, p1],
        ellipsoid: ellipsoid,
      });
      const subdividedCount = subdivided.length / 3;

      // Render the subdivided geodesic (CYAN) through the PolylineCollection
      // path — the path DP-H7 names. On WebGPU this routes through
      // WebGPUPolylineRenderer.
      const pc = new C.PolylineCollection();
      pc.add({
        positions: subdivided,
        width: input.dials.geodesicWidth,
        material: C.Material.fromType("Color", { color: C.Color.CYAN }),
      });
      // Add the straight-chord REFERENCE (RED, 2 points, no subdivision) so the
      // geodesic's bow is measured against the true chord (not just the
      // rendered endpoints). The geodesic must separate from this by many px.
      pc.add({
        positions: [p0, p1],
        width: input.dials.chordWidth,
        material: C.Material.fromType("Color", { color: C.Color.RED }),
      });
      scene.primitives.add(pc);

      // Camera high above the equator at lon 0, looking NORTH and slightly
      // down, so the great-circle arc bows UP toward the pole (top of frame)
      // while the straight chord sits lower/flatter.
      const cam = input.camera;
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(cam.lon, cam.lat, cam.height),
        orientation: {
          heading: cam.heading,
          pitch: cam.pitch,
          roll: cam.roll,
        },
      });

      for (let i = 0; i < input.frames; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      return { subdividedCount };
    },
    { dials: rig.dials, camera: rig.camera, frames: rig.readiness.frames },
  );
}

/**
 * One backend: a page in the run's one browser, the scene built and settled,
 * the viewer chrome removed, one element capture decoded in Node.
 *
 * @param {object} options Inputs.
 * @returns {Promise<{image: object, subdividedCount: number, png: string}>} The capture.
 */
async function runBackend({
  browser,
  origin,
  renderer,
  run,
  outputDirectory,
  captures,
}) {
  const context = await browser.newContext({ viewport: { ...rig.viewport } });
  try {
    const page = await context.newPage();
    const diagnostics = attachPageDiagnostics(page, {
      filter: (record) => record.text.startsWith("PROBE:"),
    });
    await page.goto(
      `${origin}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
      { waitUntil: "networkidle", timeout: 90000 },
    );
    await page.waitForFunction(() => !!window.viewer, null, {
      timeout: 90000,
    });
    const strip = await page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`);
    if (strip.leftovers.length > 0) {
      throw new ProbeRefusal(
        "viewer-chrome-over-canvas",
        `${rig.id}/${renderer}: elements still overlap the scene canvas after the widget strip (${strip.leftovers.join(", ")}), so an element capture would score them`,
        { rig: rig.id, renderer, ...strip },
      );
    }
    const { subdividedCount } = await buildScene(page);
    const shot = await captureElement({
      page,
      selector: SCENE_CANVAS,
      name: `probe-polyline-geodesic-${renderer}-run${run}`,
      outputDirectory,
      captures,
    });
    for (const record of diagnostics.console) {
      console.log(`[${renderer}] ${record.text}`);
    }
    return {
      image: decodePng(shot.buffer),
      subdividedCount,
      png: shot.path,
    };
  } finally {
    await context.close();
  }
}

/**
 * The original report, from two decoded frames. The arc renders
 * near-horizontal (bows vertically), so it is read per COLUMN by
 * `curveBowAgainstChord`:
 *   - maxBow: max perpendicular distance of the cyan path from the straight
 *     line between its own rendered endpoints (curve vs straight, no reference
 *     needed). A chord bug → ~0.
 *   - maxSeparation: max vertical separation between the cyan geodesic and the
 *     red straight chord. The geodesic bows above the chord → large; a
 *     straight-line bug would overlay the chord → ~0.
 * The mismatch is `null` when the frames differ in size — never a number taken
 * over part of a frame.
 *
 * Pure and exported so `polyline-probe-verdicts.spec.mjs` can drive it.
 *
 * @param {{image: object, subdividedCount: number}} gpu WebGPU capture.
 * @param {{image: object}} gl WebGL capture.
 * @returns {object} The report.
 */
export function measureGeodesic(gpu, gl) {
  const gpuArc = curveBowAgainstChord(gpu.image, CYAN, RED);
  const wglArc = curveBowAgainstChord(gl.image, CYAN, RED);
  const sameSize =
    gpu.image.width === gl.image.width && gpu.image.height === gl.image.height;
  // The percentage is formed as the original formed it, (changed / total) x
  // 100, from the kit's changed-pixel count: `diffImages`' own `mismatchPct`
  // multiplies first and can differ from it in the last binary digit.
  const diffPct = sameSize
    ? (diffImages(gpu.image, gl.image, { tolerance: DIFF_TOLERANCE })
        .changedPx /
        (gpu.image.width * gpu.image.height)) *
      100
    : null;
  return {
    endpoints: "60N lon-90 -> 60N lon+90 (great-circle over the pole)",
    canvas: { w: gpu.image.width, h: gpu.image.height },
    webglCanvas: { w: gl.image.width, h: gl.image.height },
    subdividedPositions: gpu.subdividedCount,
    webgpuNonBlackPixels: maskCount(gpu.image, COVERED),
    webglNonBlackPixels: maskCount(gl.image, COVERED),
    webgpuArcOk: gpuArc.ok,
    webglArcOk: wglArc.ok,
    webgpuArcBowDeviationPx: Number(gpuArc.maxBow.toFixed(2)),
    webglArcBowDeviationPx: Number(wglArc.maxBow.toFixed(2)),
    webgpuGeodesicVsChordSepPx: Number(gpuArc.maxSeparation.toFixed(2)),
    webglGeodesicVsChordSepPx: Number(wglArc.maxSeparation.toFixed(2)),
    webgpuVsWebglDiffPct: diffPct === null ? null : Number(diffPct.toFixed(4)),
    pngs: [gpu.png ?? null, gl.png ?? null],
    // The unrounded numbers the clauses read, as the original's `ok` did.
    raw: { webgpuArc: gpuArc, webglArc: wglArc, diffPct },
  };
}

/**
 * The original pass criteria, one clause per verdict, over a report:
 *   - both backends render the geodesic (coverage present) and the arc is
 *     measurable on both;
 *   - WebGPU CURVES: the cyan geodesic bows more than 8 px from a straight
 *     line between its own endpoints AND sits more than 8 px from the red
 *     straight chord (a straight-line geodesic bug would give ~0 for both);
 *   - WebGPU matches WebGL: bow and separation within 6 px, and a low overall
 *     mismatch — which a size mismatch (no comparison) FAILS.
 * Every clause reads the report's unrounded `raw` numbers, as the original's
 * single `ok` did; the rounded fields are for the printed report.
 *
 * @param {object} report From {@link measureGeodesic}.
 * @returns {Array<{id: string, claim: string, pass: boolean, detail: object}>} Verdicts.
 */
export function evaluateGeodesic(report) {
  const { webgpuArc: gpuArc, webglArc: wglArc, diffPct } = report.raw;
  const r = {
    webgpuNonBlackPixels: report.webgpuNonBlackPixels,
    webglNonBlackPixels: report.webglNonBlackPixels,
    webgpuArcOk: gpuArc.ok,
    webglArcOk: wglArc.ok,
    webgpuArcBowDeviationPx: gpuArc.maxBow,
    webgpuGeodesicVsChordSepPx: gpuArc.maxSeparation,
    webgpuVsWebglDiffPct: diffPct,
    canvas: report.canvas,
    webglCanvas: report.webglCanvas,
  };
  const bowGap = Math.abs(gpuArc.maxBow - wglArc.maxBow);
  const sepGap = Math.abs(gpuArc.maxSeparation - wglArc.maxSeparation);
  return [
    {
      id: "webgpu-coverage",
      claim: `webgpu renders the geodesic (coverage ${r.webgpuNonBlackPixels} > 200)`,
      pass: r.webgpuNonBlackPixels > 200,
      detail: { coverage: r.webgpuNonBlackPixels },
    },
    {
      id: "webgl-coverage",
      claim: `webgl renders the geodesic (coverage ${r.webglNonBlackPixels} > 200)`,
      pass: r.webglNonBlackPixels > 200,
      detail: { coverage: r.webglNonBlackPixels },
    },
    {
      id: "arc-measurable",
      claim: "the arc is measurable on both backends (>= 20 cyan columns)",
      pass: r.webgpuArcOk === true && r.webglArcOk === true,
      detail: { webgpu: r.webgpuArcOk, webgl: r.webglArcOk },
    },
    {
      id: "webgpu-curves",
      claim: `webgpu geodesic bows ${r.webgpuArcBowDeviationPx.toFixed(2)} px > 8 from its own endpoints' line`,
      pass: r.webgpuArcBowDeviationPx > 8,
      detail: { maxBow: r.webgpuArcBowDeviationPx },
    },
    {
      id: "webgpu-separates-from-chord",
      claim: `webgpu geodesic separates ${r.webgpuGeodesicVsChordSepPx.toFixed(2)} px > 8 from the straight chord`,
      pass: r.webgpuGeodesicVsChordSepPx > 8,
      detail: { maxSeparation: r.webgpuGeodesicVsChordSepPx },
    },
    {
      id: "bow-parity",
      claim: `webgpu bow within 6 px of webgl's (gap ${bowGap.toFixed(2)})`,
      pass: bowGap < 6,
      detail: { bowGap },
    },
    {
      id: "separation-parity",
      claim: `webgpu chord separation within 6 px of webgl's (gap ${sepGap.toFixed(2)})`,
      pass: sepGap < 6,
      detail: { sepGap },
    },
    {
      id: "low-overall-mismatch",
      claim: `webgpu vs webgl mismatch ${r.webgpuVsWebglDiffPct === null ? "null" : r.webgpuVsWebglDiffPct.toFixed(4)}% < 2.0 (null = frames of different sizes, not compared)`,
      pass: r.webgpuVsWebglDiffPct !== null && r.webgpuVsWebglDiffPct < 2.0,
      detail: {
        mismatchPct: r.webgpuVsWebglDiffPct,
        webgpuCanvas: r.canvas,
        webglCanvas: r.webglCanvas,
      },
    },
  ];
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "polyline-geodesic",
  title: "DP-H7 — a geodesic PolylineCollection line curves on WebGPU",
  outputSubdirectory: "polyline-geodesic",
  // No JSON receipt was banked before the migration; it printed this report.
  receiptEnvelope: "runtime",
  // The CesiumViewer page and the in-page import both read this module.
  servedArtifacts: ["Build/CesiumUnminified/index.js"],
  workBudgetMs: () => 2 * BACKEND_BUDGET_MS,
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (
      !options.renderers.includes("webgl") ||
      !options.renderers.includes("webgpu")
    ) {
      throw new ProbeRefusal(
        "renderer-pair-required",
        `the geodesic is measured against WebGL, so both renderers are required (got ${options.renderers.join(",")})`,
        { renderers: options.renderers },
      );
    }
    const shared = { browser, origin, run, outputDirectory, captures };
    const webgpu = await runBackend({ ...shared, renderer: "webgpu" });
    const webgl = await runBackend({ ...shared, renderer: "webgl" });
    const report = measureGeodesic(webgpu, webgl);
    console.log(JSON.stringify(report, null, 2));
    return [{ run, report }];
  },
  verdicts(cells) {
    return cells.flatMap((cell) =>
      evaluateGeodesic(cell.report).map((verdict) => ({
        ...verdict,
        id: `${verdict.id}/run${cell.run}`,
      })),
    );
  },
  receipt(cells, context) {
    for (const verdict of context.verdicts) {
      console.log(`  [${verdict.pass ? "PASS" : "FAIL"}] ${verdict.claim}`);
    }
    return { rig: rig.id, cells, verdicts: context.verdicts };
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
