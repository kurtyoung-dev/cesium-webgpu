#!/usr/bin/env node
/**
 * Probe: PolylineCollection MIXED materials parity — WebGPU vs WebGL (AR-754,
 * `L2-COL-5` Claim B; standing guard for AR-001's collection-shader batch).
 * @purpose Parity gate: one PolylineCollection mixing Solid/Dash/Glow/Arrow/Outline, measured per hue at two device pixel ratios, so no material's regression can hide behind another's.
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * WHAT THIS REPLACES, AND WHY. `BUG-POLYLINE-COLLECTION-MULTI-MATERIAL` was
 * closed FIXED with this probe named as its standing guard. The guard it named
 * did not cover the bug it closed:
 *
 *   - the bug had TWO symptoms — dash losing its pattern AND glow losing its
 *     taper (~3.3x the WebGL lit pixels) — and only the dash half was gated;
 *   - glow was asserted with a bare `colored > 200`, which a full-width solid
 *     band passes more easily than a correct tapered glow does;
 *   - PolylineArrow and PolylineOutline were never instantiated at all, so two
 *     of the four non-Color material groups had no coverage in the multi-group
 *     path the bug lived in;
 *   - it ran at DPR 1 only;
 *   - and `probe-path-portions.mjs`, the second probe the closure record names,
 *     is not in the tree and never has been.
 *
 * So this file measures each of the four non-Color materials against WebGL by a
 * quantity that material's failure mode actually moves, at both DPR 1 and
 * DPR 2. Claim A of `L2-COL-5` — that the per-material binding architecture is
 * correct — is settled and is NOT re-opened here.
 *
 * THE SCENE. ONE `PolylineCollection` holding five colour-separated horizontal
 * lines, so the per-`materialType` group loop is exercised with five material
 * types at once. Each line owns a hue no other line can produce, and every
 * measurement is taken over that hue's mask alone:
 *
 *   SOLID   RED      lat 35.6   Material.ColorType — the sanity anchor
 *   DASH    CYAN     lat 35.3   PolylineDash
 *   GLOW    YELLOW   lat 35.0   PolylineGlow
 *   ARROW   MAGENTA  lat 34.7   PolylineArrow
 *   OUTLINE LIME     lat 34.4   PolylineOutline, outlined in BLUE
 *
 * WHAT EACH MATERIAL IS MEASURED BY. A lit-pixel ratio alone is a weak gate —
 * the dash bug moved the pattern without moving the count much, and the glow
 * bug moved the count by 3.3x. So each material is gated on the quantity its
 * own failure moves:
 *
 *   dash     runs-per-row, plus a run-count ratio: a dashed line yields many
 *            colored runs per row, a collapsed one yields ~1.
 *   glow     lit-pixel ratio AND the cross-line FWHM ratio: the taper is a
 *            profile, and a solid band of similar total area would pass a
 *            count-only check.
 *   arrow    lit-pixel ratio AND the head's column-height profile: the head
 *            is a triangle cut by two half-planes, so it fills about half its
 *            own bounding box. A head that paints as a filled RECTANGLE has
 *            the same bounding box, the same peak and a total only ~14% high —
 *            comfortably inside a count band. Éowyn's job-11 leg 5 found
 *            exactly that, which is why the head fill fraction and the head's
 *            length in pixels are asserted here and not only the count.
 *   outline  lit-pixel ratio on the CORE hue, the presence of the OUTLINE hue,
 *            and the cross-section structure: the outline must BRACKET the
 *            core above and below. A collapse to Color renders the core and no
 *            outline at all, and a flood renders the outline and no core.
 *
 * Usage: node server.js --port 8094 --serve-built   (separate terminal, once)
 *        node Tools/visual-regression/probe-polyline-multimaterial.mjs
 * Out:   Tools/visual-regression/output/polyline-multimaterial/
 */
import fs from "node:fs";
import path from "node:path";

import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { ProbeRefusal, isEntryPoint, runProbe } from "./lib/probe-runtime.mjs";
import {
  DEVICE_SCALE_FACTORS,
  MATERIALS,
  buildChecks,
  gateCheck,
  materialChecks,
} from "./lib/polyline-multimaterial-verdicts.mjs";

