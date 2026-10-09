#!/usr/bin/env node
/**
 * Probe: polyline `Primitive` + `PolylineMaterialAppearance` parity on WebGPU
 * vs WebGL (NEW-POLYLINE-APPEARANCE-PRIMITIVE-WEBGPU, MATERIAL slice).
 * @purpose Gate: Primitive+PolylineMaterialAppearance MATERIAL slice — Dash renders dashed (run-count metric) and Glow renders, at parity with WebGL
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * The COLOR slice landed a polyline `Primitive` + `PolylineColorAppearance`.
 * The MATERIAL slice adds `PolylineMaterialAppearance` with the PolylineDash /
 * PolylineGlow / PolylineArrow / PolylineOutline / plain Color materials. This
 * probe exercises DASH (pass 1) and GLOW (pass 2) on both backends.
 *
 * What it verifies:
 *   PASS 1 (PolylineDash):
 *     - Both backends draw colored pixels (line renders, not 0px).
 *     - The line is DASHED — many colored runs along rows, not a single solid
 *       run per crossing. We count colored runs across all rows; a solid line
 *       yields O(rows-crossed) runs, a dashed line yields several× more. The
 *       run count must be comfortably above the solid-line floor on BOTH
 *       backends, and within ~15% backend-to-backend.
 *   PASS 2 (PolylineGlow):
 *     - Both backends draw a glowing line (colored pixels present), within ~15%.
 *
 * The backend-to-backend check in PASS 1 has always been the COLORED-PIXEL
 * ratio, not a run-count ratio as the paragraph above suggests; the migration
 * keeps the check the code made.
 *
 * C11-09 (`CAMPAIGN11_EXECUTION_GUIDE` cluster G1, A10) names this probe as
 * one of the two colour/material baselines the polyline appearance pick fix
 * must leave unchanged.
 *
 * ON THE SHARED RUNTIME (probe-kit harvest, polyline family, DX-108). The
 * browser, the origin (`--port`, a governed Edge port, never 8080), the
 * served-build preflight, the Edge slot, the lifecycle deadline and the
 * receipt belong to `lib/probe-runtime.mjs`. The two passes are the rigs
 * `polyline-material-dash` and `polyline-material-glow`, and the page builds
 * each scene from its rig. Each capture still gets a fresh browser context
 * (the original launched a fresh browser) and the WebGPU error gate. Each
 * frame is an element capture of the scene canvas through `captureElement`,
 * taken after `lib/strip-viewer-widgets.mjs` has removed the viewer chrome
 * that otherwise sits inside the canvas's rectangle (a run with chrome left
 * over the canvas refuses). The colored count, the runs and the colored rows
 * are `rowRunProfile` (`lib/metrics/line-structure.mjs`) over the decoded PNG
 * with the original "any channel > 30" class (`anyChannelAbove`,
 * `lib/metrics/colour-mask.mjs`), where the original read the live canvas
 * through `drawImage` inside the page.
 *
 * Usage: node server.js --port 8094 --serve-built   (separate terminal, once)
 *        node Tools/visual-regression/probe-polyline-material-primitive.mjs
 * Out:   Tools/visual-regression/output/polyline-material-primitive/
 */
import { decodePng } from "../lib/png-decode.mjs";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";
import { anyChannelAbove } from "./lib/metrics/colour-mask.mjs";
import { rowRunProfile } from "./lib/metrics/line-structure.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";
import { STRIP_WIDGETS_SOURCE } from "./lib/strip-viewer-widgets.mjs";
import dashRig from "./rigs/polyline-material-dash.mjs";
import glowRig from "./rigs/polyline-material-glow.mjs";

/** The two passes, in the order the probe has always measured them. */
export const RIGS = Object.freeze([dashRig, glowRig]);

/** "Colored" = clearly non-black: the cyan-ish line or glow over a black clear. */
export const COLORED = anyChannelAbove(30);

/** The canvas the scene draws into; the CesiumViewer page has exactly one. */
const SCENE_CANVAS = ".cesium-widget canvas";

/**
 * A bound on one capture's work, from the probe's own step timeouts: page
 * load (90 s), the wait for `window.viewer` (90 s), the settle loop (at most
 * half a second per settle frame) and the capture (30 s). Not a measurement —
 * a ceiling past which the lifecycle stops the run instead of letting a hung
 * device wedge the machine (the original had no watchdog at all).
 *
 * @param {object} rig The capture's rig.
 * @returns {number} Milliseconds.
 */
function captureBudgetMs(rig) {
  return 90_000 + 90_000 + rig.readiness.frames * 500 + 30_000;
}

/**
 * Builds one rig's scene in the page and renders it for the rig's settle
 * frames. `page.evaluate` ships this function's SOURCE, so everything it reads
 * arrives in `scene`; it measures nothing — the pixels are read in Node from
 * the capture.
 *
 * @param {object} page Playwright page.
 * @param {object} rig The pass's rig.
 * @returns {Promise<{renderer: string, primitiveReady: boolean, material: string}>} Page-side facts.
 */
