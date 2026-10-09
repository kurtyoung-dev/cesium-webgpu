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
 * WHERE THE PIXELS ARE READ (probe-kit harvest, polyline family, DX-108).
 * Until the harvest every one of those quantities was computed inside the
 * page, over a `drawImage` copy of the live canvas — the reader
 * `prohibited-reader-allowlist.mjs` exists to retire — and the banked PNG was a
 * separate page screenshot, viewer chrome included, outside the capture seam.
 * Now the frame is ONE element capture of the scene canvas through
 * `captureElement` (device-liveness checked, sha256 in the runtime receipt),
 * taken after `lib/strip-viewer-widgets.mjs` has removed the viewer chrome that
 * otherwise sits inside the canvas's rectangle (a run with chrome left over the
 * canvas refuses), and every quantity is computed in Node from that PNG by the
 * kit: the six hue classes are `channelThresholds`
 * (`lib/metrics/colour-mask.mjs`, the same strict `T = 30` bounds), and the
 * runs, FWHM, arrow-head profile and outline cross-section are
 * `rowRunProfile`, `arrowHeadProfile` and `outlineCrossSection`
 * (`lib/metrics/line-structure.mjs`), the in-page bodies moved verbatim. The
 * measurement object the verdict library reads keeps its exact shape. The two
 * legs are the rigs `polyline-multimaterial-dpr1` and
 * `polyline-multimaterial-dpr2`, which supply the viewport, the settle frames
 * and the camera; the scene's five lines stay literal below because
 * `polyline-multimaterial-verdicts.spec.mjs` A1 reads them from this source.
 *
 * Usage: node server.js --port 8094 --serve-built   (separate terminal, once)
 *        node Tools/visual-regression/probe-polyline-multimaterial.mjs
 * Out:   Tools/visual-regression/output/polyline-multimaterial/
 */
import fs from "node:fs";

import { decodePng } from "../lib/png-decode.mjs";
import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { channelThresholds } from "./lib/metrics/colour-mask.mjs";
import {
  arrowHeadProfile,
  outlineCrossSection,
  rowRunProfile,
} from "./lib/metrics/line-structure.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";
import {
  DEVICE_SCALE_FACTORS,
  MATERIALS,
  buildChecks,
  gateCheck,
  materialChecks,
} from "./lib/polyline-multimaterial-verdicts.mjs";
import { STRIP_WIDGETS_SOURCE } from "./lib/strip-viewer-widgets.mjs";
import dpr1Rig from "./rigs/polyline-multimaterial-dpr1.mjs";
import dpr2Rig from "./rigs/polyline-multimaterial-dpr2.mjs";

/** The rig of each device-scale leg, keyed by its factor. */
export const RIG_BY_DEVICE_SCALE = Object.freeze(
  Object.fromEntries(
    [dpr1Rig, dpr2Rig].map((rig) => [rig.dials.deviceScaleFactor, rig]),
  ),
);

const WATCHDOG_BUDGET_MS = 6 * 60 * 1000;

/** The canvas the scene draws into; the CesiumViewer page has exactly one. */
const SCENE_CANVAS = ".cesium-widget canvas";

/**
 * Six mutually exclusive hue classifiers, strict at `T = 30`. No line can be
 * mistaken for another, so one material's collapse cannot inflate another's
 * count.
 */
const T = 30;
export const HUES = Object.freeze({
  solid: channelThresholds({ rAbove: T, gBelow: T, bBelow: T }),
  dash: channelThresholds({ rBelow: T, gAbove: T, bAbove: T }),
  glow: channelThresholds({ rAbove: T, gAbove: T, bBelow: T }),
  arrow: channelThresholds({ rAbove: T, gBelow: T, bAbove: T }),
  outline: channelThresholds({ rBelow: T, gAbove: T, bBelow: T }),
  outlineEdge: channelThresholds({ rBelow: T, gBelow: T, bAbove: T }),
});

/**
 * Every quantity the verdict library reads, from one decoded frame — the
 * object the in-page analysis used to return, key for key.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} image Decoded frame.
 * @param {{renderer: string|null, devicePixelRatio: number}} facts Page-side facts.
 * @returns {object} The measurement.
 */