const VIEWPORT = { width: 1024, height: 768 };
const WATCHDOG_BUDGET_MS = 6 * 60 * 1000;

// The verdict functions live in `lib/polyline-multimaterial-verdicts.mjs`,
// which has no imports of its own so `polyline-multimaterial-verdicts.spec.mjs`
// can mutate them as text and execute the mutant — AR-754's acceptance is that
// removing ONE material's assertions makes this probe exit zero on a scene that
// is visibly wrong for that material, and that is only demonstrable against the
// shipped decision source.
export {
  DEVICE_SCALE_FACTORS,
  MATERIALS,
  buildChecks,
  gateCheck,
  materialChecks,
} from "./lib/polyline-multimaterial-verdicts.mjs";

// ---------------------------------------------------------------------------
// Capture.
// ---------------------------------------------------------------------------

/**
 * Builds the mixed collection and measures every hue. Runs inside the page.
 *
 * @param {object} page Playwright page.
 * @returns {Promise<object>} Per-hue measurements.
 */
async function captureRender(page) {
  return page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    // Make the DPR-2 leg a second RESOLUTION and not only a second
    // `window.devicePixelRatio`. Cesium's default
    // `useBrowserRecommendedResolution: true` pins the drawing buffer to CSS
    // pixels AND pins `czm_pixelRatio` to 1, so every DPR-2 count used to be a
    // near-duplicate of DPR 1 and no pixel-ratio term in any polyline shader
    // was ever exercised. Turning it off makes the backing store
    // `devicePixelRatio` times the CSS size, so leg 1 is unchanged (ratio 1)
    // and leg 2 is genuinely 2x.
    v.useBrowserRecommendedResolution = false;
    // The flag only sets `_forceResize`; the backing store is reconfigured by
    // `CesiumWidget.resize()`. Call it here so the leg does not depend on the
    // default render loop having ticked before the first measurement.
    v.cesiumWidget?.resize();
    v.scene.globe.show = false;
    v.scene.skyBox.show = false;
    v.scene.sun.show = false;
    v.scene.moon.show = false;
    v.scene.skyAtmosphere.show = false;
    v.scene.backgroundColor = C.Color.BLACK;

    const prims = v.scene.primitives;
    for (let i = prims.length - 1; i >= 0; i--) {
      const p = prims.get(i);
      if (p && p.constructor && p.constructor.name === "PolylineCollection") {
        prims.remove(p);
      }
    }

    const collection = prims.add(new C.PolylineCollection());
    const line = (lat) =>
      C.Cartesian3.fromDegreesArray([-76.0, lat, -72.0, lat]);

    collection.add({
      positions: line(35.6),
      width: 12.0,
      material: C.Material.fromType("Color", { color: C.Color.RED }),
    });
    collection.add({
      positions: line(35.3),
      width: 12.0,
      material: C.Material.fromType("PolylineDash", {
        color: C.Color.CYAN,
        dashLength: 24.0,
        dashPattern: 255.0,
      }),
    });
    collection.add({
      positions: line(35.0),
      width: 12.0,
      material: C.Material.fromType("PolylineGlow", {
        color: C.Color.YELLOW,
        glowPower: 0.25,
        taperPower: 1.0,
      }),
    });
    collection.add({
      positions: line(34.7),
      width: 24.0,
      material: C.Material.fromType("PolylineArrow", {
        color: C.Color.MAGENTA,
      }),
    });
    collection.add({
      positions: line(34.4),
      width: 16.0,
      material: C.Material.fromType("PolylineOutline", {
        color: C.Color.LIME,
        outlineColor: C.Color.BLUE,
        outlineWidth: 6.0,
      }),
    });

    const center = C.Cartesian3.fromDegrees(-74.0, 35.0, 0.0);
    v.camera.lookAt(
      center,
      new C.HeadingPitchRange(0.0, C.Math.toRadians(-90.0), 700000.0),
    );
    v.camera.lookAtTransform(C.Matrix4.IDENTITY);

    for (let i = 0; i < 90; i++) {
      v.scene.render();
      await new Promise((res) => requestAnimationFrame(res));
    }

    const canvas = v.canvas;
    const w = canvas.width;
    const h = canvas.height;
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;
    const tctx = tmp.getContext("2d");
    tctx.drawImage(canvas, 0, 0);
    const px = tctx.getImageData(0, 0, w, h).data;

    // Six mutually exclusive hue classifiers. No line can be mistaken for
    // another, so one material's collapse cannot inflate another's count.
    const T = 30;
    const hues = {
      solid: (i) => px[i] > T && px[i + 1] < T && px[i + 2] < T,
      dash: (i) => px[i] < T && px[i + 1] > T && px[i + 2] > T,
      glow: (i) => px[i] > T && px[i + 1] > T && px[i + 2] < T,
      arrow: (i) => px[i] > T && px[i + 1] < T && px[i + 2] > T,
      outline: (i) => px[i] < T && px[i + 1] > T && px[i + 2] < T,
      outlineEdge: (i) => px[i] < T && px[i + 1] < T && px[i + 2] > T,
    };

    /**
     * Counts pixels, colored runs per row, and the full width at half maximum
     * of the row-intensity profile — the cross-line thickness, which is what a
     * glow losing its taper moves and a pixel count alone does not.
     *
     * @param {Function} classify Hue predicate over a pixel offset.
     * @returns {object} The measurements.
     */
    function measure(classify) {
      let colored = 0;
      let runs = 0;
      let coloredRows = 0;
      const rowIntensity = new Float64Array(h);
      for (let y = 0; y < h; y++) {
        let prev = false;
        let rowHas = false;
        let sum = 0;
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const c = classify(i);
          if (c) {
            colored++;
            rowHas = true;
            sum += Math.max(px[i], px[i + 1], px[i + 2]);
            if (!prev) {
              runs++;
            }
          }
          prev = c;
        }
        rowIntensity[y] = sum;
        if (rowHas) {
          coloredRows++;
        }
      }
      let peak = 0;
      for (let y = 0; y < h; y++) {
        if (rowIntensity[y] > peak) {
          peak = rowIntensity[y];
        }
      }
      let fwhm = 0;
      if (peak > 0) {
        const half = peak / 2;
        for (let y = 0; y < h; y++) {
          if (rowIntensity[y] >= half) {
            fwhm++;
          }
        }
      }
      return {
        colored,
        runs,
        coloredRows,
        fwhm,
        runsPerRow: coloredRows > 0 ? runs / coloredRows : 0,
      };
    }

    /**
     * Per-column lit-pixel heights for one hue.
     *
     * @param {Function} classify Hue predicate over a pixel offset.
     * @returns {Int32Array} Height per column.
     */
    function columnHeights(classify) {
      const heights = new Int32Array(w);
      for (let x = 0; x < w; x++) {
        let n = 0;
        for (let y = 0; y < h; y++) {
          if (classify((y * w + x) * 4)) {
            n++;
          }
        }
        heights[x] = n;
      }
      return heights;
    }

    /**
     * The arrow's shape, not its area. `PolylineArrowMaterial.glsl` cuts the
     * head with two half-planes that meet at the tip, so the head's column
     * heights fall away linearly and it fills about half of its own bounding
     * box. A head that renders at full area in the wrong shape — a filled
     * rectangle — has the same bounding box, the same peak and nearly the same
     * total, so only the profile separates them.
     *
     * @param {Function} classify The arrow hue predicate.
     * @returns {object|null} Body height, head extent, and head fill fraction.
     */
    function arrowProfile(classify) {
      const heights = columnHeights(classify);
      let x0 = -1;
      let x1 = -1;
      for (let x = 0; x < w; x++) {
        if (heights[x] > 0) {
          if (x0 < 0) {
            x0 = x;
          }
          x1 = x;
        }
      }
      if (x0 < 0) {
        return null;
      }
      // The shaft is the leading 80% of the span; its median height is robust
      // against the antialiased first and last columns.
      const bodyEnd = x0 + Math.floor((x1 - x0 + 1) * 0.8);
      const samples = [];
      for (let x = x0; x <= bodyEnd; x++) {
        if (heights[x] > 0) {
          samples.push(heights[x]);
        }
      }
      samples.sort((a, b) => a - b);
      const body = samples.length > 0 ? samples[samples.length >> 1] : 0;
      // The head is the trailing run of columns that flare past the shaft,
      // extended to the end of the line so the tip's taper is included.
      const flare = body * 1.5;
      let lastFlare = -1;
      for (let x = x1; x >= x0; x--) {
        if (heights[x] > flare) {
          lastFlare = x;
          break;
        }
      }
      if (lastFlare < 0) {
        return { body, headColumns: 0, headPeak: 0, headFill: null, head: [] };
      }
      let headStart = lastFlare;
      while (headStart > x0 && heights[headStart - 1] > flare) {
        headStart--;
      }
      const head = [];
      let sum = 0;
      let peak = 0;
      for (let x = headStart; x <= x1; x++) {
        head.push(heights[x]);
        sum += heights[x];
        if (heights[x] > peak) {
          peak = heights[x];
        }
      }
      return {
        spanStart: x0,
        spanEnd: x1,
        body,
        headStart,
        headColumns: head.length,
        headPeak: peak,
        headFill:
          peak > 0 && head.length > 0 ? sum / (peak * head.length) : null,
        head,
      };
    }

    /**
     * The outline's vertical structure at its widest column: the outline hue
     * must BRACKET the core hue above and below. A count ratio cannot tell a
     * two-sided outline from a one-sided one, or from a flood.
     *
     * @param {Function} coreClassify The core hue predicate.
     * @param {Function} edgeClassify The outline hue predicate.
     * @returns {object|null} Column, core extent, and outline rows each side.
     */
    function outlineCrossSection(coreClassify, edgeClassify) {
      const coreHeights = columnHeights(coreClassify);
      let column = -1;
      let best = 0;
      for (let x = 0; x < w; x++) {
        if (coreHeights[x] > best) {
          best = coreHeights[x];
          column = x;
        }
      }
      if (column < 0) {
        return null;
      }
      let coreMin = h;
      let coreMax = -1;
      for (let y = 0; y < h; y++) {
        if (coreClassify((y * w + column) * 4)) {
          if (y < coreMin) {
            coreMin = y;
          }
          coreMax = y;
        }
      }
      let edgeAbove = 0;
      let edgeBelow = 0;
      for (let y = 0; y < h; y++) {
        if (edgeClassify((y * w + column) * 4)) {
          if (y < coreMin) {
            edgeAbove++;
          } else if (y > coreMax) {
            edgeBelow++;
          }
        }
      }
      return { column, coreRows: best, coreMin, coreMax, edgeAbove, edgeBelow };
    }

    const out = {
      renderer: v.scene.context ? v.scene.context.rendererType : null,
      width: w,
      height: h,
      devicePixelRatio: window.devicePixelRatio,
    };
    for (const [key, classify] of Object.entries(hues)) {
      out[key] = measure(classify);
    }
    out.arrowProfile = arrowProfile(hues.arrow);
    out.outlineCrossSection = outlineCrossSection(
      hues.outline,
      hues.outlineEdge,
    );
    return out;
  });
}