async function buildScene(page, rig) {
  return page.evaluate(
    async (scene) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      for (const name of scene.hide) {
        v.scene[name].show = false;
      }
      v.scene.backgroundColor = C.Color.BLACK;

      // Remove any prior Primitive instances.
      const prims = v.scene.primitives;
      for (let i = prims.length - 1; i >= 0; i--) {
        const p = prims.get(i);
        if (p && p.constructor && p.constructor.name === "Primitive") {
          prims.remove(p);
        }
      }

      // A mostly-horizontal line so dash gaps fall along screen rows.
      const positions = C.Cartesian3.fromDegreesArray(scene.positionsDegrees);

      const spec = scene.material;
      let material;
      if (spec.type === "PolylineDash") {
        material = C.Material.fromType("PolylineDash", {
          color: new C.Color(...spec.color),
          // 50% duty bitmask (0x00FF), long cycle so dashes are several px each.
          dashLength: spec.dashLength,
          dashPattern: spec.dashPattern,
        });
      } else {
        material = C.Material.fromType("PolylineGlow", {
          color: new C.Color(...spec.color),
          glowPower: spec.glowPower,
          taperPower: spec.taperPower,
        });
      }

      const primitive = prims.add(
        new C.Primitive({
          geometryInstances: new C.GeometryInstance({
            geometry: new C.PolylineGeometry({
              positions: positions,
              width: scene.width,
              arcType: C.ArcType[scene.arcType],
              vertexFormat: C.PolylineMaterialAppearance.VERTEX_FORMAT,
            }),
          }),
          appearance: new C.PolylineMaterialAppearance({
            material: material,
            translucent: false,
          }),
          asynchronous: false,
        }),
      );

      // Frame the line from straight above.
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

      let ready = false;
      for (let i = 0; i < scene.frames; i++) {
        v.scene.render();
        if (primitive.ready) ready = true;
        await new Promise((res) => requestAnimationFrame(res));
      }
      return {
        renderer: v.scene.context?.rendererType,
        primitiveReady: ready,
        material: spec.type,
      };
    },
    { ...rig.dials, frames: rig.readiness.frames },
  );
}

/**
 * One pass on one backend: a fresh browser context, the scene built and
 * settled, the viewer chrome removed, one element capture of the scene canvas,
 * and the gate read before the context closes.
 *
 * @param {object} options Inputs.
 * @returns {Promise<{render: object, gate: object, consoleErrors: string[]}>} The capture.
 */