export function measureMultimaterialFrame(image, facts) {
  const out = {
    renderer: facts.renderer,
    width: image.width,
    height: image.height,
    devicePixelRatio: facts.devicePixelRatio,
  };
  for (const [key, classify] of Object.entries(HUES)) {
    out[key] = rowRunProfile(image, classify);
  }
  out.arrowProfile = arrowHeadProfile(image, HUES.arrow);
  out.outlineCrossSection = outlineCrossSection(
    image,
    HUES.outline,
    HUES.outlineEdge,
  );
  return out;
}

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
 * Builds the mixed collection and renders it. Runs inside the page; it
 * measures nothing — every hue is read in Node from the capture
 * ({@link measureMultimaterialFrame}).
 *
 * @param {object} page Playwright page.
 * @param {object} rig The leg's rig (camera and settle frames).
 * @returns {Promise<{renderer: string|null, devicePixelRatio: number}>} Page-side facts.
 */
async function captureRender(page, rig) {
  return page.evaluate(
    async (scene) => {
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

      const look = scene.lookAt;
      v.camera.lookAt(
        C.Cartesian3.fromDegrees(look.lon, look.lat, look.height),
        new C.HeadingPitchRange(
          C.Math.toRadians(look.headingDegrees),
          C.Math.toRadians(look.pitchDegrees),
          look.rangeMetres,
        ),
      );
      v.camera.lookAtTransform(C.Matrix4.IDENTITY);

      for (let i = 0; i < scene.frames; i++) {
        v.scene.render();
        await new Promise((res) => requestAnimationFrame(res));
      }

      return {
        renderer: v.scene.context ? v.scene.context.rendererType : null,
        devicePixelRatio: window.devicePixelRatio,
      };
    },
    { lookAt: rig.dials.lookAt, frames: rig.readiness.frames },
  );
}

/**
 * One renderer at one device scale factor: the scene built and settled, the
 * viewer chrome removed, one element capture of the scene canvas through the
 * seam, and every hue measured in Node from it.
 *
 * @param {object} options Inputs.
 * @param {object} options.browser Playwright browser.
 * @param {string} options.origin Served origin.
 * @param {string} options.renderer Backend.
 * @param {number} options.deviceScaleFactor The DPR to emulate.
 * @param {string} options.outputDirectory Where the PNG goes.
 * @param {Array<object>} options.captures The runtime's capture records.
 * @returns {Promise<object>} The capture.
 */
async function captureOne({
  browser,
  origin,
  renderer,
  deviceScaleFactor,
  outputDirectory,
  captures,
}) {
  const rig = RIG_BY_DEVICE_SCALE[deviceScaleFactor];
  if (!rig) {
    throw new ProbeRefusal(
      "device-scale-without-rig",
      `no polyline-multimaterial rig declares deviceScaleFactor ${deviceScaleFactor}`,
      { deviceScaleFactor },
    );
  }
  const page = await browser.newPage({
    viewport: { ...rig.viewport },
    deviceScaleFactor,
  });
  try {
    const consoleErrors = attachConsoleErrorGate(page);
    await page.addInitScript(errorGateInit);
    await page.goto(
      `${origin}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
      { waitUntil: "networkidle", timeout: 90000 },
    );
    await page.waitForFunction(() => !!window.viewer, null, {
      timeout: 90000,
    });
    await armWebGPUDevices(page);
    const strip = await page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`);
    if (strip.leftovers.length > 0) {
      throw new ProbeRefusal(
        "viewer-chrome-over-canvas",
        `${rig.id}/${renderer}: elements still overlap the scene canvas after the widget strip (${strip.leftovers.join(", ")}), so an element capture would score them`,
        { rig: rig.id, renderer, ...strip },
      );
    }

    const facts = await captureRender(page, rig);
    const shot = await captureElement({
      page,
      selector: SCENE_CANVAS,
      name: `polyline-multimaterial-${renderer}-dpr${deviceScaleFactor}`,
      outputDirectory,
      captures,
    });
    const render = measureMultimaterialFrame(decodePng(shot.buffer), facts);

    const gate = await collectGateErrors(page);
    return {
      render,
      png: shot.path,
      gateErrors: gate.errors.length,
      gateErrorsSample: gate.errors.slice(0, 6),
      deviceLost: gate.deviceLost ?? null,
      consoleErrors: consoleErrors.slice(0, 6),
    };
  } finally {
    await page.close();
  }
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "polyline-multimaterial",
  title: "PolylineCollection mixed-material parity (AR-754)",
  receiptEnvelope: "probe-owned",
  async cells({ browser, origin, outputDirectory, options, captures }) {
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
          const capture = await captureOne({
            browser,
            origin,
            renderer,
            deviceScaleFactor,
            outputDirectory,
            captures,
          });
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