/**
 * One renderer at one device scale factor.
 *
 * @param {object} browser Playwright browser.
 * @param {string} origin Served origin.
 * @param {string} renderer Backend.
 * @param {number} deviceScaleFactor The DPR to emulate.
 * @param {string} outputDirectory Where the PNG goes.
 * @returns {Promise<object>} The capture.
 */
async function captureOne(
  browser,
  origin,
  renderer,
  deviceScaleFactor,
  outputDirectory,
) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.goto(
    `${origin}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
    { waitUntil: "networkidle", timeout: 90000 },
  );
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });
  await armWebGPUDevices(page);

  const render = await captureRender(page);
  const buffer = await page.screenshot({ omitBackground: false });
  const file = path.join(
    outputDirectory,
    `polyline-multimaterial-${renderer}-dpr${deviceScaleFactor}.png`,
  );
  fs.writeFileSync(file, buffer);

  const gate = await collectGateErrors(page);
  await page.close();
  return {
    render,
    png: file,
    gateErrors: gate.errors.length,
    gateErrorsSample: gate.errors.slice(0, 6),
    deviceLost: gate.deviceLost ?? null,
    consoleErrors: consoleErrors.slice(0, 6),
  };
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "polyline-multimaterial",
  title: "PolylineCollection mixed-material parity (AR-754)",
  receiptEnvelope: "probe-owned",
  async cells({ browser, origin, outputDirectory, options }) {
    if (options.renderers.length !== 2) {
      throw new ProbeRefusal(
        "renderer-pair-required",
        `probe-polyline-multimaterial reports WebGPU/WebGL ratios and cannot compute one from a single backend; got --renderer ${options.renderers.join(",")}`,
        { renderers: options.renderers },
      );
    }
    if (options.runs !== 1) {
      throw new ProbeRefusal(
        "multi-run-not-supported",
        `this probe's receipt keys legs by deviceScaleFactor, so --runs ${options.runs} would drop every run but the last; pass --runs 1`,
        { runs: options.runs },
      );
    }
    fs.mkdirSync(outputDirectory, { recursive: true });

    // Everything that can hang — page open, navigation, the wait for
    // `window.viewer`, and the render loop — runs inside `work`, so the
    // watchdog covers the whole budget rather than only the scene loop.
    const work = (async () => {
      const legs = [];
      for (const deviceScaleFactor of DEVICE_SCALE_FACTORS) {
        const leg = { deviceScaleFactor };
        for (const renderer of options.renderers) {
          const capture = await captureOne(
            browser,
            origin,
            renderer,
            deviceScaleFactor,
            outputDirectory,
          );
          leg[renderer] = capture.render;
          leg[`${renderer}Png`] = capture.png;
          if (renderer === "webgpu") {
            leg.gateErrors = capture.gateErrors;
            leg.gateErrorsSample = capture.gateErrorsSample;
            leg.deviceLost = capture.deviceLost;
          }
        }
        leg.checks = buildChecks([leg]);
        leg.pass = leg.checks.every((check) => check.pass);
        legs.push(leg);
      }
      return legs;
    })();
    work.catch(() => {});
    let watchdogTimer;
    const watchdog = new Promise((_resolve, reject) => {
      watchdogTimer = setTimeout(
        () =>
          reject(
            new ProbeRefusal(
              "watchdog-timeout",
              `probe-polyline-multimaterial exceeded its ${WATCHDOG_BUDGET_MS}ms machine-safety budget`,
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
    const legs = {};
    for (const leg of cells) {
      legs[`dpr${leg.deviceScaleFactor}`] = leg;
    }
    return { base: context.origin, legs };
  },
  verdicts(cells) {
    const verdicts = [];
    for (const leg of cells) {
      for (const material of MATERIALS) {
        verdicts.push({
          id: `${material}-dpr${leg.deviceScaleFactor}`,
          claim: `AR-754 — ${material} renders at parity inside a mixed-material PolylineCollection at DPR ${leg.deviceScaleFactor}`,
          pass: materialChecks(material, leg).every((check) => check.pass),
        });
      }
      // The device-health gate has to be a VERDICT, not only a summary line:
      // `exitCodeForOutcome` reads verdicts and nothing else, so a leg with
      // uncaptured WebGPU validation errors or a lost device would otherwise
      // exit 0 on the strength of the material ratios alone.
      verdicts.push({
        id: `gate-dpr${leg.deviceScaleFactor}`,
        claim: `AR-754 — no uncaptured WebGPU errors and no device loss at DPR ${leg.deviceScaleFactor}`,
        pass: gateCheck(leg).pass,
      });
    }
    return verdicts;
  },
  summary(receipt) {
    const lines = [
      "# PolylineCollection mixed-material parity (AR-754)",
      "",
      `Base: \`${receipt.base}\``,
      "",
    ];
    for (const [key, leg] of Object.entries(receipt.legs)) {
      lines.push(`## ${key}`, "");
      for (const check of leg.checks) {
        lines.push(`- [${check.pass ? "PASS" : "FAIL"}] ${check.label}`);
      }
      lines.push("");
    }
    return lines.join("\n");
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