async function capturePass({
  browser,
  origin,
  rig,
  renderer,
  run,
  outputDirectory,
  captures,
}) {
  const context = await browser.newContext({ viewport: { ...rig.viewport } });
  try {
    const page = await context.newPage();
    const consoleErrors = attachConsoleErrorGate(page);
    await page.addInitScript(errorGateInit);
    await page.goto(
      `${origin}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
      { waitUntil: "networkidle", timeout: 90_000 },
    );
    await page.waitForFunction(() => !!window.viewer, null, {
      timeout: 90_000,
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

    const facts = await buildScene(page, rig);
    const material = rig.dials.material.type;
    const shot = await captureElement({
      page,
      selector: SCENE_CANVAS,
      name: `polyline-material-${renderer}-${material}-run${run}`,
      outputDirectory,
      captures,
    });
    const image = decodePng(shot.buffer);
    const profile = rowRunProfile(image, COLORED);
    const render = {
      ...facts,
      width: image.width,
      height: image.height,
      colored: profile.colored,
      runs: profile.runs,
      coloredRows: profile.coloredRows,
      // runs per colored row — ~1.x for a solid line, >>1 for a dashed line.
      runsPerRow: profile.runsPerRow,
    };
    const gate = await collectGateErrors(page);
    console.log(
      `  [${renderer}/${material}] ${JSON.stringify(render)} gate: armed=${gate.armedDevices} uncaptured=${gate.errors.length} deviceLost=${gate.deviceLost || "no"}`,
    );
    return {
      render,
      gate: {
        errors: gate.errors.slice(0, 6),
        errorCount: gate.errors.length,
        deviceLost: gate.deviceLost ?? null,
        armedDevices: gate.armedDevices,
      },
      consoleErrors: consoleErrors.slice(0, 6),
      widgetsRemoved: strip.removed,
    };
  } finally {
    await context.close();
  }
}

/**
 * The probe's checks over one run's results — DASH's six, GLOW's four — pure
 * and exported so `polyline-probe-verdicts.spec.mjs` can drive it.
 *
 * @param {Record<string, {webgl: {render: object}, webgpu: {render: object, gate: object}}>} results By material type.
 * @returns {Array<{id: string, claim: string, pass: boolean, detail: object}>} Verdicts.
 */
export function evaluateMaterialPrimitive(results) {
  const errorFree = (gate) => (gate.errorCount ?? 0) === 0 && !gate.deviceLost;
  const verdicts = [];

  // ── DASH ──
  {
    const wgl = results.PolylineDash.webgl.render;
    const wgpu = results.PolylineDash.webgpu.render;
    const gate = results.PolylineDash.webgpu.gate;
    // Parity: colored-pixel count within 15%.
    const ratio = wgl.colored > 0 ? wgpu.colored / wgl.colored : 0;
    verdicts.push(
      {
        id: "dash/webgl-draws",
        claim: "[Dash] webgl draws colored pixels",
        pass: wgl.colored > 200,
        detail: { webglColored: wgl.colored },
      },
      {
        id: "dash/webgpu-draws",
        claim: "[Dash] webgpu draws colored pixels",
        pass: wgpu.colored > 200,
        detail: { webgpuColored: wgpu.colored },
      },
      // Dash gaps: a solid line is ~1 run/row. Require clearly more than that
      // on BOTH backends (multiple dashes per row).
      {
        id: "dash/webgl-dashed",
        claim: `[Dash] webgl is DASHED (runsPerRow=${wgl.runsPerRow.toFixed(2)} > 2)`,
        pass: wgl.runsPerRow > 2,
        detail: { runsPerRow: wgl.runsPerRow, runs: wgl.runs },
      },
      {
        id: "dash/webgpu-dashed",
        claim: `[Dash] webgpu is DASHED (runsPerRow=${wgpu.runsPerRow.toFixed(2)} > 2)`,
        pass: wgpu.runsPerRow > 2,
        detail: { runsPerRow: wgpu.runsPerRow, runs: wgpu.runs },
      },
      {
        id: "dash/parity",
        claim: `[Dash] webgpu colored within 15% of webgl (ratio=${ratio.toFixed(3)})`,
        pass: ratio >= 0.85 && ratio <= 1.15,
        detail: { ratio },
      },
      {
        id: "dash/webgpu-error-free",
        claim: "[Dash] no uncaptured WebGPU errors",
        pass: errorFree(gate),
        detail: { errorCount: gate.errorCount, deviceLost: gate.deviceLost },
      },
    );
  }

  // ── GLOW ──
  {
    const wgl = results.PolylineGlow.webgl.render;
    const wgpu = results.PolylineGlow.webgpu.render;
    const gate = results.PolylineGlow.webgpu.gate;
    const ratio = wgl.colored > 0 ? wgpu.colored / wgl.colored : 0;
    verdicts.push(
      {
        id: "glow/webgl-draws",
        claim: "[Glow] webgl draws the glow (reference)",
        pass: wgl.colored > 200,
        detail: { webglColored: wgl.colored },
      },
      {
        id: "glow/webgpu-draws",
        claim: "[Glow] webgpu draws the glow (not 0px)",
        pass: wgpu.colored > 200,
        detail: { webgpuColored: wgpu.colored },
      },
      {
        id: "glow/parity",
        claim: `[Glow] webgpu colored within 15% of webgl (ratio=${ratio.toFixed(3)})`,
        pass: ratio >= 0.85 && ratio <= 1.15,
        detail: { ratio },
      },
      {
        id: "glow/webgpu-error-free",
        claim: "[Glow] no uncaptured WebGPU errors",
        pass: errorFree(gate),
        detail: { errorCount: gate.errorCount, deviceLost: gate.deviceLost },
      },
    );
  }
  return verdicts;
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "polyline-material-primitive",
  title:
    "NEW-POLYLINE-APPEARANCE-PRIMITIVE-WEBGPU material slice — Dash and Glow parity",
  outputSubdirectory: "polyline-material-primitive",
  // No JSON receipt was banked before the migration.
  receiptEnvelope: "runtime",
  // The CesiumViewer page and the in-page import both read this module.
  servedArtifacts: ["Build/CesiumUnminified/index.js"],
  workBudgetMs: () =>
    RIGS.reduce((sum, rig) => sum + 2 * captureBudgetMs(rig), 0),
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (
      !options.renderers.includes("webgl") ||
      !options.renderers.includes("webgpu")
    ) {
      throw new ProbeRefusal(
        "renderer-pair-required",
        `the material-slice gate is a WebGPU/WebGL colored-pixel ratio, so both renderers are required (got ${options.renderers.join(",")})`,
        { renderers: options.renderers },
      );
    }
    const results = {};
    for (const rig of RIGS) {
      const material = rig.dials.material.type;
      results[material] = {};
      for (const renderer of ["webgl", "webgpu"]) {
        results[material][renderer] = await capturePass({
          browser,
          origin,
          rig,
          renderer,
          run,
          outputDirectory,
          captures,
        });
      }
    }
    return [{ run, results }];
  },
  verdicts(cells) {
    return cells.flatMap((cell) =>
      evaluateMaterialPrimitive(cell.results).map((verdict) => ({
        ...verdict,
        id: `${verdict.id}/run${cell.run}`,
      })),
    );
  },
  receipt(cells, context) {
    for (const verdict of context.verdicts) {
      console.log(`  [${verdict.pass ? "PASS" : "FAIL"}] ${verdict.claim}`);
    }
    return {
      rigs: RIGS.map((rig) => rig.id),
      cells,
      verdicts: context.verdicts,
    };
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
